import { z } from 'zod';

export const Config = z.object({
  PORTAL_URL: z.string().url().default('http://localhost:4000'),
  PORTAL_API_KEY: z.string().min(1).default('sol-demo-key'),
  // Probe: normal answers take under 1 s, "slow" ones about 10 s.
  PORTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Probe: the portal allows 30 requests per minute; we stay a bit below.
  PORTAL_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(25),
  SYNC_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgres://sync:sync@localhost:5432/sync'),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Config.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
