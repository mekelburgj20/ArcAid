import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { pickgame } from '../discord/commands/pickgame.js';

/**
 * Drift-audit fix #1 — `/pick-game` used to hard-fail with "No iScored
 * credentials configured for this tournament. Cannot activate." whenever
 * `getIScoredCredsForRoom` returned null, which is the NORMAL state for a
 * standalone room (ISCORED_ENABLED=false has been the default for new rooms
 * since v2.81.0 — see s23-score-integrity.test.ts). The web `/pick-game`
 * twin (`rooms.ts`) and `/activate-game` already tolerated missing creds by
 * leaving `iscoredId` undefined; `pickgame.ts` now mirrors that instead of
 * returning early.
 *
 * No full discord.js gateway exists in this test suite (same constraint
 * noted in discord-suspension-gate.test.ts), so `execute()` is driven with a
 * minimal plain-object interaction stub covering exactly the surface the
 * command touches (user identity, options, reply/deferReply/editReply).
 */

function makeInteraction(opts: { tournamentName: string; gameName: string; userId: string; guildId: string }) {
    const replies: unknown[] = [];
    const interaction = {
        user: { id: opts.userId, tag: `${opts.userId}#0000`, displayName: 'Tester' },
        guildId: opts.guildId,
        options: {
            getString: (name: string) => {
                if (name === 'tournament') return opts.tournamentName;
                if (name === 'game_name') return opts.gameName;
                return null;
            },
        },
        deferReply: async () => {},
        editReply: async (payload: unknown) => { replies.push(payload); return payload; },
        reply: async (payload: unknown) => { replies.push(payload); return payload; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, replies };
}

describe('/pick-game — iScored-optional activation (drift-audit fix #1)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('activates a pick immediately in a room with ISCORED_ENABLED=false, leaving iscored_id NULL', async () => {
        const roomId = await createTestRoom('pick-iscored-off');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        // Link the room to the invoking guild so the drift-audit #4 cross-room
        // write guard (added in the same batch) doesn't refuse the pick first.
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-pick-1');
        const tournamentId = await createTestTournament(roomId, { name: 'Standalone Pick Tournament' });

        const { interaction, replies } = makeInteraction({
            tournamentName: 'Standalone Pick Tournament',
            gameName: 'No iScored Game',
            userId: 'pick-user-1',
            guildId: 'guild-pick-1',
        });

        await pickgame.execute(interaction);

        const db = await getDatabase();
        const game = await db.get(
            `SELECT status, iscored_id FROM games WHERE tournament_id = ? AND name = ?`,
            tournamentId, 'No iScored Game',
        );
        expect(game).toBeTruthy();
        expect(game.status).toBe('ACTIVE');
        expect(game.iscored_id).toBeNull();

        const finalReply = JSON.stringify(replies[replies.length - 1]);
        expect(finalReply).not.toMatch(/No iScored credentials/i);
        expect(finalReply).toMatch(/now active/i);
    });

    it('still degrades gracefully (no iScored) for a room with only PARTIAL per-room creds set', async () => {
        // iscoredCreds.ts treats partial per-room config (some but not all of
        // USERNAME/PASSWORD/PUBLIC_URL) as disabled — proving the fix reads
        // `creds` conditionally rather than special-casing ISCORED_ENABLED.
        const roomId = await createTestRoom('pick-iscored-partial');
        await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'only-username-set');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-pick-2');
        const tournamentId = await createTestTournament(roomId, { name: 'Partial Creds Tournament' });

        const { interaction, replies } = makeInteraction({
            tournamentName: 'Partial Creds Tournament',
            gameName: 'Partial Creds Game',
            userId: 'pick-user-2',
            guildId: 'guild-pick-2',
        });

        await pickgame.execute(interaction);

        const db = await getDatabase();
        const game = await db.get(
            `SELECT status, iscored_id FROM games WHERE tournament_id = ? AND name = ?`,
            tournamentId, 'Partial Creds Game',
        );
        expect(game).toBeTruthy();
        expect(game.status).toBe('ACTIVE');
        expect(game.iscored_id).toBeNull();
        const finalReply = JSON.stringify(replies[replies.length - 1]);
        expect(finalReply).not.toMatch(/No iScored credentials/i);
    });
});
