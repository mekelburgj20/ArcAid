import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { TournamentService } from '../services/TournamentService.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

// S3 (Phase 0): foreign-key enforcement flip. Every test here runs under live
// `PRAGMA foreign_keys=ON` (initDatabase enables it after the migration loop),
// so each one would throw SQLITE_CONSTRAINT before the corresponding write-path
// fix. They lock in: a clean enforced schema, and the four delete paths the
// audit proved would 500 under enforcement.

const adminToken = (roomId: string) => signToken({ role: 'room_admin', gameRoomIds: [roomId] });

async function seedGlobalScore(roomId: string, opts: { gameId?: string } = {}) {
    const db = await getDatabase();
    const ggId = crypto.randomUUID();
    await db.run(`INSERT INTO global_games (id, name, type) VALUES (?, ?, 'pinball')`, ggId, `GG ${ggId.slice(0, 8)}`);
    const gsId = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_scores (id, global_game_id, player_id, score, origin_type, origin_game_room_id, origin_game_id)
         VALUES (?, ?, 'player-1', 5000, 'room', ?, ?)`,
        gsId, ggId, roomId, opts.gameId ?? null,
    );
    return { ggId, gsId };
}

describe('S3 — foreign-key enforcement', () => {
    it('enables enforcement with a clean schema on a fresh DB', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const fk = await db.get('PRAGMA foreign_keys');
        expect(fk.foreign_keys).toBe(1);
        const violations = await db.all('PRAGMA foreign_key_check');
        expect(violations).toEqual([]);
        const mig = await db.get(`SELECT name FROM schema_migrations WHERE name = '104_fk_enforcement_prep'`);
        expect(mig).toBeTruthy();
    });

    it('migration-104 cleanup clears room-child orphans but keeps the live room', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const liveRoom = await createTestRoom('fk-live-room', 'Live Room');
        // Recreate the pre-enforcement debris prod had (rows whose parent room/
        // group is already gone). FK is on, so seed with it briefly off, then
        // restore. Covers the game_room_id, room_id, and ranking-group variants.
        await db.exec('PRAGMA foreign_keys = OFF');
        try {
            await db.run(`INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source) VALUES ('Ghost', 'gone-room', 'X', 1, 'tournament')`);
            await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES ('u1', 'gone-room', 'backfill')`);
            await db.run(`INSERT INTO ranking_group_tournaments (ranking_group_id, tournament_id) VALUES ('gone-group', 'gone-tourn')`);
            await db.run(`INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source) VALUES ('Keep', ?, 'Y', 2, 'tournament')`, liveRoom);
        } finally {
            await db.exec('PRAGMA foreign_keys = ON');
        }
        expect((await db.all('PRAGMA foreign_key_check')).length).toBeGreaterThan(0);

        // The same cleanup migration 104 performs:
        await db.run(`DELETE FROM score_history WHERE game_room_id NOT IN (SELECT id FROM game_rooms)`);
        await db.run(`DELETE FROM room_members WHERE room_id NOT IN (SELECT id FROM game_rooms)`);
        await db.run(`DELETE FROM ranking_group_tournaments WHERE ranking_group_id NOT IN (SELECT id FROM ranking_groups) OR tournament_id NOT IN (SELECT id FROM tournaments)`);

        expect(await db.all('PRAGMA foreign_key_check')).toEqual([]);
        expect((await db.get(`SELECT COUNT(*) c FROM score_history WHERE game_name = 'Keep'`)).c).toBe(1);
        expect((await db.get(`SELECT COUNT(*) c FROM score_history WHERE game_name = 'Ghost'`)).c).toBe(0);
    });

    it('game_room_game_library is writable after the rebuild (dead game_library FK gone)', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('fk-grgl', 'FK GRGL');
        // Pre-rebuild this would throw "no such table: game_library" under FK ON.
        await expect(
            db.run(
                `INSERT INTO game_room_game_library (game_room_id, game_name, catalogue_style_id) VALUES (?, 'Some Table', 'style-1')`,
                roomId,
            ),
        ).resolves.toBeTruthy();
        const row = await db.get(
            `SELECT catalogue_style_id FROM game_room_game_library WHERE game_room_id = ? AND game_name = 'Some Table'`,
            roomId,
        );
        expect(row.catalogue_style_id).toBe('style-1');
    });

    it('TournamentService.delete resolves under enforcement and preserves score history', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('fk-tdel', 'FK TDel');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { status: 'COMPLETED', endDate: new Date().toISOString() });
        const subId = await createTestSubmission(gameId, { username: 'Alice', score: 9000 });

        await expect(TournamentService.delete(tId)).resolves.toBeUndefined();

        expect(await db.get('SELECT id FROM tournaments WHERE id = ?', tId)).toBeUndefined();
        expect(await db.get('SELECT id FROM games WHERE tournament_id = ?', tId)).toBeUndefined();
        // Score history survives, unlinked from the deleted game.
        const sub = await db.get('SELECT game_id FROM submissions WHERE id = ?', subId);
        expect(sub).toBeTruthy();
        expect(sub.game_id).toBeNull();
        const hist = await db.get('SELECT game_id FROM score_history WHERE game_id IS NULL AND iscored_username = ?', 'Alice');
        expect(hist).toBeTruthy();
    });

    it('GameRoomService.delete resolves and preserves global history (NO-ACTION origin_game_room_id)', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('fk-rdel', 'FK RDel');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Room Game' });
        await createTestSubmission(gameId, { username: 'Bob', score: 7000 });
        const { gsId } = await seedGlobalScore(roomId, { gameId });

        await expect(GameRoomService.delete(roomId)).resolves.toBe(true);

        expect(await db.get('SELECT id FROM game_rooms WHERE id = ?', roomId)).toBeUndefined();
        expect(await db.get('SELECT id FROM tournaments WHERE id = ?', tId)).toBeUndefined();
        expect(await db.get('SELECT id FROM games WHERE id = ?', gameId)).toBeUndefined();
        // game_room_id-cascade child gone; global score survives, room ref nulled.
        expect(await db.get('SELECT id FROM score_history WHERE game_room_id = ?', roomId)).toBeUndefined();
        const gs = await db.get('SELECT origin_game_room_id, origin_game_id FROM global_scores WHERE id = ?', gsId);
        expect(gs).toBeTruthy();
        expect(gs.origin_game_room_id).toBeNull();
        expect(gs.origin_game_id).toBeNull();
    });

    it('GlobalGameService.delete resolves and removes dependent global scores', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('fk-cdel', 'FK CDel');
        const { ggId, gsId } = await seedGlobalScore(roomId);

        await expect(GlobalGameService.delete(ggId)).resolves.toBe(true);

        expect(await db.get('SELECT id FROM global_games WHERE id = ?', ggId)).toBeUndefined();
        expect(await db.get('SELECT id FROM global_scores WHERE id = ?', gsId)).toBeUndefined();
    });

    it('admin "remove game, retain scores" endpoint resolves and keeps unlinked scores', async () => {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);

        const db = await getDatabase();
        const roomId = await createTestRoom('fk-removegame', 'FK RemoveGame');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Keep Scores' });
        const subId = await createTestSubmission(gameId, { username: 'Carol', score: 4200 });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/games/${gameId}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        expect(res.status).toBe(200);
        expect(await db.get('SELECT id FROM games WHERE id = ?', gameId)).toBeUndefined();
        const sub = await db.get('SELECT game_id FROM submissions WHERE id = ?', subId);
        expect(sub).toBeTruthy();
        expect(sub.game_id).toBeNull();
    });
});
