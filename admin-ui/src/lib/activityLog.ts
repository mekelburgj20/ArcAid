/**
 * G14 (v2.227.0, ADR 0037) - shared bits of the activity timeline (types,
 * category chips, URL filter keys, time formatting).
 */

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
  summary: string;
  reasons: string[];
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
