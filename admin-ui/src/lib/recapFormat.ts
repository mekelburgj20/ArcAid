/**
 * Formatters for run recaps (B31.1). `formatRecapScore` is the same table as the
 * server's `abbrevScore` (src/utils/runRecapText.ts): 950, 31.4K, 116.2M, 8.6B,
 * 1.2T, one decimal, a trailing .0 kept ("92.0M"). Both are tested against the
 * same case table. The full value belongs in a `title` (`n.toLocaleString()`).
 */

const UNITS = [
  { v: 1e12, s: 'T' },
  { v: 1e9, s: 'B' },
  { v: 1e6, s: 'M' },
  { v: 1e3, s: 'K' },
];

export function formatRecapScore(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  let idx = UNITS.findIndex(u => abs >= u.v);
  let fixed = (abs / UNITS[idx]!.v).toFixed(1);
  if (Number(fixed) >= 1000 && idx > 0) {
    idx -= 1;
    fixed = (abs / UNITS[idx]!.v).toFixed(1);
  }
  return `${n < 0 ? '-' : ''}${fixed}${UNITS[idx]!.s}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'Fri 11/20' from a local 'YYYY-MM-DD' key, zone-free (matches the server's day labels). */
export function formatRecapDay(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return dayKey;
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${m}/${d}`;
}

/** 'Fri 8:04 am' for an ISO instant, in the run's zone. */
export function formatRecapTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(date)) parts[p.type] = p.value;
  return `${parts.weekday} ${parts.hour}:${parts.minute} ${(parts.dayPeriod ?? '').toLowerCase()}`.trim();
}

/** < 60 min "N minutes", < 48 h "about N hours", else "N days" (same words as the Discord text). */
export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(hours / 24)} days`;
}
