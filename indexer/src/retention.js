import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DAY_MS = 86_400_000;

function days(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Retention windows must be a non-negative number of days (0 keeps data forever)");
  }
  return parsed;
}

/**
 * Retention is expressed as three windows, each in days, where 0 means "keep
 * forever". Raw rows are rolled into daily aggregates before they are removed,
 * so the aggregate window must be at least as long as the raw window.
 */
export function loadRetentionPolicy(env = process.env) {
  const rawEventDays = days(env.RETENTION_RAW_EVENT_DAYS, 0);
  const aggregateDays = days(env.RETENTION_AGGREGATE_DAYS, 0);
  const reconciliationDays = days(env.RETENTION_RECONCILIATION_DAYS, 0);

  if (rawEventDays > 0 && aggregateDays > 0 && aggregateDays < rawEventDays) {
    throw new Error(
      "RETENTION_AGGREGATE_DAYS must be greater than or equal to RETENTION_RAW_EVENT_DAYS, " +
        "otherwise aggregates would be dropped while the raw rows they summarise are still kept"
    );
  }

  return {
    rawEventDays,
    aggregateDays,
    reconciliationDays,
    archiveDir: env.RETENTION_ARCHIVE_DIR?.trim() || null,
    intervalMs: Number(env.RETENTION_INTERVAL_MS ?? DAY_MS),
    get enabled() {
      return this.rawEventDays > 0 || this.aggregateDays > 0 || this.reconciliationDays > 0;
    },
  };
}

function cutoff(now, windowDays) {
  return new Date(now.getTime() - windowDays * DAY_MS).toISOString();
}

function archive(archiveDir, target, name, rows, stamp) {
  if (!archiveDir || rows.length === 0) return null;
  const directory = resolve(join(archiveDir, target.network, target.contractId));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}-${stamp}.jsonl`);
  appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return path;
}

/**
 * Applies the retention policy to one target: roll up, archive (when an archive
 * directory is configured), then remove. Running balances in `token_balances`
 * and the daily aggregates are never touched by the raw-event window, so
 * reports and dashboards keep working against pruned history.
 */
export function applyRetentionToTarget({ store, target, policy, now = new Date() }) {
  const scope = { network: target.network, contractId: target.contractId };
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archivePaths = [];
  const run = {
    ...scope,
    ranAt: now.toISOString(),
    entriesRolledUp: 0,
    entriesRemoved: 0,
    eventsRolledUp: 0,
    eventsRemoved: 0,
    reconciliationsRemoved: 0,
    aggregatesRemoved: 0,
    archivePaths,
  };

  if (policy.rawEventDays > 0) {
    const before = cutoff(now, policy.rawEventDays);
    const rolled = store.rollUpBefore({ ...scope, before });
    run.entriesRolledUp = rolled.entries;
    run.eventsRolledUp = rolled.events;

    if (policy.archiveDir) {
      const entryPath = archive(
        policy.archiveDir,
        target,
        "ledger_entries",
        store.selectEntriesBefore({ ...scope, before }),
        stamp
      );
      if (entryPath) archivePaths.push(entryPath);
      const eventPath = archive(
        policy.archiveDir,
        target,
        "accord_events",
        store.selectAccordEventsBefore({ ...scope, before }),
        stamp
      );
      if (eventPath) archivePaths.push(eventPath);
    }

    run.entriesRemoved = store.deleteEntriesBefore({ ...scope, before });
    run.eventsRemoved = store.deleteAccordEventsBefore({ ...scope, before });
  }

  if (policy.aggregateDays > 0) {
    run.aggregatesRemoved = store.deleteAggregatesBefore({
      ...scope,
      beforeDay: cutoff(now, policy.aggregateDays).slice(0, 10),
    });
  }

  if (policy.reconciliationDays > 0) {
    run.reconciliationsRemoved = store.deleteReconciliationsBefore({
      ...scope,
      before: cutoff(now, policy.reconciliationDays),
    });
  }

  store.recordRetentionRun(run);
  store.setState(scope, "last_retention_at", run.ranAt);
  return run;
}

export function applyRetention({ store, targets, policy, now = new Date() }) {
  if (!policy.enabled) return [];
  return targets.map((target) => applyRetentionToTarget({ store, target, policy, now }));
}
