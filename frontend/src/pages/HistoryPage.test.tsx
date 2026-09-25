import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { HistoryPage } from "./HistoryPage";
import type { Proposal, RecurringSchedule } from "../types/accord";

vi.mock("../lib/contract", () => ({
  getTotalProposals: vi.fn().mockResolvedValue(0),
  getProposalsPaged: vi.fn().mockResolvedValue([]),
  getThreshold: vi.fn().mockResolvedValue(2),
  mapProposal: vi.fn(),
}));

const mockProposal: Proposal = {
  id: 1,
  kind: "transfer",
  category: "transfer",
  to: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
  amount: "25",
  token: "XLM",
  description: "History proposal",
  approvals: 2,
  threshold: 2,
  status: "executed",
  deadline: "Jul 4, 2026",
  deadlineTs: 1783123200,
  createdAt: "Jun 27, 2026",
  proposer: "GPROPOSER1",
  userHasApproved: true,
  approverAddresses: ["GAPPROVER1", "GAPPROVER2"],
  executedAt: "Jul 4, 2026",
};

describe("HistoryPage CSV export", () => {
  let createdBlobText = "";
  let clickedDownload = false;

  beforeEach(() => {
    vi.clearAllMocks();
    createdBlobText = "";
    clickedDownload = false;

    // Mock URL and createElement for Blob download
    global.URL.createObjectURL = vi.fn((blob: any) => {
      if (blob && typeof blob.text === "function") {
        blob.text().then((t: string) => {
          createdBlobText = t;
        });
      }
      return "blob:mock-url";
    });
    global.URL.revokeObjectURL = vi.fn();

    // Ensure Blob constructor captures text
    const OriginalBlob = global.Blob;
    global.Blob = class MockBlob extends OriginalBlob {
      private _content: string;
      constructor(blobParts?: BlobPart[], options?: BlobPropertyBag) {
        super(blobParts, options);
        this._content = (blobParts || []).map((p) => String(p)).join("");
        createdBlobText = this._content;
      }
      text(): Promise<string> {
        return Promise.resolve(this._content);
      }
    } as any;

    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      clickedDownload = true;
    });
  });

  test("exports executed proposals unchanged", async () => {
    render(
      <MemoryRouter>
        <HistoryPage proposals={[mockProposal]} onApprove={vi.fn()} />
      </MemoryRouter>
    );

    const exportBtn = screen.getByRole("button", { name: /export csv/i });
    fireEvent.click(exportBtn);

    expect(clickedDownload).toBe(true);
    expect(createdBlobText).toContain("ID,Amount,Token,Recipient,Date");
    expect(createdBlobText).toContain('1,"25","XLM","GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC","Jul 4, 2026"');
    expect(createdBlobText).not.toContain("Recurring Schedules");
  });

  test("exports recurring schedules with id, recipient, amount, cadence, and total disbursed", async () => {
    const schedules: RecurringSchedule[] = [
      {
        id: 42,
        recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
        amount: "50 XLM",
        interval: 2592000, // Monthly
        totalDisbursed: "150 XLM",
        status: "active",
      },
      {
        id: 43,
        recipient: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
        amount: "10 USDC",
        interval: 604800, // Weekly
        totalDisbursed: "40 USDC",
        status: "active",
      },
    ];

    render(
      <MemoryRouter>
        <HistoryPage
          proposals={[mockProposal]}
          recurringSchedules={schedules}
          onApprove={vi.fn()}
        />
      </MemoryRouter>
    );

    const exportBtn = screen.getByRole("button", { name: /export csv/i });
    fireEvent.click(exportBtn);

    expect(clickedDownload).toBe(true);

    // Verify existing proposal export is unchanged
    expect(createdBlobText).toContain("ID,Amount,Token,Recipient,Date");
    expect(createdBlobText).toContain('1,"25","XLM","GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC","Jul 4, 2026"');

    // Verify recurring schedules section
    expect(createdBlobText).toContain("Recurring Schedules");
    expect(createdBlobText).toContain("Schedule ID,Recipient,Amount,Cadence,Total Disbursed");
    expect(createdBlobText).toContain('42,"GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC","50 XLM","Monthly","150 XLM"');
    expect(createdBlobText).toContain('43,"GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC","10 USDC","Weekly","40 USDC"');
  });

  test("formats custom cadence intervals properly", async () => {
    const schedules: RecurringSchedule[] = [
      {
        id: 10,
        recipient: "GABC",
        amount: "100",
        interval: 86400 * 3, // Every 3 days
        totalDisbursed: "300",
        status: "active",
      },
    ];

    render(
      <MemoryRouter>
        <HistoryPage
          proposals={[]}
          recurringSchedules={schedules}
          onApprove={vi.fn()}
        />
      </MemoryRouter>
    );

    const exportBtn = screen.getByRole("button", { name: /export csv/i });
    fireEvent.click(exportBtn);

    expect(createdBlobText).toContain('10,"GABC","100","Every 3 days","300"');
  });
});
