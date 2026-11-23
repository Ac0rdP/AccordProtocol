import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJunit,
  parseResults,
  emptyHistory,
  recordRun,
  analyzeTest,
  rankFlaky,
  weeklyTrend,
  weekStart,
  validateQuarantine,
  buildReport,
  renderMarkdown,
} from './flaky-tests.mjs';

const runs = (statuses) =>
  statuses.map((s, i) => ({ run: String(i), date: `2026-10-0${i + 1}T00:00:00Z`, status: s }));

test('parseJunit maps failures, skips and classnames', () => {
  const xml = `<testsuite>
    <testcase classname="a" name="ok"/>
    <testcase classname="a" name="bad"><failure message="x"/></testcase>
    <testcase name="skip &amp; go"><skipped/></testcase></testsuite>`;
  assert.deepEqual(parseJunit(xml), [
    { name: 'a::ok', status: 'passed' },
    { name: 'a::bad', status: 'failed' },
    { name: 'skip & go', status: 'skipped' },
  ]);
});

test('parseResults accepts JSON', () => {
  assert.deepEqual(parseResults('[{"name":"t","status":"passed"}]'), [{ name: 't', status: 'passed' }]);
});

test('recordRun is idempotent per run id and ignores skipped', () => {
  const h = emptyHistory();
  const res = [
    { name: 't', status: 'passed' },
    { name: 's', status: 'skipped' },
  ];
  recordRun(h, res, { run: '1', date: '2026-10-01T00:00:00Z' });
  recordRun(h, res, { run: '1', date: '2026-10-01T00:00:00Z' });
  assert.equal(h.tests.t.length, 1);
  assert.equal(h.tests.s, undefined);
});

test('analyzeTest separates flaky from consistently failing', () => {
  assert.equal(analyzeTest(runs(['passed', 'failed', 'passed', 'passed', 'failed'])).flaky, true);
  assert.equal(analyzeTest(runs(['failed', 'failed', 'failed', 'failed', 'failed'])).flaky, false);
  assert.equal(analyzeTest(runs(['passed', 'passed', 'passed', 'passed', 'passed'])).flaky, false);
  assert.equal(analyzeTest(runs(['passed', 'failed'])).flaky, false); // too few runs
});

test('rankFlaky orders by flip rate', () => {
  const h = {
    tests: {
      mild: runs(['passed', 'passed', 'passed', 'failed', 'failed', 'failed']),
      bad: runs(['passed', 'failed', 'passed', 'failed', 'passed', 'failed']),
    },
  };
  assert.deepEqual(rankFlaky(h).map((t) => t.name), ['bad', 'mild']);
});

test('weekStart and weeklyTrend group by Monday', () => {
  assert.equal(weekStart('2026-10-21T12:00:00Z'), '2026-10-19');
  const h = { tests: { t: runs(['passed', 'failed']) } };
  const trend = weeklyTrend(h);
  assert.equal(trend.reduce((n, w) => n + w.runs, 0), 2);
});

test('validateQuarantine enforces issue, owner, age and fix reference', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const problems = validateQuarantine(
    {
      tests: [
        { name: 'a', status: 'quarantined', issue: '#1', owner: 'x', since: '2026-10-10' },
        { name: 'b', status: 'quarantined', since: '2026-10-10' },
        { name: 'c', status: 'quarantined', issue: '#2', owner: 'x', since: '2026-01-01' },
        { name: 'd', status: 'fixed' },
      ],
    },
    now,
  );
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.startsWith('b:') && p.includes('issue')));
  assert.ok(problems.some((p) => p.startsWith('c:') && p.includes('days')));
  assert.ok(problems.some((p) => p.startsWith('d:')));
});

test('report flags unquarantined flaky tests and renders markdown', () => {
  const h = { tests: { t: runs(['passed', 'failed', 'passed', 'failed', 'passed']) } };
  const r = buildReport(h, { tests: [] }, new Date('2026-10-20T00:00:00Z'));
  assert.equal(r.unquarantined.length, 1);
  const md = renderMarkdown(r);
  assert.match(md, /Flakiest tests/);
  assert.match(md, /not quarantined/);
});
