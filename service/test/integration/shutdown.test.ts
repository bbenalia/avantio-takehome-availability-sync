import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../support/db.ts';
import { startFakePortal, type FakePortal } from '../support/fake-portal.ts';
import { startService, type RunningService } from '../support/service-process.ts';
import { waitFor } from '../support/wait.ts';

let pool: pg.Pool;
let portal: FakePortal;
let running: RunningService | undefined;

beforeAll(async () => { pool = await freshDb(); portal = await startFakePortal(); });
afterAll(async () => { await portal.stop(); await pool.end(); });
afterEach(() => { running?.child.kill('SIGKILL'); running = undefined; });

describe('SIGTERM (SPEC §8.2)', () => {
  it('lets the PUT in flight finish and be saved, then exits 0 and frees its advisory locks', async () => {
    portal.requests.length = 0;
    portal.queue({ status: 200, delayMs: 800 });
    running = await startService(3921, { DATABASE_URL: 'postgres://sync:sync@localhost:5432/sync', PORTAL_URL: portal.url });
    await fetch(`${running.base}/updates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accommodationId: 'acc-1', from: '2026-10-01', to: '2026-10-02', available: true, pricePerNight: 10 }),
    });
    await waitFor(() => portal.requests.length === 1, 10_000, 'PUT in flight');
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(0);

    const r = await pool.query(`SELECT count(*) FILTER (WHERE synced_version = version)::int AS synced FROM desired_days`);
    expect(r.rows[0].synced).toBe(2); // the in-flight result was saved before exit
    const locks = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`);
    expect(locks.rows[0].n).toBe(0);
  });
});
