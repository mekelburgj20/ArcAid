import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { RankingService } from '../services/RankingService.js';
import crypto from 'crypto';

/**
 * Ranking-card backgrounds (owner-designed 2026-08-09, pre-review branch
 * feature/ranking-card-backgrounds).
 *
 * Covers: migration 140 sanity, the PUT/DELETE
 * /:roomId/ranking-groups/:id/style admin endpoints (auth + happy path +
 * clear-to-null + validation), the public read path shipping bg_style_id/
 * bg_has_bg, and — the important design decision from the spec — that
 * setting a background does NOT bounce the ranking_groups_cache the way
 * RankingService.update() does (presentation-only, not a computeRankings
 * input).
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function adminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}

function superAdminToken() {
    return signToken({ role: 'super_admin', gameRoomIds: [] });
}

/** Seeds a style_catalogue row. hasBackground defaults true. */
async function createTestStyle(opts: { hasBackground?: boolean; hasHeader?: boolean } = {}): Promise<string> {
    const db = await getDatabase();
    const id = `custom-${crypto.randomUUID()}`;
    await db.run(
        `INSERT INTO style_catalogue (id, iscored_style_id, name, author, notes, has_background, has_header, source)
         VALUES (?, NULL, ?, 'Tester', '', ?, ?, 'custom')`,
        id, 'Test Style', opts.hasBackground === false ? 0 : 1, opts.hasHeader ? 1 : 0,
    );
    return id;
}

async function createTestRankingGroup(roomId: string, tournamentId?: string): Promise<string> {
    const id = crypto.randomUUID();
    await RankingService.create({
        id,
        name: 'Overall',
        rank_method: 'max_10',
        best_n: 25,
        min_games: 1,
        tournament_ids: tournamentId ? [tournamentId] : [],
        game_room_id: roomId,
    });
    return id;
}

describe('Ranking-group background style', () => {
    describe('migration 140 sanity', () => {
        it('ranking_groups has a bg_style_id column, defaulting to null', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);

            const group = await RankingService.getById(groupId);
            expect(group).toBeTruthy();
            expect(group!.bg_style_id).toBeNull();
            expect(group!.bg_has_bg).toBeNull();

            // Column is genuinely queryable (not just absent-and-undefined).
            const db = await getDatabase();
            const cols = await db.all<{ name: string }[]>(`PRAGMA table_info(ranking_groups)`);
            expect(cols.some(c => c.name === 'bg_style_id')).toBe(true);
        });
    });

    describe('PUT /api/rooms/:roomId/ranking-groups/:id/style', () => {
        it('sets a background style (happy path)', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);
            const styleId = await createTestStyle();

            const res = await request(app)
                .put(`/api/rooms/${roomId}/ranking-groups/${groupId}/style`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`)
                .send({ styleId });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const group = await RankingService.getById(groupId);
            expect(group!.bg_style_id).toBe(styleId);
            expect(group!.bg_has_bg).toBe(1);
        });

        it('400s when the style does not exist', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);

            const res = await request(app)
                .put(`/api/rooms/${roomId}/ranking-groups/${groupId}/style`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`)
                .send({ styleId: 'nonexistent-style' });

            expect(res.status).toBe(400);
            const group = await RankingService.getById(groupId);
            expect(group!.bg_style_id).toBeNull();
        });

        it('400s when the style has no background image', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);
            const headerOnlyStyle = await createTestStyle({ hasBackground: false, hasHeader: true });

            const res = await request(app)
                .put(`/api/rooms/${roomId}/ranking-groups/${groupId}/style`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`)
                .send({ styleId: headerOnlyStyle });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/background/i);
        });

        it('404s when the group belongs to a different room', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom('room-a', 'Room A');
            const otherRoomId = await createTestRoom('room-b', 'Room B');
            const groupId = await createTestRankingGroup(roomId);
            const styleId = await createTestStyle();

            const res = await request(app)
                .put(`/api/rooms/${otherRoomId}/ranking-groups/${groupId}/style`)
                .set('Authorization', `Bearer ${superAdminToken()}`)
                .send({ styleId });

            expect(res.status).toBe(404);
        });

        it('403s a room_admin token for a different room', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);
            const styleId = await createTestStyle();

            const res = await request(app)
                .put(`/api/rooms/${roomId}/ranking-groups/${groupId}/style`)
                .set('Authorization', `Bearer ${adminToken('some-other-room')}`)
                .send({ styleId });

            expect(res.status).toBe(403);
        });

        it('401s with no token', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);
            const styleId = await createTestStyle();

            const res = await request(app)
                .put(`/api/rooms/${roomId}/ranking-groups/${groupId}/style`)
                .send({ styleId });

            expect(res.status).toBe(401);
        });
    });

    describe('DELETE /api/rooms/:roomId/ranking-groups/:id/style', () => {
        it('clears an assigned background back to null', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);
            const styleId = await createTestStyle();
            await RankingService.setBgStyle(groupId, styleId);

            const res = await request(app)
                .delete(`/api/rooms/${roomId}/ranking-groups/${groupId}/style`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`);

            expect(res.status).toBe(200);
            const group = await RankingService.getById(groupId);
            expect(group!.bg_style_id).toBeNull();
        });
    });

    describe('public read path', () => {
        it('GET /:roomId/rankings ships bg_style_id and bg_has_bg on the group', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED' });
            await createTestSubmission(gameId, { username: 'Alice', score: 1000 });
            const groupId = await createTestRankingGroup(roomId, tId);
            const styleId = await createTestStyle();
            await RankingService.setBgStyle(groupId, styleId);

            const res = await request(app).get(`/api/rooms/${roomId}/rankings`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(res.body[0].group.bg_style_id).toBe(styleId);
            expect(res.body[0].group.bg_has_bg).toBe(1);
        });

        it('ships null bg fields when no background is assigned', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED' });
            await createTestSubmission(gameId, { username: 'Alice', score: 1000 });
            await createTestRankingGroup(roomId, tId);

            const res = await request(app).get(`/api/rooms/${roomId}/rankings`);

            expect(res.status).toBe(200);
            expect(res.body[0].group.bg_style_id).toBeNull();
            expect(res.body[0].group.bg_has_bg).toBeNull();
        });
    });

    describe('cache is presentation-decoupled (does not recompute on bg change)', () => {
        it('setBgStyle leaves ranking_groups_cache untouched', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED' });
            await createTestSubmission(gameId, { username: 'Alice', score: 1000 });
            const groupId = await createTestRankingGroup(roomId, tId);

            // Populate the cache.
            await RankingService.getRankings(groupId);
            const db = await getDatabase();
            const before = await db.get<{ generated_at: string }>(
                'SELECT generated_at FROM ranking_groups_cache WHERE ranking_group_id = ?',
                groupId,
            );
            expect(before).toBeTruthy();

            const styleId = await createTestStyle();
            const result = await RankingService.setBgStyle(groupId, styleId);
            expect(result.ok).toBe(true);

            // Unlike update(), setBgStyle must NOT delete/bounce the cache row —
            // a background image is not a computeRankings input.
            const after = await db.get<{ generated_at: string }>(
                'SELECT generated_at FROM ranking_groups_cache WHERE ranking_group_id = ?',
                groupId,
            );
            expect(after).toBeTruthy();
            expect(after!.generated_at).toBe(before!.generated_at);
        });
    });

    describe('style deletion cleans up ranking_groups references', () => {
        it('StyleCatalogueService.delete nulls out bg_style_id on any group using it', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const groupId = await createTestRankingGroup(roomId);
            const styleId = await createTestStyle();
            await RankingService.setBgStyle(groupId, styleId);

            const { StyleCatalogueService } = await import('../services/StyleCatalogueService.js');
            const deleted = await StyleCatalogueService.delete(styleId);
            expect(deleted).toBe(true);

            const group = await RankingService.getById(groupId);
            expect(group!.bg_style_id).toBeNull();
        });
    });
});
