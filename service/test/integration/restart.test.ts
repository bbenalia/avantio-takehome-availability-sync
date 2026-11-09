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

const post = (base: string, body: object) =>
  fetch(`${base}/updates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('test 4: kill the service, restart, everything still syncs (AC2)', () => {
  it('survives kill -9: updates accepted before the kill reach the portal after the restart', async () => {
    // First run: the portal is unreachable, so nothing can sync; the updates only exist in Postgres.
    running = await startService(3911, {
      DATABASE_URL: 'postgres://sync:sync@localhost:5432/sync', PORTAL_URL: 'http://127.0.0.1:1',
    });
    expect((await post(running.base, { accommodationId: 'acc-1', from: '2026-10-01', to: '2026-10-07', available: true, pricePerNight: 100 })).status).toBe(202);
    expect((await post(running.base, { accommodationId: 'acc-1', from: '2026-10-03', to: '2026-10-04', available: true, pricePerNight: 200 })).status).toBe(202);
    expect((await post(running.base, { accommodationId: 'acc-2', from: '2026-11-01', to: '2026-11-02', available: false, pricePerNight: 50 })).status).toBe(202);

    running.child.kill('SIGKILL');
    await running.exited;
    expect(portal.puts()).toHaveLength(0);

    // Second run against a working portal.
    running = await startService(3912, {
      DATABASE_URL: 'postgres://sync:sync@localhost:5432/sync', PORTAL_URL: portal.url,
    });
    await waitFor(async () => {
      const a = await (await fetch(`${running!.base}/accommodations/acc-1/sync-status`)).json();
      const b = await (await fetch(`${running!.base}/accommodations/acc-2/sync-status`)).json();
      return a.state === 'synced' && b.state === 'synced';
    }, 20_000, 'both accommodations synced after restart');

    expect(portal.days('acc-1')['2026-10-03'].pricePerNight).toBe(200);
    expect(portal.days('acc-1')['2026-10-05'].pricePerNight).toBe(100);
    expect(portal.days('acc-2')['2026-11-02']).toEqual({ available: false, pricePerNight: 50 });
  });

  it('a 429 pause saved in Postgres survives a restart: nothing is sent before it ends (AC5)', async () => {
    await pool.query('TRUNCATE updates, desired_days RESTART IDENTITY');
    portal.requests.length = 0;
    const until = Number((await pool.query(
      `UPDATE portal_state SET paused_until = now() + interval '6 seconds' RETURNING extract(epoch from paused_until) * 1000 AS ms`)).rows[0].ms);
    running = await startService(3913, {
      DATABASE_URL: 'postgres://sync:sync@localhost:5432/sync', PORTAL_URL: portal.url,
    });
    await post(running.base, { accommodationId: 'acc-3', from: '2026-10-01', to: '2026-10-01', available: true, pricePerNight: 10 });
    await waitFor(() => portal.puts().length > 0, 15_000, 'first PUT');
    expect(portal.puts()[0].at).toBeGreaterThanOrEqual(until - 50);
  });
});
