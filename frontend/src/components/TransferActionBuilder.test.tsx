import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TransferActionBuilder,
  createTransferDraft,
  type TransferDraft,
} from "./TransferActionBuilder";

describe("TransferActionBuilder", () => {
  it("supports adding and keyboard-operable reordering", () => {
    const first = { ...createTransferDraft(), recipient: "recipient one" };
    const second = { ...createTransferDraft(), recipient: "recipient two" };
    let transfers: TransferDraft[] = [first, second];
    const onChange = vi.fn((next: TransferDraft[]) => {
      transfers = next;
    });

    const { rerender } = render(
      <TransferActionBuilder transfers={transfers} onChange={onChange} />,
    );
    const section = screen.getByRole("region", { name: "Proposal transfers" });
    const list = within(section).getByRole("list");

    fireEvent.click(screen.getByRole("button", { name: "Move transfer 1 down" }));
    expect(onChange).toHaveBeenLastCalledWith([second, first]);

    rerender(
      <TransferActionBuilder transfers={transfers} onChange={onChange} />,
    );
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
      "recipient two",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add transfer" }));
    expect(onChange).toHaveBeenLastCalledWith([
      second,
      first,
      expect.objectContaining({ recipient: "", amount: "", token: "XLM" }),
    ]);
  });
});
