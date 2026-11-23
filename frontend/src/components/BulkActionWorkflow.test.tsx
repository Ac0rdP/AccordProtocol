import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { BulkActionWorkflow } from "./BulkActionWorkflow";
import { baseProposal, mockWallet } from "../stories/fixtures";
import { ACCEPTANCE_VIEWPORTS, setViewport } from "../test/viewport";

const proposals = [
  baseProposal({ id: 1, status: "ready", description: "Pay auditors" }),
  baseProposal({ id: 2, status: "ready", description: "Grant tranche" }),
  baseProposal({ id: 3, status: "ready", description: "Server bill" }),
  baseProposal({ id: 4, status: "pending", description: "Needs my approval" }),
  baseProposal({ id: 5, status: "pending", userHasApproved: true, description: "Already approved" }),
];

function setup(overrides: Partial<React.ComponentProps<typeof BulkActionWorkflow>> = {}) {
  const props = {
    proposals,
    walletAddress: mockWallet,
    onApprove: vi.fn().mockResolvedValue(undefined),
    onExecute: vi.fn().mockResolvedValue(undefined),
    onBatchComplete: vi.fn(),
    onConnectWallet: vi.fn(),
    ...overrides,
  };
  const user = userEvent.setup();
  const utils = render(<BulkActionWorkflow {...props} />);
  return { user, props, ...utils };
}

describe("BulkActionWorkflow", () => {
  it("lists only eligible proposals for the chosen action", async () => {
    const { user } = setup();
    expect(screen.getByRole("checkbox", { name: /pay auditors/i })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /needs my approval/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /approve/i }));
    expect(screen.getByRole("checkbox", { name: /needs my approval/i })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /already approved/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /pay auditors/i })).not.toBeInTheDocument();
  });

  it("supports select all with an indeterminate state", async () => {
    const { user } = setup();
    const all = screen.getByRole("checkbox", { name: /select all/i }) as HTMLInputElement;
    await user.click(screen.getByRole("checkbox", { name: /pay auditors/i }));
    expect(all.indeterminate).toBe(true);
    await user.click(all);
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    await user.click(all);
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review/i })).toBeDisabled();
  });

  it("runs the batch and reports per-item results, then retries only failures", async () => {
    const onExecute = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Transaction was rejected in your wallet."))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const { user, props } = setup({ onExecute });

    await user.click(screen.getByRole("checkbox", { name: /select all/i }));
    await user.click(screen.getByRole("button", { name: /review 3 proposals/i }));
    expect(screen.getByRole("heading", { name: /review: execute 3 proposals/i })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /confirm and execute 3/i }));

    expect(await screen.findByRole("heading", { name: /batch results/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 executed, 1 failed.");
    const results = screen.getByRole("list", { name: /per-proposal results/i });
    expect(within(results).getByText("Transaction was rejected in your wallet.")).toBeInTheDocument();
    expect(onExecute.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(props.onBatchComplete).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /retry 1 unfinished/i }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 executed, 0 failed."),
    );
    expect(onExecute).toHaveBeenLastCalledWith(2);
  });

  it("can stop a running batch after the current item", async () => {
    let release!: () => void;
    const onExecute = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockResolvedValue(undefined);
    const { user } = setup({ onExecute });

    await user.click(screen.getByRole("checkbox", { name: /select all/i }));
    await user.click(screen.getByRole("button", { name: /review/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));
    await user.click(await screen.findByRole("button", { name: /stop after current/i }));
    release();

    expect(await screen.findByRole("heading", { name: /batch results/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 executed, 0 failed, 2 skipped.");
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it("blocks submission without a wallet and offers to connect", async () => {
    const { user, props } = setup({ walletAddress: null });
    await user.click(screen.getByRole("checkbox", { name: /pay auditors/i }));
    await user.click(screen.getByRole("button", { name: /review/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/connect a wallet/i);
    expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(props.onConnectWallet).toHaveBeenCalled();
  });

  it("shows an empty state when the chosen action has nothing eligible", () => {
    setup({ proposals: [baseProposal({ id: 4, status: "pending" })], initialAction: "execute" });
    expect(screen.getByText("No proposals to execute")).toBeInTheDocument();
  });

  it.each(ACCEPTANCE_VIEWPORTS)(
    "completes the whole flow with the keyboard only at %ipx",
    async (width) => {
      setViewport(width);
      const { user, props } = setup();

      // Tab into the action radios, switch to Execute with arrow keys, then to the list.
      await user.tab();
      expect(screen.getByRole("radio", { name: /execute/i })).toHaveFocus();
      await user.tab(); // select all
      expect(screen.getByRole("checkbox", { name: /select all/i })).toHaveFocus();
      await user.tab(); // first proposal
      await user.keyboard(" ");
      await user.tab();
      await user.keyboard(" ");
      expect(screen.getByText("2 selected")).toBeInTheDocument();

      await user.tab(); // third proposal
      await user.tab(); // review button
      expect(screen.getByRole("button", { name: /review 2 proposals/i })).toHaveFocus();
      await user.keyboard("{Enter}");

      await user.tab(); // Back
      await user.tab(); // Confirm
      expect(screen.getByRole("button", { name: /confirm and execute 2/i })).toHaveFocus();
      await user.keyboard("{Enter}");

      expect(await screen.findByRole("heading", { name: /batch results/i })).toHaveFocus();
      expect(props.onExecute).toHaveBeenCalledTimes(2);
    },
  );

  it("has no axe violations in the select and results steps", async () => {
    const { user, container } = setup();
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole("checkbox", { name: /pay auditors/i }));
    await user.click(screen.getByRole("button", { name: /review/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));
    await screen.findByRole("heading", { name: /batch results/i });
    expect((await axe(container)).violations).toEqual([]);
  });
});
