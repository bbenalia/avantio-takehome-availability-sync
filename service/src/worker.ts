import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { logger } from './logger.ts';
import type { PortalClient, PutResult } from './portal-client.ts';
import { toRanges, type DueDay, type PortalRange } from './ranges.ts';

export type RetryReason = '503' | 'timeout' | 'network_error' | '401';
export type Workers = { stop(): Promise<void> };

export type WorkerOptions = {
  pool: pg.Pool;
  portal: PortalClient;
  concurrency: number;
  pollIntervalMs?: number;
  backoffBaseMs?: number;
  onRetry?: (reason: RetryReason) => void;
};

type Retry = Extract<PutResult, { kind: 'retry' }>;

const MAX_BACKOFF_MS = 5 * 60_000;
const CANDIDATES = 20;

const RETRY_REASON: Record<Retry['code'], RetryReason> = {
  '503': '503', '401': '401', TIMEOUT: 'timeout', NETWORK_ERROR: 'network_error',
};
const RETRY_ERROR_CODE: Record<Retry['code'], string> = {
  '503': 'UNAVAILABLE', '401': 'UNAUTHORIZED', TIMEOUT: 'TIMEOUT', NETWORK_ERROR: 'NETWORK_ERROR',
};

// SPEC §9.2: base * 2^attempts, capped at 5 minutes, ±20% jitter.
function backoffMs(baseMs: number, attempts: number): number {
  const delay = Math.min(baseMs * 2 ** attempts, MAX_BACKOFF_MS);
  return delay * (0.8 + Math.random() * 0.4);
}

export function startWorkers(options: WorkerOptions): Workers {
  const { pool, portal, concurrency, pollIntervalMs = 1000, backoffBaseMs = 2000, onRetry } = options;
  let stopping = false;

  async function findCandidates(db: pg.ClientBase): Promise<string[]> {
    const { rows } = await db.query(
      `SELECT DISTINCT accommodation_id FROM desired_days
       WHERE version > synced_version AND failed_at IS NULL AND next_attempt_at <= now()
       LIMIT ${CANDIDATES}`);
    return rows.map(r => r.accommodation_id);
  }

  async function readDueDays(db: pg.ClientBase, accommodationId: string): Promise<DueDay[]> {
    const { rows } = await db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, available, price_per_night::text AS "pricePerNight",
              version::text AS version, attempts
       FROM desired_days
       WHERE accommodation_id = $1
         AND version > synced_version AND failed_at IS NULL AND next_attempt_at <= now()
       ORDER BY date`, [accommodationId]);
    return rows;
  }

  // The per-day version guard: a day changed while we were sending is left alone (SPEC §7.2 step 5, §9.1).
  async function saveSynced(db: pg.ClientBase, accommodationId: string, range: PortalRange) {
    await db.query(
      `UPDATE desired_days d SET synced_version = s.version, synced_at = now()
       FROM unnest($2::date[], $3::bigint[]) AS s(date, version)
       WHERE d.accommodation_id = $1 AND d.date = s.date AND d.version = s.version`,
      [accommodationId, range.days.map(d => d.date), range.days.map(d => d.version)]);
  }

  async function saveRetry(db: pg.ClientBase, accommodationId: string, range: PortalRange, nextAttemptAt: Date, code: string) {
    await db.query(
      `UPDATE desired_days d
       SET attempts = d.attempts + 1, next_attempt_at = $4, last_error_code = $5, last_error_at = now()
       FROM unnest($2::date[], $3::bigint[]) AS s(date, version)
       WHERE d.accommodation_id = $1 AND d.date = s.date AND d.version = s.version`,
      [accommodationId, range.days.map(d => d.date), range.days.map(d => d.version), nextAttemptAt, code]);
  }

  async function saveFailed(db: pg.ClientBase, accommodationId: string, range: PortalRange, code: string) {
    await db.query(
      `UPDATE desired_days d
       SET failed_at = now(), last_error_code = $4, last_error_at = now()
       FROM unnest($2::date[], $3::bigint[]) AS s(date, version)
       WHERE d.accommodation_id = $1 AND d.date = s.date AND d.version = s.version`,
      [accommodationId, range.days.map(d => d.date), range.days.map(d => d.version), code]);
  }

  // Sends one range and saves the answer. Returns false when the portal is paused (429).
  async function syncRange(db: pg.ClientBase, accommodationId: string, range: PortalRange, attemptsByDate: Map<string, number>): Promise<boolean> {
    const maxAttempts = Math.max(...range.days.map(d => attemptsByDate.get(d.date) ?? 0));
    const log = { accommodationId, from: range.from, to: range.to, attempt: maxAttempts + 1 };
    const started = performance.now();
    const result = await portal.putAvailability(accommodationId, {
      from: range.from, to: range.to, available: range.available, pricePerNight: Number(range.pricePerNight),
    });
    const durationMs = Math.round(performance.now() - started);

    if (result.kind === 'ok') {
      await saveSynced(db, accommodationId, range);
      logger.info({ ...log, outcome: 'ok', durationMs }, 'range confirmed');
    } else if (result.kind === 'paused') {
      logger.warn({ ...log, outcome: '429', durationMs }, 'portal paused (429)');
      return false;
    } else if (result.kind === 'retry') {
      const nextAttemptAt = new Date(Date.now() + backoffMs(backoffBaseMs, maxAttempts));
      await saveRetry(db, accommodationId, range, nextAttemptAt, RETRY_ERROR_CODE[result.code]);
      const reason = RETRY_REASON[result.code];
      onRetry?.(reason);
      const line = { ...log, outcome: reason, durationMs, nextAttemptAt };
      if (result.code === '401') logger.error(line, 'portal rejected our API key; retry scheduled');
      else logger.warn(line, 'retry scheduled');
    } else {
      await saveFailed(db, accommodationId, range, result.code);
      logger.error({ ...log, outcome: result.code, durationMs }, 'days marked failed');
    }
    return true;
  }

  async function syncAccommodation(db: pg.ClientBase, accommodationId: string) {
    const days = await readDueDays(db, accommodationId);
    const attemptsByDate = new Map(days.map(d => [d.date, d.attempts]));
    for (const range of toRanges(days)) {
      if (stopping) return;
      if (!(await syncRange(db, accommodationId, range, attemptsByDate))) return;
    }
  }

  // Locks and syncs the first free accommodation with due work. Returns false if there was none.
  async function syncNext(db: pg.ClientBase): Promise<boolean> {
    for (const accommodationId of await findCandidates(db)) {
      const { rows } = await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [accommodationId]);
      if (!rows[0].locked) continue;
      try {
        await syncAccommodation(db, accommodationId);
      } finally {
        await db.query('SELECT pg_advisory_unlock(hashtext($1))', [accommodationId]);
      }
      return true;
    }
    return false;
  }

  async function runWorker() {
    const db = await pool.connect(); // dedicated: the session lock lives on this connection
    try {
      while (!stopping) {
        try {
          if (!(await syncNext(db))) await sleep(pollIntervalMs);
        } catch (err) {
          logger.error({ err }, 'worker error');
          await sleep(pollIntervalMs);
        }
      }
    } finally {
      db.release();
    }
  }

  const running = Array.from({ length: concurrency }, runWorker);

  return {
    async stop() {
      stopping = true;
      await Promise.all(running);
    },
  };
}
