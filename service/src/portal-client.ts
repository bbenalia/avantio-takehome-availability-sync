import { setTimeout as sleep } from 'node:timers/promises';

export type PauseStore = { load(): Promise<number>; save(ms: number): Promise<void> };

export type PutRange = { from: string; to: string; available: boolean; pricePerNight: number };

export type PutResult =
  | { kind: 'ok' }
  | { kind: 'paused' }
  | { kind: 'retry'; code: '503' | '401' | 'TIMEOUT' | 'NETWORK_ERROR' }
  | { kind: 'rejected'; code: string };

export type Outcome = 'ok' | '429' | '503' | 'timeout' | 'network_error' | '401' | '400' | '404';

export type PortalClientOptions = {
  url: string;
  apiKey: string;
  timeoutMs: number;
  maxRequestsPerMinute: number;
  pauseStore: PauseStore;
  onResult?: (method: 'GET' | 'PUT', outcome: Outcome, seconds: number) => void;
};

const DEFAULT_PAUSE_MS = 60_000;

// Hands out one time slot every intervalMs, shared by all callers (SPEC §11.2).
class Limiter {
  private nextSlot = 0;
  private intervalMs: number;
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }
  async takeTurn(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    await sleep(slot - now);
  }
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null || header.trim() === '' ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_PAUSE_MS;
}

export function createPortalClient(opts: PortalClientOptions) {
  const limiter = new Limiter(60_000 / opts.maxRequestsPerMinute);
  const pause = { until: 0 };

  async function waitOutPause(): Promise<void> {
    while (Date.now() < pause.until) await sleep(pause.until - Date.now());
  }

  // Returns the response, 'paused', or the way the call failed without an answer.
  async function callPortal(path: string, init: RequestInit): Promise<Response | 'paused' | 'timeout' | 'network_error'> {
    await waitOutPause();
    await limiter.takeTurn();
    if (Date.now() < pause.until) return 'paused';
    // No await between the check above and fetch: nothing can set the pause in between.
    try {
      const res = await fetch(opts.url + path, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      if (res.status === 429) {
        pause.until = Math.max(pause.until, Date.now() + retryAfterMs(res));
        await opts.pauseStore.save(pause.until);
      }
      return res;
    } catch (err) {
      return (err as Error).name === 'TimeoutError' ? 'timeout' : 'network_error';
    }
  }

  async function errorCode(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return body?.error?.code ?? String(res.status);
  }

  async function putAvailability(accommodationId: string, range: PutRange): Promise<PutResult> {
    const started = performance.now();
    const report = (outcome: Outcome) => opts.onResult?.('PUT', outcome, (performance.now() - started) / 1000);

    const res = await callPortal(`/api/v1/accommodations/${encodeURIComponent(accommodationId)}/availability`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey },
      body: JSON.stringify(range),
    });

    if (res === 'paused') return { kind: 'paused' };
    if (res === 'timeout') { report('timeout'); return { kind: 'retry', code: 'TIMEOUT' }; }
    if (res === 'network_error') { report('network_error'); return { kind: 'retry', code: 'NETWORK_ERROR' }; }

    if (res.status === 200) { report('ok'); return { kind: 'ok' }; }
    if (res.status === 429) { report('429'); return { kind: 'paused' }; }
    if (res.status === 401) { report('401'); return { kind: 'retry', code: '401' }; }
    if (res.status === 400 || res.status === 404) {
      report(res.status === 400 ? '400' : '404');
      return { kind: 'rejected', code: await errorCode(res) };
    }
    // 503 and any other unexpected status: waiting may fix it.
    report('503');
    return { kind: 'retry', code: '503' };
  }

  return {
    putAvailability,
    async start() { pause.until = await opts.pauseStore.load(); },
    pausedUntil: () => pause.until,
  };
}

export type PortalClient = ReturnType<typeof createPortalClient>;
