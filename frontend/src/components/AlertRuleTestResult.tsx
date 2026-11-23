import type { AlertRuleTestResult } from "../lib/alertRules";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** What a rule would have done over the tested history. */
export function AlertRuleTestResultView({ result }: { result: AlertRuleTestResult }) {
  const hours = result.lookbackHours;
  const summary =
    result.wouldFire === 0
      ? `This rule would not have fired in the last ${hours} hours (${result.eventsEvaluated} events checked).`
      : `This rule would have fired ${result.wouldFire} ${result.wouldFire === 1 ? "alert" : "alerts"} in the last ${hours} hours (${result.eventsEvaluated} events checked).`;

  return (
    <div role="status" aria-live="polite" className="mt-3 space-y-2 text-sm">
      <p className={result.wouldFire === 0 ? "text-zinc-300" : "text-amber-300"}>{summary}</p>
      {result.suppressed > 0 && (
        <p className="text-xs text-zinc-400">
          {result.suppressed} more {result.suppressed === 1 ? "match was" : "matches were"} held back by the
          cooldown or alert cap.
        </p>
      )}
      {result.truncated && (
        <p className="text-xs text-amber-400">
          There was more activity than a test reads, so only the oldest events were checked.
        </p>
      )}
      {result.alerts.length > 0 && (
        <ul className="space-y-1">
          {result.alerts.map((alert) => (
            <li key={`${alert.firedAt}-${alert.subject}`} className="rounded-lg bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
              <span className="block text-zinc-500">{formatWhen(alert.firedAt)}</span>
              {alert.message}
            </li>
          ))}
          {result.wouldFire > result.alerts.length && (
            <li className="text-xs text-zinc-500">…and {result.wouldFire - result.alerts.length} more.</li>
          )}
        </ul>
      )}
    </div>
  );
}
