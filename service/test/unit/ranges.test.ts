import { describe, expect, it } from 'vitest';
import { toRanges, type DueDay } from '../../src/ranges.ts';

// Builds `count` consecutive days from `start` (YYYY-MM-DD, UTC), all with the same values.
function days(start: string, count: number, over: Partial<DueDay> = {}): DueDay[] {
  const out: DueDay[] = [];
  const t0 = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    out.push({
      date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
      available: true,
      pricePerNight: '100.00',
      version: String(i + 1),
      attempts: 0,
      ...over,
    });
  }
  return out;
}

describe('toRanges (SPEC §7.2 step 3)', () => {
  it('joins neighbouring days with the same values into one range', () => {
    const r = toRanges(days('2026-10-01', 7));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ from: '2026-10-01', to: '2026-10-07', available: true, pricePerNight: '100.00' });
  });

  it('starts a new range when there is a gap between dates', () => {
    const input = [...days('2026-10-01', 2), ...days('2026-10-04', 2)];
    const r = toRanges(input);
    expect(r.map(x => [x.from, x.to])).toEqual([['2026-10-01', '2026-10-02'], ['2026-10-04', '2026-10-05']]);
  });

  it('starts a new range when price or availability changes', () => {
    const input = [
      ...days('2026-10-01', 2),
      ...days('2026-10-03', 2, { pricePerNight: '200.00' }),
      ...days('2026-10-05', 2, { pricePerNight: '200.00', available: false }),
    ];
    const r = toRanges(input);
    expect(r.map(x => [x.from, x.to, x.available, x.pricePerNight])).toEqual([
      ['2026-10-01', '2026-10-02', true, '100.00'],
      ['2026-10-03', '2026-10-04', true, '200.00'],
      ['2026-10-05', '2026-10-06', false, '200.00'],
    ]);
  });

  it('never makes a range longer than 31 days (40 days → 31 + 9)', () => {
    const r = toRanges(days('2026-10-01', 40));
    expect(r.map(x => [x.from, x.to])).toEqual([['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-09']]);
  });

  it('keeps a 31-day run as a single range', () => {
    expect(toRanges(days('2026-10-01', 31))).toHaveLength(1);
  });

  it('splits a 366-day run into 12 ranges, none over 31 days, covering every day once', () => {
    const input = days('2026-01-01', 366);
    const r = toRanges(input);
    expect(r).toHaveLength(12);
    expect(r.every(x => x.days.length <= 31)).toBe(true);
    expect(r.flatMap(x => x.days.map(d => d.date))).toEqual(input.map(d => d.date));
  });

  it('remembers the version of every day, even when days with different versions are joined', () => {
    const input = days('2026-10-01', 3);
    input[0].version = '5';
    input[1].version = '9';
    input[2].version = '7';
    const r = toRanges(input);
    expect(r).toHaveLength(1);
    expect(r[0].days).toEqual([
      { date: '2026-10-01', version: '5' },
      { date: '2026-10-02', version: '9' },
      { date: '2026-10-03', version: '7' },
    ]);
  });

  it('joins across a month and a year boundary', () => {
    const r = toRanges(days('2026-12-30', 4));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ from: '2026-12-30', to: '2027-01-02' });
  });

  it('returns nothing for no days', () => {
    expect(toRanges([])).toEqual([]);
  });

  it('honours a custom maxDays', () => {
    expect(toRanges(days('2026-10-01', 5), 2).map(x => x.days.length)).toEqual([2, 2, 1]);
  });
});
