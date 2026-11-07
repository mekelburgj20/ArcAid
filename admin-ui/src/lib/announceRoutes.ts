/**
 * Announcement kinds and the per-tournament routes value (v2.226.0, E16).
 *
 * Mirrors `ANNOUNCE_KINDS` / `parseTournamentAnnounceRoutes` in
 * src/utils/discordAnnounceRoutes.ts. The server re-serializes the value
 * through its own parser on save, so this side only has to be shape-correct.
 */

export type AnnounceKind = 'tournament' | 'picks' | 'polls' | 'scores';

export const ANNOUNCE_KINDS: ReadonlyArray<{ kind: AnnounceKind; label: string; description: string }> = [
  { kind: 'tournament', label: 'Tournament posts', description: 'Now Active, winners, season standings, event rounds' },
  { kind: 'picks', label: 'Pick prompts and warnings', description: 'Pick Needed, reminders, timeouts, nothing queued' },
  { kind: 'polls', label: 'Polls', description: 'Season polls and their notices' },
  { kind: 'scores', label: 'Top-score posts', description: 'Glory and dethrone posts for top-N scores' },
];

/** The per-kind "don't post" value, and the whole-tournament one in `discord_channel_id`. */
export const ANNOUNCE_NONE = 'none';

export const SNOWFLAKE_RE = /^\d{5,25}$/;

/** Per-kind form values: '' = Room default, 'none' = Don't post, else a channel id (possibly mid-typing). */
export type TournamentAnnounceRoutes = Partial<Record<AnnounceKind, string>>;

/** Reads `tournaments.discord_announce_routes`; tolerant, never throws. */
export function parseTournamentAnnounceRoutes(raw: string | null | undefined): TournamentAnnounceRoutes {
  const out: TournamentAnnounceRoutes = {};
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  const obj = parsed as { version?: unknown; routes?: unknown };
  if (obj.version !== 1 || typeof obj.routes !== 'object' || obj.routes === null || Array.isArray(obj.routes)) return out;
  const routes = obj.routes as Record<string, unknown>;
  for (const { kind } of ANNOUNCE_KINDS) {
    const v = typeof routes[kind] === 'string' ? (routes[kind] as string).trim() : '';
    if (v === ANNOUNCE_NONE || SNOWFLAKE_RE.test(v)) out[kind] = v;
  }
  return out;
}

/** '' when no kind is overridden (the API stores NULL). */
export function serializeTournamentAnnounceRoutes(routes: TournamentAnnounceRoutes): string {
  const kept: Partial<Record<AnnounceKind, string>> = {};
  for (const { kind } of ANNOUNCE_KINDS) {
    const v = (routes[kind] ?? '').trim();
    if (v) kept[kind] = v;
  }
  if (Object.keys(kept).length === 0) return '';
  return JSON.stringify({ version: 1, routes: kept });
}
