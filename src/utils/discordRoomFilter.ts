import { getDatabase } from '../database/database.js';

/**
 * Returns the set of game_room_ids that Discord read commands must exclude:
 * rooms with `DISCORD_ENABLED=false` (toggling Discord off severs all
 * Discord visibility into a room, so its tournaments/games/submissions
 * shouldn't surface in slash-command output either), UNION rooms with
 * `JOIN_POLICY=approval` (v2.39.0 — an approval room is invisible to
 * non-members; a cross-room Discord read command has no per-guild-membership
 * concept today, so the safe default is to exclude it entirely rather than
 * leak scores/games to anyone who can run the command. See ROADMAP for a
 * future guild-implies-membership refinement), UNION suspended rooms (S22
 * Phase 2, v2.44.0 — `game_rooms.suspended_at IS NOT NULL`; suspension hides
 * a room from everyone except super-admins, and Discord slash commands have
 * no super-admin concept, so a suspended room is excluded unconditionally).
 */
export async function discordExcludedRoomIds(): Promise<string[]> {
    const db = await getDatabase();
    const settingsRows = (await db.all(
        `SELECT game_room_id FROM game_room_settings
         WHERE (key = 'DISCORD_ENABLED' AND value = 'false')
            OR (key = 'JOIN_POLICY' AND value = 'approval')`,
    )) as Array<{ game_room_id: string }>;
    const suspendedRows = (await db.all(
        `SELECT id AS game_room_id FROM game_rooms WHERE suspended_at IS NOT NULL`,
    )) as Array<{ game_room_id: string }>;
    return Array.from(new Set([...settingsRows, ...suspendedRows].map(r => r.game_room_id)));
}

/**
 * Builds a SQL fragment + parameter array that excludes rows whose tournament
 * belongs to a Discord-disabled room. The fragment is meant to be appended to
 * a WHERE clause (with a leading `AND`). If no rooms are disabled, returns an
 * empty fragment and no params — callers can always splat `...params` safely.
 *
 * `tournamentGameRoomColumn` is the qualified column to test (e.g. `t.game_room_id`
 * when the query joins `tournaments t`). Rows with a NULL tournament (manual
 * games) are always allowed through since they have no room attribution.
 *
 * NOT the read-command path any more (v2.120.1): the five read commands now
 * go through `resolveGuildReadScope` + `buildGuildScopedRoomSqlFilter` below,
 * which scope POSITIVELY to the invoking guild instead of only subtracting.
 * Kept exported as the subtract-only primitive (and its test coverage) for
 * any future caller that legitimately has no guild to scope to.
 */
export async function buildEnabledRoomSqlFilter(
    tournamentGameRoomColumn: string,
): Promise<{ sql: string; params: string[] }> {
    const disabled = await discordExcludedRoomIds();
    if (disabled.length === 0) return { sql: '', params: [] };
    const placeholders = disabled.map(() => '?').join(', ');
    return {
        sql: `AND (${tournamentGameRoomColumn} IS NULL OR ${tournamentGameRoomColumn} NOT IN (${placeholders}))`,
        params: disabled,
    };
}

/**
 * The resolved read scope for a Discord slash command invoked in a guild.
 *
 * `roomIds` are the rooms whose data the invoking guild may see (already
 * minus `discordExcludedRoomIds`). An EMPTY array is meaningful and distinct
 * from `null`: the guild IS linked, but everything it links to is currently
 * excluded (approval-gated / Discord-off / suspended) — the command should
 * render its normal "nothing to show" output, not the not-linked notice.
 *
 * `legacyEnv` marks the single-tenant env deployment fallback (see
 * `resolveGuildReadScope`); it is the ONLY case in which rows with no room
 * attribution at all (`game_room_id IS NULL` — legacy manual games) are
 * allowed through, matching the pre-v2.120.1 `IS NULL` allowance.
 */
export interface GuildReadScope {
    roomIds: string[];
    legacyEnv: boolean;
}

/**
 * User-facing text for a guild that maps to no Arcaid room. Commands own the
 * reply (ephemeral) so the copy stays in one place.
 */
export const DISCORD_GUILD_NOT_LINKED_MESSAGE =
    "This Discord server isn't linked to an Arcaid game room yet. " +
    'A room admin can link it under Room Settings → Discord → Discord Guild ID.';

/**
 * Resolves which rooms a READ command invoked in `guildId` is allowed to see.
 *
 * Pre-v2.120.1 the read commands only ever SUBTRACTED rooms
 * (`buildEnabledRoomSqlFilter`), never scoped to the invoking guild — so
 * `/list-active` in one server listed active games from every other room in
 * the deployment (owner report: RTX Pinball showing "The Fridge"'s
 * tournament). This is the read-side twin of the write-side guard in
 * `discordWriteTarget.ts`.
 *
 * Resolution order:
 *   1. No guild (DM interaction) → `null`. DMs carry no room context, so the
 *      cross-room leak is identical there; DM invocations get the not-linked
 *      notice rather than a deployment-wide dump.
 *   2. Rooms explicitly linked via `game_room_settings.DISCORD_GUILD_ID =
 *      guildId` (the same lookup `guildInteractionBlockReason` performs),
 *      minus `discordExcludedRoomIds()`. Returned even when the subtraction
 *      empties the list — see `GuildReadScope`.
 *   3. Legacy single-tenant fallback: NO room is explicitly linked to this
 *      guild AND `process.env.DISCORD_GUILD_ID === guildId`. Rooms with no
 *      per-room `DISCORD_GUILD_ID` value (absent or empty) become the scope,
 *      minus the exclusions, and NULL-room rows are allowed. This mirrors
 *      `validateDiscordWriteTarget`'s `perRoomGuildId || process.env.
 *      DISCORD_GUILD_ID` precedence for the rooms it covers; it is stricter
 *      in exactly one situation — when a room IS explicitly linked to the env
 *      guild, the write path still lets the env fallback reach OTHER
 *      settingless rooms while this read path does not (step 2 wins outright).
 *      The stricter read is deliberate: a deployment that has started
 *      configuring per-room guild ids is multi-room, and leaking the
 *      unconfigured rooms into it is the very bug being fixed.
 *   4. Otherwise → `null` (not linked).
 */
export async function resolveGuildReadScope(
    guildId: string | null | undefined,
): Promise<GuildReadScope | null> {
    if (!guildId) return null;

    const db = await getDatabase();
    const linkedRows = (await db.all(
        `SELECT game_room_id FROM game_room_settings
         WHERE key = 'DISCORD_GUILD_ID' AND value = ?`,
        guildId,
    )) as Array<{ game_room_id: string }>;

    const excluded = new Set(await discordExcludedRoomIds());

    if (linkedRows.length > 0) {
        const roomIds = Array.from(new Set(linkedRows.map(r => r.game_room_id)))
            .filter(id => !excluded.has(id));
        return { roomIds, legacyEnv: false };
    }

    if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_GUILD_ID === guildId) {
        const settinglessRows = (await db.all(
            `SELECT id AS game_room_id FROM game_rooms
             WHERE id NOT IN (
                 SELECT game_room_id FROM game_room_settings
                 WHERE key = 'DISCORD_GUILD_ID' AND value IS NOT NULL AND value != ''
             )`,
        )) as Array<{ game_room_id: string }>;
        const roomIds = Array.from(new Set(settinglessRows.map(r => r.game_room_id)))
            .filter(id => !excluded.has(id));
        return { roomIds, legacyEnv: true };
    }

    return null;
}

/**
 * Builds the guild-scoped WHERE fragment for a resolved `GuildReadScope`.
 * Appended to a WHERE clause with a leading `AND`, mirroring
 * `buildEnabledRoomSqlFilter`'s calling convention (`...params` splat).
 *
 * `tournamentGameRoomColumn` is the qualified column to test (e.g.
 * `t.game_room_id`). NULL-room rows are admitted ONLY under `legacyEnv`.
 * A linked-but-fully-excluded scope yields `AND 1 = 0` — matching nothing —
 * rather than an empty fragment, which would silently restore the leak.
 */
export function buildGuildScopedRoomSqlFilter(
    tournamentGameRoomColumn: string,
    scope: GuildReadScope,
): { sql: string; params: string[] } {
    const placeholders = scope.roomIds.map(() => '?').join(', ');

    if (scope.legacyEnv) {
        if (scope.roomIds.length === 0) {
            return { sql: `AND ${tournamentGameRoomColumn} IS NULL`, params: [] };
        }
        return {
            sql: `AND (${tournamentGameRoomColumn} IS NULL OR ${tournamentGameRoomColumn} IN (${placeholders}))`,
            params: scope.roomIds,
        };
    }

    if (scope.roomIds.length === 0) {
        return { sql: 'AND 1 = 0', params: [] };
    }
    return {
        sql: `AND ${tournamentGameRoomColumn} IN (${placeholders})`,
        params: scope.roomIds,
    };
}

/**
 * Point membership test for the same scope — the guard form used by admin
 * commands that resolve a SINGLE tournament/room by id (`/nominate-picker`,
 * `/pause-pick`) rather than filtering a list.
 *
 * A null/absent `gameRoomId` (a tournament with no room attribution) is
 * admitted ONLY under `legacyEnv`, matching `buildGuildScopedRoomSqlFilter`'s
 * NULL policy — otherwise an unattributed tournament would be mutable from
 * every guild in the deployment.
 */
export function isRoomInGuildScope(
    gameRoomId: string | null | undefined,
    scope: GuildReadScope | null,
): boolean {
    if (!scope) return false;
    if (!gameRoomId) return scope.legacyEnv;
    return scope.roomIds.includes(gameRoomId);
}

/**
 * Reply text for an admin command pointed at a tournament outside the
 * invoking guild's scope. Distinct from `DISCORD_GUILD_NOT_LINKED_MESSAGE`
 * (which is about the SERVER having no room at all) and worded like the
 * write-path denials in `discordWriteTarget`'s callers.
 */
export const DISCORD_FOREIGN_TOURNAMENT_MESSAGE =
    "That tournament belongs to a game room this Discord server isn't linked to.";
