import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { PermissionFlagsBits } from 'discord.js';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { BanService } from '../services/BanService.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { createbackup } from '../discord/commands/createbackup.js';
import { syncstate } from '../discord/commands/syncstate.js';
import { setup } from '../discord/commands/setup.js';
import { activategame } from '../discord/commands/activategame.js';
import { deactivategame } from '../discord/commands/deactivategame.js';
import { reorderlineup } from '../discord/commands/reorderlineup.js';
import { mapuser } from '../discord/commands/mapuser.js';

function makeInteraction(overrides: Record<string, unknown> = {}) {
    const replies: unknown[] = [];
    const interaction = {
        user: { id: 'misc-user-1', tag: 'misc-user-1#0000' },
        guildId: null,
        options: {
            getString: () => null,
            getUser: () => null,
            getFocused: () => ({ name: '', value: '' }),
        },
        deferReply: async () => {},
        editReply: async (payload: unknown) => { replies.push(payload); return payload; },
        reply: async (payload: unknown) => { replies.push(payload); return payload; },
        respond: async (payload: unknown) => { replies.push(payload); return payload; },
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, replies };
}

describe('drift-audit fix #2 — admin gates on /create-backup and /sync-state', () => {
    it('/create-backup declares Administrator as its default member permission', () => {
        const json = createbackup.data.toJSON() as { default_member_permissions?: string | null };
        expect(json.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    });

    it('/sync-state declares Administrator as its default member permission', () => {
        const json = syncstate.data.toJSON() as { default_member_permissions?: string | null };
        expect(json.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    });
});

describe('drift-audit fix #5 — /setup deprecation', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('announcement-channel replies with the deprecation notice and writes nothing', async () => {
        const { interaction, replies } = makeInteraction({
            options: { getSubcommand: () => 'announcement-channel', getChannel: () => ({ id: 'chan-1', name: 'general' }) },
        });
        await setup.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/retired/i);
        expect(text).toMatch(/Settings → Discord/);

        const db = await getDatabase();
        const row = await db.get(`SELECT value FROM settings WHERE key = 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'`);
        expect(row).toBeUndefined();
    });

    it('admin-role replies with the deprecation notice and writes nothing', async () => {
        const { interaction, replies } = makeInteraction({
            options: { getSubcommand: () => 'admin-role', getRole: () => ({ id: 'role-1', name: 'Admin' }) },
        });
        await setup.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/retired/i);
        expect(text).toMatch(/obsolete/i);

        const db = await getDatabase();
        const row = await db.get(`SELECT value FROM settings WHERE key = 'DISCORD_ADMIN_ROLE_ID'`);
        expect(row).toBeUndefined();
    });

    it('view reads the invoking guild\'s ACTUAL per-room DISCORD_ANNOUNCEMENT_CHANNEL_ID setting', async () => {
        const roomId = await createTestRoom('setup-view-room');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-setup-view');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID', 'chan-real-1');

        const { interaction, replies } = makeInteraction({
            guildId: 'guild-setup-view',
            options: { getSubcommand: () => 'view' },
        });
        await setup.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toContain('chan-real-1');
    });

    it('view says no room is linked when the guild maps to nothing', async () => {
        const { interaction, replies } = makeInteraction({
            guildId: 'guild-setup-unmapped',
            options: { getSubcommand: () => 'view' },
        });
        await setup.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/No Arcaid room is linked/i);
    });
});

describe('drift-audit fix #7 — /activate-game autocomplete filters by tournament mode', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('offers a video_game catalogue entry but not a pinball one for a videogame-mode tournament', async () => {
        const roomId = await createTestRoom('activate-mode-filter');
        // v2.120.2 — autocomplete is guild-scoped, so the room has to be
        // linked to the guild the fake interaction claims to come from.
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-activate-mode-filter');
        await createTestTournament(roomId, { name: 'VG Mode Tournament', mode: 'videogame' });

        const db = await getDatabase();
        await db.run(`INSERT INTO global_games (id, name, type, status) VALUES (?, 'Autocomplete VG Game', 'video_game', 'approved')`, crypto.randomUUID());
        await db.run(`INSERT INTO global_games (id, name, type, status) VALUES (?, 'Autocomplete Pin Game', 'pinball', 'approved')`, crypto.randomUUID());

        const { interaction, replies } = makeInteraction({
            guildId: 'guild-activate-mode-filter',
            options: {
                getFocused: () => ({ name: 'game_name', value: '' }),
                getString: (name: string) => (name === 'tournament' ? 'VG Mode Tournament' : null),
            },
        });
        await activategame.autocomplete(interaction);

        const choices = replies[0] as Array<{ value: string }>;
        const values = choices.map(c => c.value);
        expect(values).toContain('Autocomplete VG Game');
        expect(values).not.toContain('Autocomplete Pin Game');
    });
});

describe('drift-audit fix #6 — /deactivate-game cross-room + suspension guard', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('refuses a cross-guild deactivate — game status stays ACTIVE', async () => {
        const roomId = await createTestRoom('deactivate-cross');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-deactivate-a');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Deactivate Cross Game', status: 'ACTIVE' });

        const { interaction, replies } = makeInteraction({
            guildId: 'guild-deactivate-b',
            options: { getString: () => gameId },
        });
        await deactivategame.execute(interaction);

        const db = await getDatabase();
        const game = await db.get('SELECT status FROM games WHERE id = ?', gameId);
        expect(game.status).toBe('ACTIVE');
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/isn't linked/i);
    });

    it('refuses a suspended room\'s deactivate', async () => {
        const roomId = await createTestRoom('deactivate-susp');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-deactivate-susp');
        await GameRoomService.suspend(roomId, 'super-1', 'testing');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Deactivate Suspended Game', status: 'ACTIVE' });

        const { interaction, replies } = makeInteraction({
            guildId: 'guild-deactivate-susp',
            options: { getString: () => gameId },
        });
        await deactivategame.execute(interaction);

        const db = await getDatabase();
        const game = await db.get('SELECT status FROM games WHERE id = ?', gameId);
        expect(game.status).toBe('ACTIVE');
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/suspended/i);
    });

    it('allows a same-guild deactivate to proceed and complete the game', async () => {
        const roomId = await createTestRoom('deactivate-ok');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-deactivate-ok');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Deactivate OK Game', status: 'ACTIVE' });

        const { interaction, replies } = makeInteraction({
            guildId: 'guild-deactivate-ok',
            options: { getString: () => gameId },
        });
        await deactivategame.execute(interaction);

        const db = await getDatabase();
        const game = await db.get('SELECT status FROM games WHERE id = ?', gameId);
        expect(game.status).toBe('COMPLETED');
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).not.toMatch(/isn't linked/i);
    });
});

describe('drift-audit fix #8 — /reorder-lineup scoped to the invoking guild', () => {
    beforeEach(async () => { await setupTestDb(); });
    afterEach(() => { vi.restoreAllMocks(); delete process.env.DISCORD_GUILD_ID; });

    it('reorders only the room(s) linked to the invoking guild, not other rooms', async () => {
        const roomA = await createTestRoom('reorder-a');
        const roomB = await createTestRoom('reorder-b');
        await GameRoomSettingsService.set(roomA, 'DISCORD_GUILD_ID', 'guild-reorder-a');
        await GameRoomSettingsService.set(roomB, 'DISCORD_GUILD_ID', 'guild-reorder-b');

        const engine = TournamentEngine.getInstance();
        const spy = vi.spyOn(engine, 'reorderIScoredLineup').mockResolvedValue(undefined);

        const { interaction } = makeInteraction({ guildId: 'guild-reorder-a' });
        await reorderlineup.execute(interaction);

        expect(spy).toHaveBeenCalledWith(roomA);
        expect(spy).not.toHaveBeenCalledWith(roomB);
    });

    it('legacy env-fallback: reorders rooms with NO per-room guild id when the invoking guild is the env fallback', async () => {
        const roomEnv = await createTestRoom('reorder-env');
        const roomConfigured = await createTestRoom('reorder-configured');
        await GameRoomSettingsService.set(roomConfigured, 'DISCORD_GUILD_ID', 'guild-reorder-other');
        process.env.DISCORD_GUILD_ID = 'guild-reorder-env';

        const engine = TournamentEngine.getInstance();
        const spy = vi.spyOn(engine, 'reorderIScoredLineup').mockResolvedValue(undefined);

        const { interaction } = makeInteraction({ guildId: 'guild-reorder-env' });
        await reorderlineup.execute(interaction);

        expect(spy).toHaveBeenCalledWith(roomEnv);
        expect(spy).not.toHaveBeenCalledWith(roomConfigured);
    });

    it('an unmapped guild triggers zero reorders', async () => {
        await createTestRoom('reorder-unmapped-room');

        const engine = TournamentEngine.getInstance();
        const spy = vi.spyOn(engine, 'reorderIScoredLineup').mockResolvedValue(undefined);

        const { interaction, replies } = makeInteraction({ guildId: 'guild-reorder-nobody' });
        await reorderlineup.execute(interaction);

        expect(spy).not.toHaveBeenCalled();
        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/No Arcaid room is linked/i);
    });
});

describe('drift-audit fix #9 — /map-user ban check', () => {
    beforeEach(async () => {
        await setupTestDb();
        BanService.clearCache();
    });

    it('refuses a banned Discord user before writing a mapping', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_bans (id, discord_user_id, reason, banned_by) VALUES (?, ?, 'test ban', 'admin-1')`,
            'ban-mapuser-1', 'mapuser-banned-1',
        );
        BanService.clearCache();

        const { interaction, replies } = makeInteraction({
            user: { id: 'mapuser-banned-1', tag: 'mapuser-banned-1#0000' },
            options: { getString: () => 'SomeAlias', getUser: () => null },
        });
        await mapuser.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toMatch(/banned/i);
        const mapping = await db.get('SELECT * FROM user_mappings WHERE discord_user_id = ?', 'mapuser-banned-1');
        expect(mapping).toBeUndefined();
    });

    it('allows an unbanned user to map normally', async () => {
        const { interaction, replies } = makeInteraction({
            user: { id: 'mapuser-ok-1', tag: 'mapuser-ok-1#0000' },
            options: { getString: () => 'SomeAlias', getUser: () => null },
        });
        await mapuser.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).not.toMatch(/banned/i);
        const db = await getDatabase();
        const mapping = await db.get('SELECT * FROM user_mappings WHERE discord_user_id = ?', 'mapuser-ok-1');
        expect(mapping).toBeTruthy();
    });
});
