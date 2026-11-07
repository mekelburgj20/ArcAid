/**
 * Per-kind announcement channels (v2.221.0, E8; `scores` + per-tournament
 * overrides v2.226.0, E16).
 *
 * ROOM level: a room admin can send each KIND of bot post to its own Discord
 * channel in Room Settings -> Discord -> Announcement channels. Stored as ONE
 * `game_room_settings` key, `DISCORD_ANNOUNCE_ROUTES`:
 *
 *   { "version": 1, "routes": { "tournament": "<id>", "picks": "<id>", "polls": "<id>", "scores": "<id>" } }
 *
 * Every route is optional; an absent/unusable route means "Room default"
 * (`DISCORD_ANNOUNCEMENT_CHANNEL_ID`) - except `scores`, which falls back to
 * the room's `tournament` route first.
 *
 * TOURNAMENT level: `tournaments.discord_announce_routes` (migration 208) has
 * the same shape, but a value may also be the literal `'none'` (= don't post
 * that kind for this tournament). It sits ABOVE the tournament's catch-all
 * `discord_channel_id`. `resolveAnnouncementChannelId` in `./discord.ts` is the
 * one resolver and documents the full precedence.
 *
 * `parseAnnounceRoutes` is the ONLY reader of the room setting and
 * `parseTournamentAnnounceRoutes` the ONLY reader of the tournament column:
 * both tolerant (bad JSON, a wrong version, a non-string or non-snowflake
 * value -> null for that route), never throw.
 */

export const DISCORD_ANNOUNCE_ROUTES_KEY = 'DISCORD_ANNOUNCE_ROUTES';

export type AnnounceKind = 'tournament' | 'picks' | 'polls' | 'scores';

/** Label + description per kind; the Room Settings rows and the tournament form mirror this copy. */
export const ANNOUNCE_KINDS: ReadonlyArray<{ kind: AnnounceKind; label: string; description: string }> = [
    { kind: 'tournament', label: 'Tournament posts', description: 'Now Active, winners, season standings, event rounds' },
    { kind: 'picks', label: 'Pick prompts and warnings', description: 'Pick Needed, reminders, timeouts, nothing queued' },
    { kind: 'polls', label: 'Polls', description: 'Season polls and their notices' },
    { kind: 'scores', label: 'Top-score posts', description: 'Glory and dethrone posts for top-N scores' },
];

export type AnnounceRoutes = Record<AnnounceKind, string | null>;

/** Per-tournament value sentinel: don't post this kind (same literal as `ANNOUNCE_NONE`). */
export const ANNOUNCE_ROUTE_NONE = 'none';

/** Same snowflake shape `discordCommandPolicy.ts` accepts. */
const SNOWFLAKE_RE = /^\d{5,25}$/;

const EMPTY: AnnounceRoutes = { tournament: null, picks: null, polls: null, scores: null };

function readRoutes(raw: string | null | undefined, allowNone: boolean): AnnounceRoutes {
    const out: AnnounceRoutes = { ...EMPTY };
    if (typeof raw !== 'string' || raw.trim() === '') return out;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    const obj = parsed as { version?: unknown; routes?: unknown };
    if (obj.version !== 1) return out;
    if (!obj.routes || typeof obj.routes !== 'object' || Array.isArray(obj.routes)) return out;
    const routes = obj.routes as Record<string, unknown>;
    for (const { kind } of ANNOUNCE_KINDS) {
        const v = routes[kind];
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (SNOWFLAKE_RE.test(t)) out[kind] = t;
        else if (allowNone && t === ANNOUNCE_ROUTE_NONE) out[kind] = ANNOUNCE_ROUTE_NONE;
    }
    return out;
}

function writeRoutes(routes: AnnounceRoutes): string {
    const kept: Partial<AnnounceRoutes> = {};
    for (const { kind } of ANNOUNCE_KINDS) {
        if (routes[kind]) kept[kind] = routes[kind];
    }
    if (Object.keys(kept).length === 0) return '';
    return JSON.stringify({ version: 1, routes: kept });
}

/** Room setting reader: snowflakes only. */
export function parseAnnounceRoutes(raw: string | null | undefined): AnnounceRoutes {
    return readRoutes(raw, false);
}

/**
 * Canonical stored form: re-serialized through the parser so garbage never
 * lands in the DB. No usable route -> '' (the settings save removes the row).
 */
export function serializeAnnounceRoutes(raw: string | null | undefined): string {
    return writeRoutes(parseAnnounceRoutes(raw));
}

/**
 * `tournaments.discord_announce_routes` reader (v2.226.0, E16): a value is a
 * snowflake or `'none'`; anything else is null (= fall through to the
 * tournament's catch-all `discord_channel_id`).
 */
export function parseTournamentAnnounceRoutes(raw: string | null | undefined): AnnounceRoutes {
    return readRoutes(raw, true);
}

/** Canonical stored form of the tournament column; no usable entry -> ''. */
export function serializeTournamentAnnounceRoutes(raw: string | null | undefined): string {
    return writeRoutes(parseTournamentAnnounceRoutes(raw));
}
