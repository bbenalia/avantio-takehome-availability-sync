import type pg from 'pg';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

// One Registry per instance (not the global one), so tests can create several.
export function createMetrics(pool: pg.Pool) {
  const registry = new Registry();

  // The gauges are read from PostgreSQL at scrape time, so they are right after a restart.
  const dbGauge = (name: string, help: string, sql: string) =>
    new Gauge({
      name, help, registers: [registry],
      async collect() {
        const { rows } = await pool.query<{ value: string }>(sql);
        this.set(Number(rows[0]!.value));
      },
    });

  dbGauge('sync_pending_days', 'Days not yet confirmed by the portal (failed days excluded)',
    'SELECT count(*) AS value FROM desired_days WHERE version > synced_version AND failed_at IS NULL');
  dbGauge('sync_oldest_pending_age_seconds', 'Age of the oldest pending day, 0 when nothing is pending',
    `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(changed_at)), 0) AS value
       FROM desired_days WHERE version > synced_version AND failed_at IS NULL`);
  dbGauge('sync_failed_days', 'Days the portal rejected (400/404) that are still failed',
    'SELECT count(*) AS value FROM desired_days WHERE failed_at IS NOT NULL');

  const requests = new Counter({
    name: 'portal_requests_total', help: 'Portal calls by result',
    labelNames: ['method', 'outcome'], registers: [registry],
  });
  const duration = new Histogram({
    name: 'portal_request_duration_seconds', help: 'Portal call duration',
    labelNames: ['method'], registers: [registry],
  });
  const retries = new Counter({
    name: 'sync_retries_total', help: 'Retries scheduled, by reason',
    labelNames: ['reason'], registers: [registry],
  });

  return {
    onPortalResult(method: 'GET' | 'PUT', outcome: string, seconds: number) {
      requests.inc({ method, outcome });
      duration.observe({ method }, seconds);
    },
    onRetry(reason: string) {
      retries.inc({ reason });
    },
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
