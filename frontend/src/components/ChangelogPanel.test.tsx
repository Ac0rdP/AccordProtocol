import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The real raw import is denied by Vite's dev-server fs allow list in tests;
// these suites pass fixture releases via the component's `releases` prop.
vi.mock("../../../CHANGELOG.md?raw", () => ({ default: "# Changelog\n" }));

import { ChangelogPanel } from "./ChangelogPanel";
import type { ChangelogRelease } from "../lib/changelog";

const FIXTURE: ChangelogRelease[] = [
  {
    version: "Unreleased",
    entries: [
      {
        id: "Unreleased-0",
        text: "Nightly workflow (#820) documented in docs/CI.md.",
        release: "Unreleased",
        category: "Added",
        issues: [820],
        docs: ["docs/CI.md"],
      },
      {
        id: "Unreleased-1",
        text: "Seeded preview deployments.",
        release: "Unreleased",
        category: "Added",
        issues: [],
        docs: [],
      },
    ],
  },
  {
    version: "0.1.0",
    entries: [
      {
        id: "0.1.0-0",
        text: "Initial Soroban multisig contract.",
        release: "0.1.0",
        category: "Added",
        issues: [],
        docs: [],
      },
    ],
  },
];

const FIXTURE_WITH_CODE: ChangelogRelease[] = [
  {
    version: "Unreleased",
    entries: [
      {
        id: "Unreleased-0",
        text: "`docs/CI.md` documenting the workflow map.",
        release: "Unreleased",
        category: "Added",
        issues: [],
        docs: ["docs/CI.md"],
      },
      {
        id: "Unreleased-1",
        text: "Opt-in Postgres backend (`STORE_BACKEND=postgres`).",
        release: "Unreleased",
        category: "Added",
        issues: [],
        docs: [],
      },
    ],
  },
];

describe("ChangelogPanel", () => {
  let store: Record<string, string> = {};

  function renderPanel(releases: ChangelogRelease[]) {
    return render(
      <MemoryRouter>
        <ChangelogPanel releases={releases} />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    store = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  test("shows an unread badge when entries have never been seen", () => {
    renderPanel(FIXTURE);
    expect(screen.getByTestId("changelog-unread-badge")).toHaveTextContent("3");
  });

  test("hides the badge once the changelog has been seen", () => {
    localStorage.setItem(
      "accord_changelog_seen",
      JSON.stringify({ version: "Unreleased", entryCount: 2 }),
    );
    renderPanel(FIXTURE);
    expect(screen.queryByTestId("changelog-unread-badge")).toBeNull();
  });

  test("renders recent entries grouped by release when opened", () => {
    renderPanel(FIXTURE);
    fireEvent.click(screen.getByRole("button", { name: /what's new/i }));

    expect(screen.getByRole("dialog", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByText("What's new", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(
      screen.getByText("Seeded preview deployments."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Initial Soroban multisig contract."),
    ).toBeInTheDocument();
  });

  test("links issue references and documentation paths to GitHub", () => {
    renderPanel(FIXTURE);
    fireEvent.click(screen.getByRole("button", { name: /what's new/i }));

    const issueLink = screen.getByRole("link", { name: "#820" });
    expect(issueLink).toHaveAttribute(
      "href",
      "https://github.com/connelevalsam/AccordProtocol/issues/820",
    );

    const docLink = screen.getByRole("link", { name: "docs/CI.md" });
    expect(docLink).toHaveAttribute(
      "href",
      "https://github.com/connelevalsam/AccordProtocol/blob/main/docs/CI.md",
    );
  });

  test("links documentation paths wrapped in backticks and renders other code spans", () => {
    renderPanel(FIXTURE_WITH_CODE);
    fireEvent.click(screen.getByRole("button", { name: /what's new/i }));

    const docLink = screen.getByRole("link", { name: "docs/CI.md" });
    expect(docLink).toHaveAttribute(
      "href",
      "https://github.com/connelevalsam/AccordProtocol/blob/main/docs/CI.md",
    );
    expect(screen.getByText("STORE_BACKEND=postgres")).toBeInTheDocument();
  });

  test("marks entries read when opened: badge clears and new dots show for this session", () => {
    renderPanel(FIXTURE);
    const trigger = screen.getByRole("button", { name: /what's new/i });
    expect(screen.getByTestId("changelog-unread-badge")).toHaveTextContent("3");
    fireEvent.click(trigger);

    // Unread entries that existed at open time are flagged as new in the panel.
    expect(screen.getAllByLabelText("New")).toHaveLength(3);
    // Everything is marked seen, so the badge clears.
    expect(screen.queryByTestId("changelog-unread-badge")).toBeNull();
    expect(trigger).toHaveAccessibleName("What's new");
    expect(JSON.parse(localStorage.getItem("accord_changelog_seen")!)).toEqual({
      version: "Unreleased",
      entryCount: 2,
    });
  });

  test("does not show new dots after reopening once entries are seen", () => {
    renderPanel(FIXTURE);
    const trigger = screen.getByRole("button", { name: /what's new/i });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    fireEvent.click(trigger);

    expect(screen.queryAllByLabelText("New")).toHaveLength(0);
    expect(screen.queryByTestId("changelog-unread-badge")).toBeNull();
  });
});
