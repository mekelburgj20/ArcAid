import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

// ---------------------------------------------------------------------------
// TournamentEngine winner resolution — direct submission attribution
// preference (v2.35.0 Google-login contract, D3.5). A Google-identified web
// player never gets a user_mappings row (that table is Discord-alias-only),
// so winner resolution must prefer the top submission's OWN
// submitted_by_user_id/discord_user_id over the user_mappings iscored-name
// lookup. Falls back to the mapping lookup only when the submission carries
// no direct attribution at all (pure iScored-synced/anonymous rows).
//
// Uses the real `runMaintenance` -> processSlotMaintenance path and reads the
// winner back from `player_achievements.discord_user_id` — a synchronous,
// awaited write (AchievementService.award), sidestepping the fire-and-forget
// DM/notification timing entirely. Each test room explicitly sets
// ISCORED_ENABLED=false so `getIScoredCredsForRoom` short-circuits to null
// instead of falling through to process.env.ISCORED_* — the repo's local
// `.env` (loaded transitively via `terminology.ts`'s dotenv.config() call)
// carries real iScored creds during local dev, which would otherwise make
// this test try to launch a real Playwright browser.
// ---------------------------------------------------------------------------

async function seedSubmission(gameId: string, opts: {
    discordUserId: string; // NOT NULL column — sentinel when no legacy Discord attribution
    submittedByUserId?: string | null;
    iscoredUsername: string;
    score: number;
}) {
    const db = await getDatabase();
    const id = `${gameId}-${opts.iscoredUsername.toLowerCase()}`;
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, gameId, opts.discordUserId, opts.submittedByUserId ?? null, opts.iscoredUsername, opts.score,
        new Date().toISOString(),
    );
}

async function seedMapping(iscoredUsername: string, discordUserId: string) {
    const db = await getDatabase();
    await db.run(
        'INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
        discordUserId, iscoredUsername,
    );
}

async function getWinnerDiscordId(tournamentId: string): Promise<string | null> {
    const db = await getDatabase();
    const row = await db.get(
        "SELECT discord_user_id FROM player_achievements WHERE tournament_id = ? AND type = 'tournament_win'",
        tournamentId,
    );
    return row?.discord_user_id ?? null;
}

describe('TournamentEngine winner resolution — attribution preference', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('prefers submitted_by_user_id (Google) over a user_mappings lookup for the same name', async () => {
        const roomId = await createTestRoom('twa-google', 'TWA Google');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const tournamentId = await createTestTournament(roomId, { name: 'TWA Google Tournament' });
        const gameId = await createTestGame(tournamentId, { name: 'TWA Google Game', status: 'ACTIVE' });

        await seedSubmission(gameId, {
            discordUserId: 'COMMUNITY',
            submittedByUserId: 'google:999',
            iscoredUsername: 'GoogleWinner',
            score: 99999,
        });
        // A stale/unrelated mapping for the same name — must NOT win.
        await seedMapping('GoogleWinner', '111111111111111111');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        expect(await getWinnerDiscordId(tournamentId)).toBe('google:999');
    });

    it('falls back to the user_mappings lookup when the submission has no direct attribution', async () => {
        const roomId = await createTestRoom('twa-fallback', 'TWA Fallback');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const tournamentId = await createTestTournament(roomId, { name: 'TWA Fallback Tournament' });
        const gameId = await createTestGame(tournamentId, { name: 'TWA Fallback Game', status: 'ACTIVE' });

        await seedSubmission(gameId, {
            discordUserId: 'COMMUNITY',
            submittedByUserId: null,
            iscoredUsername: 'MappedWinner',
            score: 99999,
        });
        await seedMapping('MappedWinner', '222222222222222222');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        expect(await getWinnerDiscordId(tournamentId)).toBe('222222222222222222');
    });

    it('still resolves via the legacy discord_user_id column when submitted_by_user_id is absent (unchanged Discord behavior)', async () => {
        const roomId = await createTestRoom('twa-legacy', 'TWA Legacy');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const tournamentId = await createTestTournament(roomId, { name: 'TWA Legacy Tournament' });
        const gameId = await createTestGame(tournamentId, { name: 'TWA Legacy Game', status: 'ACTIVE' });

        await seedSubmission(gameId, {
            discordUserId: '333333333333333333',
            submittedByUserId: null,
            iscoredUsername: 'DiscordBotWinner',
            score: 99999,
        });

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        expect(await getWinnerDiscordId(tournamentId)).toBe('333333333333333333');
    });

    it('resolves to null (no winner id) when neither attribution nor mapping exists', async () => {
        const roomId = await createTestRoom('twa-none', 'TWA None');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const tournamentId = await createTestTournament(roomId, { name: 'TWA None Tournament' });
        const gameId = await createTestGame(tournamentId, { name: 'TWA None Game', status: 'ACTIVE' });

        await seedSubmission(gameId, {
            discordUserId: 'COMMUNITY',
            submittedByUserId: null,
            iscoredUsername: 'UnclaimedWinner',
            score: 99999,
        });

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        expect(await getWinnerDiscordId(tournamentId)).toBeNull();
    });
});
