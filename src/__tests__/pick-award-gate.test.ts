import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { dropEnableGamePickAward } from '../database/migrations/dropEnableGamePickAward.js';

// ---------------------------------------------------------------------------
// v2.56.0 — the room-level pick-award gate is gone.
//
// Reported bug: a tournament configured with "Winner picks next game" ✓ and a
// 60-minute winner window auto-picked immediately and the winner never got to
// choose. `PickAwardGate.isEnabled` resolved `room AND tournament`, and the
// room-level `ENABLE_GAME_PICK_AWARD` key was absent for that room (→ false),
// so three correct tournament settings were silently inert.
//
// The engine assertions use the real `runMaintenance` → `processSlotMaintenance`
// path and read the `[Pending Pick]` placeholder row back out of `games` — the
// same synchronous, awaited write the flow depends on, sidestepping the
// fire-and-forget DM/notification timing. Rooms set ISCORED_ENABLED=false so
// `getIScoredCredsForRoom` short-circuits instead of falling through to the
// repo's local `.env` creds and launching a real Playwright browser.
// ---------------------------------------------------------------------------

/** Seed a top-scoring submission so winner resolution finds a winner. */
async function seedWinningSubmission(gameId: string, discordUserId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        `${gameId}-winner`, gameId, discordUserId, 'Winner', 99999, new Date().toISOString(),
    );
}

async function pendingPickCount(tournamentId: string): Promise<number> {
    const db = await getDatabase();
    const row = await db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM games WHERE tournament_id = ? AND name = '[Pending Pick]'`,
        tournamentId,
    );
    return row?.c ?? 0;
}

async function setWinnerPicks(tournamentId: string, value: number) {
    const db = await getDatabase();
    await db.run('UPDATE tournaments SET winner_picks = ? WHERE id = ?', value, tournamentId);
    PickAwardGate.invalidate();
}

describe('PickAwardGate — per-tournament resolution (v2.56.0)', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    describe('tournament-scoped', () => {
        it('is enabled for winner_picks=1 in a room that never set ENABLE_GAME_PICK_AWARD (the reported bug)', async () => {
            const roomId = await createTestRoom('pag-absent', 'PAG Absent');
            const tournamentId = await createTestTournament(roomId, { name: 'PAG Absent Tournament' });
            await setWinnerPicks(tournamentId, 1);

            // Precondition: the room genuinely has no such setting row.
            expect(await GameRoomSettingsService.get(roomId, 'ENABLE_GAME_PICK_AWARD')).toBeFalsy();

            expect(await PickAwardGate.isEnabled(roomId, tournamentId)).toBe(true);
        });

        it('is disabled for winner_picks=0', async () => {
            const roomId = await createTestRoom('pag-off', 'PAG Off');
            const tournamentId = await createTestTournament(roomId, { name: 'PAG Off Tournament' });
            await setWinnerPicks(tournamentId, 0);

            expect(await PickAwardGate.isEnabled(roomId, tournamentId)).toBe(false);
        });

        it('ignores a leftover ENABLE_GAME_PICK_AWARD=false row — the room leg is gone', async () => {
            const roomId = await createTestRoom('pag-legacy-false', 'PAG Legacy False');
            const tournamentId = await createTestTournament(roomId, { name: 'PAG Legacy False Tournament' });
            await setWinnerPicks(tournamentId, 1);
            await GameRoomSettingsService.set(roomId, 'ENABLE_GAME_PICK_AWARD', 'false');
            PickAwardGate.invalidate();

            expect(await PickAwardGate.isEnabled(roomId, tournamentId)).toBe(true);
        });

        it('returns false for a missing tournament, and for a falsy roomId', async () => {
            const roomId = await createTestRoom('pag-missing', 'PAG Missing');
            expect(await PickAwardGate.isEnabled(roomId, 'no-such-tournament')).toBe(false);
            expect(await PickAwardGate.isEnabled(null)).toBe(false);
        });
    });

    describe('room-scoped (no tournament id)', () => {
        it('is true when any tournament in the room has winner-picks on', async () => {
            const roomId = await createTestRoom('pag-room-mixed', 'PAG Room Mixed');
            const offId = await createTestTournament(roomId, { name: 'Off' });
            const onId = await createTestTournament(roomId, { name: 'On' });
            await setWinnerPicks(offId, 0);
            await setWinnerPicks(onId, 1);

            expect(await PickAwardGate.isEnabled(roomId)).toBe(true);
        });

        it('is false when every tournament in the room has winner-picks off', async () => {
            const roomId = await createTestRoom('pag-room-all-off', 'PAG Room All Off');
            const a = await createTestTournament(roomId, { name: 'A' });
            const b = await createTestTournament(roomId, { name: 'B' });
            await setWinnerPicks(a, 0);
            await setWinnerPicks(b, 0);

            expect(await PickAwardGate.isEnabled(roomId)).toBe(false);
        });

        it('is false for a room with no tournaments at all (not a blanket true)', async () => {
            const roomId = await createTestRoom('pag-room-empty', 'PAG Room Empty');
            expect(await PickAwardGate.isEnabled(roomId)).toBe(false);
        });

        it('does not leak across rooms', async () => {
            const enabledRoom = await createTestRoom('pag-room-x', 'PAG Room X');
            const disabledRoom = await createTestRoom('pag-room-y', 'PAG Room Y');
            const onId = await createTestTournament(enabledRoom, { name: 'X On' });
            const offId = await createTestTournament(disabledRoom, { name: 'Y Off' });
            await setWinnerPicks(onId, 1);
            await setWinnerPicks(offId, 0);

            expect(await PickAwardGate.isEnabled(enabledRoom)).toBe(true);
            expect(await PickAwardGate.isEnabled(disabledRoom)).toBe(false);
        });
    });

    describe('engine behaviour', () => {
        it('creates a picker slot for winner_picks=1 in a room that never set the key', async () => {
            const roomId = await createTestRoom('pag-engine-on', 'PAG Engine On');
            await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
            const tournamentId = await createTestTournament(roomId, { name: 'PAG Engine On Tournament' });
            await setWinnerPicks(tournamentId, 1);
            const gameId = await createTestGame(tournamentId, { name: 'PAG Engine On Game', status: 'ACTIVE' });
            await seedWinningSubmission(gameId, '444444444444444444');

            await TournamentEngine.getInstance().runMaintenance(tournamentId);

            expect(await pendingPickCount(tournamentId)).toBe(1);
            const db = await getDatabase();
            const slot = await db.get(
                `SELECT picker_discord_id, picker_type, won_game_id FROM games
                 WHERE tournament_id = ? AND name = '[Pending Pick]'`,
                tournamentId,
            );
            expect(slot.picker_discord_id).toBe('444444444444444444');
            expect(slot.picker_type).toBe('WINNER');
            expect(slot.won_game_id).toBe(gameId);
        });

        it('creates no picker slot when winner_picks=0', async () => {
            const roomId = await createTestRoom('pag-engine-off', 'PAG Engine Off');
            await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
            const tournamentId = await createTestTournament(roomId, { name: 'PAG Engine Off Tournament' });
            await setWinnerPicks(tournamentId, 0);
            const gameId = await createTestGame(tournamentId, { name: 'PAG Engine Off Game', status: 'ACTIVE' });
            await seedWinningSubmission(gameId, '555555555555555555');

            await TournamentEngine.getInstance().runMaintenance(tournamentId);

            expect(await pendingPickCount(tournamentId)).toBe(0);
        });
    });

    describe('migration 126', () => {
        it('removes ENABLE_GAME_PICK_AWARD rows and is idempotent', async () => {
            const db = await getDatabase();
            const roomA = await createTestRoom('mig126-a', 'Mig126 A');
            const roomB = await createTestRoom('mig126-b', 'Mig126 B');
            await GameRoomSettingsService.set(roomA, 'ENABLE_GAME_PICK_AWARD', 'true');
            await GameRoomSettingsService.set(roomB, 'ENABLE_GAME_PICK_AWARD', 'false');
            // An unrelated key in the same table must survive.
            await GameRoomSettingsService.set(roomA, 'DISCORD_ENABLED', 'true');

            expect(await dropEnableGamePickAward(db)).toBe(2);

            const remaining = await db.get<{ c: number }>(
                `SELECT COUNT(*) AS c FROM game_room_settings WHERE key = 'ENABLE_GAME_PICK_AWARD'`,
            );
            expect(remaining?.c).toBe(0);
            expect(await GameRoomSettingsService.get(roomA, 'DISCORD_ENABLED')).toBe('true');

            // Second run is a no-op.
            expect(await dropEnableGamePickAward(db)).toBe(0);
        });

        it('is recorded in schema_migrations on a fresh database', async () => {
            const db = await getDatabase();
            const row = await db.get(
                'SELECT name FROM schema_migrations WHERE name = ?',
                '126_drop_enable_game_pick_award',
            );
            expect(row?.name).toBe('126_drop_enable_game_pick_award');
        });
    });
});
