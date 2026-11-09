import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { acceptUpdate } from '../../src/intake.ts';
import { createMetrics } from '../../src/metrics.ts';
import { createPortalClient } from '../../src/portal-client.ts';
import { createPgPauseStore } from '../../src/pause-store.ts';
import { startWorkers, type Workers } from '../../src/worker.ts';
import { freshDb } from '../support/db.ts';
import { startFakePortal, type FakePortal } from '../support/fake-portal.ts';
import { sample } from '../support/prom.ts';
import { waitFor } from '../support/wait.ts';

let pool: pg.Pool;
let portal: FakePortal;
let server: Server;
let base: string;
let workers: Workers | undefined;
let metrics: ReturnType<typeof createMetrics>;

beforeAll(async () => { pool = await freshDb(); portal = await startFakePortal(); });
afterAll(async () => { await portal.stop(); await pool.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE updates, desired_days RESTART IDENTITY');
  await pool.query('UPDATE portal_state SET paused_until = NULL');
  portal.requests.length = 0;
  metrics = createMetrics(pool);
  server = createApp({ pool, metrics }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await workers?.stop();
  workers = undefined;
  server.close();
  portal.always('acc-bad', null);
});

const upd = (id: string, from: string, to: string, price = 100) =>
  acceptUpdate(pool, { accommodationId: id, from, to, available: true, pricePerNight: price });
const scrape = async () => (await fetch(`${base}/metrics`)).text();
const getStatus = async (id: string) => (await fetch(`${base}/accommodations/${id}/sync-status`)).json();

async function start(backoffBaseMs: number) {
  const client = createPortalClient({
    url: portal.url, apiKey: 'sol-demo-key', timeoutMs: 2000, maxRequestsPerMinute: 6000,
    pauseStore: createPgPauseStore(pool), onResult: metrics.onPortalResult,
  });
  await client.start();
  workers = startWorkers({ pool, portal: client, concurrency: 2, pollIntervalMs: 20, backoffBaseMs, onRetry: metrics.onRetry });
}

describe('GET /metrics (SPEC §13.1, AC10)', () => {
  it('serves Prometheus text with the six metrics', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-01');
    // One portal call and one retry so the labelled series exist.
    metrics.onPortalResult('PUT', 'ok', 0.2);
    metrics.onRetry('503');
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    for (const name of ['sync_pending_days', 'sync_oldest_pending_age_seconds', 'portal_requests_total',
      'portal_request_duration_seconds', 'sync_retries_total', 'sync_failed_days']) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  it('gauges are read from PostgreSQL at scrape time (correct without any worker running)', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-03');
    await upd('acc-2', '2026-10-01', '2026-10-02');
    await pool.query(`UPDATE desired_days SET failed_at = now() WHERE accommodation_id = 'acc-2'`);
    await pool.query(`UPDATE desired_days SET changed_at = now() - interval '100 seconds' WHERE accommodation_id = 'acc-1' AND date = '2026-10-01'`);
    const text = await scrape();
    expect(sample(text, 'sync_pending_days')).toBe(3); // failed days are not pending
    expect(sample(text, 'sync_failed_days')).toBe(2);
    const age = sample(text, 'sync_oldest_pending_age_seconds')!;
    expect(age).toBeGreaterThanOrEqual(99);
    expect(age).toBeLessThan(110);
  });

  it('oldest pending age is 0 when nothing is pending', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-03');
    await pool.query('UPDATE desired_days SET synced_version = version');
    const text = await scrape();
    expect(sample(text, 'sync_pending_days')).toBe(0);
    expect(sample(text, 'sync_oldest_pending_age_seconds')).toBe(0);
  });
});

describe('test 8: 503, 503, 429 then 200 shows up in /metrics and sync-status (SPEC §16)', () => {
  it('counts exactly what happened and shows pending → synced', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-02');
    portal.queue({ status: 503 }, { status: 503 }, { status: 429, retryAfter: 1 });
    await start(300);

    // While retrying: pending, with the last error and the next attempt.
    const retrying = await waitFor(async () => {
      const s = await getStatus('acc-1');
      return s.state === 'pending' && s.lastError ? s : false;
    }, 5000, 'pending with lastError');
    expect(retrying.lastError.code).toBe('UNAVAILABLE');
    expect(Date.parse(retrying.nextAttemptAt)).not.toBeNaN();

    await waitFor(async () => (await getStatus('acc-1')).state === 'synced', 15_000, 'synced');
    const text = await scrape();
    expect(sample(text, 'portal_requests_total', { method: 'PUT', outcome: '503' })).toBe(2);
    expect(sample(text, 'portal_requests_total', { method: 'PUT', outcome: '429' })).toBe(1);
    expect(sample(text, 'portal_requests_total', { method: 'PUT', outcome: 'ok' })).toBe(1);
    expect(sample(text, 'sync_retries_total', { reason: '503' })).toBe(2);
    expect(sample(text, 'portal_request_duration_seconds_count', { method: 'PUT' })).toBe(4);
    expect(sample(text, 'sync_pending_days')).toBe(0);
    expect(sample(text, 'sync_failed_days')).toBe(0);
  });
});

describe('test 9: a 404 for one accommodation (SPEC §16)', () => {
  it('marks its days failed, counts it, keeps the other accommodation syncing, and a new POST re-arms it', async () => {
    portal.always('acc-bad', { status: 404 });
    await upd('acc-bad', '2026-10-01', '2026-10-03');
    await upd('acc-1', '2026-10-01', '2026-10-02');
    await start(20);

    await waitFor(async () => (await getStatus('acc-bad')).state === 'failed', 5000, 'acc-bad failed');
    await waitFor(async () => (await getStatus('acc-1')).state === 'synced', 5000, 'acc-1 synced');
    const bad = await getStatus('acc-bad');
    expect(bad.days.failed).toBe(3);
    expect(bad.ranges).toEqual([{ from: '2026-10-01', to: '2026-10-03', state: 'failed', errorCode: 'NOT_FOUND' }]);
    let text = await scrape();
    expect(sample(text, 'portal_requests_total', { method: 'PUT', outcome: '404' })).toBe(1);
    expect(sample(text, 'sync_failed_days')).toBe(3);

    portal.always('acc-bad', null);
    await upd('acc-bad', '2026-10-01', '2026-10-03', 150);
    await waitFor(async () => (await getStatus('acc-bad')).state === 'synced', 5000, 'acc-bad re-armed and synced');
    text = await scrape();
    expect(sample(text, 'sync_failed_days')).toBe(0);
  });
});
