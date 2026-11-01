import { getDatabase } from '../database/database.js';

/**
 * Returns the set of game_room_ids that Discord commands must exclude
 * UNCONDITIONALLY, whoever is asking: rooms with `DISCORD_ENABLED=false`
 * (toggling Discord off severs all Discord visibility into a room), UNION
 * suspended rooms (S22 Phase 2, v2.44.0 - `game_rooms.suspended_at IS NOT
 * NULL`; suspension hides a room from everyone except super-admins, and
 * Discord slash commands have no super-admin concept).
 *
 * `JOIN_POLICY=approval` rooms are NOT in this set as of v2.212.0 (E3): an
 * approval room is invisible to NON-members only, so it is decided per
 * invoking user by `resolveGuildReadScope` / `validateDiscordWriteTarget`
 * through `discordApprovalRoomIds` below.
 */
export async function discordExcludedRoomIds(): Promise<string[]> {
    const db = await getDatabase();
    const settingsRows = (await db.all(
        `SELECT game_room_id FROM game_room_settings
         WHERE key = 'DISCORD_ENABLED' AND value = 'false'`,
    )) as Array<{ game_room_id: string }>;
    const suspendedRows = (await db.all(
        `SELECT id AS game_room_id FROM game_rooms WHERE suspended_at IS NOT NULL`,
    )) as Array<{ game_room_id: string }>;
    return Array.from(new Set([...settingsRows, ...suspendedRows].map(r => r.game_room_id)));
}

/**
 * game_room_ids with `JOIN_POLICY=approval` (v2.39.0 - invisible to
 * non-members). Whether one is in scope depends on the invoking Discord user:
 * see `discordUserVisibleRoomIds`.
 */
export async function discordApprovalRoomIds(): Promise<string[]> {
    const db = await getDatabase();
    const rows = (await db.all(
        `SELECT game_room_id FROM game_room_settings
         WHERE key = 'JOIN_POLICY' AND value = 'approval'`,
    )) as Array<{ game_room_id: string }>;
    return Array.from(new Set(rows.map(r => r.game_room_id)));
}

/**
 * Membership test for the invoking Discord user against a set of rooms,
 * returning the subset they may see. Same identity expansion as
 * `RoomAccessService.canViewRoom`: the Discord id is expanded through the
 * identity-link layer (so a Google-linked member matches) and checked with
 * `RoomMembershipService.isMemberAny`; room admins (`AdminService.
 * getRoomsForDiscordUser`, link-aware) count as members. A missing userId
 * yields the empty set (today's exclude behaviour - nothing widens silently).
 */
export async function discordUserVisibleRoomIds(
    userId: string | null | undefined,
    roomIds: string[],
): Promise<Set<string>> {
    const visible = new Set<string>();
    if (!userId || roomIds.length === 0) return visible;
    const { IdentityLinkService } = await import('../services/IdentityLinkService.js');
    const { RoomMembershipService } = await import('../services/RoomMembershipService.js');
    const { AdminService } = await import('../services/AdminService.js');
    const adminRoomIds = new Set(await AdminService.getRoomsForDiscordUser(userId));
    const candidates = Array.from(await IdentityLinkService.expandCandidates(userId));
    for (const roomId of roomIds) {
        if (adminRoomIds.has(roomId) || await RoomMembershipService.isMemberAny(candidates, roomId)) {
            visible.add(roomId);
        }
    }
    return visible;
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
    // Subtract-only primitive with no user: approval rooms stay excluded.
    const disabled = Array.from(new Set([
        ...(await discordExcludedRoomIds()),
        ...(await discordApprovalRoomIds()),
    ]));
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
 * minus `discordExcludedRoomIds`, and minus approval rooms the invoking user
 * is not a member of). An EMPTY array is meaningful and distinct from `null`:
 * the guild IS linked, but everything it links to is currently out of scope.
 * `notMemberOf` names the approval rooms dropped ONLY because the user is not
 * a member (v2.212.0, E3): when `roomIds` is empty and this is non-empty the
 * command replies with `notMemberMessage` instead of "nothing to show".
 *
 * `legacyEnv` marks the single-tenant env deployment fallback (see
 * `resolveGuildReadScope`); it is the ONLY case in which rows with no room
 * attribution at all (`game_room_id IS NULL` — legacy manual games) are
 * allowed through, matching the pre-v2.120.1 `IS NULL` allowance.
 */
export interface GuildReadScope {
    roomIds: string[];
    legacyEnv: boolean;
    notMemberOf: Array<{ slug: string; name: string }>;
}

/**
 * User-facing text for a guild that maps to no Arcaid room. Commands own the
 * reply (ephemeral) so the copy stays in one place.
 */
export const DISCORD_GUILD_NOT_LINKED_MESSAGE =
    "This Discord server isn't linked to an Arcaid game room yet. " +
    'A room admin can link it under Room Settings → Discord → Discord Guild ID.';

/**
 * Reply text for a linked guild whose rooms are approval rooms the invoking
 * user has not joined. Build the full reply with `notMemberMessage(...)`.
 */
export const DISCORD_NOT_A_MEMBER_MESSAGE =
    "You aren't a member of this server's Arcaid game room yet, so there is nothing to show you. " +
    'Request to join it on the web:';

export function notMemberMessage(notMemberOf: Array<{ slug: string; name: string }>): string {
    const lines = notMemberOf.map(r => `${r.name}: https://arcaid.app/${r.slug}`);
    return `${DISCORD_NOT_A_MEMBER_MESSAGE}\n${lines.join('\n')}`;
}

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
 *
 * Approval rooms (v2.212.0, E3): in scope when `userId` (the invoking Discord
 * user) is a member or admin of the room (`discordUserVisibleRoomIds`), out of
 * scope otherwise and listed in `notMemberOf`. An undefined `userId` excludes
 * them (no caller silently widens). Discord-off and suspended rooms are out
 * regardless of membership.
 */
export async function resolveGuildReadScope(
    guildId: string | null | undefined,
    userId?: string | null,
): Promise<GuildReadScope | null> {
    if (!guildId) return null;

    const db = await getDatabase();
    const linkedRows = (await db.all(
        `SELECT game_room_id FROM game_room_settings
         WHERE key = 'DISCORD_GUILD_ID' AND value = ?`,
        guildId,
    )) as Array<{ game_room_id: string }>;

    const excluded = new Set(await discordExcludedRoomIds());
    const approval = new Set(await discordApprovalRoomIds());

    /** Applies the unconditional exclusions, then the per-user approval rule. */
    const applyPolicy = async (candidates: string[]) => {
        const live = Array.from(new Set(candidates)).filter(id => !excluded.has(id));
        const gated = live.filter(id => approval.has(id));
        const visible = await discordUserVisibleRoomIds(userId, gated);
        const roomIds = live.filter(id => !approval.has(id) || visible.has(id));
        const hidden = gated.filter(id => !visible.has(id));
        let notMemberOf: Array<{ slug: string; name: string }> = [];
        if (hidden.length > 0) {
            notMemberOf = (await db.all(
                `SELECT slug, name FROM game_rooms WHERE id IN (${hidden.map(() => '?').join(', ')})`,
                ...hidden,
            )) as Array<{ slug: string; name: string }>;
        }
        return { roomIds, notMemberOf };
    };

    if (linkedRows.length > 0) {
        const { roomIds, notMemberOf } = await applyPolicy(linkedRows.map(r => r.game_room_id));
        return { roomIds, legacyEnv: false, notMemberOf };
    }

    if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_GUILD_ID === guildId) {
        const settinglessRows = (await db.all(
            `SELECT id AS game_room_id FROM game_rooms
             WHERE id NOT IN (
                 SELECT game_room_id FROM game_room_settings
                 WHERE key = 'DISCORD_GUILD_ID' AND value IS NOT NULL AND value != ''
             )`,
        )) as Array<{ game_room_id: string }>;
        const { roomIds, notMemberOf } = await applyPolicy(settinglessRows.map(r => r.game_room_id));
        return { roomIds, legacyEnv: true, notMemberOf };
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
