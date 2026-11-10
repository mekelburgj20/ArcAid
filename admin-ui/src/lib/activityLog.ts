/**
 * G14 (v2.227.0, ADR 0037) - shared bits of the activity timeline (types,
 * category chips, URL filter keys, time formatting).
 */

/** One line of a row's details panel (G15). `time`: `value` is a SQLite UTC stamp. */
export interface ActivityFact {
  label: string;
  value: string;
  time?: boolean;
}

/** One changed key of an admin edit. A secret carries no values. */
export interface ActivityChange {
  key: string;
  label: string;
  from?: string | null;
  to?: string | null;
  secret?: boolean;
}

/** The curated details panel the server builds per row (G15, v2.228.0). */
export interface ActivityDetail {
  facts: ActivityFact[];
  changes?: ActivityChange[];
  recordedKeys?: string[];
  notes?: string[];
}

export interface ActivityRow {
  id: number;
  created_at: string;
  tz: string;
  room_id?: string | null;
  room_name: string | null;
  category: string;
  event_type: string;
  severity: 'info' | 'problem';
  player: string | null;
  actor: string | null;
  device: string | null;
  tournament_name: string | null;
  game_name: string | null;
  table_name: string | null;
  source: string | null;
  score: number | null;
  /**
   * A42 (v2.239.0) - on a score that landed on an event round, how long after
   * the round opened ("16h 25m into round 1"). Absent on an older server.
   */
  round_time?: string | null;
  summary: string;
  reasons: string[];
  /** Absent on a server older than v2.228.0. */
  detail?: ActivityDetail;
  /** Super-admin only: the raw stored JSON. */
  details?: Record<string, unknown> | null;
}

export interface ActivityPage {
  rows: ActivityRow[];
  nextBefore: number | null;
  timezone: string;
  writeFailures?: { count: number; last: string | null };
}

export const ACTIVITY_CATEGORIES: Array<{ key: string; label: string; color: string }> = [
  { key: 'score', label: 'Scores', color: 'text-neon-green border-neon-green/40 bg-neon-green/10' },
  { key: 'device', label: 'Devices', color: 'text-neon-cyan border-neon-cyan/40 bg-neon-cyan/10' },
  { key: 'admin', label: 'Admin', color: 'text-neon-amber border-neon-amber/40 bg-neon-amber/10' },
  { key: 'bot', label: 'Bot', color: 'text-neon-purple border-neon-purple/40 bg-neon-purple/10' },
  { key: 'lifecycle', label: 'Tournament', color: 'text-neon-blue border-neon-blue/40 bg-neon-blue/10' },
  { key: 'server', label: 'Server', color: 'text-muted border-border bg-raised' },
];

/** The URL keys the server understands (`room` is super-admin only). */
export const ACTIVITY_FILTER_KEYS = ['player', 'from', 'to', 'tournament', 'game', 'category', 'q', 'problems', 'room'] as const;

/** A SQLite UTC stamp, shown in `tz` (the row's room timezone). */
export function formatActivityTime(utc: string, tz: string): string {
  const ms = Date.parse(utc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return utc;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/** The exact moment, to the second, with the zone named (the details panel). */
export function formatActivityTimeExact(utc: string, tz: string): string {
  const ms = Date.parse(utc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return utc;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/**
 * A changed value as readable text: JSON (command policy, announcement
 * routes, platform rules) pretty-printed over several lines, never one giant
 * line; anything else as it is.
 */
export function formatChangeValue(v: string): string {
  const t = v.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch { /* not JSON after all */ }
  }
  return v;
}

/** The filter part of the URL as an API query string (`?a=b`, or ''). */
export function activityQueryString(params: URLSearchParams, extra: Record<string, string> = {}): string {
  const out = new URLSearchParams();
  for (const k of ACTIVITY_FILTER_KEYS) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  const s = out.toString();
  return s ? `?${s}` : '';
}
