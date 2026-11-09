import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPortalClient, type PauseStore } from '../../src/portal-client.ts';
import { startFakePortal, type FakePortal } from '../support/fake-portal.ts';

let portal: FakePortal;
beforeAll(async () => { portal = await startFakePortal(); });
afterAll(() => portal.stop());
beforeEach(() => { portal.requests.length = 0; });
afterEach(() => { portal.always('acc-1', null); });

const range = { from: '2026-10-01', to: '2026-10-07', available: true, pricePerNight: 120.5 };

function memoryStore(initial = 0) {
  const store = { value: initial, saved: [] as number[] } satisfies Record<string, unknown>;
  const pauseStore: PauseStore = {
    load: async () => store.value,
    save: async ms => { store.value = ms; store.saved.push(ms); },
  };
  return { store, pauseStore };
}

function makeClient(over: { url?: string; timeoutMs?: number; perMinute?: number; initialPause?: number } = {}) {
  const mem = memoryStore(over.initialPause ?? 0);
  const client = createPortalClient({
    url: over.url ?? portal.url,
    apiKey: 'sol-demo-key',
    timeoutMs: over.timeoutMs ?? 2000,
    maxRequestsPerMinute: over.perMinute ?? 6000, // 10 ms between calls unless a test says otherwise
    pauseStore: mem.pauseStore,
  });
  return { client, ...mem };
}

describe('portal client: one PUT (SPEC §9.1)', () => {
  it('sends the PUT with the api key and the range as JSON, and reports ok on 200', async () => {
    const { client } = makeClient();
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'ok' });
    expect(portal.requests).toHaveLength(1);
    expect(portal.requests[0]).toMatchObject({
      method: 'PUT', path: '/api/v1/accommodations/acc-1/availability', apiKey: 'sol-demo-key', body: range,
    });
  });

  it.each([
    ['503', { status: 503 as const }, '503'],
    ['401', { status: 401 as const }, '401'],
  ])('a %s is a retryable error with that code', async (_n, answer, code) => {
    portal.queue(answer);
    const { client } = makeClient();
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'retry', code });
  });

  it('a request slower than the timeout is a retryable TIMEOUT', async () => {
    portal.queue({ status: 200, delayMs: 600 });
    const { client } = makeClient({ timeoutMs: 100 });
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'retry', code: 'TIMEOUT' });
  });

  it('an unreachable portal is a retryable NETWORK_ERROR', async () => {
    const { client } = makeClient({ url: 'http://127.0.0.1:1' });
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'retry', code: 'NETWORK_ERROR' });
  });

  it('400 and 404 are rejections that carry the portal error code', async () => {
    portal.queue({ status: 404 });
    const { client } = makeClient();
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'rejected', code: 'NOT_FOUND' });
    portal.queue({ status: 400 });
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'rejected', code: 'INVALID_BODY' });
  });

  it('reports every call to onResult with method, outcome and a duration', async () => {
    const seen: any[] = [];
    const { pauseStore } = memoryStore();
    const client = createPortalClient({
      url: portal.url, apiKey: 'sol-demo-key', timeoutMs: 2000, maxRequestsPerMinute: 6000, pauseStore,
      onResult: (method, outcome, seconds) => seen.push([method, outcome, typeof seconds]),
    });
    portal.queue({ status: 503 }, { status: 200 }, { status: 404 });
    await client.putAvailability('acc-1', range);
    await client.putAvailability('acc-1', range);
    await client.putAvailability('acc-1', range);
    expect(seen).toEqual([['PUT', '503', 'number'], ['PUT', 'ok', 'number'], ['PUT', '404', 'number']]);
  });
});

describe('portal client: rate limiter (SPEC §11)', () => {
  it('spaces calls by 60000 / maxRequestsPerMinute, even when they start together', async () => {
    const { client } = makeClient({ perMinute: 600 }); // 100 ms
    await Promise.all([1, 2, 3, 4].map(() => client.putAvailability('acc-1', range)));
    const at = portal.requests.map(r => r.at);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(90);
  });
});

describe('portal client: 429 pause (SPEC §11)', () => {
  it('reports paused on 429, saves the pause, and sends nothing before Retry-After has passed', async () => {
    portal.queue({ status: 429, retryAfter: 1 });
    const { client, store } = makeClient();
    const t0 = Date.now();
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'paused' });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toBeGreaterThanOrEqual(t0 + 900);
    expect(client.pausedUntil()).toBe(store.saved[0]);

    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'ok' });
    expect(portal.requests).toHaveLength(2);
    expect(portal.requests[1].at - portal.requests[0].at).toBeGreaterThanOrEqual(950);
  });

  it('pauses 60 s when Retry-After is missing or not a number', async () => {
    for (const retryAfter of [undefined, 'soon']) {
      const { client } = makeClient(); // a fresh client each time: the pause would block the next call
      portal.queue({ status: 429, retryAfter });
      const t0 = Date.now();
      await client.putAvailability('acc-1', range);
      expect(client.pausedUntil()).toBeGreaterThanOrEqual(t0 + 59_000);
      expect(client.pausedUntil()).toBeLessThanOrEqual(Date.now() + 61_000);
    }
  });

  it('a 429 stops calls that were waiting for their turn (the check right before fetch)', async () => {
    portal.queue({ status: 429, retryAfter: 5 });
    const { client } = makeClient({ perMinute: 300 }); // 200 ms between turns
    const results = await Promise.all([1, 2, 3].map(() => client.putAvailability('acc-1', range)));
    expect(results).toEqual([{ kind: 'paused' }, { kind: 'paused' }, { kind: 'paused' }]);
    expect(portal.requests).toHaveLength(1);
  });

  it('honours a pause saved before a restart', async () => {
    const { client } = makeClient({ initialPause: Date.now() + 1000 });
    await client.start(); // loads the saved pause
    const t0 = Date.now();
    expect(await client.putAvailability('acc-1', range)).toEqual({ kind: 'ok' });
    expect(portal.requests[0].at - t0).toBeGreaterThanOrEqual(900);
  });

  it('a 429 does not count as an error outcome that needs retry (no retry result)', async () => {
    portal.queue({ status: 429, retryAfter: 1 });
    const { client } = makeClient();
    const r = await client.putAvailability('acc-1', range);
    expect(r.kind).not.toBe('retry');
  });
});
