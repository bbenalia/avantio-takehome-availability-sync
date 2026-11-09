export type DueDay = { date: string; available: boolean; pricePerNight: string; version: string; attempts: number };

export type PortalRange = {
  from: string;
  to: string;
  available: boolean;
  pricePerNight: string;
  days: { date: string; version: string }[]; // what was read, so results can be guarded
};

const DAY_MS = 86_400_000;

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

// `days` must be sorted by date.
export function toRanges(days: DueDay[], maxDays = 31): PortalRange[] {
  const ranges: PortalRange[] = [];
  let current: PortalRange | undefined;

  for (const day of days) {
    const joins =
      current !== undefined &&
      current.days.length < maxDays &&
      nextDay(current.to) === day.date &&
      current.available === day.available &&
      current.pricePerNight === day.pricePerNight;

    if (current !== undefined && joins) {
      current.to = day.date;
      current.days.push({ date: day.date, version: day.version });
    } else {
      current = {
        from: day.date,
        to: day.date,
        available: day.available,
        pricePerNight: day.pricePerNight,
        days: [{ date: day.date, version: day.version }],
      };
      ranges.push(current);
    }
  }
  return ranges;
}
