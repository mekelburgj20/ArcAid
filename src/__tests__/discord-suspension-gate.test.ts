import { describe, it, expect } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { guildInteractionBlockReason } from '../utils/discord.js';
import { resolveActiveSubmitGame } from '../discord/commands/submitscore.js';

/**
 * S22 Phase 2 (v2.44.0) — M1 fix (adversarial review): Discord slash commands
 * previously bypassed room suspension entirely (the guild-level gate only
 * checked DISCORD_ENABLED, and per-command room resolution by
 * tournament/game NAME is independent of the invoking guild). Covers the two
 * explicitly-required cases: the guild-level interaction gate, and
 * `/submit-score`'s room-resolution guard. (activategame/pickgame/
 * forcemaintenance/runcleanup got the identical `RoomAccessService.isSuspended`
 * guard inline — same tested primitive, no full discord.js interaction
 * harness exists to drive those commands' `execute()` directly.)
 */

describe('guildInteractionBlockReason', () => {
    it('null (allowed) when the guild maps to no room', async () => {
        await setupTestDb();
        expect(await guildInteractionBlockReason('guild-unmapped-1')).toBeNull();
    });

    it('null (allowed) for an enabled, non-suspended room', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('gate-ok-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-ok-1');
        expect(await guildInteractionBlockReason('guild-ok-1')).toBeNull();
    });

    it('refuses (non-null) when the mapped room is Discord-disabled', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('gate-disabled-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-disabled-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        const reason = await guildInteractionBlockReason('guild-disabled-1');
        expect(reason).toMatch(/not connected/i);
    });

    it('refuses (non-null) when the mapped room is suspended, even if Discord-enabled', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('gate-suspended-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-suspended-1');
        await GameRoomService.suspend(roomId, 'super-1', 'testing');
        const reason = await guildInteractionBlockReason('guild-suspended-1');
        expect(reason).toMatch(/suspended/i);
    });

    it('suspension check takes priority over the disabled check (both true)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('gate-both-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-both-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        await GameRoomService.suspend(roomId, 'super-1', 'testing');
        const reason = await guildInteractionBlockReason('guild-both-1');
        expect(reason).toMatch(/suspended/i);
    });

    it('allowed again after unsuspend', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('gate-unsuspend-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-unsuspend-1');
        await GameRoomService.suspend(roomId, 'super-1', null);
        expect(await guildInteractionBlockReason('guild-unsuspend-1')).toMatch(/suspended/i);
        await GameRoomService.unsuspend(roomId);
        expect(await guildInteractionBlockReason('guild-unsuspend-1')).toBeNull();
    });
});

/** helpers.ts's createTestGame doesn't set iscored_id — resolveActiveSubmitGame
 * requires it truthy (mirrors the pre-existing production query), so tests
 * that need an "active + iScored-linked" game set it directly. */
async function linkGameToIscored(gameId: string, iscoredId: string): Promise<void> {
    const db = await getDatabase();
    await db.run('UPDATE games SET iscored_id = ? WHERE id = ?', iscoredId, gameId);
}

describe('resolveActiveSubmitGame (submitscore.ts room-resolution guard)', () => {
    it('not_found for a nonexistent/inactive game name', async () => {
        await setupTestDb();
        const result = await resolveActiveSubmitGame('No Such Game');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('not_found');
    });

    it('ok:true for an active game in a non-suspended room', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('submit-gate-ok-1');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Submit Gate OK Game' });
        await linkGameToIscored(gameId, 'iscored-ok-1');

        const result = await resolveActiveSubmitGame('Submit Gate OK Game');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.game.game_room_id).toBe(roomId);
    });

    it('reason:suspended when the resolved game\'s room is suspended — closes the cross-room gap the guild-level gate cannot catch', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('submit-gate-suspended-1');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Submit Gate Suspended Game' });
        await linkGameToIscored(gameId, 'iscored-suspended-1');
        await GameRoomService.suspend(roomId, 'super-1', 'testing');

        const result = await resolveActiveSubmitGame('Submit Gate Suspended Game');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('suspended');
    });

    it('allowed again after unsuspend', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('submit-gate-revert-1');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Submit Gate Revert Game' });
        await linkGameToIscored(gameId, 'iscored-revert-1');
        await GameRoomService.suspend(roomId, 'super-1', null);

        const during = await resolveActiveSubmitGame('Submit Gate Revert Game');
        expect(during.ok).toBe(false);

        await GameRoomService.unsuspend(roomId);
        const after = await resolveActiveSubmitGame('Submit Gate Revert Game');
        expect(after.ok).toBe(true);
    });
});

// Sanity check that the underlying tables/columns this fix depends on are
// wired the way the two suites above assume (belt-and-suspenders, cheap).
describe('sanity: game_room_settings DISCORD_GUILD_ID lookup shape', () => {
    it('a room row is retrievable by its mapped guild id', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('sanity-guild-map-1');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-sanity-1');
        const db = await getDatabase();
        const row = await db.get(
            `SELECT game_room_id FROM game_room_settings WHERE key = 'DISCORD_GUILD_ID' AND value = ?`,
            'guild-sanity-1',
        );
        expect(row?.game_room_id).toBe(roomId);
    });
});
