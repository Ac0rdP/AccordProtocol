#!/usr/bin/env node

/**
 * flaky-tests.mjs — test-flakiness tracking, dashboard and quarantine checks.
 *
 * Usage:
 *   node scripts/flaky-tests.mjs record --results=<file> [--run=<id>] [--date=<iso>] [--history=<file>]
 *   node scripts/flaky-tests.mjs report [--history=<file>] [--quarantine=<file>] [--format=md|json] [--out=<file>]
 *   node scripts/flaky-tests.mjs check  [--quarantine=<file>] [--history=<file>]
 *
 * `--results` accepts a JUnit XML file or a JSON array of { name, status }
 * where status is "passed" | "failed" | "skipped".
 * See "Flaky tests and quarantine" in CONTRIBUTING.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HISTORY = 'data/test-history.json';
export const DEFAULT_QUARANTINE = 'quarantine.json';
/** Max runs kept per test, so the history file stays bounded. */
export const MAX_RUNS_PER_TEST = 200;
/** A test needs at least this many runs, with both outcomes, to be flaky. */
export const MIN_RUNS = 5;
/** Flip rate (pass/fail transitions per adjacent run pair) at/above which a test is flaky. */
export const FLAKY_THRESHOLD = 0.1;
/** Days a quarantine may last before `check` fails. */
export const MAX_QUARANTINE_DAYS = 30;

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse JUnit XML into [{ name, status }]. */
export function parseJunit(xml) {
  const out = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[3] || '';
    const name = /\bname="([^"]*)"/.exec(attrs);
    if (!name) continue;
    const cls = /\bclassname="([^"]*)"/.exec(attrs);
    const full = decodeXml(cls && cls[1] ? `${cls[1]}::${name[1]}` : name[1]);
    let status = 'passed';
    if (/<(failure|error)\b/.test(body)) status = 'failed';
    else if (/<skipped\b/.test(body)) status = 'skipped';
    out.push({ name: full, status });
  }
  return out;
}

export function parseResults(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) return parseJunit(trimmed);
  const data = JSON.parse(trimmed);
  if (!Array.isArray(data)) throw new Error('results JSON must be an array');
  return data.map((r) => ({ name: String(r.name), status: String(r.status) }));
}

export function emptyHistory() {
  return { version: 1, tests: {} };
}

/** Append one run's results to the history. Skipped tests are ignored. */
export function recordRun(history, results, { run, date }) {
  const when = date || new Date().toISOString();
  for (const r of results) {
    if (r.status !== 'passed' && r.status !== 'failed') continue;
    const runs = (history.tests[r.name] ||= []);
    if (run && runs.some((x) => x.run === run)) continue; // idempotent per run id
    runs.push({ run: run || null, date: when, status: r.status });
    if (runs.length > MAX_RUNS_PER_TEST) runs.splice(0, runs.length - MAX_RUNS_PER_TEST);
  }
  return history;
}

/** Compute stats for one test's run list (oldest first). */
export function analyzeTest(runs) {
  const total = runs.length;
  const failures = runs.filter((r) => r.status === 'failed').length;
  let flips = 0;
  for (let i = 1; i < total; i++) if (runs[i].status !== runs[i - 1].status) flips++;
  const flipRate = total > 1 ? flips / (total - 1) : 0;
  const mixed = failures > 0 && failures < total;
  return {
    total,
    failures,
    failRate: total ? failures / total : 0,
    flips,
    flipRate,
    flaky: total >= MIN_RUNS && mixed && flipRate >= FLAKY_THRESHOLD,
  };
}

export function rankFlaky(history, limit = 20) {
  return Object.entries(history.tests)
    .map(([name, runs]) => ({ name, ...analyzeTest(runs) }))
    .filter((t) => t.flaky)
    .sort((a, b) => b.flipRate - a.flipRate || b.failures - a.failures || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** UTC date (YYYY-MM-DD) of the Monday starting the week of `iso`. */
export function weekStart(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Weekly trend: executions, failure rate, and number of distinct tests that flipped. */
export function weeklyTrend(history) {
  const weeks = new Map();
  for (const [name, runs] of Object.entries(history.tests)) {
    const perWeek = new Map();
    for (const r of runs) {
      const w = weekStart(r.date);
      (perWeek.get(w) || perWeek.set(w, []).get(w)).push(r);
    }
    for (const [w, wr] of perWeek) {
      const agg = weeks.get(w) || { week: w, runs: 0, failures: 0, flakyTests: 0 };
      agg.runs += wr.length;
      agg.failures += wr.filter((r) => r.status === 'failed').length;
      const statuses = new Set(wr.map((r) => r.status));
      if (wr.length >= 2 && statuses.size > 1) agg.flakyTests++;
      weeks.set(w, agg);
    }
  }
  return [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => ({ ...w, failRate: w.runs ? w.failures / w.runs : 0 }));
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

/** Validate quarantine entries; returns a list of problem strings. */
export function validateQuarantine(quarantine, now = new Date()) {
  const problems = [];
  const seen = new Set();
  for (const e of quarantine.tests || []) {
    const label = e.name || '(unnamed)';
    if (!e.name) problems.push('entry without a name');
    if (seen.has(e.name)) problems.push(`${label}: duplicate entry`);
    seen.add(e.name);
    if (e.status === 'fixed') {
      if (!e.fixedIn) problems.push(`${label}: fixed entries need "fixedIn" (PR or commit)`);
      continue;
    }
    if (!e.issue) problems.push(`${label}: missing tracking "issue"`);
    if (!e.owner) problems.push(`${label}: missing "owner"`);
    if (!e.since || Number.isNaN(Date.parse(e.since))) problems.push(`${label}: missing/invalid "since"`);
    else if ((now - Date.parse(e.since)) / 86400000 > MAX_QUARANTINE_DAYS) {
      problems.push(`${label}: quarantined over ${MAX_QUARANTINE_DAYS} days — fix it or escalate`);
    }
  }
  return problems;
}

export function buildReport(history, quarantine, now = new Date()) {
  const flaky = rankFlaky(history);
  const entries = quarantine.tests || [];
  const active = entries.filter((e) => e.status !== 'fixed');
  const fixed = entries.filter((e) => e.status === 'fixed');
  const unquarantined = flaky.filter((t) => !entries.some((e) => e.name === t.name && e.status !== 'fixed'));
  return {
    generated: now.toISOString(),
    flaky,
    unquarantined,
    quarantined: active.map((e) => ({
      ...e,
      ageDays: e.since ? Math.floor((now - Date.parse(e.since)) / 86400000) : null,
      stats: history.tests[e.name] ? analyzeTest(history.tests[e.name]) : null,
    })),
    resolved: fixed,
    trend: weeklyTrend(history),
    problems: validateQuarantine(quarantine, now),
  };
}

export function renderMarkdown(r) {
  const L = [];
  L.push('# Test flakiness dashboard', '', `_Generated ${r.generated}_`, '');
  L.push('## Flakiest tests', '');
  if (!r.flaky.length) L.push('No flaky tests detected.', '');
  else {
    L.push('| Test | Runs | Failures | Fail rate | Flip rate | Quarantined |', '|---|---|---|---|---|---|');
    for (const t of r.flaky) {
      const q = r.unquarantined.includes(t) ? 'no' : 'yes';
      L.push(`| \`${t.name}\` | ${t.total} | ${t.failures} | ${pct(t.failRate)} | ${pct(t.flipRate)} | ${q} |`);
    }
    L.push('');
  }
  if (r.unquarantined.length) {
    L.push(`**${r.unquarantined.length} flaky test(s) are not quarantined** — follow the quarantine process in CONTRIBUTING.md.`, '');
  }
  L.push('## Quarantined tests', '');
  if (!r.quarantined.length) L.push('None.', '');
  else {
    L.push('| Test | Issue | Owner | Since | Age (days) |', '|---|---|---|---|---|');
    for (const e of r.quarantined) {
      L.push(`| \`${e.name}\` | ${e.issue || '—'} | ${e.owner || '—'} | ${e.since || '—'} | ${e.ageDays ?? '—'} |`);
    }
    L.push('');
  }
  L.push('## Resolved', '');
  if (!r.resolved.length) L.push('None yet.', '');
  else {
    L.push('| Test | Issue | Fixed in |', '|---|---|---|');
    for (const e of r.resolved) L.push(`| \`${e.name}\` | ${e.issue || '—'} | ${e.fixedIn || '—'} |`);
    L.push('');
  }
  L.push('## Weekly trend', '');
  if (!r.trend.length) L.push('No history recorded.', '');
  else {
    L.push('| Week of | Test runs | Failure rate | Tests that flipped |', '|---|---|---|---|');
    for (const w of r.trend) L.push(`| ${w.week} | ${w.runs} | ${pct(w.failRate)} | ${w.flakyTests} |`);
    L.push('');
  }
  if (r.problems.length) {
    L.push('## Quarantine problems', '', ...r.problems.map((p) => `- ${p}`), '');
  }
  return L.join('\n');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (const a of rest) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1]] = m[2] ?? true;
  }
  return { cmd, opts };
}

export function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  const historyFile = opts.history || DEFAULT_HISTORY;
  const quarantineFile = opts.quarantine || DEFAULT_QUARANTINE;

  if (cmd === 'record') {
    if (!opts.results || opts.results === true) throw new Error('--results=<file> is required');
    const results = parseResults(fs.readFileSync(opts.results, 'utf8'));
    const history = recordRun(readJson(historyFile, emptyHistory()), results, {
      run: opts.run || process.env.GITHUB_RUN_ID,
      date: opts.date,
    });
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');
    console.log(`Recorded ${results.length} results into ${historyFile}`);
    return 0;
  }

  if (cmd === 'report' || cmd === 'check') {
    const history = readJson(historyFile, emptyHistory());
    const quarantine = readJson(quarantineFile, { tests: [] });
    const report = buildReport(history, quarantine);
    if (cmd === 'check') {
      if (report.problems.length) {
        console.error(report.problems.map((p) => `- ${p}`).join('\n'));
        return 1;
      }
      console.log('Quarantine list is valid.');
      return 0;
    }
    const out = opts.format === 'json' ? JSON.stringify(report, null, 2) : renderMarkdown(report);
    if (opts.out && opts.out !== true) fs.writeFileSync(opts.out, out + '\n');
    else console.log(out);
    return 0;
  }

  console.error('Usage: node scripts/flaky-tests.mjs <record|report|check> [options]');
  return cmd === '--help' || cmd === '-h' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
