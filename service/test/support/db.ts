import pg from 'pg';
import { createPool, runMigrations } from '../../src/db.ts';

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sync:sync@localhost:5432/sync';

// Pool on the real Postgres with migrations applied and all data wiped.
export async function freshDb(): Promise<pg.Pool> {
  const pool = createPool(TEST_DATABASE_URL);
  await runMigrations(pool);
  await pool.query('TRUNCATE updates, desired_days RESTART IDENTITY');
  await pool.query('UPDATE portal_state SET paused_until = NULL');
  return pool;
}
