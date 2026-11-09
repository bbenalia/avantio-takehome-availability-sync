import { z } from 'zod';

function isRealCalendarDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

function daysInclusive(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

// Used by the HTTP layer to tell this refinement apart (RANGE_TOO_LARGE).
export const RANGE_TOO_LARGE_MESSAGE = 'At most 366 days per update';

// Real calendar day in YYYY-MM-DD ("2026-02-30" is rejected).
const isoDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isRealCalendarDay, 'Not a real calendar day');

export const UpdateRequest = z.object({
  accommodationId: z.string().min(1).max(64), // no format check (SPEC 6.4)
  from: isoDate,
  to: isoDate,
  available: z.boolean(),
  pricePerNight: z.number()
    .nonnegative()
    .max(99_999_999.99) // fits numeric(10,2)
    .refine(hasAtMostTwoDecimals, 'At most 2 decimals'),
}).strict() // unknown fields -> 400
  .refine(u => u.to >= u.from, { path: ['to'], message: '`to` must be on or after `from`' })
  .refine(u => daysInclusive(u.from, u.to) <= 366, { path: ['to'], message: RANGE_TOO_LARGE_MESSAGE });

export type UpdateRequest = z.infer<typeof UpdateRequest>;
