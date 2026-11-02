import { getDatabase } from '../database/database.js';
import { logWarn } from './logger.js';
import { discordExcludedRoomIds } from './discordRoomFilter.js';

/**
 * Per-room slash-command policy (v2.217.0, E7).
 *
 * A room admin picks, in Room Settings -> Discord -> Slash commands, which
 * Arcaid commands the bot answers in the room's Discord server and may lock
 * each one to Discord ROLES and/or CHANNELS. Stored as ONE
 * `game_room_settings` key, `DISCORD_COMMAND_POLICY`:
 *
 *   { "version": 1,
 *     "defaults": { "channelIds": string[], "roleIds": string[] },
 *     "commands": { [name]: { "enabled": boolean, "channelIds": string[], "roleIds": string[] } } }
 *
 * The rules (keep them this simple):
 *   - Key absent or unparseable -> everything allowed. Malformed JSON logs ONE
 *     warn naming the room (see `loadRoomPolicy`), never throws.
 *   - A command not present in `commands` -> enabled, inherits the defaults.
 *   - Effective channel list = the command's `channelIds` when non-empty, else
 *     `defaults.channelIds`; empty = any channel. Same for roles. A member
 *     passes the role test when they hold ANY listed role.
 *   - `enabled: false` -> refused everywhere in that room's guild.
 *   - Ids are Discord snowflakes; anything not matching `SNOWFLAKE_RE` is
 *     dropped on parse.
 *
 * `commandPolicyBlockReason` below is the ONE gate - called from
 * `DiscordClient`'s InteractionCreate handler for chat-input commands AND
 * autocomplete. A guild linked to several rooms allows a command when ANY of
 * those rooms allows it, so a multi-room guild is never stricter than its
 * loosest room.
 */

export const DISCORD_COMMAND_POLICY_KEY = 'DISCORD_COMMAND_POLICY';

/** Same snowflake shape `parseJoinRoleIds` (RoomAccessService) accepts. */
const SNOWFLAKE_RE = /^\d{5,25}$/;

/** Slash-command names: Discord allows lowercase letters, digits, - and _. */
const COMMAND_NAME_RE = /^[\w-]{1,32}$/;

export interface CommandRule {
    enabled: boolean;
    channelIds: string[];
    roleIds: string[];
}

export interface CommandPolicy {
    version: 1;
    defaults: { channelIds: string[]; roleIds: string[] };
    commands: Record<string, CommandRule>;
}

export type CommandPolicyVerdict =
    | { allowed: true }
    | { allowed: false; reason: 'disabled' | 'channel' | 'role'; channelIds: string[]; roleIds: string[] };

export function emptyCommandPolicy(): CommandPolicy {
    return { version: 1, defaults: { channelIds: [], roleIds: [] }, commands: {} };
}

function idList(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const ids = v
        .map(x => (typeof x === 'string' || typeof x === 'number') ? String(x).trim() : '')
        .filter(x => SNOWFLAKE_RE.test(x));
    return Array.from(new Set(ids));
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Internal: parse, reporting whether the input was malformed. */
function parseWithStatus(raw: string | null | undefined): { policy: CommandPolicy; malformed: boolean } {
    const policy = emptyCommandPolicy();
    if (raw === null || raw === undefined || raw.trim() === '') return { policy, malformed: false };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { policy, malformed: true };
    }
    if (!isObject(parsed)) return { policy, malformed: true };
    if (isObject(parsed.defaults)) {
        policy.defaults.channelIds = idList(parsed.defaults.channelIds);
        policy.defaults.roleIds = idList(parsed.defaults.roleIds);
    }
    if (isObject(parsed.commands)) {
        for (const [name, rule] of Object.entries(parsed.commands)) {
            if (!COMMAND_NAME_RE.test(name) || !isObject(rule)) continue;
            policy.commands[name] = {
                enabled: rule.enabled !== false,
                channelIds: idList(rule.channelIds),
                roleIds: idList(rule.roleIds),
            };
        }
    }
    return { policy, malformed: false };
}

/** Pure and tolerant: absent / garbage reads as the allow-everything policy. */
export function parseCommandPolicy(raw: string | null | undefined): CommandPolicy {
    return parseWithStatus(raw).policy;
}

/** True when the policy restricts nothing (the same as having no key at all). */
export function isEmptyCommandPolicy(policy: CommandPolicy): boolean {
    if (policy.defaults.channelIds.length > 0 || policy.defaults.roleIds.length > 0) return false;
    return Object.values(policy.commands).every(r => r.enabled && r.channelIds.length === 0 && r.roleIds.length === 0);
}

/**
 * The canonical stored form of a submitted value: '' (row removed) when the
 * policy restricts nothing, else the re-serialized parse. Used by the settings
 * save so garbage never lands in the DB.
 */
export function serializeCommandPolicy(raw: string | null | undefined): string {
    const policy = parseCommandPolicy(raw);
    if (isEmptyCommandPolicy(policy)) return '';
    return JSON.stringify(policy);
}

/** Pure: does this policy let `commandName` run here for this member? */
export function evaluateCommandPolicy(
    policy: CommandPolicy,
    ctx: { commandName: string; channelId: string | null | undefined; memberRoleIds: string[] },
): CommandPolicyVerdict {
    const rule = policy.commands[ctx.commandName];
    const channelIds = rule && rule.channelIds.length > 0 ? rule.channelIds : policy.defaults.channelIds;
    const roleIds = rule && rule.roleIds.length > 0 ? rule.roleIds : policy.defaults.roleIds;
    if (rule && rule.enabled === false) {
        return { allowed: false, reason: 'disabled', channelIds, roleIds };
    }
    if (channelIds.length > 0 && !(ctx.channelId && channelIds.includes(ctx.channelId))) {
        return { allowed: false, reason: 'channel', channelIds, roleIds };
    }
    if (roleIds.length > 0 && !ctx.memberRoleIds.some(r => roleIds.includes(r))) {
        return { allowed: false, reason: 'role', channelIds, roleIds };
    }
    return { allowed: true };
}

/** One warn per (room, stored value), not one per interaction. */
const warnedMalformed = new Set<string>();

const MAX_LISTED_CHANNELS = 5;

function channelList(ids: string[]): string {
    const shown = ids.slice(0, MAX_LISTED_CHANNELS).map(id => `<#${id}>`);
    const rest = ids.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

function roleNamesText(guildId: string, roleIds: string[], listRoles: RoleLister): string | null {
    let byId = new Map<string, string>();
    try {
        byId = new Map(listRoles(guildId).map(r => [r.id, r.name]));
    } catch {
        // fall through to the generic wording
    }
    const names = roleIds.map(id => byId.get(id)).filter((n): n is string => !!n);
    if (names.length === 0) return null;
    const quoted = names.map(n => `"${n}"`);
    return quoted.length === 1
        ? quoted.join('')
        :`${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/** The ephemeral reply text for a refusal. Never prints a raw role id. */
export function refusalText(
    commandName: string,
    verdict: Exclude<CommandPolicyVerdict, { allowed: true }>,
    guildId: string,
    listRoles: RoleLister,
): string {
    if (verdict.reason === 'disabled') return `This room has turned off /${commandName} in Discord.`;
    if (verdict.reason === 'channel') return `/${commandName} only works in ${channelList(verdict.channelIds)} here.`;
    const names = roleNamesText(guildId, verdict.roleIds, listRoles);
    return names
        ? `/${commandName} is limited to the roles ${names} in this server.`
        : `/${commandName} is limited to a role this room has chosen in this server.`;
}

type RoleLister = (guildId: string) => Array<{ id: string; name: string }>;

async function defaultRoleLister(): Promise<RoleLister> {
    try {
        const { getDiscordClient } = await import('../discord/DiscordClient.js');
        const client = getDiscordClient();
        return (guildId: string) => client?.listGuildRoles(guildId) ?? [];
    } catch {
        return () => [];
    }
}

/**
 * THE gate. Returns null when the command may run, else the ephemeral reply.
 *
 * The guild's rooms are the ones whose `DISCORD_GUILD_ID` is `guildId`, minus
 * `discordExcludedRoomIds()` (Discord off / suspended - those are refused by
 * `guildInteractionBlockReason` already). No linked room -> allowed. Allowed
 * when ANY remaining room allows it (a room with no policy allows
 * everything). When all refuse, the first room by name supplies the reason.
 *
 * `userId` is accepted for symmetry with the other Discord gates and future
 * per-user rules; today the decision is channel + roles only.
 */
export async function commandPolicyBlockReason(
    guildId: string,
    _userId: string,
    commandName: string,
    channelId: string | null | undefined,
    memberRoleIds: string[],
    listRoles?: RoleLister,
): Promise<string | null> {
    const db = await getDatabase();
    const rows = (await db.all(
        `SELECT s.game_room_id AS roomId, r.name AS roomName, p.value AS policy
         FROM game_room_settings s
         JOIN game_rooms r ON r.id = s.game_room_id
         LEFT JOIN game_room_settings p
           ON p.game_room_id = s.game_room_id AND p.key = ?
         WHERE s.key = 'DISCORD_GUILD_ID' AND s.value = ?
         ORDER BY r.name COLLATE NOCASE ASC, s.game_room_id ASC`,
        DISCORD_COMMAND_POLICY_KEY, guildId,
    )) as Array<{ roomId: string; roomName: string; policy: string | null }>;
    if (rows.length === 0) return null;

    const excluded = new Set(await discordExcludedRoomIds());
    const rooms = rows.filter(r => !excluded.has(r.roomId));
    if (rooms.length === 0) return null;

    let firstRefusal: Exclude<CommandPolicyVerdict, { allowed: true }> | null = null;
    for (const room of rooms) {
        const { policy, malformed } = parseWithStatus(room.policy);
        const warnKey = `${room.roomId}:${room.policy}`;
        if (malformed && !warnedMalformed.has(warnKey)) {
            warnedMalformed.add(warnKey);
            logWarn(`DISCORD_COMMAND_POLICY for room "${room.roomName}" (${room.roomId}) is malformed - allowing every command.`);
        }
        const verdict = evaluateCommandPolicy(policy, { commandName, channelId, memberRoleIds });
        if (verdict.allowed) return null;
        if (!firstRefusal) firstRefusal = verdict;
    }
    if (!firstRefusal) return null;
    const lister = listRoles ?? await defaultRoleLister();
    return refusalText(commandName, firstRefusal, guildId, lister);
}

/**
 * Member role ids from an interaction's `member`, which is either a
 * discord.js `GuildMember` (`roles.cache`) or the raw API shape
 * (`roles: string[]`). Anything else reads as no roles.
 */
export function memberRoleIdsOf(member: unknown): string[] {
    if (!member || typeof member !== 'object') return [];
    const roles = (member as { roles?: unknown }).roles;
    if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === 'string');
    if (roles && typeof roles === 'object') {
        const cache = (roles as { cache?: { keys?: () => Iterable<string> } }).cache;
        if (cache && typeof cache.keys === 'function') return Array.from(cache.keys());
    }
    return [];
}
