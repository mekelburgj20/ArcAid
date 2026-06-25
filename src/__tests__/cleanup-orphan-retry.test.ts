import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import type { IScoredClient } from '../engine/IScoredClient.js';

// Regression lock for the iScored-cleanup-orphan bug (diagnosed 2026-06-25):
// runCleanup used to mark games ARCHIVED unconditionally, even when the iScored
// delete silently no-op'd. Because cleanup only ever re-scans COMPLETED rows, an
// ARCHIVED orphan was never retried, so iScored accumulated weeks of stale games
// while ArcAid showed them archived. Fix: archive ONLY games whose delete was
// confirmed; failures stay COMPLETED to retry next cycle.

async function addCompletedGame(
    tournamentId: string,
    roomId: string,
    name: string,
    iscoredId: string,
): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, iscored_id, start_date, end_date, game_room_id)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
        id, tournamentId, name, iscoredId,
        new Date().toISOString(), new Date().toISOString(), roomId,
    );
    return id;
}

const statusOf = async (id: string): Promise<string | undefined> => {
    const db = await getDatabase();
    const row = await db.get<{ status: string }>('SELECT status FROM games WHERE id = ?', id);
    return row?.status;
};

describe('runCleanup — orphan-safe archiving (iScored delete must confirm)', () => {
    it('archives only confirmed-deleted games; a no-op or throw stays COMPLETED to retry', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-orphan', 'Cleanup Orphan');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });

        const gOk = await addCompletedGame(tId, roomId, 'Deletes Fine', 'ISC_OK');
        const gNoop = await addCompletedGame(tId, roomId, 'Delete No-ops', 'ISC_FALSE');
        const gThrow = await addCompletedGame(tId, roomId, 'Delete Throws', 'ISC_THROW');

        // Mock the iScored client injected as runCleanup's sharedClient.
        const deleteGame = vi.fn(async (iscoredId: string) => {
            if (iscoredId === 'ISC_THROW') throw new Error('iScored boom');
            return iscoredId === 'ISC_OK'; // true → confirmed gone; false → still present
        });
        const mockClient = { deleteGame } as unknown as IScoredClient;

        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, mockClient, null);

        expect(await statusOf(gOk)).toBe('ARCHIVED');     // confirmed gone → terminal
        expect(await statusOf(gNoop)).toBe('COMPLETED');  // silent no-op → retry next cycle
        expect(await statusOf(gThrow)).toBe('COMPLETED'); // threw → retry next cycle
        expect(deleteGame).toHaveBeenCalledTimes(3);
    });

    it('retries on the next cleanup: a previously-failed delete that now succeeds gets archived', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-retry', 'Cleanup Retry');
        const tId = await createTestTournament(roomId, { name: 'Weekly Grind - VPXS' });
        const g = await addCompletedGame(tId, roomId, 'Flaky Game', 'ISC_FLAKY');

        const engine = TournamentEngine.getInstance();

        // Cycle 1: delete fails → row must remain COMPLETED (still selectable).
        const failClient = { deleteGame: vi.fn(async () => false) } as unknown as IScoredClient;
        await engine.runCleanup(tId, { mode: 'immediate' }, failClient, null);
        expect(await statusOf(g)).toBe('COMPLETED');

        // Cycle 2: delete now confirms → row archives.
        const okClient = { deleteGame: vi.fn(async () => true) } as unknown as IScoredClient;
        await engine.runCleanup(tId, { mode: 'immediate' }, okClient, null);
        expect(await statusOf(g)).toBe('ARCHIVED');
    });

    it('archives all completed games when iScored is disabled for the room (no client/creds)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-nodisc', 'Cleanup NoDisc');
        const tId = await createTestTournament(roomId, { name: 'Monthly Grind' });
        const g1 = await addCompletedGame(tId, roomId, 'G1', 'X1');
        const g2 = await addCompletedGame(tId, roomId, 'G2', 'X2');

        // sharedClient null + sharedCreds null → iScored-disabled branch.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, null, null);

        expect(await statusOf(g1)).toBe('ARCHIVED');
        expect(await statusOf(g2)).toBe('ARCHIVED');
    });
});
