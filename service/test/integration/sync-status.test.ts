import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { acceptUpdate } from '../../src/intake.ts';
import { freshDb } from '../support/db.ts';

let pool: pg.Pool;
let server: Server;
let base: string;

beforeAll(async () => {
  pool = await freshDb();
  server = createApp({ pool }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await pool.end(); });
beforeEach(async () => { await pool.query('TRUNCATE updates, desired_days RESTART IDENTITY'); });

const status = (id: string) => fetch(`${base}/accommodations/${id}/sync-status`);
const upd = (from: string, to: string, price = 100, id = 'acc-1') =>
  acceptUpdate(pool, { accommodationId: id, from, to, available: true, pricePerNight: price });

describe('GET /accommodations/:id/sync-status (SPEC §12, AC9)', () => {
  it('404 with our error shape for an accommodation we never received an update for', async () => {
    const res = await status('acc-nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('is "pending" right after an update, with counts, a range, and no error yet', async () => {
    await upd('2026-10-01', '2026-10-05');
    const body = await (await status('acc-1')).json();
    expect(body).toMatchObject({
      accommodationId: 'acc-1', state: 'pending',
      days: { total: 5, synced: 0, pending: 5, failed: 0 },
      lastSyncedAt: null, lastError: null,
      ranges: [{ from: '2026-10-01', to: '2026-10-05', state: 'pending' }],
    });
    expect(Date.parse(body.oldestPendingSince)).not.toBeNaN();
    expect(Date.parse(body.nextAttemptAt)).not.toBeNaN();
  });

  it('is "synced" with no ranges once everything is confirmed', async () => {
    await upd('2026-10-01', '2026-10-05');
    await pool.query('UPDATE desired_days SET synced_version = version, synced_at = now()');
    const body = await (await status('acc-1')).json();
    expect(body).toMatchObject({
      state: 'synced', days: { total: 5, synced: 5, pending: 0, failed: 0 },
      oldestPendingSince: null, nextAttemptAt: null, ranges: [],
    });
    expect(Date.parse(body.lastSyncedAt)).not.toBeNaN();
  });

  it('mixed: failed is the most urgent state; ranges list only non-synced days, grouped by state', async () => {
    await upd('2026-10-01', '2026-10-10');
    await pool.query(`UPDATE desired_days SET synced_version = version, synced_at = now() WHERE date <= '2026-10-03'`);
    await pool.query(
      `UPDATE desired_days SET failed_at = now(), last_error_code = 'NOT_FOUND', last_error_at = now()
       WHERE date IN ('2026-10-04','2026-10-05')`);
    await pool.query(
      `UPDATE desired_days SET attempts = 2, last_error_code = 'UNAVAILABLE', last_error_at = '2026-10-08T10:00:00Z'
       WHERE date = '2026-10-08'`);
    const body = await (await status('acc-1')).json();
    expect(body.state).toBe('failed');
    expect(body.days).toEqual({ total: 10, synced: 3, pending: 5, failed: 2 });
    expect(body.ranges).toEqual([
      { from: '2026-10-04', to: '2026-10-05', state: 'failed', errorCode: 'NOT_FOUND' },
      { from: '2026-10-06', to: '2026-10-10', state: 'pending' },
    ]);
    expect(body.lastError.code).toBeTypeOf('string');
    expect(Date.parse(body.lastError.at)).not.toBeNaN();
  });

  it('does not mix up accommodations', async () => {
    await upd('2026-10-01', '2026-10-02', 100, 'acc-1');
    await upd('2026-10-01', '2026-10-09', 100, 'acc-2');
    const body = await (await status('acc-1')).json();
    expect(body.days.total).toBe(2);
  });
});
