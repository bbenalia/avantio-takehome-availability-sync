import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPauseStore } from '../../src/pause-store.ts';
import { freshDb } from '../support/db.ts';

let pool: pg.Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(async () => { await pool.query('UPDATE portal_state SET paused_until = NULL'); await pool.end(); });

describe('pause store (SPEC §11.1)', () => {
  it('loads 0 when no pause was saved, and gives back exactly what was saved', async () => {
    const store = createPgPauseStore(pool);
    expect(await store.load()).toBe(0);
    const until = Date.now() + 45_000;
    await store.save(until);
    expect(await createPgPauseStore(pool).load()).toBe(until); // a new store = after a restart
  });
});
