import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { buildReconcilePlan, type IScoredGameSummary } from '../services/IScoredReconcileService.js';

async function addGame(
    tournamentId: string,
    roomId: string,
    name: string,
    status: string,
    iscoredId: string | null,
): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, iscored_id, start_date, game_room_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(), tournamentId, name, status, iscoredId, new Date().toISOString(), roomId,
    );
}

const isg = (id: string, name: string): IScoredGameSummary =>
    ({ id, name, hidden: false, locked: false, tags: [] });

describe('buildReconcilePlan — iScored reconcile categorization', () => {
    it('buckets iScored games into keep / orphans / unmanaged by local status', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('reconcile', 'Reconcile');
        const tId = await createTestTournament(roomId);

        await addGame(tId, roomId, 'Active Game', 'ACTIVE', '1001');
        await addGame(tId, roomId, 'Completed Game', 'COMPLETED', '1002');
        await addGame(tId, roomId, 'Archived Game', 'ARCHIVED', '1003');
        await addGame(tId, roomId, 'Queued Game', 'QUEUED', '1004');
        // '9999' has no local row at all → unmanaged.

        const plan = await buildReconcilePlan([
            isg('1001', 'Active Game'),
            isg('1002', 'Completed Game'),
            isg('1003', 'Archived Game'),
            isg('1004', 'Queued Game'),
            isg('9999', 'Hand-made Game'),
        ]);

        expect(plan.keep.map((e) => e.id).sort()).toEqual(['1001', '1002', '1004']); // ACTIVE/COMPLETED/QUEUED
        expect(plan.orphans.map((e) => e.id)).toEqual(['1003']);                      // ARCHIVED only
        expect(plan.unmanaged.map((e) => e.id)).toEqual(['9999']);                    // no local row
    });

    it('keeps a game ARCHIVED in one room but ACTIVE in another (shared iScored id is safe)', async () => {
        await setupTestDb();
        const roomA = await createTestRoom('rec-a', 'Rec A');
        const roomB = await createTestRoom('rec-b', 'Rec B');
        const tA = await createTestTournament(roomA);
        const tB = await createTestTournament(roomB);

        // Same iscored_id '2001' — ARCHIVED in A but ACTIVE in B. Must NOT be an orphan.
        await addGame(tA, roomA, 'Shared (archived in A)', 'ARCHIVED', '2001');
        await addGame(tB, roomB, 'Shared (active in B)', 'ACTIVE', '2001');

        const plan = await buildReconcilePlan([isg('2001', 'Shared')]);

        expect(plan.orphans).toHaveLength(0);
        expect(plan.keep.map((e) => e.id)).toEqual(['2001']);
    });

    it('returns empty buckets when iScored has no games', async () => {
        await setupTestDb();
        const plan = await buildReconcilePlan([]);
        expect(plan).toEqual({ keep: [], orphans: [], unmanaged: [] });
    });
});
