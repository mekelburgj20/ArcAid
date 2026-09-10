import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import type { IScoredClient } from '../engine/IScoredClient.js';

// Regression lock for the RTX_Pinball Daily Grind incident (2026-09-09, v2.155.6):
// cleanup selected only COMPLETED games WITH an iscored_id. A room that has iScored
// switched off creates every game without one, so those games were invisible to
// cleanup forever and piled up on the board as locked cards. Every completed game
// must be considered; the ones that were never on iScored archive locally.

async function addCompletedGame(
    tournamentId: string,
    roomId: string,
    name: string,
    iscoredId: string | null,
    endedAt: string,
): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, iscored_id, start_date, end_date, game_room_id)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
        id, tournamentId, name, iscoredId,
        new Date(Date.parse(endedAt) - 24 * 3600 * 1000).toISOString(), endedAt, roomId,
    );
    return id;
}

const statusOf = async (id: string): Promise<string | undefined> => {
    const db = await getDatabase();
    const row = await db.get<{ status: string }>('SELECT status FROM games WHERE id = ?', id);
    return row?.status;
};

describe('runCleanup — games that were never on iScored (no iscored_id)', () => {
    it('archives them when the room has no iScored at all (the RTX Daily Grind case)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-native', 'Cleanup Native');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const g1 = await addCompletedGame(tId, roomId, 'Star God 2019', null, '2026-09-02T03:00:00.000Z');
        const g2 = await addCompletedGame(tId, roomId, 'Big Shot', null, '2026-09-03T03:00:00.000Z');
        const g3 = await addCompletedGame(tId, roomId, 'House of Diamonds 2017', null, '2026-09-10T03:00:00.000Z');

        // sharedClient null + sharedCreds null → the room resolves to no iScored.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, null, null);

        expect(await statusOf(g1)).toBe('ARCHIVED');
        expect(await statusOf(g2)).toBe('ARCHIVED');
        expect(await statusOf(g3)).toBe('ARCHIVED');
    });

    it('never hands a missing id to deleteGame; rows WITH an id still go through the delete path', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-mixed', 'Cleanup Mixed');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const local = await addCompletedGame(tId, roomId, 'Never On iScored', null, '2026-09-03T03:00:00.000Z');
        const remote = await addCompletedGame(tId, roomId, 'Still On iScored', 'ISC_REMOTE', '2026-09-02T03:00:00.000Z');

        // The remote delete does NOT confirm → that row must stay COMPLETED to retry,
        // exactly as before. The local-only row has nothing to retry and archives now.
        const deleteGame = vi.fn(async () => false);
        const client = { deleteGame } as unknown as IScoredClient;
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, client, null);

        expect(deleteGame).toHaveBeenCalledTimes(1);
        expect(deleteGame).toHaveBeenCalledWith('ISC_REMOTE', 'Still On iScored');
        expect(await statusOf(local)).toBe('ARCHIVED');
        expect(await statusOf(remote)).toBe('COMPLETED');
    });

    it('a retain count is applied across both kinds, newest first', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-retain', 'Cleanup Retain');
        const tId = await createTestTournament(roomId, { name: 'Weekly Grind' });
        const oldest = await addCompletedGame(tId, roomId, 'Oldest (remote)', 'ISC_OLD', '2026-09-01T03:00:00.000Z');
        const middle = await addCompletedGame(tId, roomId, 'Middle (local)', null, '2026-09-02T03:00:00.000Z');
        const newest = await addCompletedGame(tId, roomId, 'Newest (local)', null, '2026-09-03T03:00:00.000Z');

        const deleteGame = vi.fn(async () => true);
        const client = { deleteGame } as unknown as IScoredClient;
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'retain', count: 1 }, client, null);

        expect(await statusOf(newest)).toBe('COMPLETED'); // retained: the single most recent
        expect(await statusOf(middle)).toBe('ARCHIVED');
        expect(await statusOf(oldest)).toBe('ARCHIVED');
        expect(deleteGame).toHaveBeenCalledTimes(1);
        expect(deleteGame).toHaveBeenCalledWith('ISC_OLD', 'Oldest (remote)');
    });

    it('with nothing past the retain count it changes nothing and calls nothing', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-noop', 'Cleanup Noop');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const a = await addCompletedGame(tId, roomId, 'A', null, '2026-09-02T03:00:00.000Z');
        const b = await addCompletedGame(tId, roomId, 'B', 'ISC_B', '2026-09-03T03:00:00.000Z');

        const deleteGame = vi.fn(async () => true);
        const client = { deleteGame } as unknown as IScoredClient;
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'retain', count: 5 }, client, null);

        expect(deleteGame).not.toHaveBeenCalled();
        expect(await statusOf(a)).toBe('COMPLETED');
        expect(await statusOf(b)).toBe('COMPLETED');
    });
});
