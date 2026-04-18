import { REST, Routes } from 'discord.js';
import { logError } from '../utils/logger.js';

const MEMO_TTL_MS = 30_000;

type DiscordRestMember = {
    nick: string | null;
    user: {
        id: string;
        username: string;
        global_name: string | null;
    };
};

// Sprint 13: cache entries carry an `ok` flag so transient Discord API failures
// don't lock the entire 30s window into empty-match territory. Successful
// empty-arrays are still cached (they mean "no match, don't re-fetch"); errors
// are skipped so the next call retries.
type MemoEntry = { at: number; members: DiscordRestMember[]; ok: boolean };

const searchCache = new Map<string, MemoEntry>();

function cacheKey(guildId: string, query: string): string {
    return `${guildId}::${query.toLowerCase()}`;
}

async function fetchMembersByQuery(guildId: string, query: string): Promise<DiscordRestMember[]> {
    const key = cacheKey(guildId, query);
    const cached = searchCache.get(key);
    // Only reuse cache when fresh AND the prior fetch was successful.
    if (cached && cached.ok && Date.now() - cached.at < MEMO_TTL_MS) return cached.members;

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return [];

    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const results = (await rest.get(Routes.guildMembersSearch(guildId), {
            query: new URLSearchParams({ query, limit: '10' }),
        })) as DiscordRestMember[];
        searchCache.set(key, { at: Date.now(), members: results, ok: true });
        return results;
    } catch (err) {
        logError(`DiscordNicknameResolver: search failed (guild=${guildId}, query=${query}):`, err);
        // Don't pollute cache with failure; next call retries Discord REST.
        return [];
    }
}

export type ResolvedMember = {
    discordUserId: string;
    serverNickname: string;
    rawNickname: string | null;
    globalName: string | null;
    username: string;
    matchedField: 'nickname' | 'globalName' | 'username';
};

export type ResolveOptions = {
    fallbackToGlobal?: boolean;
};

/**
 * Resolve a case-insensitive display name to a guild member.
 *
 * Matches on server nickname, global display name, or username (preserving the
 * IdentityManager auto-map behavior). Returns the member's rendered display name:
 * nickname > globalName > username, with globalName skipped when
 * `fallbackToGlobal` is false.
 *
 * Memoizes guild search responses (30s TTL) to avoid Discord rate limits under
 * submission bursts.
 */
export async function resolveServerNickname(
    guildId: string,
    name: string,
    options: ResolveOptions = {},
): Promise<ResolvedMember | null> {
    const fallbackToGlobal = options.fallbackToGlobal !== false;
    const trimmed = name.trim();
    if (!trimmed || !guildId) return null;

    const members = await fetchMembersByQuery(guildId, trimmed);
    if (!members.length) return null;

    const lower = trimmed.toLowerCase();

    const match = pickBestMatch(members, lower);
    if (!match) return null;

    const rawNickname = match.member.nick;
    const globalName = match.member.user.global_name;
    const username = match.member.user.username;

    const serverNickname = rawNickname ?? ((fallbackToGlobal && globalName) ? globalName : username);

    return {
        discordUserId: match.member.user.id,
        serverNickname,
        rawNickname,
        globalName,
        username,
        matchedField: match.field,
    };
}

function pickBestMatch(
    members: DiscordRestMember[],
    lower: string,
): { member: DiscordRestMember; field: 'nickname' | 'globalName' | 'username' } | null {
    for (const m of members) {
        if (m.nick && m.nick.toLowerCase() === lower) return { member: m, field: 'nickname' };
    }
    for (const m of members) {
        if (m.user.global_name && m.user.global_name.toLowerCase() === lower) return { member: m, field: 'globalName' };
    }
    for (const m of members) {
        if (m.user.username.toLowerCase() === lower) return { member: m, field: 'username' };
    }
    return null;
}

/** Test-only: clear the memo cache. */
export function __resetNicknameCacheForTesting(): void {
    searchCache.clear();
}
