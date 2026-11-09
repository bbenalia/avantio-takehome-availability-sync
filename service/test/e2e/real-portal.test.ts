import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../support/db.ts';
import { startService, type RunningService } from '../support/service-process.ts';
import { waitFor } from '../support/wait.ts';

// Needs the real Portal Sol on http://localhost:4000 (docker compose up -d).
const PORTAL = 'http://localhost:4000';
const KEY = { 'x-api-key': 'sol-demo-key' };

let pool: pg.Pool;
let running: RunningService | undefined;

beforeAll(async () => { pool = await freshDb(); });
afterAll(() => pool.end());
afterEach(() => { running?.child.kill('SIGKILL'); running = undefined; });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('test 7: full run against the real Portal Sol (SPEC §16)', () => {
  it('overlapping updates end with the latest value on every day, in valid requests, without a 429', async () => {
    await fetch(`${PORTAL}/__admin/reset`, { method: 'POST' });
    running = await startService(3931, { DATABASE_URL: 'postgres://sync:sync@localhost:5432/sync', PORTAL_URL: PORTAL });
    const post = (body: object) => fetch(`${running!.base}/updates`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // A: 40 days at 100 (needs a split into 31 + 9). B: two days in the middle at 200.
    const a = { accommodationId: 'acc-1003', from: iso(5), to: iso(44), available: true, pricePerNight: 100 };
    const b = { accommodationId: 'acc-1003', from: iso(10), to: iso(11), available: false, pricePerNight: 200 };
    expect((await post(a)).status).toBe(202);
    expect((await post(b)).status).toBe(202);

    await waitFor(async () => (await (await fetch(`${running!.base}/accommodations/acc-1003/sync-status`)).json()).state === 'synced',
      50_000, 'acc-1003 synced');

    // The real portal also answers our own check with a random 503 now and then: ask again.
    const state = await waitFor(async () => {
      const res = await fetch(`${PORTAL}/api/v1/accommodations/acc-1003?from=${iso(5)}&to=${iso(44)}`, { headers: KEY });
      return res.ok ? res.json() : false;
    }, 20_000, 'portal state');
    expect(state.days).toHaveLength(40);
    for (const d of state.days as { date: string; available: boolean; pricePerNight: number }[]) {
      const inB = d.date === iso(10) || d.date === iso(11);
      expect([d.available, d.pricePerNight]).toEqual(inB ? [false, 200] : [true, 100]);
    }

    const log = (await (await fetch(`${PORTAL}/__admin/requests`)).json()).requests as
      { method: string; body: { from: string; to: string } | null; status: number | null }[];
    const puts = log.filter(r => r.method === 'PUT');
    for (const p of puts) {
      const days = (Date.parse(p.body!.to) - Date.parse(p.body!.from)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(31);
    }
    expect(log.filter(r => r.status === 429)).toHaveLength(0); // our limiter stays under the portal's limit
  });
});
