import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakePortal, type FakePortal } from '../support/fake-portal.ts';

// The fake portal is test infrastructure; this only checks that its scripting works.
let portal: FakePortal;
beforeAll(async () => { portal = await startFakePortal(); });
afterAll(() => portal.stop());

const put = (id: string, body: object, key = 'sol-demo-key') =>
  fetch(`${portal.url}/api/v1/accommodations/${id}/availability`, {
    method: 'PUT', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

describe('fake portal', () => {
  it('answers 200, remembers days, follows the queue, and checks the api key', async () => {
    portal.queue({ status: 503 }, { status: 429, retryAfter: 3 });
    expect((await put('a', { from: '2026-10-01', to: '2026-10-02', available: true, pricePerNight: 5 })).status).toBe(503);
    const r429 = await put('a', { from: '2026-10-01', to: '2026-10-02', available: true, pricePerNight: 5 });
    expect([r429.status, r429.headers.get('retry-after')]).toEqual([429, '3']);
    expect((await put('a', { from: '2026-10-01', to: '2026-10-02', available: true, pricePerNight: 5 })).status).toBe(200);
    expect(portal.days('a')['2026-10-02']).toEqual({ available: true, pricePerNight: 5 });
    expect((await put('a', {}, 'wrong')).status).toBe(401);
    portal.always('b', { status: 404 });
    expect((await put('b', {})).status).toBe(404);
  });
});
