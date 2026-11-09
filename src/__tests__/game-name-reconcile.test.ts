import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { GameNameReconcileService, suggestFor } from '../services/GameNameReconcileService.js';

/**
 * A35 (v2.235.0): merge room history recorded under a name the catalogue does
 * not have ("Arkanoid") into a catalogue game ("Arkanoid (Pinball)").
 *
 * Pinned:
 *   - orphans are found per room, case variants grouped, catalogue names never
 *     listed, and the AtGames table is the first suggestion;
 *   - a merge renames every table in THAT room only, points the games at the
 *     catalogue row, merges the room's game-list row and moves the deleted-score
 *     key;
 *   - iScored-linked games and two live cards under one name block it;
 *   - Undo restores exactly the changed rows; a score written after the merge
 *     keeps the new name;
 *   - the routes are super-admin only.
 */

let roomA: string;
let roomB: string;
let pinballId: string;

async function seed() {
    await setupTestDb();
    const db = await getDatabase();
    roomA = await createTestRoom(`rec-a-${crypto.randomUUID().slice(0, 6)}`, 'Alpha Room');
    roomB = await createTestRoom(`rec-b-${crypto.randomUUID().slice(0, 6)}`, 'Bravo Room');
    pinballId = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, status, platforms, atgames_id) VALUES (?, 'Arkanoid (Pinball)', 'pinball', 'approved', '["atgames_native"]', 50297)`,
        pinballId,
    );
    await db.run(
        `INSERT INTO global_games (id, name, type, status, platforms) VALUES (?, 'Medieval Madness', 'pinball', 'approved', '["vpx"]')`,
        crypto.randomUUID(),
    );
    const tid = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format) VALUES (?, 'Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
        tid, roomA,
    );
    await db.run(`INSERT INTO games (id, tournament_id, name, status, game_room_id) VALUES ('ga1', ?, 'Arkanoid', 'COMPLETED', ?)`, tid, roomA);
    await db.run(`INSERT INTO games (id, tournament_id, name, status, game_room_id) VALUES ('gmm', ?, 'Medieval Madness', 'COMPLETED', ?)`, tid, roomA);
    for (const [room, name, score] of [[roomA, 'Arkanoid', 100], [roomA, 'arkanoid', 200], [roomA, 'Medieval Madness', 300], [roomB, 'Arkanoid', 400]] as const) {
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source) VALUES (?, ?, 'p1', 'u1', ?, 'tournament')`,
            name, room, score,
        );
    }
    await db.run(`INSERT INTO community_scores (game_name, game_room_id, iscored_username, score) VALUES ('Arkanoid', ?, 'p2', 50)`, roomA);
    await db.run(`INSERT INTO game_comments (game_name, game_room_id, user_id, display_name, body) VALUES ('Arkanoid', ?, 'u1', 'P1', 'nice')`, roomA);
    await db.run(`INSERT INTO game_room_game_library (game_room_id, game_name, catalogue_style_id) VALUES (?, 'Arkanoid', 'style-1')`, roomA);
    await db.run(
        `INSERT INTO auto_score_suppressions (source, owner_key, game_key, score, game_room_id) VALUES ('atgames', 'u1', ?, 999, ?)`,
        normalizeGameName('Arkanoid'), roomA,
    );
}

const names = async (sql: string, ...p: unknown[]) => (await (await getDatabase()).all<Array<{ n: string }>>(sql, ...p)).map(r => r.n).sort();

describe('GameNameReconcileService', () => {
    beforeEach(seed);

    it('lists orphans per room with case variants grouped, and suggests the AtGames table first', async () => {
        const orphans = await GameNameReconcileService.listOrphans();
        expect(orphans.map(o => [o.roomName, o.name.toLowerCase()])).toEqual([
            ['Alpha Room', 'arkanoid'], ['Bravo Room', 'arkanoid'],
        ]);
        const a = orphans[0]!;
        expect(a.spellings.sort()).toEqual(['Arkanoid', 'arkanoid']);
        expect(a.counts).toMatchObject({ games: 1, scores: 2, communityScores: 1, comments: 1 });
        expect(a.suggestions[0]).toMatchObject({ id: pinballId, name: 'Arkanoid (Pinball)', atgames: true });
    });

    it('ranks an exact normalized match above a longer name', () => {
        const cat = ['Space Invaders (Pinball)', 'Space Invaders'].map(name => ({
            row: { id: name, name, manufacturer: null, year: null, platforms: '[]', atgames_id: null, normalized_name: null },
            norm: normalizeGameName(name), lower: name.toLowerCase(),
        }));
        expect(suggestFor('space invaders', cat).map(s => s.name)).toEqual(['Space Invaders', 'Space Invaders (Pinball)']);
    });

    it('ranks by shared words and preselects only a clear winner (owner screenshot 2026-11-09)', () => {
        const cat = ['Kung Fu', 'DreamWorks Kung Fu Panda Pinball', 'Getaway', 'The Getaway - High Speed II',
            'Tomb Raider Pinball: Secrets of Croft Manor', 'Arkanoid (Pinball)', 'Arkanoid: Revenge of Doh'].map(name => ({
            row: { id: name, name, manufacturer: null, year: null, platforms: '[]', atgames_id: null, normalized_name: null },
            norm: normalizeGameName(name), lower: name.toLowerCase(),
        }));
        const top = (n: string) => suggestFor(n, cat)[0]!;
        expect(top('Kung Fu Panda Pinball')).toMatchObject({ name: 'DreamWorks Kung Fu Panda Pinball', sure: true });
        expect(top('Getaway - High Speed II, The')).toMatchObject({ name: 'The Getaway - High Speed II', sure: true });
        expect(top('Secrets of Croft Manor')).toMatchObject({ name: 'Tomb Raider Pinball: Secrets of Croft Manor', sure: true });
        // Two tables hold every word of "Arkanoid": suggest both, preselect neither.
        expect(suggestFor('Arkanoid', cat).map(s => s.sure)).toEqual([false, false]);
    });

    it('merges every table in that room only, then Undo restores exactly those rows', async () => {
        const db = await getDatabase();
        const preview = await GameNameReconcileService.preview(roomA, 'Arkanoid', pinballId);
        expect(preview.blockers).toEqual([]);
        expect(preview.counts).toMatchObject({ games: 1, scores: 2, communityScores: 1, comments: 1, library: 'rename', suppressions: 1 });

        const { id } = await GameNameReconcileService.apply(roomA, 'Arkanoid', pinballId, 'admin-1');

        expect(await names(`SELECT game_name AS n FROM score_history WHERE game_room_id = ?`, roomA))
            .toEqual(['Arkanoid (Pinball)', 'Arkanoid (Pinball)', 'Medieval Madness']);
        expect(await names(`SELECT game_name AS n FROM score_history WHERE game_room_id = ?`, roomB)).toEqual(['Arkanoid']);
        const g = await db.get<{ name: string; global_game_id: string }>(`SELECT name, global_game_id FROM games WHERE id = 'ga1'`);
        expect(g).toEqual({ name: 'Arkanoid (Pinball)', global_game_id: pinballId });
        expect(await names(`SELECT game_name AS n FROM community_scores WHERE game_room_id = ?`, roomA)).toEqual(['Arkanoid (Pinball)']);
        expect(await names(`SELECT game_name AS n FROM game_comments WHERE game_room_id = ?`, roomA)).toEqual(['Arkanoid (Pinball)']);
        const lib = await db.get<{ game_name: string; catalogue_style_id: string }>(
            `SELECT game_name, catalogue_style_id FROM game_room_game_library WHERE game_room_id = ?`, roomA,
        );
        expect(lib).toMatchObject({ game_name: 'Arkanoid (Pinball)', catalogue_style_id: 'style-1' });
        expect(await names(`SELECT game_key AS n FROM auto_score_suppressions`)).toEqual([normalizeGameName('Arkanoid (Pinball)')]);
        expect((await GameNameReconcileService.listOrphans()).map(o => o.roomName)).toEqual(['Bravo Room']);

        // A score written AFTER the merge stays under the new name on Undo.
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source) VALUES ('Arkanoid (Pinball)', ?, 'p3', 'u3', 777, 'atgames')`,
            roomA,
        );

        const undone = await GameNameReconcileService.undo(id, 'admin-1');
        expect(undone.restored).toBeGreaterThan(0);
        expect(await names(`SELECT game_name AS n FROM score_history WHERE game_room_id = ?`, roomA))
            .toEqual(['Arkanoid', 'Arkanoid (Pinball)', 'Medieval Madness', 'arkanoid']);
        expect(await db.get(`SELECT name, global_game_id FROM games WHERE id = 'ga1'`)).toEqual({ name: 'Arkanoid', global_game_id: null });
        expect((await db.get<{ game_name: string }>(`SELECT game_name FROM game_room_game_library WHERE game_room_id = ?`, roomA))!.game_name).toBe('Arkanoid');
        expect(await names(`SELECT game_key AS n FROM auto_score_suppressions`)).toEqual([normalizeGameName('Arkanoid')]);
        await expect(GameNameReconcileService.undo(id, 'admin-1')).rejects.toMatchObject({ code: 'ALREADY_UNDONE' });
    });

    it("keeps the target's game-list row when the room already has one, and Undo brings the old one back", async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO game_room_game_library (game_room_id, game_name, catalogue_style_id) VALUES (?, 'Arkanoid (Pinball)', 'style-2')`, roomA);
        const { id, preview } = await GameNameReconcileService.apply(roomA, 'Arkanoid', pinballId, null);
        expect(preview.counts.library).toBe('merge');
        expect(await names(`SELECT game_name AS n FROM game_room_game_library WHERE game_room_id = ?`, roomA)).toEqual(['Arkanoid (Pinball)']);
        await GameNameReconcileService.undo(id, null);
        expect(await names(`SELECT game_name AS n FROM game_room_game_library WHERE game_room_id = ?`, roomA)).toEqual(['Arkanoid', 'Arkanoid (Pinball)']);
    });

    it('blocks iScored-linked games, two live cards under one name, and a name already in the catalogue', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE games SET iscored_id = 'isc-1' WHERE id = 'ga1'`);
        await expect(GameNameReconcileService.apply(roomA, 'Arkanoid', pinballId, null)).rejects.toMatchObject({ code: 'BLOCKED' });
        await db.run(`UPDATE games SET iscored_id = NULL, status = 'ACTIVE' WHERE id = 'ga1'`);
        await db.run(`INSERT INTO games (id, name, status, game_room_id) VALUES ('gp', 'Arkanoid (Pinball)', 'ACTIVE', ?)`, roomA);
        const p = await GameNameReconcileService.preview(roomA, 'Arkanoid', pinballId);
        expect(p.blockers.join(' ')).toMatch(/Both "Arkanoid" and "Arkanoid \(Pinball\)" have a live card/);
        await expect(GameNameReconcileService.preview(roomA, 'Medieval Madness', pinballId)).rejects.toMatchObject({ code: 'IN_CATALOGUE' });
        // Nothing changed.
        expect(await names(`SELECT game_name AS n FROM score_history WHERE game_room_id = ?`, roomA))
            .toEqual(['Arkanoid', 'Medieval Madness', 'arkanoid']);
    });
});

describe('/api/admin/game-names routes', () => {
    beforeEach(seed);

    async function app() {
        const a = express();
        a.use(express.json());
        const { default: adminRouter } = await import('../api/routes/admin.js');
        a.use('/api/admin', adminRouter);
        return a;
    }

    it('are super-admin only, and run preview -> reconcile -> undo', async () => {
        const a = await app();
        const roomAdmin = signToken({ role: 'room_admin', gameRoomIds: [roomA], username: 'ra' });
        expect((await request(a).get('/api/admin/game-names/orphans').set('Authorization', `Bearer ${roomAdmin}`)).status).toBe(403);

        const su = signToken({ role: 'super_admin', username: 'su' });
        const orphans = await request(a).get('/api/admin/game-names/orphans').set('Authorization', `Bearer ${su}`);
        expect(orphans.body.orphans).toHaveLength(2);

        const body = { roomId: roomA, fromName: 'Arkanoid', toGlobalGameId: pinballId };
        const pv = await request(a).post('/api/admin/game-names/preview').set('Authorization', `Bearer ${su}`).send(body);
        expect(pv.status).toBe(200);
        expect(pv.body.counts.scores).toBe(2);

        const run = await request(a).post('/api/admin/game-names/reconcile').set('Authorization', `Bearer ${su}`).send(body);
        expect(run.status).toBe(200);
        const hist = await request(a).get('/api/admin/game-names/reconciles').set('Authorization', `Bearer ${su}`);
        expect(hist.body.reconciles[0]).toMatchObject({ id: run.body.id, fromName: 'Arkanoid', toName: 'Arkanoid (Pinball)', undoneAt: null });

        const undo = await request(a).post(`/api/admin/game-names/reconciles/${run.body.id}/undo`).set('Authorization', `Bearer ${su}`);
        expect(undo.status).toBe(200);
        const again = await request(a).post(`/api/admin/game-names/reconciles/${run.body.id}/undo`).set('Authorization', `Bearer ${su}`);
        expect(again.status).toBe(409);
    });
});
