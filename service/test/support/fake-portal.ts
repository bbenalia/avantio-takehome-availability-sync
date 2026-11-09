import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A tiny stand-in for Portal Sol whose answers we script (SPEC §16).
// Without a script it answers 200 and remembers the days it was told about.

export type Scripted =
  | { status: 200; delayMs?: number }
  | { status: 429; retryAfter?: number | string }
  | { status: 400 | 401 | 404 | 503 };

export type RecordedRequest = {
  n: number;
  at: number; // Date.now() when the request arrived
  method: string;
  path: string;
  body: any;
  apiKey: string | undefined;
  status: number | null; // null when the client went away before we answered
};

export type FakePortal = {
  url: string;
  requests: RecordedRequest[];
  /** The next /api requests (any accommodation) get these answers, in order. */
  queue(...answers: Scripted[]): void;
  /** Every request for this accommodation gets this answer, until cleared. */
  always(accommodationId: string, answer: Scripted | null): void;
  /** Day-by-day state the portal holds after the 200s it gave. */
  days(accommodationId: string): Record<string, { available: boolean; pricePerNight: number }>;
  puts(): RecordedRequest[];
  stop(): Promise<void>;
};

export async function startFakePortal(): Promise<FakePortal> {
  const requests: RecordedRequest[] = [];
  const queued: Scripted[] = [];
  const perAcc = new Map<string, Scripted>();
  const state = new Map<string, Record<string, { available: boolean; pricePerNight: number }>>();

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const rec: RecordedRequest = {
      n: requests.length + 1,
      at: Date.now(),
      method: req.method ?? '',
      path: req.url ?? '',
      body: raw ? JSON.parse(raw) : null,
      apiKey: req.headers['x-api-key'] as string | undefined,
      status: null,
    };
    requests.push(rec);

    const accId = /^\/api\/v1\/accommodations\/([^/?]+)/.exec(rec.path)?.[1] ?? '';
    const answer: Scripted = queued.shift() ?? perAcc.get(accId) ?? { status: 200 };

    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      rec.status = status;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (rec.apiKey !== 'sol-demo-key') return send(401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } });
    if (answer.status === 429) {
      const headers: Record<string, string> = {};
      if (answer.retryAfter !== undefined) headers['retry-after'] = String(answer.retryAfter);
      return send(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, headers);
    }
    if (answer.status !== 200) {
      const codes = { 400: 'INVALID_BODY', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND', 503: 'UNAVAILABLE' } as const;
      return send(answer.status, { error: { code: codes[answer.status], message: 'scripted' } });
    }
    if (answer.delayMs) await new Promise(r => setTimeout(r, answer.delayMs));
    if (res.destroyed) return; // the client gave up while we were "slow"

    if (rec.method === 'PUT' && rec.body) {
      const days = state.get(accId) ?? {};
      for (let t = Date.parse(rec.body.from); t <= Date.parse(rec.body.to); t += 86_400_000) {
        days[new Date(t).toISOString().slice(0, 10)] = {
          available: rec.body.available,
          pricePerNight: rec.body.pricePerNight,
        };
      }
      state.set(accId, days);
    }
    send(200, { accommodationId: accId });
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    queue: (...a) => void queued.push(...a),
    always: (id, a) => void (a ? perAcc.set(id, a) : perAcc.delete(id)),
    days: id => state.get(id) ?? {},
    puts: () => requests.filter(r => r.method === 'PUT'),
    stop: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
