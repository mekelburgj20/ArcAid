import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import {
    parseCommandPolicy,
    evaluateCommandPolicy,
    commandPolicyBlockReason,
    serializeCommandPolicy,
    memberRoleIdsOf,
    DISCORD_COMMAND_POLICY_KEY,
} from '../utils/discordCommandPolicy.js';

// v2.217.0 (E7) - per-room slash-command policy.

const GUILD = '2000000000000000001';
const CH_A = '3000000000000000001';
const CH_B = '3000000000000000002';
const ROLE_X = '4000000000000000001';
const ROLE_Y = '4000000000000000002';

const noRoles = () => [];

describe('parseCommandPolicy', () => {
    it('absent / empty / garbage read as allow-everything', () => {
        for (const raw of [null, undefined, '', 'not json', '[]', '42', '{"commands": "x"}']) {
            const p = parseCommandPolicy(raw);
            expect(p.defaults).toEqual({ channelIds: [], roleIds: [] });
            expect(p.commands).toEqual({});
            expect(evaluateCommandPolicy(p, { commandName: 'ping', channelId: CH_A, memberRoleIds: [] })).toEqual({ allowed: true });
        }
    });

    it('drops ids that are not snowflakes and dedupes', () => {
        const p = parseCommandPolicy(JSON.stringify({
            version: 1,
            defaults: { channelIds: [CH_A, 'general', CH_A, 12], roleIds: ['<@&1>', ROLE_X] },
            commands: { 'list-active': { enabled: true, channelIds: ['nope', CH_B], roleIds: [] }, 'bad name!': { enabled: false } },
        }));
        expect(p.defaults.channelIds).toEqual([CH_A]);
        expect(p.defaults.roleIds).toEqual([ROLE_X]);
        expect(p.commands['list-active']!.channelIds).toEqual([CH_B]);
        expect(p.commands['bad name!']).toBeUndefined();
    });

    it('serializes a no-restriction policy as empty (row removed)', () => {
        expect(serializeCommandPolicy('garbage')).toBe('');
        expect(serializeCommandPolicy(JSON.stringify({ commands: { ping: { enabled: true } } }))).toBe('');
        const s = serializeCommandPolicy(JSON.stringify({ commands: { ping: { enabled: false, channelIds: ['x'] } } }));
        expect(JSON.parse(s)).toEqual({
            version: 1, defaults: { channelIds: [], roleIds: [] },
            commands: { ping: { enabled: false, channelIds: [], roleIds: [] } },
        });
    });
});

describe('evaluateCommandPolicy', () => {
    const policy = parseCommandPolicy(JSON.stringify({
        version: 1,
        defaults: { channelIds: [CH_A], roleIds: [] },
        commands: {
            'pick-game': { enabled: true, channelIds: [CH_B], roleIds: [ROLE_X, ROLE_Y] },
            'run-cleanup': { enabled: false, channelIds: [], roleIds: [] },
        },
    }));

    it('a command not listed inherits the defaults', () => {
        expect(evaluateCommandPolicy(policy, { commandName: 'ping', channelId: CH_A, memberRoleIds: [] }).allowed).toBe(true);
        const v = evaluateCommandPolicy(policy, { commandName: 'ping', channelId: CH_B, memberRoleIds: [] });
        expect(v).toMatchObject({ allowed: false, reason: 'channel', channelIds: [CH_A] });
    });

    it('enabled:false refuses everywhere', () => {
        expect(evaluateCommandPolicy(policy, { commandName: 'run-cleanup', channelId: CH_A, memberRoleIds: [ROLE_X] }))
            .toMatchObject({ allowed: false, reason: 'disabled' });
    });

    it('a command list overrides the default channel list', () => {
        expect(evaluateCommandPolicy(policy, { commandName: 'pick-game', channelId: CH_A, memberRoleIds: [ROLE_X] }))
            .toMatchObject({ allowed: false, reason: 'channel', channelIds: [CH_B] });
    });

    it('roles are any-of', () => {
        expect(evaluateCommandPolicy(policy, { commandName: 'pick-game', channelId: CH_B, memberRoleIds: ['999999', ROLE_Y] }).allowed).toBe(true);
        expect(evaluateCommandPolicy(policy, { commandName: 'pick-game', channelId: CH_B, memberRoleIds: ['999999'] }))
            .toMatchObject({ allowed: false, reason: 'role' });
    });
});

describe('memberRoleIdsOf', () => {
    it('handles GuildMember, API shape and nothing', () => {
        expect(memberRoleIdsOf({ roles: { cache: new Map([[ROLE_X, {}]]) } })).toEqual([ROLE_X]);
        expect(memberRoleIdsOf({ roles: [ROLE_Y] })).toEqual([ROLE_Y]);
        expect(memberRoleIdsOf(null)).toEqual([]);
    });
});

describe('commandPolicyBlockReason', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    async function room(slug: string, name: string, policy?: object) {
        const id = await createTestRoom(slug, name);
        await GameRoomSettingsService.set(id, 'DISCORD_GUILD_ID', GUILD);
        if (policy) await GameRoomSettingsService.set(id, DISCORD_COMMAND_POLICY_KEY, JSON.stringify(policy));
        return id;
    }

    it('an unlinked guild and a room without a policy allow everything', async () => {
        expect(await commandPolicyBlockReason('2999999999999999999', 'u', 'ping', CH_A, [], noRoles)).toBeNull();
        await room('cp-none', 'No Policy');
        expect(await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles)).toBeNull();
    });

    it('refuses with the disabled wording', async () => {
        await room('cp-off', 'Off Room', { commands: { ping: { enabled: false } } });
        expect(await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles))
            .toBe('This room has turned off /ping in Discord.');
    });

    it('channel wording lists mentions, capped at 5', async () => {
        const ids = Array.from({ length: 7 }, (_, i) => `30000000000000001${i}`);
        await room('cp-ch', 'Chan Room', { defaults: { channelIds: ids } });
        const text = await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles);
        expect(text).toBe(`/ping only works in ${ids.slice(0, 5).map(i => `<#${i}>`).join(', ')} and 2 more here.`);
    });

    it('role wording names roles, never ids', async () => {
        await room('cp-role', 'Role Room', { defaults: { roleIds: [ROLE_X, ROLE_Y] } });
        const named = await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], () => [{ id: ROLE_X, name: 'Mods' }, { id: ROLE_Y, name: 'Players' }]);
        expect(named).toBe('/ping is limited to the roles "Mods" or "Players" in this server.');
        const unnamed = await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles);
        expect(unnamed).toBe('/ping is limited to a role this room has chosen in this server.');
        expect(unnamed).not.toContain(ROLE_X);
        expect(await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [ROLE_Y], noRoles)).toBeNull();
    });

    it('multi-room guild: allowed when ANY room allows', async () => {
        await room('cp-a', 'Alpha', { commands: { ping: { enabled: false } } });
        await room('cp-b', 'Beta');
        expect(await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles)).toBeNull();
    });

    it('multi-room guild: all refuse -> first room by name gives the reason', async () => {
        await room('cp-z', 'Zulu', { commands: { ping: { enabled: false } } });
        await room('cp-a2', 'Alpha', { defaults: { channelIds: [CH_B] } });
        expect(await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles))
            .toBe(`/ping only works in <#${CH_B}> here.`);
    });

    it('ignores Discord-off and suspended rooms', async () => {
        const off = await room('cp-off2', 'Off', {});
        await GameRoomSettingsService.set(off, 'DISCORD_ENABLED', 'false');
        const susp = await room('cp-susp', 'Suspended');
        const db = await getDatabase();
        await db.run(`UPDATE game_rooms SET suspended_at = CURRENT_TIMESTAMP WHERE id = ?`, susp);
        await room('cp-strict', 'Strict', { commands: { ping: { enabled: false } } });
        // The two open-everything rooms are out of scope, so the strict one decides.
        expect(await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles))
            .toBe('This room has turned off /ping in Discord.');
    });

    it('a malformed stored value allows everything', async () => {
        const id = await createTestRoom('cp-bad', 'Bad');
        await GameRoomSettingsService.set(id, 'DISCORD_GUILD_ID', GUILD);
        await GameRoomSettingsService.set(id, DISCORD_COMMAND_POLICY_KEY, '{not json');
        expect(await commandPolicyBlockReason(GUILD, 'u', 'ping', CH_A, [], noRoles)).toBeNull();
    });
});
