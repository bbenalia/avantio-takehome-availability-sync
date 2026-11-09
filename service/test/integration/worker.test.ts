import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptUpdate } from '../../src/intake.ts';
import { createPortalClient } from '../../src/portal-client.ts';
import { createPgPauseStore } from '../../src/pause-store.ts';
import { startWorkers, type Workers } from '../../src/worker.ts';
import { freshDb } from '../support/db.ts';
import { startFakePortal, type FakePortal } from '../support/fake-portal.ts';
import { waitFor } from '../support/wait.ts';

let pool: pg.Pool;
let portal: FakePortal;
let workers: Workers | undefined;
let retries: string[];

beforeAll(async () => { pool = await freshDb(); portal = await startFakePortal(); });
afterAll(async () => { await portal.stop(); await pool.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE updates, desired_days RESTART IDENTITY');
  await pool.query('UPDATE portal_state SET paused_until = NULL');
  portal.requests.length = 0;
  retries = [];
});
afterEach(async () => {
  await workers?.stop();
  workers = undefined;
  portal.always('acc-bad', null);
});

const upd = (accommodationId: string, from: string, to: string, pricePerNight: number, available = true) =>
  acceptUpdate(pool, { accommodationId, from, to, available, pricePerNight });

async function start(over: { timeoutMs?: number; backoffBaseMs?: number; concurrency?: number } = {}) {
  const client = createPortalClient({
    url: portal.url, apiKey: 'sol-demo-key', timeoutMs: over.timeoutMs ?? 2000,
    maxRequestsPerMinute: 6000, pauseStore: createPgPauseStore(pool),
  });
  await client.start();
  workers = startWorkers({
    pool, portal: client, concurrency: over.concurrency ?? 4, pollIntervalMs: 20,
    backoffBaseMs: over.backoffBaseMs ?? 20, onRetry: r => retries.push(r),
  });
}

const counts = async (acc: string) =>
  (await pool.query(
    `SELECT count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS failed,
            count(*) FILTER (WHERE failed_at IS NULL AND version > synced_version)::int AS pending,
            count(*) FILTER (WHERE failed_at IS NULL AND version <= synced_version)::int AS synced
     FROM desired_days WHERE accommodation_id = $1`, [acc])).rows[0];
const allSynced = (acc: string) => async () => { const c = await counts(acc); return c.pending === 0 && c.failed === 0 && c.synced > 0; };

describe('worker: the final state (SPEC §7.2, AC3, AC4)', () => {
  it('overlapping updates A then B: the portal ends with B on its days and A on the rest, in 3 PUTs', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-07', 100);
    await upd('acc-1', '2026-10-03', '2026-10-04', 200);
    await start();
    await waitFor(allSynced('acc-1'), 10_000, 'acc-1 synced');
    const d = portal.days('acc-1');
    expect(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.pricePerNight]))).toEqual({
      '2026-10-01': 100, '2026-10-02': 100, '2026-10-03': 200, '2026-10-04': 200,
      '2026-10-05': 100, '2026-10-06': 100, '2026-10-07': 100,
    });
    expect(portal.puts().map(p => [p.body.from, p.body.to, p.body.pricePerNight])).toEqual([
      ['2026-10-01', '2026-10-02', 100], ['2026-10-03', '2026-10-04', 200], ['2026-10-05', '2026-10-07', 100],
    ]);
  });

  it('never sends more than 31 days in one PUT (40 days → 31 + 9)', async () => {
    await upd('acc-1', '2026-10-01', '2026-11-09', 80);
    await start();
    await waitFor(allSynced('acc-1'));
    expect(portal.puts().map(p => [p.body.from, p.body.to])).toEqual([
      ['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-09'],
    ]);
  });

  it('sends updates accepted while the service was not running (restart, AC2)', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-03', 100);
    await upd('acc-2', '2026-10-05', '2026-10-06', 50, false);
    // Nothing is running here: this is the state after a kill. A new start picks everything up.
    await start();
    await waitFor(allSynced('acc-1'));
    await waitFor(allSynced('acc-2'));
    expect(portal.days('acc-2')['2026-10-06']).toEqual({ available: false, pricePerNight: 50 });
  });

  it('a day changed while its PUT is in flight stays "to send" and goes out again with the new value', async () => {
    portal.queue({ status: 200, delayMs: 300 });
    await upd('acc-1', '2026-10-01', '2026-10-01', 100);
    await start();
    await waitFor(() => portal.requests.length === 1, 5000, 'first PUT in flight');
    await upd('acc-1', '2026-10-01', '2026-10-01', 999);
    await waitFor(allSynced('acc-1'));
    expect(portal.days('acc-1')['2026-10-01'].pricePerNight).toBe(999);
    expect(portal.puts().map(p => p.body.pricePerNight)).toEqual([100, 999]);
  });
});

describe('worker: one at a time per accommodation (SPEC §7.1)', () => {
  it('never has two PUTs for the same accommodation in flight, but works on different ones together', async () => {
    portal.queue({ status: 200, delayMs: 300 }, { status: 200, delayMs: 300 }, { status: 200, delayMs: 300 }, { status: 200, delayMs: 300 });
    await upd('acc-1', '2026-10-01', '2026-10-01', 100);
    await upd('acc-1', '2026-10-05', '2026-10-05', 100); // a gap → a second PUT for the same accommodation
    await upd('acc-2', '2026-10-01', '2026-10-01', 100);
    await upd('acc-2', '2026-10-05', '2026-10-05', 100);
    await start();
    await waitFor(allSynced('acc-1'));
    await waitFor(allSynced('acc-2'));
    const at = (acc: string) => portal.puts().filter(p => p.path.includes(acc)).map(p => p.at);
    for (const acc of ['acc-1', 'acc-2']) expect(at(acc)[1] - at(acc)[0]).toBeGreaterThanOrEqual(280);
    expect(Math.abs(at('acc-1')[0] - at('acc-2')[0])).toBeLessThan(200);
  });
});

describe('worker: failures (SPEC §9, AC6, AC7, AC8)', () => {
  it('retries 503s and a 429 until everything is synced, and sends nothing before Retry-After ends', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-02', 100);
    portal.queue({ status: 503 }, { status: 503 }, { status: 429, retryAfter: 1 });
    await start();
    await waitFor(allSynced('acc-1'), 15_000);
    const reqs = portal.requests;
    expect(reqs.map(r => r.status)).toEqual([503, 503, 429, 200]);
    expect(reqs[3].at - reqs[2].at).toBeGreaterThanOrEqual(950);
    expect(retries).toEqual(['503', '503']); // a 429 is a pause, not a retry
    expect(portal.days('acc-1')['2026-10-02'].pricePerNight).toBe(100);
  });

  it('records the error on the days and schedules the next attempt in the future', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-02', 100);
    portal.queue({ status: 503 });
    await start({ backoffBaseMs: 60_000 });
    const row = await waitFor(async () => {
      const r = await pool.query(`SELECT attempts, last_error_code, last_error_at, next_attempt_at > now() + interval '30 seconds' AS later
                                  FROM desired_days WHERE date = '2026-10-01'`);
      return r.rows[0].attempts > 0 ? r.rows[0] : false;
    });
    expect(row).toMatchObject({ attempts: 1, last_error_code: 'UNAVAILABLE', later: true });
    expect(row.last_error_at).not.toBeNull();
    expect(portal.puts()).toHaveLength(1); // not tried again before next_attempt_at
  });

  it('a PUT that times out is sent again with the same values until it gets a clear answer', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-03', 120);
    portal.queue({ status: 200, delayMs: 800 });
    await start({ timeoutMs: 150 });
    await waitFor(allSynced('acc-1'), 10_000);
    const puts = portal.puts();
    expect(puts).toHaveLength(2);
    expect(puts[1].body).toEqual(puts[0].body);
    expect(puts[0].status).toBeNull(); // the client gave up on the first
    expect(retries).toEqual(['timeout']);
  });

  it('401 is retried like a 503 and never marks days failed', async () => {
    await upd('acc-1', '2026-10-01', '2026-10-01', 100);
    portal.queue({ status: 401 });
    await start();
    await waitFor(allSynced('acc-1'));
    expect(retries).toEqual(['401']);
  });

  it('a 404 marks only that accommodation failed with NOT_FOUND; others keep syncing; a new POST re-arms it', async () => {
    portal.always('acc-bad', { status: 404 });
    await upd('acc-bad', '2026-10-01', '2026-10-03', 100);
    await upd('acc-1', '2026-10-01', '2026-10-03', 100);
    await start();
    await waitFor(allSynced('acc-1'));
    await waitFor(async () => (await counts('acc-bad')).failed === 3, 5000, 'acc-bad failed');
    const e = await pool.query(`SELECT last_error_code, last_error_at, failed_at FROM desired_days WHERE accommodation_id='acc-bad' LIMIT 1`);
    expect(e.rows[0].last_error_code).toBe('NOT_FOUND');
    expect(e.rows[0].failed_at).not.toBeNull();
    const putsToBad = portal.puts().filter(p => p.path.includes('acc-bad')).length;
    await new Promise(r => setTimeout(r, 300));
    expect(portal.puts().filter(p => p.path.includes('acc-bad')).length).toBe(putsToBad); // not retried

    portal.always('acc-bad', null);
    await upd('acc-bad', '2026-10-01', '2026-10-03', 101);
    await waitFor(allSynced('acc-bad'));
    expect(portal.days('acc-bad')['2026-10-02'].pricePerNight).toBe(101);
  });
});
