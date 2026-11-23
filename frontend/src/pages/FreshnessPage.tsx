import { useCallback, useEffect, useState } from "react";
import { PageState } from "../components/PageState";
import { fetchFreshness, formatAge, type Freshness, type FreshnessStatus } from "../lib/freshness";

const POLL_MS = 30_000;

const BADGE: Record<FreshnessStatus, { label: string; className: string }> = {
  ok: { label: "Within SLO", className: "bg-emerald-500/15 text-emerald-300" },
  breach: { label: "SLO breached", className: "bg-red-500/15 text-red-300" },
  unknown: { label: "No data yet", className: "bg-zinc-700/50 text-zinc-300" },
};

function Badge({ status }: { status: FreshnessStatus }) {
  const { label, className } = BADGE[status];
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}

function Metric({ title, value, target, status }: { title: string; value: string; target: string; status: FreshnessStatus }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-300">{title}</h3>
        <Badge status={status} />
      </div>
      <p className="mt-2 text-2xl font-semibold text-zinc-100">{value}</p>
      <p className="text-xs text-zinc-500">{target}</p>
    </div>
  );
}

/** Ingestion lag, last checkpoint, API latency and report freshness against their SLOs. */
export function FreshnessPage({ load = fetchFreshness }: { load?: (signal?: AbortSignal) => Promise<Freshness> } = {}) {
  const [data, setData] = useState<Freshness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const run = () =>
      load(controller.signal)
        .then((result) => {
          setData(result);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load data freshness");
        });
    void run();
    const timer = setInterval(run, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  let body;
  if (!data && !error) {
    body = <PageState status="loading" title="Loading data freshness…" />;
  } else if (!data) {
    body = <PageState status="error" title="Could not load data freshness" description={error ?? undefined} onRetry={retry} />;
  } else {
    body = (
      <div className="space-y-6">
        {error && <p role="alert" className="text-sm text-amber-400">Showing the last result; refreshing failed: {error}</p>}
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-400">Overall</span>
          <Badge status={data.status} />
          <span className="text-xs text-zinc-500">Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
        </div>
        <section aria-label="API latency">
          <h2 className="mb-2 text-base font-semibold text-zinc-100">API latency</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Metric
              title="p95 latency"
              value={data.api.p95Ms === null ? "no requests yet" : `${Math.round(data.api.p95Ms)} ms`}
              target={`Objective: ≤ ${data.slo.apiP95Ms} ms (${data.api.requests} requests since start)`}
              status={data.api.status}
            />
            <Metric
              title="p50 latency"
              value={data.api.p50Ms === null ? "no requests yet" : `${Math.round(data.api.p50Ms)} ms`}
              target="Median since the service started"
              status="unknown"
            />
          </div>
        </section>
        <section aria-label="Contracts">
          <h2 className="mb-2 text-base font-semibold text-zinc-100">Ingestion and reports</h2>
          <ul className="space-y-3">
            {data.items.map((item) => (
              <li key={`${item.network}-${item.contractId}`} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="break-all text-sm font-semibold text-zinc-100">
                    {item.network} · {item.contractId}
                  </h3>
                  <Badge status={item.status} />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Metric
                    title="Ingestion lag"
                    value={formatAge(item.ingestionLagSeconds)}
                    target={
                      item.lastLedger === null
                        ? "No checkpoint recorded"
                        : `Last checkpoint: ledger ${item.lastLedger}, objective ≤ ${formatAge(data.slo.ingestionLagSeconds)}`
                    }
                    status={item.ingestionStatus}
                  />
                  <Metric
                    title="Report freshness"
                    value={item.lastReportAt ? `${formatAge(item.reportAgeSeconds)} old` : "no report yet"}
                    target={`Objective: ≤ ${formatAge(data.slo.reportMaxAgeSeconds)}`}
                    status={item.reportStatus}
                  />
                </div>
              </li>
            ))}
            {data.items.length === 0 && <li className="text-sm text-zinc-400">No contracts in scope.</li>}
          </ul>
        </section>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">Data freshness</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          How current the analytics data is, and how the API is performing, against the service objectives.
        </p>
      </header>
      {body}
    </div>
  );
}
