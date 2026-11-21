import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOwners,
  getProposalsPaged,
  getThreshold,
  getTotalProposals,
  getTotalWeight,
  mapProposal,
} from "../lib/contract";
import { EmbedWidget } from "./EmbedWidget";

vi.mock("../lib/contract", () => ({
  getOwners: vi.fn(),
  getThreshold: vi.fn(),
  getTotalProposals: vi.fn(),
  getTotalWeight: vi.fn(),
  getProposalsPaged: vi.fn(),
  mapProposal: vi.fn((raw: unknown) => raw),
}));

const MOCK_PROPOSAL = {
  id: 1,
  kind: "transfer" as const,
  to: "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD",
  amount: "250.00",
  token: "XLM",
  description: "Public Ecosystem Grant",
  approvals: 1,
  threshold: 2,
  status: "pending" as const,
  deadline: "2026-12-01",
  deadlineTs: 1796083200,
  createdAt: "2026-11-19",
  proposer: "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD",
  userHasApproved: false,
};

describe("EmbedWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOwners).mockResolvedValue([
      "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD",
      "GCOTL5HEOY6ZC453QWAAIYL2QTZWNXWWU4PF22TK22YBZE6XLBIQHUH2",
    ]);
    vi.mocked(getThreshold).mockResolvedValue(2);
    vi.mocked(getTotalProposals).mockResolvedValue(1);
    vi.mocked(getTotalWeight).mockResolvedValue(2);
    vi.mocked(getProposalsPaged).mockResolvedValue([MOCK_PROPOSAL]);
    vi.mocked(mapProposal).mockImplementation((raw: any) => raw);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a read-only proposal embed widget with light theme and compact options", async () => {
    render(
      <MemoryRouter initialEntries={["/embed/proposals/1?theme=light&compact=true"]}>
        <Routes>
          <Route
            path="/embed/proposals/:id"
            element={<EmbedWidget mode="proposal" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const widget = await screen.findByTestId("embed-proposal-widget");
    expect(widget).toHaveAttribute("data-theme", "light");
    expect(widget).toHaveAttribute("data-compact", "true");
    expect(screen.getByText("Proposal #1")).toBeInTheDocument();
    expect(screen.getByTestId("embed-proposal-amount")).toHaveTextContent(
      "250.00 XLM",
    );
    expect(screen.getByTestId("embed-proposal-approvals")).toHaveTextContent(
      "Approvals: 1 / 2",
    );
    expect(
      screen.queryByTestId("embed-proposal-description"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("embed-open-proposal-link")).toHaveAttribute(
      "href",
      "/proposals/1",
    );
  });

  it("renders full proposal description when compact mode is off", async () => {
    render(
      <MemoryRouter initialEntries={["/embed/proposals/1"]}>
        <Routes>
          <Route
            path="/embed/proposals/:id"
            element={<EmbedWidget mode="proposal" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const desc = await screen.findByTestId("embed-proposal-description");
    expect(desc).toHaveTextContent("Public Ecosystem Grant");
  });

  it("renders invalid link state for malformed or boundary-zero proposal IDs", async () => {
    render(
      <MemoryRouter initialEntries={["/embed/proposals/0"]}>
        <Routes>
          <Route
            path="/embed/proposals/:id"
            element={<EmbedWidget mode="proposal" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const err = await screen.findByTestId("embed-error");
    expect(err).toHaveTextContent("Invalid proposal link");
  });

  it("renders not-found state when the proposal ID does not exist on-chain", async () => {
    render(
      <MemoryRouter initialEntries={["/embed/proposals/999"]}>
        <Routes>
          <Route
            path="/embed/proposals/:id"
            element={<EmbedWidget mode="proposal" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const notFound = await screen.findByTestId("embed-not-found");
    expect(notFound).toHaveTextContent("Proposal not found");
  });

  it("renders treasury summary embed widget", async () => {
    render(
      <MemoryRouter initialEntries={["/embed/treasury?theme=dark"]}>
        <Routes>
          <Route
            path="/embed/treasury"
            element={<EmbedWidget mode="treasury" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const widget = await screen.findByTestId("embed-treasury-widget");
    expect(widget).toHaveTextContent("2 of 2");
    expect(screen.getByTestId("embed-open-treasury-link")).toHaveAttribute(
      "href",
      "/app",
    );
  });

  it("redacts secrets from RPC error messages when rendering embed failure state", async () => {
    const token = ["tok", "secret0123456789abcdef"].join("_");
    vi.mocked(getOwners).mockRejectedValueOnce(
      new Error(`RPC error with Bearer ${token}`),
    );

    render(
      <MemoryRouter initialEntries={["/embed/proposals/1"]}>
        <Routes>
          <Route
            path="/embed/proposals/:id"
            element={<EmbedWidget mode="proposal" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const err = await screen.findByTestId("embed-error");
    expect(err).toHaveTextContent("Unable to load embedded proposal");
    expect(err.textContent).not.toContain(token);
    expect(err.textContent).toContain("[REDACTED]");
  });
});
