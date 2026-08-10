/**
 * v2.9x — time-window helpers for the public Stats page filters (RTX demo
 * request: "key in on specific tournament durations (weeks)").
 *
 * Every range here is HALF-OPEN `[from, to)`, matching the BE contract in
 * `StatsService.StatsWindowFilters`: `from` is inclusive, `to` is exclusive.
 * Weeks are ISO weeks (Monday 00:00 UTC through the following Monday
 * 00:00 UTC) — deliberately UTC, not the viewer's local timezone, so a
 * shared `?week=2026-W32` URL resolves to the same range for everyone and
 * the BE/FE boundary math never has to reconcile two clocks.
 */

export type StatsRangePreset = 'this_week' | 'last_week' | 'last4' | 'all';

export const STATS_RANGE_PRESETS: { value: StatsRangePreset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'last4', label: 'Last 4 weeks' },
];

export interface DateWindow {
  from?: string;
  to?: string;
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
function isoWeekStartUtc(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
  date.setUTCDate(date.getUTCDate() + diff);
  return date;
}

function addDaysUtc(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Resolves a preset to a `[from, to)` ISO range. `now` is injectable for tests. */
export function presetToRange(preset: StatsRangePreset, now: Date = new Date()): DateWindow {
  if (preset === 'all') return {};
  const thisWeekStart = isoWeekStartUtc(now);
  if (preset === 'this_week') {
    return { from: thisWeekStart.toISOString(), to: addDaysUtc(thisWeekStart, 7).toISOString() };
  }
  if (preset === 'last_week') {
    return { from: addDaysUtc(thisWeekStart, -7).toISOString(), to: thisWeekStart.toISOString() };
  }
  // last4: the current week plus the 3 preceding it.
  return { from: addDaysUtc(thisWeekStart, -21).toISOString(), to: addDaysUtc(thisWeekStart, 7).toISOString() };
}

/** `YYYY-Www` (the native `<input type="week">` value format) → ISO week number. */
function parseWeekInput(value: string): { year: number; week: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const week = parseInt(m[2]!, 10);
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/**
 * Converts an `<input type="week">` value (e.g. "2026-W32") to a `[from, to)`
 * ISO range. ISO 8601 defines week 1 as the week containing the year's first
 * Thursday (equivalently, the week containing Jan 4th) — the standard
 * `<input type="week">` numbering already follows this, so decoding just
 * needs to replicate the same anchor. Returns `null` for a malformed value.
 */
export function weekInputToRange(value: string): DateWindow | null {
  const parsed = parseWeekInput(value);
  if (!parsed) return null;
  const jan4 = new Date(Date.UTC(parsed.year, 0, 4));
  const week1Start = isoWeekStartUtc(jan4);
  const start = addDaysUtc(week1Start, (parsed.week - 1) * 7);
  return { from: start.toISOString(), to: addDaysUtc(start, 7).toISOString() };
}

/** The `<input type="week">` value for the ISO week containing `d`. */
export function dateToWeekInput(d: Date = new Date()): string {
  const weekStart = isoWeekStartUtc(d);
  // ISO week-numbering year: the week containing weekStart+3 days (Thursday)
  // determines the year, matching the Jan-4th anchor used above.
  const thursday = addDaysUtc(weekStart, 3);
  const isoYear = thursday.getUTCFullYear();
  const week1Start = isoWeekStartUtc(new Date(Date.UTC(isoYear, 0, 4)));
  const weekNum = Math.round((weekStart.getTime() - week1Start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}
