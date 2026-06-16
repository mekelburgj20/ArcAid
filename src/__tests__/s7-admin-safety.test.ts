import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import {
    setupTestDb,
    createTestRoom,
    createTestTournament,
    createTestGame,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { Scheduler } from '../engine/Scheduler.js';

// S7 — admin-safety changes:
//   • merge-player (rename) relaxed to requireRoomAccess but room-scoped, with
//     dry-run + global-identity gated to super_admin.
//   • DELETE /games/:id auto-deactivate option (default stays 409 for ACTIVE).
//   • PATCH /tournaments/:id/active pause/resume toggle + activation-path guard.

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const roomAdminToken = (roomId: string) => signToken({ role: 'room_admin', gameRoomIds: [roomId] });
const superAdminToken = () => signToken({ role: 'super_admin', gameRoomIds: [] });

/**
 * Seed a "Bob" score footprint in a room: one submission (with score_history
 * via the games→tournament context) + one community_score + one scores row.
 * Returns the gameId so callers can assert per-row.
 */
async function seedBobInRoom(roomId: string, tournamentId: string, opts: {
    name?: string;
    score?: number;
} = {}): Promise<{ gameId: string }> {
    const db = await getDatabase();
    const username = 'Bob';
    const gameId = crypto.randomUUID();
    const score = opts.score ?? 1000;
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, start_date, game_room_id)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?)`,
        gameId, tournamentId, opts.name || 'Test Game', new Date().toISOString(), roomId,
    );
    // submissions — id follows the ${gameId}-${username} convention.
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_from_room_id)
         VALUES (?, ?, 'iscored:bob', ?, ?, ?, ?)`,
        `${gameId}-${username.toLowerCase()}`, gameId, username, score, new Date().toISOString(), roomId,
    );
    // score_history — direct game_room_id column.
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source, submitted_from_room_id)
         VALUES (?, ?, ?, ?, 'iscored:bob', ?, 'tournament', ?)`,
        opts.name || 'Test Game', roomId, gameId, username, score, roomId,
    );
    // community_scores — direct game_room_id column.
    await db.run(
        `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score)
         VALUES (?, ?, ?, 'iscored:bob', ?)`,
        opts.name || 'Test Game', roomId, username, score,
    );
    // scores — no room column; scoped via game→tournament join.
    await db.run(
        `INSERT INTO scores (id, game_id, discord_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, 'iscored:bob', ?, ?, ?)`,
        crypto.randomUUID(), gameId, username, score, new Date().toISOString(),
    );
    return { gameId };
}

async function countBob(table: string, roomId: string): Promise<number> {
    const db = await getDatabase();
    if (table === 'community_scores' || table === 'score_history') {
        const r = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE LOWER(iscored_username)='bob' AND game_room_id = ?`,
            roomId,
        );
        return r?.n ?? 0;
    }
    if (table === 'submissions') {
        const r = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM submissions s
             LEFT JOIN games g ON g.id = s.game_id
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE LOWER(s.iscored_username)='bob'
               AND (s.submitted_from_room_id = ? OR t.game_room_id = ? OR g.game_room_id = ?)`,
            roomId, roomId, roomId,
        );
        return r?.n ?? 0;
    }
    // scores
    const r = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM scores sc
         LEFT JOIN games g ON g.id = sc.game_id
         LEFT JOIN tournaments t ON t.id = g.tournament_id
         WHERE LOWER(sc.iscored_username)='bob'
           AND (t.game_room_id = ? OR g.game_room_id = ?)`,
        roomId, roomId,
    );
    return r?.n ?? 0;
}

describe('S7 — rename player is room-scoped (cross-tenant isolation)', () => {
    it('renames only Room A rows; Room B "Bob" rows untouched (incl. pinned)', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomA = await createTestRoom('s7-iso-a', 'S7 Iso A');
        const roomB = await createTestRoom('s7-iso-b', 'S7 Iso B');
        const tA = await createTestTournament(roomA);
        const tB = await createTestTournament(roomB);
        await seedBobInRoom(roomA, tA, { name: 'Game A' });
        await seedBobInRoom(roomB, tB, { name: 'Game B' });

        // Room B pinned game (tournament_id NULL, games.game_room_id = roomB) with a Bob submission.
        const db = await getDatabase();
        const pinnedId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, game_room_id)
             VALUES (?, NULL, 'Pinned B', 'COMPLETED', ?, ?)`,
            pinnedId, new Date().toISOString(), roomB,
        );
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, 'iscored:bob', 'Bob', 500, ?)`,
            `${pinnedId}-bob`, pinnedId, new Date().toISOString(),
        );

        const res = await request(app)
            .post(`/api/rooms/${roomA}/admin/merge-player`)
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({ fromUsername: 'Bob', toUsername: 'Bobby' });
        expect(res.status).toBe(200);

        // Room A: zero "Bob" rows remain (all became "Bobby").
        expect(await countBob('submissions', roomA)).toBe(0);
        expect(await countBob('scores', roomA)).toBe(0);
        expect(await countBob('community_scores', roomA)).toBe(0);
        expect(await countBob('score_history', roomA)).toBe(0);

        // Room B: every "Bob" row UNTOUCHED.
        expect(await countBob('submissions', roomB)).toBe(2); // tournament + pinned
        expect(await countBob('scores', roomB)).toBe(1);
        expect(await countBob('community_scores', roomB)).toBe(1);
        expect(await countBob('score_history', roomB)).toBe(1);

        // Pinned Room B row specifically still reads "Bob".
        const pinned = await db.get<{ iscored_username: string }>(
            'SELECT iscored_username FROM submissions WHERE id = ?',
            `${pinnedId}-bob`,
        );
        expect(pinned?.iscored_username).toBe('Bob');
    });
});

describe('S7 — rename dry-run equals commit', () => {
    it('dry-run rowsAffected/total deep-equal the actual commit', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomA = await createTestRoom('s7-dry-a', 'S7 Dry A');
        const tA = await createTestTournament(roomA);
        await seedBobInRoom(roomA, tA, { name: 'Game 1' });
        await seedBobInRoom(roomA, tA, { name: 'Game 2' });

        const dry = await request(app)
            .post(`/api/rooms/${roomA}/admin/merge-player?dryRun=true`)
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({ fromUsername: 'Bob', toUsername: 'Bobby' });
        expect(dry.status).toBe(200);
        expect(dry.body.dryRun).toBe(true);

        const commit = await request(app)
            .post(`/api/rooms/${roomA}/admin/merge-player`)
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({ fromUsername: 'Bob', toUsername: 'Bobby' });
        expect(commit.status).toBe(200);

        expect(commit.body.rowsAffected).toEqual(dry.body.rowsAffected);
        expect(commit.body.total).toBe(dry.body.total);
    });
});

describe('S7 — global identity writes gated to super_admin', () => {
    it('room_admin commit leaves user_mappings/player_aliases untouched', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomA = await createTestRoom('s7-gi-a', 'S7 GI A');
        const tA = await createTestTournament(roomA);
        await seedBobInRoom(roomA, tA);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('d-1', 'Bob')`,
        );

        const res = await request(app)
            .post(`/api/rooms/${roomA}/admin/merge-player`)
            .set('Authorization', `Bearer ${roomAdminToken(roomA)}`)
            .send({ fromUsername: 'Bob', toUsername: 'Bobby' });
        expect(res.status).toBe(200);
        expect(res.body.globalIdentityUpdated).toBe(false);
        expect(res.body.rowsAffected.user_mappings).toBe(0);
        expect(res.body.rowsAffected.player_aliases).toBe(0);

        // user_mappings still maps "Bob" (not rewritten); no alias row created.
        const um = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM user_mappings WHERE LOWER(iscored_username)='bob'`,
        );
        expect(um?.n).toBe(1);
        const alias = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM player_aliases WHERE old_username='bob'`,
        );
        expect(alias?.n).toBe(0);
    });

    it('super_admin commit rewrites user_mappings + writes a player_aliases row', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomA = await createTestRoom('s7-gi-super', 'S7 GI Super');
        const tA = await createTestTournament(roomA);
        await seedBobInRoom(roomA, tA);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('d-2', 'Bob')`,
        );

        const res = await request(app)
            .post(`/api/rooms/${roomA}/admin/merge-player`)
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({ fromUsername: 'Bob', toUsername: 'Bobby' });
        expect(res.status).toBe(200);
        expect(res.body.globalIdentityUpdated).toBe(true);

        const um = await db.get<{ iscored_username: string }>(
            `SELECT iscored_username FROM user_mappings WHERE discord_user_id='d-2'`,
        );
        expect(um?.iscored_username).toBe('Bobby');
        const alias = await db.get<{ new_username: string }>(
            `SELECT new_username FROM player_aliases WHERE old_username='bob'`,
        );
        expect(alias?.new_username).toBe('Bobby');
    });
});

describe('S7 — rename gate still blocks cross-room', () => {
    it('room_admin of Room A cannot rename in Room B (403)', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomA = await createTestRoom('s7-gate-a', 'S7 Gate A');
        const roomB = await createTestRoom('s7-gate-b', 'S7 Gate B');
        const res = await request(app)
            .post(`/api/rooms/${roomB}/admin/merge-player`)
            .set('Authorization', `Bearer ${roomAdminToken(roomA)}`)
            .send({ fromUsername: 'Bob', toUsername: 'Bobby' });
        expect(res.status).toBe(403);
    });
});

describe('S7 — tournament-game DELETE auto-deactivate path', () => {
    it('409 with games[] on an ACTIVE game and no flag', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('s7-del-409', 'S7 Del 409');
        const tId = await createTestTournament(roomId);
        const activeId = await createTestGame(tId, { name: 'Live Table', status: 'ACTIVE' });
        await createTestGame(tId, { name: 'Next Up', status: 'QUEUED' });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${activeId}`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`);
        expect(res.status).toBe(409);
        expect(Array.isArray(res.body.games)).toBe(true);
        const names = res.body.games.map((g: any) => g.name).sort();
        expect(names).toEqual(['Live Table', 'Next Up']);
        const active = res.body.games.find((g: any) => g.name === 'Live Table');
        expect(active.status).toBe('ACTIVE');
    });

    it('deactivateActive:true deactivates (200) — row COMPLETED, iscored_id intact, not deleted', async () => {
        await setupTestDb();
        // Ensure offline: clear any env iScored creds a dev machine might export
        // so getIScoredCredsForRoom returns null (no Playwright/registry call).
        delete process.env.ISCORED_USERNAME;
        delete process.env.ISCORED_PASSWORD;
        delete process.env.ISCORED_PUBLIC_URL;
        const app = await createTestApp();
        const roomId = await createTestRoom('s7-del-deact', 'S7 Del Deact');
        const tId = await createTestTournament(roomId);
        const db = await getDatabase();
        const activeId = crypto.randomUUID();
        // iscored_id present, but the test room has NO iScored credentials
        // configured, so getIScoredCredsForRoom returns null and both the
        // final-sync and the iScored lock short-circuit — fully offline, no
        // Playwright/registry call. iscored_id is intentionally kept non-NULL.
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, iscored_id, game_room_id)
             VALUES (?, ?, 'Live Table', 'ACTIVE', ?, '95570', ?)`,
            activeId, tId, new Date().toISOString(), roomId,
        );

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${activeId}`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`)
            .send({ deactivateActive: true });
        expect(res.status).toBe(200);
        expect(res.body.action).toBe('deactivated');

        const row = await db.get<{ status: string; iscored_id: string | null }>(
            'SELECT status, iscored_id FROM games WHERE id = ?',
            activeId,
        );
        expect(row).toBeTruthy(); // NOT deleted
        expect(row?.status).toBe('COMPLETED');
        expect(row?.iscored_id).toBe('95570'); // kept non-NULL
    });

    it('DELETE on a COMPLETED game removes the row + orphans scores (ADR 0005)', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('s7-del-done', 'S7 Del Done');
        const tId = await createTestTournament(roomId);
        const db = await getDatabase();
        const gameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, game_room_id, end_date)
             VALUES (?, ?, 'Old Table', 'COMPLETED', ?, ?, ?)`,
            gameId, tId, new Date().toISOString(), roomId, new Date().toISOString(),
        );
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, 'iscored:zed', 'Zed', 999, ?)`,
            `${gameId}-zed`, gameId, new Date().toISOString(),
        );
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, score, source)
             VALUES ('Old Table', ?, ?, 'Zed', 999, 'tournament')`,
            roomId, gameId,
        );
        await db.run(
            `INSERT INTO global_games (id, name, type) VALUES ('gg-1', 'Old Table', 'pinball')`,
        );
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_id)
             VALUES (?, 'gg-1', 'iscored:zed', 'Zed', 999, 'room', ?)`,
            crypto.randomUUID(), gameId,
        );

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${gameId}`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`);
        expect(res.status).toBe(200);
        expect(res.body.action).toBe('deleted');

        // games row gone.
        const gone = await db.get('SELECT id FROM games WHERE id = ?', gameId);
        expect(gone).toBeUndefined();
        // Score records preserved but orphaned.
        const sub = await db.get<{ game_id: string | null }>('SELECT game_id FROM submissions WHERE id = ?', `${gameId}-zed`);
        expect(sub).toBeTruthy();
        expect(sub?.game_id).toBeNull();
        const hist = await db.get<{ game_id: string | null }>(
            `SELECT game_id FROM score_history WHERE iscored_username='Zed'`,
        );
        expect(hist?.game_id).toBeNull();
        const gs = await db.get<{ origin_game_id: string | null }>(
            `SELECT origin_game_id FROM global_scores WHERE player_id='iscored:zed'`,
        );
        expect(gs?.origin_game_id).toBeNull();
    });
});

describe('S7 — paused tournament is skipped by the activation path', () => {
    it('Scheduler registers no maintenance task for an is_active=0 tournament', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('s7-pause-sched', 'S7 Pause Sched');
        const pausedId = crypto.randomUUID();
        const activeId = crypto.randomUUID();
        // Both need a real cron cadence so scheduleTournament would register them.
        const cadence = JSON.stringify({ cron: '0 22 * * *', autoRotate: true, autoLock: true });
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'Paused', 'DG', 'pinball', ?, 0, ?)`,
            pausedId, cadence, roomId,
        );
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'Running', 'DG', 'pinball', ?, 1, ?)`,
            activeId, cadence, roomId,
        );

        const scheduler = Scheduler.getInstance();
        await scheduler.start();
        const tasks = (scheduler as unknown as { tasks: Map<string, any> }).tasks;
        expect(tasks.has(pausedId)).toBe(false); // paused → no task
        expect(tasks.has(activeId)).toBe(true);  // active → task registered (positive control)
        scheduler.stop();
    });

    it('runMaintenance early-returns for a paused tournament (no game activation)', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('s7-pause-run', 'S7 Pause Run');
        const pausedId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'Paused', 'DG', 'pinball', '{}', 0, ?)`,
            pausedId, roomId,
        );
        // A QUEUED game that maintenance would normally try to activate.
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, queue_order, game_room_id)
             VALUES (?, ?, 'Should Not Activate', 'QUEUED', 0, ?)`,
            crypto.randomUUID(), pausedId, roomId,
        );

        await TournamentEngine.getInstance().runMaintenance(pausedId);

        // No game became ACTIVE — the guard short-circuited.
        const active = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`,
            pausedId,
        );
        expect(active?.n).toBe(0);
    });
});

describe('S7 — PATCH /tournaments/:id/active pause toggle', () => {
    it('toggles is_active and reloads the Scheduler', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('s7-patch', 'S7 Patch');
        const tId = await createTestTournament(roomId);
        const db = await getDatabase();
        const reloadSpy = vi.spyOn(Scheduler.getInstance(), 'reload').mockResolvedValue();

        const off = await request(app)
            .patch(`/api/rooms/${roomId}/tournaments/${tId}/active`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`)
            .send({ is_active: false });
        expect(off.status).toBe(200);
        expect(off.body).toEqual({ success: true, is_active: false });
        let row = await db.get<{ is_active: number }>('SELECT is_active FROM tournaments WHERE id = ?', tId);
        expect(row?.is_active).toBe(0);
        expect(reloadSpy).toHaveBeenCalled();

        const on = await request(app)
            .patch(`/api/rooms/${roomId}/tournaments/${tId}/active`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`)
            .send({ is_active: true });
        expect(on.status).toBe(200);
        row = await db.get<{ is_active: number }>('SELECT is_active FROM tournaments WHERE id = ?', tId);
        expect(row?.is_active).toBe(1);
        reloadSpy.mockRestore();
    });

    it('400 on a non-boolean is_active', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomId = await createTestRoom('s7-patch-bad', 'S7 Patch Bad');
        const tId = await createTestTournament(roomId);
        const res = await request(app)
            .patch(`/api/rooms/${roomId}/tournaments/${tId}/active`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`)
            .send({ is_active: 'nope' });
        expect(res.status).toBe(400);
    });

    it('404 when the tournament belongs to another room', async () => {
        await setupTestDb();
        const app = await createTestApp();
        const roomA = await createTestRoom('s7-patch-a', 'S7 Patch A');
        const roomB = await createTestRoom('s7-patch-b', 'S7 Patch B');
        const tB = await createTestTournament(roomB);
        // super_admin so requireRoomAccess passes — the handler's own ownership
        // check must still 404 because tB is not in roomA.
        const res = await request(app)
            .patch(`/api/rooms/${roomA}/tournaments/${tB}/active`)
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({ is_active: false });
        expect(res.status).toBe(404);
    });
});
