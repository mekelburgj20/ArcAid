/**
 * Per-kind announcement channels (v2.221.0, E8).
 *
 * A room admin can send each KIND of bot post to its own Discord channel in
 * Room Settings -> Discord -> Announcement channels. Stored as ONE
 * `game_room_settings` key, `DISCORD_ANNOUNCE_ROUTES`:
 *
 *   { "version": 1, "routes": { "tournament": "<id>", "picks": "<id>", "polls": "<id>" } }
 *
 * Every route is optional; an absent/unusable route means "Room default"
 * (`DISCORD_ANNOUNCEMENT_CHANNEL_ID`). A tournament with its own channel
 * ignores the routes entirely - the narrower scope wins
 * (`resolveAnnouncementChannelId` in `./discord.ts` is the one resolver).
 *
 * `parseAnnounceRoutes` is the ONLY reader of the column: tolerant (bad JSON,
 * a wrong version, a non-string or non-snowflake value -> null for that
 * route), never throws.
 */

export const DISCORD_ANNOUNCE_ROUTES_KEY = 'DISCORD_ANNOUNCE_ROUTES';

export type AnnounceKind = 'tournament' | 'picks' | 'polls';

/** Label + description per kind; the Room Settings rows mirror this copy. */
export const ANNOUNCE_KINDS: ReadonlyArray<{ kind: AnnounceKind; label: string; description: string }> = [
    { kind: 'tournament', label: 'Tournament posts', description: 'Now Active, winners, season standings, event rounds' },
    { kind: 'picks', label: 'Pick prompts and warnings', description: 'Pick Needed, reminders, timeouts, nothing queued' },
    { kind: 'polls', label: 'Polls', description: 'Season polls and their notices' },
];

export type AnnounceRoutes = Record<AnnounceKind, string | null>;

/** Same snowflake shape `discordCommandPolicy.ts` accepts. */
const SNOWFLAKE_RE = /^\d{5,25}$/;

const EMPTY: AnnounceRoutes = { tournament: null, picks: null, polls: null };

export function parseAnnounceRoutes(raw: string | null | undefined): AnnounceRoutes {
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
        if (typeof v === 'string' && SNOWFLAKE_RE.test(v.trim())) out[kind] = v.trim();
    }
    return out;
}

/**
 * Canonical stored form: re-serialized through the parser so garbage never
 * lands in the DB. No usable route -> '' (the settings save removes the row).
 */
export function serializeAnnounceRoutes(raw: string | null | undefined): string {
    const routes = parseAnnounceRoutes(raw);
    const kept: Partial<AnnounceRoutes> = {};
    for (const { kind } of ANNOUNCE_KINDS) {
        if (routes[kind]) kept[kind] = routes[kind];
    }
    if (Object.keys(kept).length === 0) return '';
    return JSON.stringify({ version: 1, routes: kept });
}
