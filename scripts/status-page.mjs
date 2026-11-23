#!/usr/bin/env node

/**
 * status-page.mjs — health probing, status mapping and the public status page.
 *
 * Usage:
 *   node scripts/status-page.mjs probe  [--out-dir=<dir>] [--dry-run]
 *   node scripts/status-page.mjs render [--out=<file>] [--out-dir=<dir>]
 *
 * Environment:
 *   INDEXER_STATUS_URL        base URL of the indexer API   (default http://127.0.0.1:8787)
 *   ANALYTICS_API_STATUS_URL  base URL of the analytics API (default http://127.0.0.1:8080)
 *
 * `probe` reads the `/status` endpoint of both services, maps the answer to a
 * status, folds it into the daily availability history and rewrites
 * `docs/status/status.json` and `docs/status/index.html`.
 *
 * `render` only re-renders the page from the committed data; the documentation
 * build uses it to publish the status page without touching the network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUS_OPERATIONAL = 'operational';
export const STATUS_DEGRADED = 'degraded';
export const STATUS_OUTAGE = 'outage';
export const STATUS_UNKNOWN = 'unknown';
export const STATUSES = [STATUS_OPERATIONAL, STATUS_DEGRADED, STATUS_OUTAGE, STATUS_UNKNOWN];

/** How bad a status is; used to fold several samples of one day into one bar. */
const SEVERITY = {
  [STATUS_OPERATIONAL]: 1,
  [STATUS_UNKNOWN]: 2,
  [STATUS_DEGRADED]: 3,
  [STATUS_OUTAGE]: 4,
};

/** Dependencies a service cannot work without: their failure is an outage. */
export const CRITICAL_CHECKS = ['store', 'database'];

/** Days of daily availability the page shows. */
export const HISTORY_DAYS = 30;
/** How long one health probe may take. */
export const PROBE_TIMEOUT_MS = 10_000;
/** The page is refreshed at least this often, even when nothing changed. */
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_OUT_DIR = 'docs/status';
export const STATUS_FILE = 'status.json';
export const INCIDENTS_FILE = 'incidents.json';
export const PAGE_FILE = 'index.html';

/** The services the status page reports on. */
export const SERVICES = [
  {
    id: 'indexer',
    name: 'Indexer',
    description: 'Ingests Accord contract events from Stellar RPC into the ledger store.',
    urlEnv: 'INDEXER_STATUS_URL',
    defaultUrl: 'http://127.0.0.1:8787',
  },
  {
    id: 'analytics-api',
    name: 'Analytics API',
    description: 'Serves proposals, spend and treasury analytics to the Accord frontend.',
    urlEnv: 'ANALYTICS_API_STATUS_URL',
    defaultUrl: 'http://127.0.0.1:8080',
  },
];

/** The status endpoint of a service, derived from its base URL. */
export function statusUrlFor(service, env = process.env) {
  const base = (env[service.urlEnv] || service.defaultUrl).replace(/\/+$/, '');
  return `${base}/status`;
}

export function severity(status) {
  return SEVERITY[status] ?? 0;
}

/** The worst status of a list; an empty list counts as operational. */
export function worstStatus(statuses) {
  return statuses.reduce((worst, status) => (severity(status) > severity(worst) ? status : worst), STATUS_OPERATIONAL);
}

/**
 * Normalises the `checks` object a service reports.
 *
 * A service reports `{ ok, detail }` per check; a plain `"ok"`/`"unavailable"`
 * string is accepted as well so a hand-written health endpoint still works.
 */
export function normalizeChecks(checks) {
  const normalized = {};
  for (const [name, value] of Object.entries(checks ?? {})) {
    if (value && typeof value === 'object') {
      normalized[name] = {
        ok: Boolean(value.ok),
        ...(value.detail ? { detail: String(value.detail) } : {}),
      };
    } else {
      normalized[name] = { ok: value === true || value === 'ok' };
    }
  }
  return normalized;
}

/**
 * Derives a status from the checks a service reported.
 *
 * The store (indexer) and the database (analytics API) are the dependencies a
 * service cannot work without: if one of them fails the service is in an
 * outage. Any other failing check only degrades the service.
 */
export function statusFromChecks(checks, { critical = CRITICAL_CHECKS } = {}) {
  const entries = Object.entries(checks ?? {});
  if (!entries.length) return STATUS_UNKNOWN;
  if (entries.some(([name, check]) => critical.includes(name) && !check.ok)) return STATUS_OUTAGE;
  if (entries.every(([, check]) => check.ok)) return STATUS_OPERATIONAL;
  return STATUS_DEGRADED;
}

/**
 * Maps one probe result to a status sample.
 *
 * A service that cannot be reached is in an outage, a service that answers
 * with a failing check is degraded (or in an outage when a critical check
 * fails). The status the service reports wins when it is a valid one: it
 * knows its own internals, the probe only sees the outside.
 */
export function mapProbeResult(service, result = {}) {
  const { httpStatus = 0, body = null, error = null, latencyMs = null, checkedAt = null } = result;
  const at = checkedAt ?? new Date().toISOString();

  if (error) {
    return {
      id: service.id,
      status: STATUS_OUTAGE,
      detail: `the service did not answer: ${error}`,
      checks: {},
      latencyMs,
      httpStatus,
      checkedAt: at,
    };
  }

  if (!body || typeof body !== 'object') {
    const status = httpStatus >= 500 || httpStatus === 0 ? STATUS_OUTAGE : STATUS_UNKNOWN;
    return {
      id: service.id,
      status,
      detail: httpStatus === 404
        ? 'the status endpoint is not deployed yet'
        : `the status endpoint answered ${httpStatus} without a status document`,
      checks: {},
      latencyMs,
      httpStatus,
      checkedAt: at,
    };
  }

  const checks = normalizeChecks(body.checks);
  const reported = STATUSES.includes(body.status) ? body.status : null;
  const status = reported ?? (httpStatus >= 500 ? STATUS_OUTAGE : statusFromChecks(checks));
  const failing = Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name, check]) => `${name}: ${check.detail ?? 'not ok'}`);

  let detail;
  if (failing.length) detail = failing.join('; ');
  else if (status === STATUS_OPERATIONAL) detail = 'All checks passed.';
  else if (status === STATUS_DEGRADED) detail = 'Degraded, but the service is still serving requests.';
  else if (status === STATUS_OUTAGE) detail = 'The service is not serving requests.';
  else detail = 'The service did not report a status.';

  return { id: service.id, status, detail, checks, latencyMs, httpStatus, checkedAt: at };
}

/**
 * Probes the `/status` endpoint of every service.
 *
 * `fetchImpl` and `now` are injectable so the behaviour can be tested without
 * a network or a clock.
 */
export async function probeServices({
  services = SERVICES,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  return Promise.all(services.map(async (service) => {
    const startedAt = Date.now();
    const url = statusUrlFor(service, env);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return mapProbeResult(service, {
        httpStatus: response.status,
        body,
        latencyMs: Date.now() - startedAt,
        checkedAt: now().toISOString(),
      });
    } catch (error) {
      return mapProbeResult(service, {
        error: error?.message ?? String(error),
        latencyMs: Date.now() - startedAt,
        checkedAt: now().toISOString(),
      });
    }
  }));
}

/** The UTC day (`YYYY-MM-DD`) a timestamp belongs to. */
export function dayOf(timestamp) {
  return String(timestamp).slice(0, 10);
}

/**
 * Folds today's samples into the daily availability history.
 *
 * A day keeps the worst status seen on it, so a short blip stays visible in
 * the history even after the service recovers.
 */
export function mergeAvailability(previousDays = [], samples = [], { historyDays = HISTORY_DAYS, generatedAt = new Date().toISOString() } = {}) {
  const today = dayOf(generatedAt);
  const cutoff = dayOf(new Date(Date.parse(generatedAt) - (historyDays - 1) * 86_400_000).toISOString());
  const days = (previousDays ?? [])
    .filter((day) => day.date >= cutoff && day.date <= today)
    .map((day) => ({ date: day.date, status: day.status }));

  const todaySamples = samples.filter((sample) => dayOf(sample.checkedAt) === today);
  const existing = days.find((day) => day.date === today);
  if (existing) {
    // A day keeps the worst status seen on it; a day without a probe keeps what it had.
    if (todaySamples.length) {
      existing.status = worstStatus([existing.status, ...todaySamples.map((sample) => sample.status)]);
    }
  } else if (todaySamples.length) {
    days.push({ date: today, status: worstStatus(todaySamples.map((sample) => sample.status)) });
  }

  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Builds the next status document from the previous one and fresh samples.
 *
 * `since` is the moment the current status started, so the page can say how
 * long a service has been healthy (or broken).
 */
export function buildStatusDocument(previous, samples = [], {
  generatedAt = new Date().toISOString(),
  historyDays = HISTORY_DAYS,
  services = SERVICES,
  env = process.env,
} = {}) {
  const previousServices = previous?.services ?? [];
  const previousAvailability = previous?.availability ?? {};

  const documented = services.map((service) => {
    const sample = samples.find((entry) => entry.id === service.id);
    const before = previousServices.find((entry) => entry.id === service.id);
    const status = sample?.status ?? before?.status ?? STATUS_UNKNOWN;
    const since = sample && sample.status !== before?.status
      ? sample.checkedAt
      : before?.since ?? sample?.checkedAt ?? generatedAt;

    return {
      id: service.id,
      name: service.name,
      description: service.description,
      status,
      since,
      detail: sample?.detail ?? before?.detail ?? 'No health check has run yet.',
      checks: sample?.checks ?? before?.checks ?? {},
      latencyMs: sample?.latencyMs ?? null,
      endpoint: statusUrlFor(service, env),
    };
  });

  const availability = {};
  for (const service of services) {
    availability[service.id] = mergeAvailability(
      previousAvailability[service.id] ?? [],
      samples.filter((sample) => sample.id === service.id),
      { historyDays, generatedAt },
    );
  }

  return { version: 1, generatedAt, services: documented, availability };
}

/**
 * The part of a document that decides whether the page has to be republished.
 *
 * Volatile fields (latency, check details) are left out on purpose: they
 * change on every probe and would publish a new page every few minutes.
 */
export function statusFingerprint(document) {
  const services = (document?.services ?? []).map((service) => [service.id, service.status, service.since]);
  const availability = {};
  for (const [id, days] of Object.entries(document?.availability ?? {})) {
    availability[id] = (days ?? []).map((day) => [day.date, day.status]);
  }
  return JSON.stringify({ services, availability: Object.fromEntries(Object.entries(availability).sort()) });
}

/**
 * Whether the page has to be rewritten.
 *
 * A status change, a new day or an incident-free heartbeat refresh publishes;
 * an unchanged status does not, so the repository does not collect a commit
 * every few minutes.
 */
export function shouldPublish(previous, next, { now = Date.now(), heartbeatMs = HEARTBEAT_MS } = {}) {
  if (!previous) return true;
  if (statusFingerprint(previous) !== statusFingerprint(next)) return true;
  const generatedAt = Date.parse(previous.generatedAt ?? '');
  if (!Number.isFinite(generatedAt)) return true;
  return now - generatedAt >= heartbeatMs;
}

/** The overall status of the page: the worst status of all services. */
export function overallStatus(document) {
  return worstStatus((document?.services ?? []).map((service) => service.status));
}

/** Active incidents (anything that is not resolved yet). */
export function activeIncidents(incidents = []) {
  return (Array.isArray(incidents) ? incidents : [])
    .filter((incident) => incident && incident.status !== 'resolved')
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
}

/** Resolved incidents, newest first. */
export function resolvedIncidents(incidents = []) {
  return (Array.isArray(incidents) ? incidents : [])
    .filter((incident) => incident?.status === 'resolved')
    .sort((a, b) => String(b.resolvedAt ?? '').localeCompare(String(a.resolvedAt ?? '')));
}

/** The newest note of an incident. */
export function latestNote(incident) {
  const updates = (incident?.updates ?? []).filter((update) => update?.note);
  if (!updates.length) return incident?.impact ?? '';
  return updates[updates.length - 1].note;
}

/** The incident that covers a service right now, if there is one. */
export function incidentForService(incidents = [], serviceId) {
  return activeIncidents(incidents).find(
    (incident) => incident.service === serviceId || incident.service === 'all',
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_LABELS = {
  [STATUS_OPERATIONAL]: 'Operational',
  [STATUS_DEGRADED]: 'Degraded',
  [STATUS_OUTAGE]: 'Outage',
  [STATUS_UNKNOWN]: 'Unknown',
};

const OVERALL_MESSAGES = {
  [STATUS_OPERATIONAL]: 'All systems operational',
  [STATUS_DEGRADED]: 'Partial outage',
  [STATUS_OUTAGE]: 'Major outage',
  [STATUS_UNKNOWN]: 'Status unknown',
};

function formatTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) return 'never';
  return new Date(parsed).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatDuration(from, to) {
  const start = Date.parse(from ?? '');
  const end = Date.parse(to ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unknown';
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const STYLES = `
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #3b82f6;
      --ok: #22c55e;
      --degraded: #f59e0b;
      --outage: #ef4444;
      --unknown: #6b7280;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2.5rem 1.25rem 4rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    main { max-width: 880px; margin: 0 auto; }
    h1 { font-size: 2rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
    h2 { font-size: 1.25rem; margin: 2.5rem 0 1rem; }
    .subtitle { color: var(--text-muted); margin: 0 0 2rem; }
    .banner {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem 1.5rem;
      background: var(--card-bg);
      font-size: 1.25rem;
      font-weight: 600;
    }
    .dot { width: 0.85rem; height: 0.85rem; border-radius: 50%; flex: 0 0 auto; }
    .dot-operational { background: var(--ok); }
    .dot-degraded { background: var(--degraded); }
    .dot-outage { background: var(--outage); }
    .dot-unknown { background: var(--unknown); }
    .meta { color: var(--text-muted); font-size: 0.9rem; margin-top: 0.75rem; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem 1.5rem;
      margin-bottom: 1rem;
    }
    .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
    .card h3 { margin: 0; font-size: 1.1rem; }
    .pill {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      white-space: nowrap;
    }
    .pill-operational { background: rgba(34, 197, 94, 0.15); color: var(--ok); }
    .pill-degraded { background: rgba(245, 158, 11, 0.15); color: var(--degraded); }
    .pill-outage { background: rgba(239, 68, 68, 0.15); color: var(--outage); }
    .pill-unknown { background: rgba(107, 114, 128, 0.2); color: var(--text-muted); }
    .detail { color: var(--text-muted); margin: 0.6rem 0 0; font-size: 0.95rem; }
    dl.checks { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 1rem 0 0; font-size: 0.9rem; }
    dl.checks dt { color: var(--text-muted); }
    dl.checks dd { margin: 0; }
    .check-ok { color: var(--ok); }
    .check-failed { color: var(--outage); }
    .bars { display: flex; gap: 3px; align-items: flex-end; margin-top: 0.75rem; }
    .bar { flex: 1 1 0; height: 2.25rem; border-radius: 2px; background: var(--border); }
    .bar-operational { background: var(--ok); }
    .bar-degraded { background: var(--degraded); }
    .bar-outage { background: var(--outage); }
    .bar-unknown { background: var(--unknown); }
    .legend { display: flex; gap: 1.25rem; flex-wrap: wrap; color: var(--text-muted); font-size: 0.85rem; margin-top: 0.75rem; }
    .legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
    .incident { border-left: 3px solid var(--degraded); padding-left: 1rem; }
    .incident h3 { margin: 0 0 0.35rem; font-size: 1.05rem; }
    .incident .meta { margin: 0 0 0.5rem; }
    .incident p { margin: 0.25rem 0 0; }
    .empty { color: var(--text-muted); font-size: 0.95rem; }
    a { color: var(--accent); }
    footer { margin-top: 3rem; color: var(--text-muted); font-size: 0.85rem; }
`;

/**
 * Renders the public status page.
 *
 * The render is a pure function of the status document and the incident notes,
 * so the committed page and a freshly rendered one always agree.
 */
export function renderStatusPage({ document, incidents = [] }) {
  const overall = overallStatus(document);
  const generatedAt = document?.generatedAt ?? new Date().toISOString();
  const services = document?.services ?? [];
  const availability = document?.availability ?? {};
  const active = activeIncidents(incidents);
  const resolved = resolvedIncidents(incidents);

  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('  <meta charset="UTF-8">');
  parts.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push('  <title>Accord Protocol — Status</title>');
  parts.push(`  <meta name="description" content="Live status of the Accord Protocol indexer and analytics API.">`);
  parts.push(`  <style>${STYLES}  </style>`);
  parts.push('</head>');
  parts.push('<body>');
  parts.push('<main>');
  parts.push('  <h1>Accord Protocol status</h1>');
  parts.push('  <p class="subtitle">Availability of the indexer and the analytics API.</p>');

  parts.push(`  <div class="banner">`);
  parts.push(`    <span class="dot dot-${escapeHtml(overall)}"></span>`);
  parts.push(`    <span>${escapeHtml(OVERALL_MESSAGES[overall] ?? STATUS_UNKNOWN)}</span>`);
  parts.push('  </div>');
  parts.push(`  <p class="meta">Last updated: ${escapeHtml(formatTimestamp(generatedAt))}</p>`);
  if (overall === STATUS_UNKNOWN) {
    parts.push('  <p class="meta">No health check has completed yet; the page is refreshed as soon as the first one runs.</p>');
  }

  parts.push('  <h2>Services</h2>');
  for (const service of services) {
    const status = STATUSES.includes(service.status) ? service.status : STATUS_UNKNOWN;
    const incident = incidentForService(incidents, service.id);
    parts.push('  <section class="card">');
    parts.push('    <div class="card-head">');
    parts.push(`      <h3>${escapeHtml(service.name)}</h3>`);
    parts.push(`      <span class="pill pill-${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status])}</span>`);
    parts.push('    </div>');
    parts.push(`    <p class="detail">${escapeHtml(service.description ?? '')}</p>`);
    parts.push(`    <p class="detail">${escapeHtml(service.detail ?? '')}</p>`);

    const checks = Object.entries(service.checks ?? {});
    if (checks.length) {
      parts.push('    <dl class="checks">');
      for (const [name, check] of checks) {
        parts.push(`      <dt>${escapeHtml(name)}</dt>`);
        parts.push(`      <dd class="check-${check.ok ? 'ok' : 'failed'}">${check.ok ? 'ok' : escapeHtml(check.detail ?? 'failing')}</dd>`);
      }
      parts.push('    </dl>');
    }

    parts.push('    <p class="meta">');
    parts.push(`      Status since ${escapeHtml(formatTimestamp(service.since))} (${escapeHtml(formatDuration(service.since, generatedAt))})`);
    if (service.latencyMs !== null && service.latencyMs !== undefined) {
      parts.push(` · Health check answered in ${escapeHtml(service.latencyMs)} ms`);
    }
    if (service.endpoint && !/localhost|127\.0\.0\.1/.test(service.endpoint)) {
      parts.push(` · <a href="${escapeHtml(service.endpoint)}">live status endpoint</a>`);
    }
    parts.push('    </p>');

    if (status === STATUS_DEGRADED || status === STATUS_OUTAGE) {
      if (incident) {
        parts.push(`    <p class="detail incident"><strong>${escapeHtml(incident.title ?? 'Incident')}</strong>: ${escapeHtml(latestNote(incident))}</p>`);
      } else {
        const what = status === STATUS_OUTAGE ? 'outage' : 'degradation';
        parts.push(`    <p class="detail">No incident has been filed for this ${what} yet.</p>`);
      }
    }
    parts.push('  </section>');
  }

  parts.push('  <h2>Recent availability</h2>');
  for (const service of services) {
    const days = availability[service.id] ?? [];
    const byDate = new Map(days.map((day) => [day.date, day.status]));
    const end = Date.parse(generatedAt);
    const window = [];
    for (let offset = HISTORY_DAYS - 1; offset >= 0; offset -= 1) {
      const date = new Date(end - offset * 86_400_000).toISOString().slice(0, 10);
      window.push({ date, status: byDate.get(date) ?? null });
    }
    const affected = window.filter((day) => day.status === STATUS_DEGRADED || day.status === STATUS_OUTAGE).length;
    const recorded = window.filter((day) => day.status).length;

    parts.push('  <section class="card">');
    parts.push(`    <div class="card-head">`);
    parts.push(`      <h3>${escapeHtml(service.name)}</h3>`);
    const availabilityLabel = !recorded
      ? 'No availability data yet'
      : affected
        ? `${affected} of the last ${HISTORY_DAYS} days affected`
        : `Healthy for the last ${HISTORY_DAYS} days`;
    const availabilityStatus = !recorded ? STATUS_UNKNOWN : affected ? STATUS_DEGRADED : STATUS_OPERATIONAL;
    parts.push(`      <span class="pill pill-${escapeHtml(availabilityStatus)}">${escapeHtml(availabilityLabel)}</span>`);
    parts.push('    </div>');
    parts.push('    <div class="bars">');
    for (const day of window) {
      const status = day.status ?? STATUS_UNKNOWN;
      const label = day.status ? STATUS_LABELS[status] : 'no data';
      parts.push(`      <span class="bar bar-${escapeHtml(status)}" title="${escapeHtml(day.date)}: ${escapeHtml(label)}"></span>`);
    }
    parts.push('    </div>');
    parts.push('    <div class="legend">');
    parts.push(`      <span><span class="dot dot-operational"></span>Operational</span>`);
    parts.push(`      <span><span class="dot dot-degraded"></span>Degraded</span>`);
    parts.push(`      <span><span class="dot dot-outage"></span>Outage</span>`);
    parts.push(`      <span><span class="dot dot-unknown"></span>No data</span>`);
    parts.push('    </div>');
    parts.push('  </section>');
  }

  parts.push('  <h2>Incidents</h2>');
  if (!active.length && !resolved.length) {
    parts.push('  <p class="empty">No incidents have been reported.</p>');
  }
  for (const incident of active) {
    parts.push('  <section class="card incident">');
    parts.push(`    <h3>${escapeHtml(incident.title ?? 'Incident')}</h3>`);
    parts.push(`    <p class="meta">${escapeHtml(incident.service ?? 'all')} · started ${escapeHtml(formatTimestamp(incident.startedAt))} · ${escapeHtml(incident.status ?? 'investigating')}</p>`);
    parts.push(`    <p>${escapeHtml(latestNote(incident))}</p>`);
    parts.push('  </section>');
  }
  for (const incident of resolved.slice(0, 5)) {
    parts.push('  <section class="card">');
    parts.push(`    <h3>${escapeHtml(incident.title ?? 'Incident')} <span class="pill pill-operational">Resolved</span></h3>`);
    parts.push(`    <p class="meta">${escapeHtml(incident.service ?? 'all')} · ${escapeHtml(formatTimestamp(incident.startedAt))} → ${escapeHtml(formatTimestamp(incident.resolvedAt))}</p>`);
    parts.push(`    <p>${escapeHtml(latestNote(incident))}</p>`);
    parts.push('  </section>');
  }

  parts.push('  <footer>');
  parts.push('    Health checks run every 15 minutes and update this page automatically.');
  parts.push('    Incident notes are maintained in <code>docs/status/incidents.json</code>; see <code>docs/STATUS.md</code> and <code>docs/INCIDENT_RESPONSE.md</code>.');
  parts.push('  </footer>');
  parts.push('</main>');
  parts.push('</body>');
  parts.push('</html>');

  return parts.join('\n') + '\n';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (const arg of rest) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) opts[match[1]] = match[2] ?? true;
  }
  return { cmd, opts };
}

export async function main(argv, { env = process.env, fetchImpl = fetch } = {}) {
  const { cmd, opts } = parseArgs(argv);
  const outDir = typeof opts['out-dir'] === 'string' ? opts['out-dir'] : DEFAULT_OUT_DIR;
  const statusFile = path.join(outDir, STATUS_FILE);
  const incidentsFile = path.join(outDir, INCIDENTS_FILE);
  const pageFile = typeof opts.out === 'string' ? opts.out : path.join(outDir, PAGE_FILE);

  if (cmd === 'probe') {
    const samples = await probeServices({ env, fetchImpl });
    const previous = readJson(statusFile, null);
    const generatedAt = samples[0]?.checkedAt ?? new Date().toISOString();
    const document = buildStatusDocument(previous, samples, { generatedAt, env });

    for (const sample of samples) {
      console.log(`${sample.id}: ${sample.status} (${sample.detail})`);
    }

    const incidents = readJson(incidentsFile, { incidents: [] });
    const incidentList = incidents.incidents ?? [];
    const previousPage = readTextIfExists(pageFile);
    // A hand written incident note has to reach the page even when the health
    // of the services did not change.
    const incidentsChanged = previousPage !== null
      && renderStatusPage({ document: previous ?? document, incidents: incidentList }) !== previousPage;

    if (!shouldPublish(previous, document) && !incidentsChanged) {
      console.log('Status is unchanged; the published page stays as it is.');
      return 0;
    }

    const page = renderStatusPage({ document, incidents: incidentList });
    if (opts['dry-run']) {
      console.log('Dry run: the status document and the page were not written.');
      return 0;
    }
    writeFile(statusFile, JSON.stringify(document, null, 2) + '\n');
    writeFile(pageFile, page);
    console.log(`Published the status page to ${pageFile}`);
    return 0;
  }

  if (cmd === 'render') {
    const document = readJson(statusFile, null);
    if (!document) throw new Error(`${statusFile} is missing; run "probe" first`);
    const incidents = readJson(incidentsFile, { incidents: [] });
    const page = renderStatusPage({ document, incidents: incidents.incidents ?? [] });
    writeFile(pageFile, page);
    console.log(`Rendered the status page to ${pageFile}`);
    return 0;
  }

  console.error('Usage: node scripts/status-page.mjs <probe|render> [--out-dir=<dir>] [--out=<file>] [--dry-run]');
  return cmd === '--help' || cmd === '-h' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
