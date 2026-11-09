import type pg from 'pg';

type DayState = 'failed' | 'pending' | 'synced';
type Range = { from: string; to: string; state: 'pending' | 'failed'; errorCode?: string };

type DayRow = {
  date: string;
  state: DayState;
  changed_at: Date;
  synced_at: Date | null;
  next_attempt_at: Date;
  last_error_code: string | null;
  last_error_at: Date | null;
};

const DAY_MS = 86_400_000;

function isNextDay(a: string, b: string): boolean {
  return Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`) === DAY_MS;
}

function buildRanges(days: DayRow[]): Range[] {
  const ranges: Range[] = [];
  let current: Range | undefined;
  for (const day of days) {
    if (day.state === 'synced') { current = undefined; continue; }
    const errorCode = day.state === 'failed' ? (day.last_error_code ?? undefined) : undefined;
    if (current && current.state === day.state && current.errorCode === errorCode && isNextDay(current.to, day.date)) {
      current.to = day.date;
    } else {
      current = { from: day.date, to: day.date, state: day.state };
      if (errorCode) current.errorCode = errorCode;
      ranges.push(current);
    }
  }
  return ranges;
}

const earliest = (dates: Date[]) => dates.reduce<Date | undefined>((a, d) => (!a || d < a ? d : a), undefined);
const latest = (dates: Date[]) => dates.reduce<Date | undefined>((a, d) => (!a || d > a ? d : a), undefined);
const iso = (d: Date | undefined) => (d ? d.toISOString() : null);

// Returns undefined when we never received an update for this accommodation.
export async function getSyncStatus(pool: pg.Pool, accommodationId: string) {
  const { rows } = await pool.query<DayRow>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date,
            CASE WHEN failed_at IS NOT NULL THEN 'failed'
                 WHEN version > synced_version THEN 'pending'
                 ELSE 'synced' END AS state,
            changed_at, synced_at, next_attempt_at, last_error_code, last_error_at
       FROM desired_days WHERE accommodation_id = $1 ORDER BY date`,
    [accommodationId]);
  if (rows.length === 0) return undefined;

  const pending = rows.filter(r => r.state === 'pending');
  const failed = rows.filter(r => r.state === 'failed');
  const lastErrorAt = latest(rows.flatMap(r => (r.last_error_at ? [r.last_error_at] : [])));
  const lastErrorRow = rows.find(r => r.last_error_at === lastErrorAt);

  return {
    accommodationId,
    state: failed.length ? 'failed' : pending.length ? 'pending' : 'synced',
    days: {
      total: rows.length,
      synced: rows.length - pending.length - failed.length,
      pending: pending.length,
      failed: failed.length,
    },
    oldestPendingSince: iso(earliest(pending.map(r => r.changed_at))),
    lastSyncedAt: iso(latest(rows.flatMap(r => (r.synced_at ? [r.synced_at] : [])))),
    nextAttemptAt: iso(earliest(pending.map(r => r.next_attempt_at))),
    lastError: lastErrorRow && lastErrorAt ? { code: lastErrorRow.last_error_code ?? 'UNKNOWN', at: lastErrorAt.toISOString() } : null,
    ranges: buildRanges(rows),
  };
}
