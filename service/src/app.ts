import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type pg from 'pg';
import { pinoHttp } from 'pino-http';
import { acceptUpdate } from './intake.ts';
import { logger } from './logger.ts';
import { getSyncStatus } from './sync-status.ts';
import { RANGE_TOO_LARGE_MESSAGE, UpdateRequest } from './update-request.ts';
import type { ZodError } from 'zod';

function badRequestCode(error: ZodError): string {
  const issues = error.issues;
  if (issues.some(i => i.message === RANGE_TOO_LARGE_MESSAGE)) return 'RANGE_TOO_LARGE';
  if (issues.some(i => i.path[0] === 'from' || i.path[0] === 'to')) return 'INVALID_DATE';
  return 'INVALID_BODY';
}

function isDbUnavailable(err: unknown): boolean {
  // Node may wrap several connection attempts (IPv4 + IPv6) in an AggregateError.
  const errors = err instanceof AggregateError ? err.errors : [err];
  return errors.some(e =>
    (e as { code?: string }).code === 'ECONNREFUSED' ||
    (e instanceof Error && e.message.includes('timeout exceeded when trying to connect')));
}

export function createApp({ pool }: { pool: pg.Pool }): express.Express {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.post('/updates', async (req, res) => {
    const parsed = UpdateRequest.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      res.status(400).json({ error: { code: badRequestCode(parsed.error), message } });
      return;
    }
    const updateId = await acceptUpdate(pool, parsed.data);
    const { accommodationId, from, to } = parsed.data;
    res.status(202).json({
      updateId, accommodationId, from, to,
      statusUrl: `/accommodations/${accommodationId}/sync-status`,
    });
  });

  app.get('/accommodations/:id/sync-status', async (req, res) => {
    const status = await getSyncStatus(pool, req.params.id);
    if (!status) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No updates received for this accommodation' } });
      return;
    }
    res.json(status);
  });

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Body is not valid JSON' } });
    } else if (isDbUnavailable(err)) {
      req.log.error({ err }, 'database unavailable');
      res.status(503).json({ error: { code: 'UNAVAILABLE', message: 'Database unavailable, retry later' } });
    } else {
      req.log.error({ err }, 'unexpected error');
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
    }
  };
  app.use(onError);

  return app;
}
