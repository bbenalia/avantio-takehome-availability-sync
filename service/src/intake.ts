import type pg from 'pg';
import { logger } from './logger.ts';
import type { UpdateRequest } from './update-request.ts';

// Saves the update and its per-day desired state in one transaction (SPEC 6.2). Returns the updateId.
export async function acceptUpdate(pool: pg.Pool, req: UpdateRequest): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO updates (accommodation_id, from_date, to_date, available, price_per_night)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.accommodationId, req.from, req.to, req.available, req.pricePerNight],
    );
    await client.query(
      `INSERT INTO desired_days (accommodation_id, date, available, price_per_night, version)
       SELECT $1, d::date, $4, $5, nextval('desired_version_seq')
       FROM generate_series($2::date, $3::date, interval '1 day') AS d
       ON CONFLICT (accommodation_id, date) DO UPDATE SET
         available       = EXCLUDED.available,
         price_per_night = EXCLUDED.price_per_night,
         version         = nextval('desired_version_seq'),
         changed_at      = now(),
         attempts        = 0,
         next_attempt_at = now(),
         failed_at       = NULL`,
      [req.accommodationId, req.from, req.to, req.available, req.pricePerNight],
    );
    await client.query('COMMIT');
    const updateId = Number(inserted.rows[0].id);
    logger.info(
      { updateId, accommodationId: req.accommodationId, from: req.from, to: req.to },
      'update accepted',
    );
    return updateId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
