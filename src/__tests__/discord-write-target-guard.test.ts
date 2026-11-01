import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { validateDiscordWriteTarget } from '../utils/discordWriteTarget.js';

/**
 * Drift-audit fix #4 — cross-room privacy bypass on Discord write commands
 * (`/submit-score`, `/pick-game`, `/activate-game`, `/force-maintenance`,
 * and `/deactivate-game` per fix #6). Their target rooms are resolved by
 * tournament/game NAME, which is never guild-scoped, so a suspension-only
 * check (the pre-existing v2.44.0 M1 guard) missed two other leaks: a room
 * the invoking Discord server has no business touching because it's
 * Discord-disabled/approval-gated, or because it's linked to a DIFFERENT
 * guild entirely. `validateDiscordWriteTarget` centralizes all three checks.
 */
describe('validateDiscordWriteTarget (drift-audit fix #4)', () => {
    const originalEnvGuild = process.env.DISCORD_GUILD_ID;

    beforeEach(async () => {
        await setupTestDb();
        delete process.env.DISCORD_GUILD_ID;
    });

    afterEach(() => {
        if (originalEnvGuild === undefined) delete process.env.DISCORD_GUILD_ID;
        else process.env.DISCORD_GUILD_ID = originalEnvGuild;
    });

    it('allows through when roomId is null/undefined (no room attribution to validate)', async () => {
        expect(await validateDiscordWriteTarget(null, 'guild-x')).toEqual({ allowed: true });
        expect(await validateDiscordWriteTarget(undefined, 'guild-x')).toEqual({ allowed: true });
    });

    it('allows a same-guild write for a room with a configured DISCORD_GUILD_ID', async () => {
        const roomId = await createTestRoom('wtg-same');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-a');
        expect(await validateDiscordWriteTarget(roomId, 'guild-a')).toEqual({ allowed: true });
    });

    it('refuses a cross-guild write for a room linked to a DIFFERENT guild', async () => {
        const roomId = await createTestRoom('wtg-cross');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-a');
        const result = await validateDiscordWriteTarget(roomId, 'guild-b');
        expect(result.allowed).toBe(false);
        expect(result.denial).toBe('not_linked');
    });

    it('refuses a suspended room regardless of guild match — suspension wins even with a matching guild', async () => {
        const roomId = await createTestRoom('wtg-susp');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-a');
        await GameRoomService.suspend(roomId, 'super-1', 'testing');
        const result = await validateDiscordWriteTarget(roomId, 'guild-a');
        expect(result.allowed).toBe(false);
        expect(result.denial).toBe('suspended');
    });

    it('refuses a Discord-disabled room even with a matching guild id', async () => {
        const roomId = await createTestRoom('wtg-disabled');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-a');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        const result = await validateDiscordWriteTarget(roomId, 'guild-a');
        expect(result.allowed).toBe(false);
        expect(result.denial).toBe('not_linked');
    });

    it('refuses an approval-policy room even with a matching guild id', async () => {
        const roomId = await createTestRoom('wtg-approval');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-a');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        const result = await validateDiscordWriteTarget(roomId, 'guild-a');
        expect(result.allowed).toBe(false);
        expect(result.denial).toBe('not_a_member');
    });

    it('approval room: a member is allowed, a non-member is not (v2.212.0)', async () => {
        const roomId = await createTestRoom('wtg-approval-member');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-a');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await RoomMembershipService.addMember('111111111111111111', roomId, 'admin_invite');
        expect(await validateDiscordWriteTarget(roomId, 'guild-a', '111111111111111111')).toEqual({ allowed: true });
        const stranger = await validateDiscordWriteTarget(roomId, 'guild-a', '222222222222222222');
        expect(stranger).toEqual({ allowed: false, denial: 'not_a_member' });
        // member of the approval room still cannot reach it from another guild
        const wrongGuild = await validateDiscordWriteTarget(roomId, 'guild-b', '111111111111111111');
        expect(wrongGuild.denial).toBe('not_linked');
    });

    it('a member of a Discord-disabled room is still refused', async () => {
        const roomId = await createTestRoom('wtg-disabled-member');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-a');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        await RoomMembershipService.addMember('111111111111111111', roomId, 'admin_invite');
        const r = await validateDiscordWriteTarget(roomId, 'guild-a', '111111111111111111');
        expect(r.allowed).toBe(false);
        expect(r.denial).toBe('not_linked');
    });

    it('legacy env-fallback: a room with NO per-room guild id is reachable when the env fallback guild matches', async () => {
        const roomId = await createTestRoom('wtg-env-ok');
        process.env.DISCORD_GUILD_ID = 'guild-env';
        expect(await validateDiscordWriteTarget(roomId, 'guild-env')).toEqual({ allowed: true });
    });

    it('legacy env-fallback: refused when the invoking guild does NOT match the env fallback guild', async () => {
        const roomId = await createTestRoom('wtg-env-mismatch');
        process.env.DISCORD_GUILD_ID = 'guild-env';
        const result = await validateDiscordWriteTarget(roomId, 'guild-other');
        expect(result.allowed).toBe(false);
        expect(result.denial).toBe('not_linked');
    });

    it('refused when the room has no per-room guild id AND no env fallback is configured at all', async () => {
        const roomId = await createTestRoom('wtg-nothing-configured');
        const result = await validateDiscordWriteTarget(roomId, 'guild-anything');
        expect(result.allowed).toBe(false);
        expect(result.denial).toBe('not_linked');
    });
});
