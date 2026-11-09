import type pg from 'pg';
import type { PauseStore } from './portal-client.ts';

// The pause lives in memory; this row only survives a restart (SPEC §11.1).
export function createPgPauseStore(pool: pg.Pool): PauseStore {
  return {
    async load() {
      const { rows } = await pool.query('SELECT paused_until FROM portal_state WHERE id = 1');
      const value: Date | null = rows[0]?.paused_until ?? null;
      return value ? value.getTime() : 0;
    },
    async save(ms) {
      await pool.query('UPDATE portal_state SET paused_until = $1 WHERE id = 1', [new Date(ms)]);
    },
  };
}
