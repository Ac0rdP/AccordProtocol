import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { PageState } from "../components/PageState";
import { getProposalEvents } from "../lib/contract";
import type { Proposal, ProposalEvent } from "../types/accord";

type AuditKind = "all" | "approval" | "execution" | "governance" | "configuration";
type AuditItem = ProposalEvent & { proposal: Proposal; kind: AuditKind };

function classify(event: ProposalEvent, proposal: Proposal): Exclude<AuditKind, "all"> {
  const type = event.type.toLowerCase();
  if (type === "approved" || type === "revoked") return "approval";
  if (type === "executed") return proposal.kind === "transfer" ? "execution" : "governance";
  if (type.includes("weight") || proposal.kind === "grant_role" || proposal.kind === "revoke_role" || proposal.kind === "change_threshold") return "configuration";
  return proposal.kind === "transfer" ? "execution" : "governance";
}

function itemLabel(item: AuditItem) {
  const type = item.type.replace(/_/g, " ");
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function isInDateRange(timestamp: string, start: string, end: string) {
  if (!start && !end) return true;
  const eventTime = Date.parse(timestamp);
  if (Number.isNaN(eventTime)) return true; // Ledger-only records stay discoverable.
  return (!start || eventTime >= Date.parse(start)) && (!end || eventTime <= Date.parse(`${end}T23:59:59`));
}

export function AuditLogPage({
  proposals,
  loading: forceLoading = false,
  error: forcedError = null,
  onRetry,
}: {
  proposals: Proposal[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<AuditKind>("all");
  const [actor, setActor] = useState("");
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const load = useCallback(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoading(true);
      setError(null);
      Promise.all(proposals.map(async (proposal) => {
        const events = await getProposalEvents(proposal.id);
        return events.map((event) => ({ ...event, proposal, kind: classify(event, proposal) }));
      }))
        .then((groups) => {
          if (!active) return;
          setItems(groups.flat().sort((left, right) => (right.ledger ?? 0) - (left.ledger ?? 0)));
          setLoading(false);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setError(cause instanceof Error ? cause.message : "Unable to load audit events.");
          setLoading(false);
        });
    });
    return () => { active = false; };
  }, [proposals]);

  useEffect(() => load(), [load]);

  const filtered = useMemo(() => items.filter((item) => {
    const matchesKind = kind === "all" || item.kind === kind;
    const haystack = `${itemLabel(item)} ${item.details ?? ""} ${item.proposal.description} #${item.proposal.id}`.toLowerCase();
    return matchesKind &&
      (!actor || item.actor.toLowerCase().includes(actor.toLowerCase())) &&
      (!search || haystack.includes(search.toLowerCase())) &&
      isInDateRange(item.timestamp, startDate, endDate);
  }), [actor, endDate, items, kind, search, startDate]);

  const exportCsv = () => {
    const escape = (value: string | number | undefined) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = ["Type,Proposal,Actor,Timestamp,Ledger,Details", ...filtered.map((item) => [itemLabel(item), `#${item.proposal.id}`, item.actor, item.timestamp, item.ledger, item.details].map(escape).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "accord-audit-log.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  if (forceLoading || loading) return <PageState status="loading" title="Loading audit log…" />;
  if (forcedError || error) return <PageState status="error" title="Could not load audit log" description={forcedError ?? error ?? undefined} onRetry={onRetry ?? load} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h1 className="text-xl font-semibold text-white">Audit log</h1><p className="mt-1 text-sm text-zinc-400">Governance, role, and configuration changes recorded on-chain.</p></div>
        <button type="button" onClick={exportCsv} disabled={!filtered.length} className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50">Export CSV</button>
      </div>
      <section aria-label="Audit log filters" className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-xs text-zinc-400">Event type<select value={kind} onChange={(event) => setKind(event.target.value as AuditKind)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"><option value="all">All events</option><option value="approval">Approvals</option><option value="execution">Executions</option><option value="governance">Governance</option><option value="configuration">Configuration</option></select></label>
        <label className="text-xs text-zinc-400">Actor<input aria-label="Filter audit log by actor" value={actor} onChange={(event) => setActor(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-zinc-400" /></label>
        <label className="text-xs text-zinc-400">Search<input aria-label="Search audit log" value={search} onChange={(event) => setSearch(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-zinc-400" /></label>
        <label className="text-xs text-zinc-400">From<input aria-label="Audit log start date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-zinc-400" /></label>
        <label className="text-xs text-zinc-400">To<input aria-label="Audit log end date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-zinc-400" /></label>
      </section>
      {filtered.length === 0 ? <EmptyState variant="section" title="No audit events match these filters" description="Try changing or clearing a filter." /> : (
        <ol className="space-y-3" aria-label="Audit events">
          {filtered.map((item, index) => <li key={`${item.proposal.id}-${item.ledger ?? index}-${item.type}`} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-sm font-medium text-white">{itemLabel(item)} <span className="font-mono text-zinc-400">#{item.proposal.id}</span></p><p className="mt-1 break-all text-xs text-zinc-400">{item.actor}{item.details ? ` · ${item.details}` : ""}</p></div><div className="text-xs text-zinc-500 sm:text-end"><p>{item.timestamp}</p>{item.ledger !== undefined && <p>Ledger {item.ledger}</p>}</div></div>
          </li>)}
        </ol>
      )}
    </div>
  );
}
