import { describe, expect, it } from 'vitest';
import { UpdateRequest } from '../../src/update-request.ts';

const valid = {
  accommodationId: 'acc-1003',
  from: '2026-10-01',
  to: '2026-10-07',
  available: false,
  pricePerNight: 120,
};

// Returns the path of the first issue, or null when the body is valid.
function failsAt(body: unknown): string | null {
  const r = UpdateRequest.safeParse(body);
  return r.success ? null : r.error.issues[0].path.join('.');
}

describe('UpdateRequest (SPEC §6.1)', () => {
  it('accepts a valid body', () => {
    expect(UpdateRequest.safeParse(valid).success).toBe(true);
  });

  it('accepts from == to, price 0 and a price with 2 decimals', () => {
    expect(UpdateRequest.safeParse({ ...valid, to: valid.from, pricePerNight: 0 }).success).toBe(true);
    expect(UpdateRequest.safeParse({ ...valid, pricePerNight: 99.99 }).success).toBe(true);
  });

  it('rejects a date that does not exist (2026-02-30)', () => {
    expect(failsAt({ ...valid, from: '2026-02-30', to: '2026-03-02' })).toBe('from');
  });

  it('rejects a date in the wrong format', () => {
    expect(failsAt({ ...valid, from: '01/10/2026' })).toBe('from');
    expect(failsAt({ ...valid, to: '2026-10-7' })).toBe('to');
  });

  it('rejects to before from', () => {
    expect(failsAt({ ...valid, from: '2026-10-07', to: '2026-10-01' })).toBe('to');
  });

  it('accepts exactly 366 days and rejects 367', () => {
    expect(UpdateRequest.safeParse({ ...valid, from: '2026-01-01', to: '2026-12-31' }).success).toBe(true); // 365
    expect(UpdateRequest.safeParse({ ...valid, from: '2028-01-01', to: '2028-12-31' }).success).toBe(true); // 366
    expect(failsAt({ ...valid, from: '2028-01-01', to: '2029-01-01' })).toBe('to'); // 367
  });

  it('rejects a price with 3 decimals, a negative price and a price that does not fit numeric(10,2)', () => {
    expect(failsAt({ ...valid, pricePerNight: 10.005 })).toBe('pricePerNight');
    expect(failsAt({ ...valid, pricePerNight: -1 })).toBe('pricePerNight');
    expect(failsAt({ ...valid, pricePerNight: 100_000_000 })).toBe('pricePerNight');
  });

  it('rejects wrong types', () => {
    expect(failsAt({ ...valid, pricePerNight: '120' })).toBe('pricePerNight');
    expect(failsAt({ ...valid, available: 'yes' })).toBe('available');
  });

  it('rejects an empty or too long accommodationId, and a missing field', () => {
    expect(failsAt({ ...valid, accommodationId: '' })).toBe('accommodationId');
    expect(failsAt({ ...valid, accommodationId: 'x'.repeat(65) })).toBe('accommodationId');
    const { available: _omit, ...missing } = valid;
    expect(failsAt(missing)).toBe('available');
  });

  it('does not check the accommodationId format (SPEC §6.4)', () => {
    expect(UpdateRequest.safeParse({ ...valid, accommodationId: 'anything goes' }).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(UpdateRequest.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
