import { afterAll, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '../../src/db.ts';
import { TEST_DATABASE_URL } from '../support/db.ts';

const pool = createPool(TEST_DATABASE_URL);
afterAll(() => pool.end());

describe('migrations (SPEC §4.2)', () => {
  it('create the tables and can run twice', async () => {
    await runMigrations(pool);
    await runMigrations(pool);
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = r.rows.map(x => x.table_name);
    expect(names).toEqual(expect.arrayContaining(['updates', 'desired_days', 'portal_state']));
    const state = await pool.query('SELECT count(*)::int AS n FROM portal_state');
    expect(state.rows[0].n).toBe(1);
  });
});
