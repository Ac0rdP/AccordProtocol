import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVICES,
  STATUS_DEGRADED,
  STATUS_OPERATIONAL,
  STATUS_OUTAGE,
  STATUS_UNKNOWN,
  activeIncidents,
  buildStatusDocument,
  incidentForService,
  latestNote,
  main,
  mapProbeResult,
  mergeAvailability,
  normalizeChecks,
  overallStatus,
  renderStatusPage,
  shouldPublish,
  statusFromChecks,
  statusFingerprint,
  statusUrlFor,
  worstStatus,
} from './status-page.mjs';

const indexer = SERVICES.find((service) => service.id === 'indexer');
const analytics = SERVICES.find((service) => service.id === 'analytics-api');

const indexerBody = (overrides = {}) => ({
  service: 'indexer',
  status: 'operational',
  checks: { store: { ok: true }, indexing: { ok: true } },
  updatedAt: '2026-10-22T09:00:00.000Z',
  ...overrides,
});

const analyticsBody = (overrides = {}) => ({
  service: 'analytics-api',
  status: 'operational',
  checks: { database: { ok: true }, ingestion: { ok: true } },
  updatedAt: '2026-10-22T09:00:00.000Z',
  ...overrides,
});

test('statusFromChecks reads a service that reports every check', () => {
  assert.equal(statusFromChecks({ store: { ok: true }, indexing: { ok: true } }), STATUS_OPERATIONAL);
  assert.equal(statusFromChecks({}), STATUS_UNKNOWN);
});

test('statusFromChecks calls a broken store or database an outage', () => {
  assert.equal(statusFromChecks({ store: { ok: false }, indexing: { ok: true } }), STATUS_OUTAGE);
  assert.equal(statusFromChecks({ database: { ok: false }, ingestion: { ok: true } }), STATUS_OUTAGE);
});

test('statusFromChecks calls any other failing check a degraded service', () => {
  assert.equal(statusFromChecks({ store: { ok: true }, indexing: { ok: false } }), STATUS_DEGRADED);
  assert.equal(statusFromChecks({ database: { ok: true }, ingestion: { ok: false } }), STATUS_DEGRADED);
});

test('normalizeChecks accepts objects and plain strings', () => {
  assert.deepEqual(normalizeChecks({ store: { ok: true } }), { store: { ok: true } });
  assert.deepEqual(normalizeChecks({ database: { ok: false, detail: 'down' } }), { database: { ok: false, detail: 'down' } });
  assert.deepEqual(normalizeChecks({ database: 'unavailable' }), { database: { ok: false } });
  assert.deepEqual(normalizeChecks(undefined), {});
});

test('mapProbeResult maps a healthy service to operational', () => {
  const sample = mapProbeResult(indexer, {
    httpStatus: 200,
    body: indexerBody(),
    latencyMs: 12,
    checkedAt: '2026-10-22T09:00:00.000Z',
  });

  assert.equal(sample.status, STATUS_OPERATIONAL);
  assert.equal(sample.detail, 'All checks passed.');
  assert.equal(sample.latencyMs, 12);
});

test('mapProbeResult maps a failing check to degraded and names it', () => {
  const sample = mapProbeResult(indexer, {
    httpStatus: 200,
    body: indexerBody({
      status: 'degraded',
      checks: { store: { ok: true }, indexing: { ok: false, detail: 'no successful batch in 120s' } },
    }),
  });

  assert.equal(sample.status, STATUS_DEGRADED);
  assert.match(sample.detail, /indexing: no successful batch in 120s/);
});

test('mapProbeResult maps an unreachable service to an outage', () => {
  const sample = mapProbeResult(analytics, { error: 'connection refused' });

  assert.equal(sample.status, STATUS_OUTAGE);
  assert.match(sample.detail, /did not answer: connection refused/);
});

test('mapProbeResult maps a missing status endpoint to unknown', () => {
  const sample = mapProbeResult(analytics, { httpStatus: 404, body: null });

  assert.equal(sample.status, STATUS_UNKNOWN);
  assert.match(sample.detail, /not deployed/);
});

test('mapProbeResult trusts the status a service reports', () => {
  const sample = mapProbeResult(analytics, {
    httpStatus: 503,
    body: analyticsBody({ status: 'outage', checks: { database: { ok: false, detail: 'the datastore did not answer within 2s' } } }),
  });

  assert.equal(sample.status, STATUS_OUTAGE);
  assert.match(sample.detail, /database: the datastore did not answer/);
});

test('mapProbeResult derives a status when the service does not report one', () => {
  const sample = mapProbeResult(indexer, {
    httpStatus: 200,
    body: { checks: { store: { ok: true }, indexing: { ok: false } } },
  });

  assert.equal(sample.status, STATUS_DEGRADED);
});

test('worstStatus keeps the most severe status', () => {
  assert.equal(worstStatus([STATUS_OPERATIONAL, STATUS_DEGRADED]), STATUS_DEGRADED);
  assert.equal(worstStatus([STATUS_DEGRADED, STATUS_OUTAGE]), STATUS_OUTAGE);
  assert.equal(worstStatus([]), STATUS_OPERATIONAL);
});

test('statusUrlFor appends the status path to the configured base URL', () => {
  assert.equal(statusUrlFor(indexer, { INDEXER_STATUS_URL: 'https://indexer.example.com/' }), 'https://indexer.example.com/status');
  assert.equal(statusUrlFor(analytics, {}), 'http://127.0.0.1:8080/status');
});

test('mergeAvailability keeps the worst status of the day', () => {
  const days = mergeAvailability([], [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:00:00.000Z' },
    { id: 'indexer', status: STATUS_DEGRADED, checkedAt: '2026-10-22T09:15:00.000Z' },
  ], { generatedAt: '2026-10-22T09:15:00.000Z' });

  assert.deepEqual(days, [{ date: '2026-10-22', status: STATUS_DEGRADED }]);
});

test('mergeAvailability keeps the worst status when a service recovers', () => {
  const days = mergeAvailability(
    [{ date: '2026-10-22', status: STATUS_OUTAGE }],
    [{ id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T10:00:00.000Z' }],
    { generatedAt: '2026-10-22T10:00:00.000Z' },
  );

  assert.deepEqual(days, [{ date: '2026-10-22', status: STATUS_OUTAGE }]);
});

test('mergeAvailability drops days outside the history window', () => {
  const days = mergeAvailability(
    [{ date: '2026-01-01', status: STATUS_OUTAGE }],
    [{ id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:00:00.000Z' }],
    { generatedAt: '2026-10-22T09:00:00.000Z', historyDays: 30 },
  );

  assert.deepEqual(days.map((day) => day.date), ['2026-10-22']);
});

test('buildStatusDocument keeps the start of an unchanged status', () => {
  const previous = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:00:00.000Z', checks: {}, detail: 'ok' },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const next = buildStatusDocument(previous, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:15:00.000Z', checks: {}, detail: 'ok' },
  ], { generatedAt: '2026-10-22T09:15:00.000Z' });

  const service = next.services.find((entry) => entry.id === 'indexer');
  assert.equal(service.status, STATUS_OPERATIONAL);
  assert.equal(service.since, '2026-10-22T09:00:00.000Z');
});

test('buildStatusDocument restarts the clock when the status changes', () => {
  const previous = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:00:00.000Z', checks: {}, detail: 'ok' },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const next = buildStatusDocument(previous, [
    { id: 'indexer', status: STATUS_OUTAGE, checkedAt: '2026-10-22T09:15:00.000Z', checks: {}, detail: 'down' },
  ], { generatedAt: '2026-10-22T09:15:00.000Z' });

  const service = next.services.find((entry) => entry.id === 'indexer');
  assert.equal(service.status, STATUS_OUTAGE);
  assert.equal(service.since, '2026-10-22T09:15:00.000Z');
});

test('shouldPublish publishes a changed status and keeps an unchanged one', () => {
  const document = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:00:00.000Z', checks: {}, detail: 'ok' },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const later = buildStatusDocument(document, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:15:00.000Z', checks: {}, detail: 'ok' },
  ], { generatedAt: '2026-10-22T09:15:00.000Z' });

  assert.equal(shouldPublish(document, later, { now: Date.parse('2026-10-22T09:16:00.000Z') }), false);
  assert.equal(shouldPublish(document, later, { now: Date.parse('2026-10-22T16:00:00.000Z') }), true, 'the page is refreshed on a heartbeat');

  const broken = buildStatusDocument(document, [
    { id: 'indexer', status: STATUS_OUTAGE, checkedAt: '2026-10-22T09:15:00.000Z', checks: {}, detail: 'down' },
  ], { generatedAt: '2026-10-22T09:15:00.000Z' });

  assert.equal(shouldPublish(document, broken, { now: Date.parse('2026-10-22T09:16:00.000Z') }), true);
});

test('statusFingerprint ignores the volatile fields of a document', () => {
  const document = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:00:00.000Z', checks: {}, detail: 'ok', latencyMs: 10 },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const later = buildStatusDocument(document, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:15:00.000Z', checks: {}, detail: 'ok', latencyMs: 42 },
  ], { generatedAt: '2026-10-22T09:15:00.000Z' });

  assert.equal(statusFingerprint(document), statusFingerprint(later));
});

test('overallStatus reports the worst service status', () => {
  assert.equal(overallStatus({ services: [{ status: STATUS_OPERATIONAL }, { status: STATUS_DEGRADED }] }), STATUS_DEGRADED);
  assert.equal(overallStatus({ services: [{ status: STATUS_OPERATIONAL }] }), STATUS_OPERATIONAL);
});

test('activeIncidents and incidentForService find the open incidents', () => {
  const incidents = [
    { id: 'a', service: 'indexer', title: 'Indexer outage', status: 'investigating', startedAt: '2026-10-22T09:00:00.000Z' },
    { id: 'b', service: 'analytics-api', title: 'Old', status: 'resolved', startedAt: '2026-10-01T09:00:00.000Z', resolvedAt: '2026-10-01T10:00:00.000Z' },
  ];

  assert.equal(activeIncidents(incidents).length, 1);
  assert.equal(incidentForService(incidents, 'indexer').id, 'a');
  assert.equal(incidentForService(incidents, 'analytics-api'), undefined);
});

test('latestNote returns the newest note of an incident', () => {
  assert.equal(
    latestNote({ updates: [{ note: 'first' }, { note: 'second' }] }),
    'second',
  );
  assert.equal(latestNote({ impact: 'impact only' }), 'impact only');
  assert.equal(latestNote({}), '');
});

test('renderStatusPage shows the services, their status and the availability', () => {
  const document = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OPERATIONAL, checkedAt: '2026-10-22T09:00:00.000Z', checks: { store: { ok: true } }, detail: 'All checks passed.', latencyMs: 12 },
    { id: 'analytics-api', status: STATUS_DEGRADED, checkedAt: '2026-10-22T09:00:00.000Z', checks: { database: { ok: true }, ingestion: { ok: false, detail: 'stale' } }, detail: 'ingestion: stale' },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const page = renderStatusPage({ document, incidents: [] });

  assert.match(page, /<title>Accord Protocol — Status<\/title>/);
  assert.match(page, /All systems operational|Partial outage/);
  assert.match(page, /Indexer/);
  assert.match(page, /Analytics API/);
  assert.match(page, /pill-operational/);
  assert.match(page, /pill-degraded/);
  assert.match(page, /bar-operational/);
  assert.match(page, /Recent availability/);
  assert.match(page, /Health checks run every 15 minutes/);
});

test('renderStatusPage shows the incident note of an affected service', () => {
  const document = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OUTAGE, checkedAt: '2026-10-22T09:00:00.000Z', checks: { store: { ok: false, detail: 'connection refused' } }, detail: 'the service did not answer' },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const incidents = [{
    id: 'a',
    service: 'indexer',
    title: 'Indexer outage',
    status: 'investigating',
    startedAt: '2026-10-22T08:55:00.000Z',
    updates: [{ at: '2026-10-22T08:55:00.000Z', note: 'The indexer stopped answering health checks.' }],
  }];

  const page = renderStatusPage({ document, incidents });

  assert.match(page, /Major outage/);
  assert.match(page, /The indexer stopped answering health checks\./);
});

test('renderStatusPage says when an outage has no incident note yet', () => {
  const document = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OUTAGE, checkedAt: '2026-10-22T09:00:00.000Z', checks: { store: { ok: false, detail: 'connection refused' } }, detail: 'the service did not answer' },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const page = renderStatusPage({ document, incidents: [] });

  assert.match(page, /No incident has been filed for this outage yet\./);
});

test('renderStatusPage escapes incident notes', () => {
  const document = buildStatusDocument(null, [
    { id: 'indexer', status: STATUS_OUTAGE, checkedAt: '2026-10-22T09:00:00.000Z', checks: {}, detail: 'down' },
  ], { generatedAt: '2026-10-22T09:00:00.000Z' });

  const page = renderStatusPage({
    document,
    incidents: [{ id: 'a', service: 'indexer', title: '<script>alert(1)</script>', status: 'investigating', startedAt: '2026-10-22T09:00:00.000Z', updates: [{ note: '<img src=x onerror=alert(1)>' }] }],
  });

  assert.doesNotMatch(page, /<script>/);
  assert.doesNotMatch(page, /<img src=x/);
  assert.match(page, /&lt;script&gt;/);
});

test('the committed status page matches the committed status data', () => {
  const status = JSON.parse(fs.readFileSync(new URL('../docs/status/status.json', import.meta.url), 'utf8'));
  const incidents = JSON.parse(fs.readFileSync(new URL('../docs/status/incidents.json', import.meta.url), 'utf8'));
  const committed = fs.readFileSync(new URL('../docs/status/index.html', import.meta.url), 'utf8');

  assert.equal(committed, renderStatusPage({ document: status, incidents: incidents.incidents ?? [] }));
});

test('the probe publishes the page when an incident note was added', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-page-'));
  const fetchImpl = async (url) => {
    const body = url.includes('analytics-api')
      ? analyticsBody()
      : indexerBody();
    return { ok: true, status: 200, json: async () => body };
  };
  const env = {
    INDEXER_STATUS_URL: 'http://indexer.test',
    ANALYTICS_API_STATUS_URL: 'http://analytics.test',
  };

  await main(['probe', `--out-dir=${outDir}`], { env, fetchImpl });
  const first = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.doesNotMatch(first, /Elevated error rates/);

  fs.writeFileSync(path.join(outDir, 'incidents.json'), JSON.stringify({
    incidents: [{
      id: '2026-10-22-indexer',
      service: 'indexer',
      title: 'Elevated error rates',
      status: 'investigating',
      startedAt: '2026-10-22T09:00:00.000Z',
      updates: [{ note: 'We are looking into it.' }],
    }],
  }));

  await main(['probe', `--out-dir=${outDir}`], { env, fetchImpl });
  const second = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.match(second, /Elevated error rates/);
  assert.match(second, /We are looking into it\./);
});

test('the probe keeps the page when neither the status nor the notes changed', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-page-'));
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('analytics-api') ? analyticsBody() : indexerBody()),
  });
  const env = {
    INDEXER_STATUS_URL: 'http://indexer.test',
    ANALYTICS_API_STATUS_URL: 'http://analytics.test',
  };

  await main(['probe', `--out-dir=${outDir}`], { env, fetchImpl });
  const first = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  await main(['probe', `--out-dir=${outDir}`], { env, fetchImpl });

  assert.equal(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), first);
});
