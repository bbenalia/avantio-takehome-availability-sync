import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { freshDb } from '../support/db.ts';

let pool: pg.Pool;
let server: Server;
let base: string;

beforeAll(async () => {
  pool = await freshDb();
  server = createApp({ pool }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE updates, desired_days RESTART IDENTITY');
});

const post = (body: unknown, raw?: string) =>
  fetch(`${base}/updates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

const valid = { accommodationId: 'acc-1003', from: '2026-10-01', to: '2026-10-07', available: false, pricePerNight: 120 };

const day = async (acc: string, date: string) =>
  (await pool.query(
    `SELECT available, price_per_night::text AS price, version::text, synced_version::text, attempts, failed_at
     FROM desired_days WHERE accommodation_id = $1 AND date = $2`, [acc, date])).rows[0];

describe('POST /updates (SPEC §6)', () => {
  it('answers 202 with updateId and statusUrl, and the data is already committed', async () => {
    const res = await post(valid);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({
      updateId: 1, accommodationId: 'acc-1003', from: '2026-10-01', to: '2026-10-07',
      statusUrl: '/accommodations/acc-1003/sync-status',
    });
    // Read through the pool = another connection: only committed rows are visible.
    const upd = await pool.query('SELECT count(*)::int AS n FROM updates');
    const days = await pool.query('SELECT count(*)::int AS n FROM desired_days WHERE accommodation_id = $1', ['acc-1003']);
    expect([upd.rows[0].n, days.rows[0].n]).toEqual([1, 7]);
    expect(await day('acc-1003', '2026-10-04')).toMatchObject({ available: false, price: '120.00', synced_version: '0', attempts: 0 });
  });

  it('later update wins on overlapping days and gets a bigger version', async () => {
    await post({ ...valid, to: '2026-10-07', available: true, pricePerNight: 100 });
    await post({ ...valid, from: '2026-10-03', to: '2026-10-04', available: true, pricePerNight: 200 });
    expect((await day('acc-1003', '2026-10-02')).price).toBe('100.00');
    expect((await day('acc-1003', '2026-10-03')).price).toBe('200.00');
    expect((await day('acc-1003', '2026-10-04')).price).toBe('200.00');
    expect((await day('acc-1003', '2026-10-05')).price).toBe('100.00');
    const v = (d: string) => day('acc-1003', d).then(r => BigInt(r.version));
    expect(await v('2026-10-03')).toBeGreaterThan(await v('2026-10-02'));
  });

  it('puts an already synced day back to "to send" when it changes', async () => {
    await post(valid);
    await pool.query('UPDATE desired_days SET synced_version = version');
    await post({ ...valid, pricePerNight: 130 });
    const d = await day('acc-1003', '2026-10-01');
    expect(BigInt(d.version)).toBeGreaterThan(BigInt(d.synced_version));
  });

  it('re-arms a failed day with a fresh start', async () => {
    await post(valid);
    await pool.query(`UPDATE desired_days SET failed_at = now(), attempts = 4, next_attempt_at = now() + interval '1 hour'`);
    await post({ ...valid, pricePerNight: 99 });
    const d = await pool.query(`SELECT failed_at, attempts, next_attempt_at <= now() AS due FROM desired_days LIMIT 1`);
    expect(d.rows[0]).toEqual({ failed_at: null, attempts: 0, due: true });
  });

  it('accepts an accommodation id nobody has heard of (SPEC §6.4)', async () => {
    expect((await post({ ...valid, accommodationId: 'does-not-exist' })).status).toBe(202);
  });

  it.each([
    ['a date that does not exist', { ...valid, from: '2026-02-30', to: '2026-03-02' }],
    ['to before from', { ...valid, from: '2026-10-07', to: '2026-10-01' }],
    ['a price with 3 decimals', { ...valid, pricePerNight: 10.005 }],
    ['an unknown field', { ...valid, extra: true }],
    ['a range over 366 days', { ...valid, from: '2026-01-01', to: '2027-06-01' }],
  ])('rejects %s with 400, the portal error shape, and stores nothing', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
    const n = await pool.query('SELECT (SELECT count(*) FROM updates)::int AS u, (SELECT count(*) FROM desired_days)::int AS d');
    expect(n.rows[0]).toEqual({ u: 0, d: 0 });
  });

  it('uses the codes INVALID_DATE and RANGE_TOO_LARGE, like the portal', async () => {
    expect((await (await post({ ...valid, from: '2026-02-30', to: '2026-03-02' })).json()).error.code).toBe('INVALID_DATE');
    expect((await (await post({ ...valid, from: '2026-01-01', to: '2027-06-01' })).json()).error.code).toBe('RANGE_TOO_LARGE');
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await post(null, '{not json');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_BODY');
  });

  it('answers 503 and stores nothing when PostgreSQL is unavailable', async () => {
    const dead = new pg.Pool({ connectionString: 'postgres://sync:sync@127.0.0.1:1/sync', connectionTimeoutMillis: 500 });
    const s = createApp({ pool: dead }).listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/updates`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
    } finally {
      s.close();
      await dead.end();
    }
  });

  it('keeps all days or none when the insert fails halfway (one transaction)', async () => {
    // Make the desired_days insert fail after the updates insert succeeded.
    await pool.query('ALTER TABLE desired_days ADD CONSTRAINT no_oct4 CHECK (date <> DATE \'2026-10-04\') NOT VALID');
    try {
      const res = await post(valid);
      expect(res.status).toBe(500);
      const n = await pool.query('SELECT (SELECT count(*) FROM updates)::int AS u, (SELECT count(*) FROM desired_days)::int AS d');
      expect(n.rows[0]).toEqual({ u: 0, d: 0 });
    } finally {
      await pool.query('ALTER TABLE desired_days DROP CONSTRAINT no_oct4');
    }
  });
});
