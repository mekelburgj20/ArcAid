import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import { CommentService } from '../services/CommentService.js';
import { CommentReportService } from '../services/CommentReportService.js';
import { ScoreReportService } from '../services/ScoreReportService.js';

/**
 * v2.47.0 — S22 follow-ups Workstream 2: comment reports. Mirrors
 * contentBlocklist.test.ts / ban-enforcement.test.ts's structure — unit
 * coverage for CommentReportService, plus chokepoint integration tests for
 * the report endpoint.
 */

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

async function seedComment(roomId: string, gameName = 'Test Game') {
    const comment = await CommentService.addComment(roomId, gameName, 'discord-comment-author', 'Author', 'comment', 'nice game');
    return comment.id as number;
}

describe('CommentReportService', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('create() files a report against an existing comment', async () => {
        const roomId = await createTestRoom('cr-create-room');
        const commentId = await seedComment(roomId);
        const { id } = await CommentReportService.create({
            commentId, reporterDiscordId: 'discord-reporter-1', reason: 'spam',
        });
        expect(id).toBeGreaterThan(0);
    });

    it('create() throws COMMENT_NOT_FOUND for a nonexistent comment', async () => {
        await expect(
            CommentReportService.create({ commentId: 999999, reporterDiscordId: 'discord-reporter-2' }),
        ).rejects.toMatchObject({ code: 'COMMENT_NOT_FOUND' });
    });

    it('create() rejects a duplicate open report from the same reporter (DUPLICATE_REPORT)', async () => {
        const roomId = await createTestRoom('cr-dupe-room');
        const commentId = await seedComment(roomId);
        await CommentReportService.create({ commentId, reporterDiscordId: 'discord-reporter-3' });
        await expect(
            CommentReportService.create({ commentId, reporterDiscordId: 'discord-reporter-3' }),
        ).rejects.toMatchObject({ code: 'DUPLICATE_REPORT' });
    });

    it('allows a fresh report from the same reporter after the first one resolves (re-report-after-resolve)', async () => {
        const roomId = await createTestRoom('cr-rereport-room');
        const commentId = await seedComment(roomId);
        const first = await CommentReportService.create({ commentId, reporterDiscordId: 'discord-reporter-4' });
        await CommentReportService.dismiss(first.id, 'admin-x');

        const second = await CommentReportService.create({ commentId, reporterDiscordId: 'discord-reporter-4' });
        expect(second.id).toBeGreaterThan(first.id);
    });

    it('list() returns open reports enriched with comment body + game/room context', async () => {
        const roomId = await createTestRoom('cr-list-room', 'CR List Room');
        const commentId = await seedComment(roomId, 'Listed Game');
        await CommentReportService.create({ commentId, reporterDiscordId: 'discord-reporter-5', reason: 'rude' });

        const pending = await CommentReportService.list({ status: 'pending' });
        const row = pending.find((r) => r.comment_id === commentId);
        expect(row).toBeTruthy();
        expect(row?.comment_body).toBe('nice game');
        expect(row?.game_name).toBe('Listed Game');
        expect(row?.room_name).toBe('CR List Room');
        expect(row?.reason).toBe('rude');
    });

    it('dismiss() resolves the report without touching the comment', async () => {
        const roomId = await createTestRoom('cr-dismiss-room');
        const commentId = await seedComment(roomId);
        const { id } = await CommentReportService.create({ commentId, reporterDiscordId: 'discord-reporter-6' });

        const ok = await CommentReportService.dismiss(id, 'admin-x');
        expect(ok).toBe(true);

        const comment = await CommentService.getCommentById(commentId);
        expect(comment).toBeTruthy(); // comment survives a dismiss

        const resolved = await CommentReportService.list({ status: 'resolved' });
        expect(resolved.some((r) => r.id === id && r.resolution === 'dismissed')).toBe(true);
    });

    it('remove() deletes the comment and resolves the report', async () => {
        const roomId = await createTestRoom('cr-remove-room');
        const commentId = await seedComment(roomId);
        const { id } = await CommentReportService.create({ commentId, reporterDiscordId: 'discord-reporter-7' });

        const ok = await CommentReportService.remove(id, 'admin-x');
        expect(ok).toBe(true);

        const comment = await CommentService.getCommentById(commentId);
        expect(comment).toBeUndefined(); // comment deleted

        const resolved = await CommentReportService.list({ status: 'resolved' });
        const row = resolved.find((r) => r.id === id);
        expect(row?.resolution).toBe('removed');
        expect(row?.comment_body).toBeNull(); // LEFT JOIN — underlying comment is gone
    });

    it('dismiss()/remove() return false for an already-resolved or unknown report id', async () => {
        expect(await CommentReportService.dismiss(999999, 'admin-x')).toBe(false);
        expect(await CommentReportService.remove(999999, 'admin-x')).toBe(false);
    });

    // v2.47.0 (S22 follow-ups L4+L5) — sibling-report sweep: two open reports
    // on the same comment, resolving via ONE must resolve BOTH (not leave the
    // other dangling in the queue pointed at a now-deleted comment).
    it('remove() via one report resolves ALL open reports on the same comment, and deletes the comment once', async () => {
        const roomId = await createTestRoom('cr-remove-sibling-room');
        const commentId = await seedComment(roomId);
        const first = await CommentReportService.create({ commentId, reporterDiscordId: 'discord-sibling-reporter-1' });
        const second = await CommentReportService.create({ commentId, reporterDiscordId: 'discord-sibling-reporter-2' });

        const ok = await CommentReportService.remove(first.id, 'admin-x');
        expect(ok).toBe(true);

        const comment = await CommentService.getCommentById(commentId);
        expect(comment).toBeUndefined();

        const resolved = await CommentReportService.list({ status: 'resolved' });
        const firstRow = resolved.find((r) => r.id === first.id);
        const secondRow = resolved.find((r) => r.id === second.id);
        expect(firstRow?.resolution).toBe('removed');
        expect(secondRow?.resolution).toBe('removed');

        const pending = await CommentReportService.list({ status: 'pending' });
        expect(pending.some((r) => r.comment_id === commentId)).toBe(false);
    });
});

describe('POST /api/global/comments/:id/report — chokepoint', () => {
    async function createApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    it('requires auth — 401 without a token', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-ep-noauth-room');
        const commentId = await seedComment(roomId);
        const res = await request(app).post(`/api/global/comments/${commentId}/report`).send({ reason: 'x' });
        expect(res.status).toBe(401);
    });

    it('403s a banned reporter', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-ep-banned-room');
        const commentId = await seedComment(roomId);
        const discordId = 'discord-cr-ep-banned';
        await ScoreReportService.ban(discordId, 'admin-x', null, 'test');
        const res = await request(app)
            .post(`/api/global/comments/${commentId}/report`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ reason: 'x' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('This account is banned.');
    });

    it('404s an unknown comment id', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/global/comments/999999/report')
            .set('Authorization', `Bearer ${playerToken('discord-cr-ep-404')}`)
            .send({ reason: 'x' });
        expect(res.status).toBe(404);
    });

    it('200s a valid report from a logged-in, non-banned user', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-ep-ok-room');
        const commentId = await seedComment(roomId);
        const res = await request(app)
            .post(`/api/global/comments/${commentId}/report`)
            .set('Authorization', `Bearer ${playerToken('discord-cr-ep-ok')}`)
            .send({ reason: 'inappropriate' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.id).toBe('number');
    });

    it('409s a duplicate open report over the endpoint', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-ep-dupe-room');
        const commentId = await seedComment(roomId);
        const discordId = 'discord-cr-ep-dupe';
        const first = await request(app)
            .post(`/api/global/comments/${commentId}/report`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ reason: 'x' });
        expect(first.status).toBe(200);

        const second = await request(app)
            .post(`/api/global/comments/${commentId}/report`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ reason: 'x' });
        expect(second.status).toBe(409);
    });
});

describe('Admin comment-reports endpoints', () => {
    async function createApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: adminRouter } = await import('../api/routes/admin.js');
        app.use('/api/admin', adminRouter);
        return app;
    }

    function superToken(discordId = '999888777666555443') {
        return signToken({ role: 'super_admin', gameRoomIds: [], discordId, username: 'admin' });
    }

    it('GET /admin/comment-reports lists pending reports for a super admin', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-admin-list-room');
        const commentId = await seedComment(roomId);
        await CommentReportService.create({ commentId, reporterDiscordId: 'discord-admin-list-reporter' });

        const res = await request(app)
            .get('/api/admin/comment-reports?status=pending')
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((r: any) => r.comment_id === commentId)).toBe(true);
    });

    it('POST /admin/comment-reports/:id/remove deletes the comment and resolves the report', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('cr-admin-remove-room');
        const commentId = await seedComment(roomId);
        const { id } = await CommentReportService.create({ commentId, reporterDiscordId: 'discord-admin-remove-reporter' });

        const res = await request(app)
            .post(`/api/admin/comment-reports/${id}/remove`)
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(200);

        const comment = await CommentService.getCommentById(commentId);
        expect(comment).toBeUndefined();
    });

    it('non-super-admin is rejected', async () => {
        const app = await createApp();
        const res = await request(app)
            .get('/api/admin/comment-reports')
            .set('Authorization', `Bearer ${playerToken('discord-not-admin')}`);
        expect(res.status).toBe(403);
    });
});
