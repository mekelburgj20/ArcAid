import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import {
    parseCommandPolicy,
    evaluateCommandPolicy,
    commandPolicyBlockReason,
    commandPolicyDecision,
    forceEphemeralReplies,
    serializeCommandPolicy,
    memberRoleIdsOf,
    policyRefusedAutocompleteChoices,
    POLICY_REFUSED_CHOICE_VALUE,
    DISCORD_COMMAND_POLICY_KEY,
} from '../utils/discordCommandPolicy.js';
import { MessageFlags } from 'discord.js';

// v2.217.0 (E7) - per-room slash-command policy.
// v2.218.0 (E9) - per-command ephemeral flag, default private.

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
            expect(p.defaults).toEqual({ channelIds: [], roleIds: [], publicRoleIds: [] });
            expect(p.commands).toEqual({});
            expect(evaluateCommandPolicy(p, { commandName: 'ping', channelId: CH_A, memberRoleIds: [] })).toEqual({ allowed: true, ephemeral: true });
        }
    });

    it('ephemeral is true unless the rule says false', () => {
        const p = parseCommandPolicy(JSON.stringify({
            commands: { 'list-active': { ephemeral: false }, 'pick-game': { enabled: true }, ping: { ephemeral: 'no' } },
        }));
        expect(p.commands['list-active']!.ephemeral).toBe(false);
        expect(p.commands['pick-game']!.ephemeral).toBe(true);
        expect(p.commands['ping']!.ephemeral).toBe(true);
        expect(evaluateCommandPolicy(p, { commandName: 'list-active', channelId: CH_A, memberRoleIds: [] })).toEqual({ allowed: true, ephemeral: false });
        expect(evaluateCommandPolicy(p, { commandName: 'unlisted', channelId: CH_A, memberRoleIds: [] })).toEqual({ allowed: true, ephemeral: true });
    });

    it('a visible command keeps the policy from serializing away', () => {
        const s = serializeCommandPolicy(JSON.stringify({ commands: { ping: { ephemeral: false } } }));
        expect(JSON.parse(s).commands.ping).toEqual({ enabled: true, channelIds: [], roleIds: [], ephemeral: false, publicRoleIds: [] });
        expect(serializeCommandPolicy(JSON.stringify({ commands: { ping: { ephemeral: true } } }))).toBe('');
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
            version: 1, defaults: { channelIds: [], roleIds: [], publicRoleIds: [] },
            commands: { ping: { enabled: false, channelIds: [], roleIds: [], ephemeral: true, publicRoleIds: [] } },
        });
    });
});

// v2.224.0 (E15) - two role tiers: roleIds = private reply, publicRoleIds = visible reply.
describe('publicRoleIds (two-tier roles)', () => {
    it('round-trips through serialize, drops bad ids, and alone keeps the policy stored', () => {
        const s = serializeCommandPolicy(JSON.stringify({
            defaults: { publicRoleIds: [ROLE_Y, 'nope'] },
            commands: { 'list-scores': { roleIds: [ROLE_X], publicRoleIds: [ROLE_Y, ROLE_Y] } },
        }));
        const back = parseCommandPolicy(s);
        expect(back.defaults).toEqual({ channelIds: [], roleIds: [], publicRoleIds: [ROLE_Y] });
        expect(back.commands['list-scores']).toEqual({ enabled: true, channelIds: [], roleIds: [ROLE_X], ephemeral: true, publicRoleIds: [ROLE_Y] });
        expect(serializeCommandPolicy(s)).toBe(s);
        expect(serializeCommandPolicy(JSON.stringify({ commands: { ping: { publicRoleIds: [ROLE_Y] } } }))).not.toBe('');
    });

    it('a stored policy without the field parses exactly as before', () => {
        const p = parseCommandPolicy(JSON.stringify({
            version: 1, defaults: { channelIds: [], roleIds: [ROLE_X] },
            commands: { ping: { enabled: true, channelIds: [], roleIds: [ROLE_Y], ephemeral: false } },
        }));
        expect(p.defaults.publicRoleIds).toEqual([]);
        expect(p.commands.ping!.publicRoleIds).toEqual([]);
        expect(evaluateCommandPolicy(p, { commandName: 'ping', channelId: CH_A, memberRoleIds: [ROLE_Y] })).toEqual({ allowed: true, ephemeral: false });
        expect(evaluateCommandPolicy(p, { commandName: 'ping', channelId: CH_A, memberRoleIds: [ROLE_X] })).toMatchObject({ allowed: false, reason: 'role', roleIds: [ROLE_Y] });
    });

    const policy = parseCommandPolicy(JSON.stringify({
        commands: { 'list-scores': { roleIds: [ROLE_X], publicRoleIds: [ROLE_Y] } },
    }));

    it('a publicRoleIds role alone is allowed, and the reply is visible', () => {
        expect(evaluateCommandPolicy(policy, { commandName: 'list-scores', channelId: CH_A, memberRoleIds: [ROLE_Y] }))
            .toEqual({ allowed: true, ephemeral: false });
    });

    it('a roleIds-only member is allowed with a private reply', () => {
        expect(evaluateCommandPolicy(policy, { commandName: 'list-scores', channelId: CH_A, memberRoleIds: [ROLE_X] }))
            .toEqual({ allowed: true, ephemeral: true });
    });

    it('holding neither refuses, naming the union', () => {
        expect(evaluateCommandPolicy(policy, { commandName: 'list-scores', channelId: CH_A, memberRoleIds: [] }))
            .toMatchObject({ allowed: false, reason: 'role', roleIds: [ROLE_X, ROLE_Y] });
    });

    it('publicRoleIds alone (no roleIds) still restricts who may run it', () => {
        const p = parseCommandPolicy(JSON.stringify({ commands: { ping: { publicRoleIds: [ROLE_Y] } } }));
        expect(evaluateCommandPolicy(p, { commandName: 'ping', channelId: CH_A, memberRoleIds: [ROLE_X] }))
            .toMatchObject({ allowed: false, reason: 'role', roleIds: [ROLE_Y] });
    });

    it('ephemeral:false still wins for a roleIds-only member', () => {
        const p = parseCommandPolicy(JSON.stringify({
            commands: { 'list-scores': { roleIds: [ROLE_X], publicRoleIds: [ROLE_Y], ephemeral: false } },
        }));
        expect(evaluateCommandPolicy(p, { commandName: 'list-scores', channelId: CH_A, memberRoleIds: [ROLE_X] }))
            .toEqual({ allowed: true, ephemeral: false });
    });

    it('defaults.publicRoleIds is inherited when the rule list is empty and replaced when not', () => {
        const p = parseCommandPolicy(JSON.stringify({
            defaults: { publicRoleIds: [ROLE_Y] },
            commands: { 'list-scores': { publicRoleIds: [ROLE_X] } },
        }));
        // Unlisted command inherits the default public tier.
        expect(evaluateCommandPolicy(p, { commandName: 'ping', channelId: CH_A, memberRoleIds: [ROLE_Y] })).toEqual({ allowed: true, ephemeral: false });
        expect(evaluateCommandPolicy(p, { commandName: 'ping', channelId: CH_A, memberRoleIds: [ROLE_X] })).toMatchObject({ allowed: false, reason: 'role' });
        // The rule's own list replaces the default.
        expect(evaluateCommandPolicy(p, { commandName: 'list-scores', channelId: CH_A, memberRoleIds: [ROLE_X] })).toEqual({ allowed: true, ephemeral: false });
        expect(evaluateCommandPolicy(p, { commandName: 'list-scores', channelId: CH_A, memberRoleIds: [ROLE_Y] })).toMatchObject({ allowed: false, reason: 'role' });
    });
});

describe('forceEphemeralReplies', () => {
    function fakeInteraction() {
        const calls: Array<{ method: string; options: unknown }> = [];
        const stub = (method: string) => async function (this: unknown, options?: unknown) {
            calls.push({ method, options });
            return `${method}-done`;
        };
        return { calls, interaction: { reply: stub('reply'), deferReply: stub('deferReply'), followUp: stub('followUp'), editReply: stub('editReply') } };
    }

    it('flags reply / deferReply / followUp, leaves editReply alone, forwards the result', async () => {
        const { calls, interaction } = fakeInteraction();
        forceEphemeralReplies(interaction);
        expect(await interaction.reply('Pong!')).toBe('reply-done');
        await interaction.deferReply();
        await interaction.followUp({ content: 'later', ephemeral: false });
        await interaction.editReply({ content: 'edited' });
        expect(calls[0]).toEqual({ method: 'reply', options: { content: 'Pong!', flags: MessageFlags.Ephemeral } });
        expect(calls[1]).toEqual({ method: 'deferReply', options: { flags: MessageFlags.Ephemeral } });
        // The command's own `ephemeral: false` loses; the key is dropped so discord.js never warns.
        expect(calls[2]).toEqual({ method: 'followUp', options: { content: 'later', flags: MessageFlags.Ephemeral } });
        expect(calls[3]).toEqual({ method: 'editReply', options: { content: 'edited' } });
    });

    it('keeps flags a command already set and never mutates the caller\'s object', async () => {
        const { calls, interaction } = fakeInteraction();
        forceEphemeralReplies(interaction);
        const mine = { content: 'quiet', flags: MessageFlags.SuppressEmbeds, ephemeral: true };
        await interaction.reply(mine);
        expect(calls[0]!.options).toEqual({ content: 'quiet', flags: MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral });
        expect(mine).toEqual({ content: 'quiet', flags: MessageFlags.SuppressEmbeds, ephemeral: true });
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

describe('policyRefusedAutocompleteChoices', () => {
    it('is one explanatory choice within Discord limits, carrying the sentinel', () => {
        const choices = policyRefusedAutocompleteChoices();
        expect(choices).toHaveLength(1);
        expect(choices[0]!.value).toBe(POLICY_REFUSED_CHOICE_VALUE);
        expect(choices[0]!.name).toMatch(/^Not allowed here/);
        expect(choices[0]!.name.length).toBeLessThanOrEqual(100);
        expect(choices[0]!.value.length).toBeLessThanOrEqual(100);
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

    it('ephemeral by default: unlinked guild, no policy, and a refusal', async () => {
        expect(await commandPolicyDecision('2999999999999999999', 'u', 'ping', CH_A, [], noRoles)).toEqual({ refusal: null, ephemeral: true });
        await room('cp-e-none', 'No Policy');
        expect(await commandPolicyDecision(GUILD, 'u', 'ping', CH_A, [], noRoles)).toEqual({ refusal: null, ephemeral: true });
    });

    it('a room that flips a command to visible makes it visible', async () => {
        await room('cp-e-vis', 'Visible', { commands: { 'list-active': { ephemeral: false } } });
        expect(await commandPolicyDecision(GUILD, 'u', 'list-active', CH_A, [], noRoles)).toEqual({ refusal: null, ephemeral: false });
        expect(await commandPolicyDecision(GUILD, 'u', 'ping', CH_A, [], noRoles)).toEqual({ refusal: null, ephemeral: true });
    });

    it('multi-room guild: visible only when EVERY allowing room says so', async () => {
        await room('cp-e-a', 'Alpha', { commands: { ping: { ephemeral: false } } });
        await room('cp-e-b', 'Beta');
        expect(await commandPolicyDecision(GUILD, 'u', 'ping', CH_A, [], noRoles)).toEqual({ refusal: null, ephemeral: true });
    });

    it('multi-room guild: a room that REFUSES the command has no say in its visibility', async () => {
        await room('cp-e-c', 'Charlie', { commands: { ping: { ephemeral: false } } });
        await room('cp-e-d', 'Delta', { commands: { ping: { enabled: false } } });
        expect(await commandPolicyDecision(GUILD, 'u', 'ping', CH_A, [], noRoles)).toEqual({ refusal: null, ephemeral: false });
    });

    it('public role tier: visible for that member, private for the rest, refusal names both tiers', async () => {
        await room('cp-pub', 'Pub', { commands: { 'list-scores': { roleIds: [ROLE_X], publicRoleIds: [ROLE_Y] } } });
        expect(await commandPolicyDecision(GUILD, 'u', 'list-scores', CH_A, [ROLE_Y], noRoles)).toEqual({ refusal: null, ephemeral: false });
        expect(await commandPolicyDecision(GUILD, 'u', 'list-scores', CH_A, [ROLE_X], noRoles)).toEqual({ refusal: null, ephemeral: true });
        const lister = () => [{ id: ROLE_X, name: 'Players' }, { id: ROLE_Y, name: 'Tournament Creator' }];
        expect(await commandPolicyBlockReason(GUILD, 'u', 'list-scores', CH_A, [], lister))
            .toBe('/list-scores is limited to the roles "Players" or "Tournament Creator" in this server.');
    });

    it('multi-room guild: a public role is visible only when EVERY allowing room says so for the member', async () => {
        await room('cp-pub-a', 'Alpha', { commands: { 'list-scores': { publicRoleIds: [ROLE_Y] } } });
        const beta = await room('cp-pub-b', 'Beta', { commands: { 'list-scores': { roleIds: [ROLE_Y] } } });
        expect(await commandPolicyDecision(GUILD, 'u', 'list-scores', CH_A, [ROLE_Y], noRoles)).toEqual({ refusal: null, ephemeral: true });
        await GameRoomSettingsService.set(beta, DISCORD_COMMAND_POLICY_KEY, JSON.stringify({ commands: { 'list-scores': { roleIds: [ROLE_X], publicRoleIds: [ROLE_Y] } } }));
        expect(await commandPolicyDecision(GUILD, 'u', 'list-scores', CH_A, [ROLE_Y], noRoles)).toEqual({ refusal: null, ephemeral: false });
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
