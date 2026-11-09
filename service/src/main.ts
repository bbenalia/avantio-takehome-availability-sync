import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool, runMigrations } from './db.ts';
import { logger } from './logger.ts';
import { createMetrics } from './metrics.ts';
import { createPgPauseStore } from './pause-store.ts';
import { createPortalClient } from './portal-client.ts';
import { startWorkers } from './worker.ts';

const config = loadConfig();

const pool = createPool(config.DATABASE_URL);
await runMigrations(pool);

const metrics = createMetrics(pool);
const portal = createPortalClient({
  url: config.PORTAL_URL,
  apiKey: config.PORTAL_API_KEY,
  timeoutMs: config.PORTAL_TIMEOUT_MS,
  maxRequestsPerMinute: config.PORTAL_MAX_REQUESTS_PER_MINUTE,
  pauseStore: createPgPauseStore(pool),
  onResult: metrics.onPortalResult,
});
await portal.start(); // loads a 429 pause saved before a restart

const workers = startWorkers({ pool, portal, concurrency: config.SYNC_CONCURRENCY, onRetry: metrics.onRetry });
const server = createApp({ pool, metrics }).listen(config.PORT, () => logger.info({ port: config.PORT }, 'service listening'));

// SPEC §8.2: stop taking requests and new work, let calls in flight finish, release locks, exit.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await workers.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
