import { useEffect, useState } from "react";
import type { Proposal, ProposalCategory, ProposalStatus, RecurringSchedule } from "../types/accord";
import { ProposalCard } from "../components/ProposalCard";
import {
  getProposalsPaged,
  getTotalProposals,
  getThreshold,
  mapProposal,
} from "../lib/contract";
import { formatInterval } from "../lib/soroban";

type Filter = "all" | ProposalStatus;
type CategoryFilter = "all" | ProposalCategory;

const TABS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "ready", label: "Ready" },
  { key: "executed", label: "Executed" },
  { key: "expired", label: "Expired" },
  { key: "revoked", label: "Revoked" },
];

const CATEGORY_OPTIONS: { key: CategoryFilter; label: string }[] = [
  { key: "all", label: "All Categories" },
  { key: "transfer", label: "Transfer" },
  { key: "payroll", label: "Payroll" },
  { key: "grant", label: "Grant" },
  { key: "ops", label: "Ops" },
  { key: "other", label: "Other" },
];

export function HistoryPage({
  proposals,
  onApprove,
  recurringSchedules = [],
}: {
  proposals: Proposal[];
  onApprove: (id: number) => void;
  recurringSchedules?: RecurringSchedule[];
}) {
  const [activeTab, setActiveTab] = useState<Filter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [proposerFilter, setProposerFilter] = useState("");
  const [displayedProposals, setDisplayedProposals] = useState<Proposal[]>(proposals);
  const [offset, setOffset] = useState<number>(proposals.length);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  
  const noop = () => {};

  // Fetch the total count once on mount
  useEffect(() => {
    let active = true;
    getTotalProposals()
      .then((total) => {
        if (active) {
          setTotalCount(total);
        }
      })
      .catch((err) => {
        console.error("Failed to load total proposal count:", err);
      });
    return () => {
      active = false;
    };
  }, []);

  // Keep displayedProposals and offset in sync if initial proposals prop updates
  useEffect(() => {
    setDisplayedProposals(proposals);
    setOffset(proposals.length);
  }, [proposals]);

  const hasMore = offset < totalCount;

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const pageSize = 20;
      const raw = await getProposalsPaged(offset, pageSize);
      const thresh = await getThreshold();
      const mapped = raw.map((p) => mapProposal(p, thresh));

      // Filter for history statuses: "executed", "expired", "revoked"
      const historyItems = mapped.filter((p) =>
        ["executed", "expired", "revoked"].includes(p.status)
      );

      setDisplayedProposals((prev) => [...prev, ...historyItems]);
      setOffset((prev) => prev + pageSize);
    } catch (err) {
      console.error("Failed to load more proposals:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  const filteredProposals = displayedProposals
    .filter((p) => activeTab === "all" || p.status === activeTab)
    .filter((p) => categoryFilter === "all" || p.category === categoryFilter)
    .filter((p) =>
      p.description.toLowerCase().includes(searchTerm.toLowerCase())
    )
    .filter(
      (p) =>
        proposerFilter === "" ||
        p.proposer.toLowerCase().includes(proposerFilter.toLowerCase())
    );

  const hasExecutedProposals = displayedProposals.some((p) => p.status === "executed");
  const hasRecurringSchedules = recurringSchedules.length > 0;
  const canExportCSV = hasExecutedProposals || hasRecurringSchedules;

  const handleExportCSV = () => {
    const executed = displayedProposals.filter((p) => p.status === "executed");
    if (!canExportCSV) return;

    const sections: string[] = [];

    if (executed.length > 0) {
      const headers = ["ID", "Amount", "Token", "Recipient", "Date"];
      const rows = executed.map(
        (p) => `${p.id},"${p.amount}","${p.token}","${p.to}","${p.executedAt || p.deadline}"`
      );
      sections.push([headers.join(","), ...rows].join("\n"));
    }

    if (hasRecurringSchedules) {
      const scheduleHeaders = ["Schedule ID", "Recipient", "Amount", "Cadence", "Total Disbursed"];
      const scheduleRows = recurringSchedules.map((s) => {
        const cadence = s.cadence ?? (s.interval !== undefined ? formatInterval(s.interval) : "—");
        return `${s.id},"${s.recipient}","${s.amount}","${cadence}","${s.totalDisbursed}"`;
      });
      const scheduleSection = ["Recurring Schedules", scheduleHeaders.join(","), ...scheduleRows].join("\n");
      sections.push(scheduleSection);
    }

    const csvContent = sections.join("\n\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "accord-history.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Proposal History</h2>
        <div className="flex items-center gap-3">
          {canExportCSV && (
            <button
              onClick={handleExportCSV}
              className="text-xs px-3 py-1 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export CSV
            </button>
          )}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as CategoryFilter)}
            aria-label="Filter by category"
            className="text-xs px-3 py-1.5 bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-lg capitalize transition-colors hover:text-white focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-1 rounded-lg">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`text-xs px-3 py-1 rounded-md capitalize transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none ${
                activeTab === tab.key
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
          </div>
        </div>
      </div>

      <div className="mb-4">
        <input
          type="text"
          value={proposerFilter}
          onChange={(e) => setProposerFilter(e.target.value)}
          placeholder="Filter by proposer…"
          aria-label="Filter by proposer"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-700 transition-colors"
        />
      </div>

      <div className="mb-4 relative">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by description…"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-700 transition-colors"
        />
        <div className="absolute left-3 top-2.5 text-zinc-600">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-4 h-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.602 10.602Z"
            />
          </svg>
        </div>
      </div>

      <div className="space-y-3">
        {filteredProposals.length === 0 ? (
          <p className="text-zinc-600 text-sm py-8 text-center">
            {searchTerm || proposerFilter || categoryFilter !== "all"
              ? "No proposals match your search"
              : `No ${activeTab === "all" ? "" : `${activeTab} `}proposals found`}
          </p>
        ) : (
          filteredProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              walletAddress={null}
              onApprove={onApprove}
              onExecute={noop}
              onRevoke={noop}
            />
          ))
        )}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="w-full py-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-medium text-zinc-300 hover:text-white transition-all flex items-center justify-center gap-2 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {loadingMore ? (
              <>
                <svg className="animate-spin h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Loading proposals...</span>
              </>
            ) : (
              "Load More"
            )}
          </button>
        </div>
      )}
    </>
  );
}
