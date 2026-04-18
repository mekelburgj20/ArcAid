import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveServerNickname, __resetNicknameCacheForTesting } from '../services/DiscordNicknameResolver.js';

type Member = {
    nick: string | null;
    user: { id: string; username: string; global_name: string | null };
};

// Stub discord.js REST.get() to return a fixed member list without hitting the network.
let lastQuery: string | null = null;
let callCount = 0;
let mockMembers: Member[] = [];

vi.mock('discord.js', () => {
    class REST {
        setToken() { return this; }
        async get(_route: unknown, opts: any) {
            callCount += 1;
            lastQuery = opts?.query?.get('query') ?? null;
            return mockMembers;
        }
    }
    const Routes = { guildMembersSearch: (g: string) => `/guilds/${g}/members/search` };
    return { REST, Routes };
});

function setMembers(members: Member[]) {
    mockMembers = members;
}

describe('DiscordNicknameResolver', () => {
    beforeEach(() => {
        process.env.DISCORD_BOT_TOKEN = 'test-token';
        callCount = 0;
        lastQuery = null;
        mockMembers = [];
        __resetNicknameCacheForTesting();
    });

    afterEach(() => {
        delete process.env.DISCORD_BOT_TOKEN;
    });

    it('matches exact nickname case-insensitively and returns nickname as displayed name', async () => {
        setMembers([
            { nick: 'Justin', user: { id: '111', username: 'justinm', global_name: 'Justin M.' } },
        ]);

        const got = await resolveServerNickname('guild-1', 'justin');
        expect(got).not.toBeNull();
        expect(got!.discordUserId).toBe('111');
        expect(got!.serverNickname).toBe('Justin');
        expect(got!.matchedField).toBe('nickname');
    });

    it('trims whitespace in the query', async () => {
        setMembers([
            { nick: 'Pinny', user: { id: '222', username: 'pinny', global_name: null } },
        ]);

        const got = await resolveServerNickname('guild-1', '  pinny  ');
        expect(got).not.toBeNull();
        expect(lastQuery).toBe('pinny');
    });

    it('falls back to global_name when no nickname matches', async () => {
        setMembers([
            { nick: 'Other', user: { id: '333', username: 'someuser', global_name: 'Justin' } },
        ]);

        const got = await resolveServerNickname('guild-1', 'justin');
        expect(got).not.toBeNull();
        expect(got!.discordUserId).toBe('333');
        // No nickname match → first display chain element is globalName (fallbackToGlobal on by default)
        expect(got!.serverNickname).toBe('Other');
        expect(got!.matchedField).toBe('globalName');
    });

    it('falls back to username when no nickname or global_name matches', async () => {
        setMembers([
            { nick: null, user: { id: '444', username: 'justin', global_name: null } },
        ]);

        const got = await resolveServerNickname('guild-1', 'JUSTIN');
        expect(got).not.toBeNull();
        expect(got!.matchedField).toBe('username');
        expect(got!.discordUserId).toBe('444');
    });

    it('prefers a nickname match over a later globalName match', async () => {
        setMembers([
            { nick: null, user: { id: '555', username: 'somebody', global_name: 'Justin' } },
            { nick: 'Justin', user: { id: '666', username: 'anotheruser', global_name: null } },
        ]);

        const got = await resolveServerNickname('guild-1', 'justin');
        expect(got!.discordUserId).toBe('666');
        expect(got!.matchedField).toBe('nickname');
    });

    it('prefers a globalName match over a later username match', async () => {
        setMembers([
            { nick: null, user: { id: '777', username: 'justin', global_name: null } },
            { nick: null, user: { id: '888', username: 'coolperson', global_name: 'Justin' } },
        ]);

        const got = await resolveServerNickname('guild-1', 'justin');
        expect(got!.discordUserId).toBe('888');
        expect(got!.matchedField).toBe('globalName');
    });

    it('returns null when no member matches', async () => {
        setMembers([
            { nick: 'Someone', user: { id: '999', username: 'someone', global_name: null } },
        ]);

        const got = await resolveServerNickname('guild-1', 'ghost');
        expect(got).toBeNull();
    });

    it('returns null for empty or whitespace-only names without hitting the API', async () => {
        expect(await resolveServerNickname('guild-1', '')).toBeNull();
        expect(await resolveServerNickname('guild-1', '   ')).toBeNull();
        expect(callCount).toBe(0);
    });

    it('returns null when guildId is empty', async () => {
        expect(await resolveServerNickname('', 'justin')).toBeNull();
        expect(callCount).toBe(0);
    });

    it('memoizes guild-search responses within the TTL window', async () => {
        setMembers([
            { nick: 'Cached', user: { id: '123', username: 'cached', global_name: null } },
        ]);

        await resolveServerNickname('guild-1', 'cached');
        await resolveServerNickname('guild-1', 'cached');
        await resolveServerNickname('guild-1', 'CACHED');

        expect(callCount).toBe(1);
    });

    it('skips globalName in the display chain when fallbackToGlobal is false', async () => {
        setMembers([
            { nick: null, user: { id: '321', username: 'justin', global_name: 'Justin Display' } },
        ]);

        const got = await resolveServerNickname('guild-1', 'justin', { fallbackToGlobal: false });
        expect(got!.matchedField).toBe('username');
        // With fallbackToGlobal=false, globalName is skipped in the display chain → serverNickname falls to username
        expect(got!.serverNickname).toBe('justin');
    });

    it('returns empty array path when DISCORD_BOT_TOKEN is unset', async () => {
        delete process.env.DISCORD_BOT_TOKEN;
        setMembers([
            { nick: 'Justin', user: { id: '111', username: 'justin', global_name: null } },
        ]);

        const got = await resolveServerNickname('guild-1', 'justin');
        expect(got).toBeNull();
        expect(callCount).toBe(0);
    });
});
