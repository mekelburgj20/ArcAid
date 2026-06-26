import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { Scheduler } from '../engine/Scheduler.js';
import { GameRoomService } from '../services/GameRoomService.js';

// Regression lock for the orphaned-room ghost-tournament bug (diagnosed
// 2026-06-25): a room deleted before GameRoomService.delete's cascade existed
// left its tournaments is_active=1, so the Scheduler kept firing their crons and
// minting games on the shared iScored account. Fix: Scheduler skips tournaments
// whose game_room no longer exists, and purgeOrphanedTournaments() reaps them.

async function insertOrphanTournament(name: string, deletedRoomId = 'deleted-room-xyz'): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    const cadence = JSON.stringify({ cron: '0 22 * * *', autoRotate: true, autoLock: true });
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, ?, 'DG', 'pinball', ?, 1, ?)`,
        id, name, cadence, deletedRoomId, // game_room_id is a pseudo-FK → non-existent room is allowed
    );
    return id;
}

describe('Scheduler — orphaned-room tournament guard', () => {
    it('does not schedule a tournament whose game_room no longer exists', async () => {
        await setupTestDb();
        const validRoom = await createTestRoom('sched-valid', 'Valid Room');
        const ghostId = await insertOrphanTournament('Ghost Grind');
        const validId = await createTestTournament(validRoom, { name: 'Live Grind' });
        // Give the valid tournament a real cron so it would register.
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET cadence = ? WHERE id = ?`,
            JSON.stringify({ cron: '0 22 * * *', autoRotate: true }), validId,
        );

        const scheduler = Scheduler.getInstance();
        await scheduler.start();
        const tasks = (scheduler as unknown as { tasks: Map<string, unknown> }).tasks;

        expect(tasks.has(ghostId)).toBe(false); // orphaned room → skipped
        expect(tasks.has(validId)).toBe(true);  // valid room → scheduled (control)
        scheduler.stop();
    });
});

describe('GameRoomService.purgeOrphanedTournaments', () => {
    it('reaps orphaned tournaments + games, preserves scores, leaves valid rooms alone', async () => {
        await setupTestDb();
        const db = await getDatabase();

        // Valid room + tournament + game (control — must survive).
        const validRoom = await createTestRoom('purge-valid', 'Valid Room');
        const validT = await createTestTournament(validRoom, { name: 'Keep Me' });
        const keepGame = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, game_room_id)
             VALUES (?, ?, 'Keep Game', 'ACTIVE', ?, ?)`,
            keepGame, validT, new Date().toISOString(), validRoom,
        );

        // Orphaned tournament (room gone) + a game + a submission (score).
        const ghostT = await insertOrphanTournament('Ghost Grind');
        const ghostGame = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date)
             VALUES (?, ?, 'Ghost Game', 'ACTIVE', ?)`,
            ghostGame, ghostT, new Date().toISOString(),
        );
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, 'u1', 'Bob', 500, ?)`,
            `${ghostGame}-bob`, ghostGame, new Date().toISOString(),
        );

        const res = await GameRoomService.purgeOrphanedTournaments();
        expect(res.tournaments).toBe(1);
        expect(res.games).toBe(1);

        // Orphaned tournament + game are gone.
        expect(await db.get('SELECT id FROM tournaments WHERE id = ?', ghostT)).toBeUndefined();
        expect(await db.get('SELECT id FROM games WHERE id = ?', ghostGame)).toBeUndefined();

        // The player's score survives, unlinked (game_id → NULL).
        const sub = await db.get<{ game_id: string | null }>(
            'SELECT game_id FROM submissions WHERE id = ?', `${ghostGame}-bob`,
        );
        expect(sub).toBeDefined();
        expect(sub?.game_id).toBeNull();

        // Valid room's tournament + game untouched.
        expect(await db.get('SELECT id FROM tournaments WHERE id = ?', validT)).toBeDefined();
        expect(await db.get('SELECT id FROM games WHERE id = ?', keepGame)).toBeDefined();
    });

    it('is a no-op when there are no orphaned tournaments', async () => {
        await setupTestDb();
        const room = await createTestRoom('purge-none', 'No Orphans');
        await createTestTournament(room, { name: 'Healthy' });
        const res = await GameRoomService.purgeOrphanedTournaments();
        expect(res).toEqual({ tournaments: 0, games: 0 });
    });
});
