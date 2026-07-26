import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

// S22 Phase 1 content moderation (v2.43.0) — first-ever coverage of the
// PRE-EXISTING score-reports admin endpoints (admin.ts:1214-1284,
// ScoreReportService), which the new Reports page's "Scores" tab consumes
// for the first time (recon risk #7: they shipped untested). Smoke-level:
// seed a score report, exercise list → dismiss, and the ban action creating
// a user_bans row. Deliberately does NOT refactor ScoreReportService.

async function createApp() {
    await setupTestDb();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    return app;
}

let ipCounter = 1;
function freshIp(): string {
    const n = ipCounter++;
    return `10.97.${(n >> 8) & 0xff}.${n & 0xff}`;
}

function superToken(): string {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId: '999888777666555444', username: 'admin' });
}

async function seedGlobalScore(overrides: { playerId?: string; score?: number } = {}): Promise<{ scoreId: string; gameId: string; playerId: string }> {
    const db = await getDatabase();
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, status) VALUES (?, 'Score Report Test Game', 'pinball', 'approved')`,
        gameId,
    );
    const scoreId = crypto.randomUUID();
    const playerId = overrides.playerId ?? 'discord-offender-1';
    await db.run(
        `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type)
         VALUES (?, ?, ?, 'Offender', ?, 'global')`,
        scoreId, gameId, playerId, overrides.score ?? 999999,
    );
    return { scoreId, gameId, playerId };
}

async function seedScoreReport(scoreId: string, reason = 'cheating'): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason) VALUES (?, ?, ?, ?)`,
        id, scoreId, 'reporter-1', reason,
    );
    return id;
}

describe('GET /api/admin/score-reports', () => {
    it('403s a non-super-admin', async () => {
        const app = await createApp();
        const res = await request(app)
            .get('/api/admin/score-reports')
            .set('X-Forwarded-For', freshIp());
        expect([401, 403]).toContain(res.status);
    });

    it('lists pending reports with joined score/game context', async () => {
        const app = await createApp();
        const { scoreId } = await seedGlobalScore();
        await seedScoreReport(scoreId, 'suspicious score');

        const res = await request(app)
            .get('/api/admin/score-reports')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].score_id).toBe(scoreId);
        expect(res.body[0].reason).toBe('suspicious score');
        expect(res.body[0].game_name).toBe('Score Report Test Game');
    });
});

describe('POST /api/admin/score-reports/:reportId/dismiss', () => {
    it('dismisses a report without touching the score', async () => {
        const app = await createApp();
        const { scoreId } = await seedGlobalScore();
        const reportId = await seedScoreReport(scoreId);

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/dismiss`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const score = await db.get('SELECT deleted_at FROM global_scores WHERE id = ?', scoreId);
        expect(score.deleted_at).toBeNull();

        const report = await db.get('SELECT resolution FROM score_reports WHERE id = ?', reportId);
        expect(report.resolution).toBe('dismissed');

        // Already-resolved → 404 on a second dismiss
        const second = await request(app)
            .post(`/api/admin/score-reports/${reportId}/dismiss`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(second.status).toBe(404);
    });

    it('404s an unknown report id', async () => {
        const app = await createApp();
        const res = await request(app)
            .post(`/api/admin/score-reports/${crypto.randomUUID()}/dismiss`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(404);
    });
});

describe('POST /api/admin/score-reports/:reportId/soft-delete', () => {
    it('soft-deletes the score and resolves the report', async () => {
        const app = await createApp();
        const { scoreId } = await seedGlobalScore();
        const reportId = await seedScoreReport(scoreId);

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/soft-delete`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const score = await db.get('SELECT deleted_at FROM global_scores WHERE id = ?', scoreId);
        expect(score.deleted_at).not.toBeNull();

        const report = await db.get('SELECT resolution FROM score_reports WHERE id = ?', reportId);
        expect(report.resolution).toBe('deleted');
    });
});

describe('POST /api/admin/score-reports/:reportId/hard-delete', () => {
    // m8 (S22 Phase 1 adversarial review) — this endpoint had zero coverage
    // despite the CHANGELOG line claiming otherwise; added here and the
    // CHANGELOG corrected in the same fix round.
    it('permanently deletes the score row and resolves the report', async () => {
        const app = await createApp();
        const { scoreId } = await seedGlobalScore();
        const reportId = await seedScoreReport(scoreId, 'definitely fake');

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/hard-delete`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const score = await db.get('SELECT * FROM global_scores WHERE id = ?', scoreId);
        expect(score).toBeUndefined(); // row is gone, not just soft-deleted

        const report = await db.get('SELECT resolution FROM score_reports WHERE id = ?', reportId);
        expect(report.resolution).toBe('deleted');
    });

    it('404s an unknown report id', async () => {
        const app = await createApp();
        const res = await request(app)
            .post(`/api/admin/score-reports/${crypto.randomUUID()}/hard-delete`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(404);
    });
});

describe('POST /api/admin/score-reports/:reportId/ban', () => {
    it('bans the reported player, soft-deletes the score, and creates a user_bans row', async () => {
        const app = await createApp();
        const { scoreId, playerId } = await seedGlobalScore({ playerId: 'discord-repeat-offender' });
        const reportId = await seedScoreReport(scoreId, 'blatant cheating');

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/ban`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ durationDays: 30, reason: 'repeat cheating' });
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const ban = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ?', playerId);
        expect(ban).toBeTruthy();
        expect(ban.reason).toBe('repeat cheating');
        expect(ban.expires_at).not.toBeNull();

        const score = await db.get('SELECT deleted_at FROM global_scores WHERE id = ?', scoreId);
        expect(score.deleted_at).not.toBeNull();

        const report = await db.get('SELECT resolution FROM score_reports WHERE id = ?', reportId);
        expect(report.resolution).toBe('banned');
    });

    it('permanent ban (no durationDays) leaves expires_at null', async () => {
        const app = await createApp();
        const { scoreId, playerId } = await seedGlobalScore({ playerId: 'discord-permaban' });
        const reportId = await seedScoreReport(scoreId);

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/ban`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const ban = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ?', playerId);
        expect(ban.expires_at).toBeNull();
    });

    // m6 (S22 Phase 1 adversarial review) — a score synced FROM iScored
    // carries a synthetic `iscored:<username>` player_id with no login
    // identity behind it. Banning it previously wrote a user_bans row that
    // could never match any real session — a silent no-op. Must 400 instead.
    it('400s banning a score with a synthetic iscored: player_id, and writes NO user_bans row', async () => {
        const app = await createApp();
        const { scoreId } = await seedGlobalScore({ playerId: 'iscored:offender_alias' });
        const reportId = await seedScoreReport(scoreId, 'obviously synced from iScored');

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/ban`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ durationDays: 30 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/iScored/);

        const db = await getDatabase();
        const ban = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ?', 'iscored:offender_alias');
        expect(ban).toBeUndefined();

        // Report stays unresolved — the admin needs to pick a different action.
        const report = await db.get('SELECT resolved_at FROM score_reports WHERE id = ?', reportId);
        expect(report.resolved_at).toBeNull();
    });

    // m7 (S22 Phase 1 adversarial review) — ban bodies were previously
    // unvalidated: {"durationDays":"abc"} coerced to `new Date(NaN)` deep
    // inside ScoreReportService.ban, surfacing as an opaque 500 instead of a
    // clear 400 at the API boundary.
    it('400s a garbage durationDays instead of 500ing', async () => {
        const app = await createApp();
        const { scoreId } = await seedGlobalScore();
        const reportId = await seedScoreReport(scoreId);

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/ban`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ durationDays: 'abc' });
        expect(res.status).toBe(400);
    });

    it('400s a durationDays out of the sane 1..3650 range', async () => {
        const app = await createApp();
        const { scoreId } = await seedGlobalScore();
        const reportId = await seedScoreReport(scoreId);

        const res = await request(app)
            .post(`/api/admin/score-reports/${reportId}/ban`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ durationDays: 999999 });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/admin/bans (m7 validation)', () => {
    it('400s a missing discordUserId', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/admin/bans')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({});
        expect(res.status).toBe(400);
    });

    it('400s a garbage durationDays instead of 500ing', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/admin/bans')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ discordUserId: 'discord-m7-target', durationDays: 'abc' });
        expect(res.status).toBe(400);
    });

    it('accepts a valid body', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/admin/bans')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ discordUserId: 'discord-m7-target-2', durationDays: 30, reason: 'test' });
        expect(res.status).toBe(201);
    });
});

describe('GET /api/admin/bans + POST /api/admin/bans/:banId/lift', () => {
    it('lists bans and lifts one', async () => {
        const app = await createApp();
        const { scoreId, playerId } = await seedGlobalScore({ playerId: 'discord-lift-me' });
        const reportId = await seedScoreReport(scoreId);
        await request(app)
            .post(`/api/admin/score-reports/${reportId}/ban`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp())
            .send({ durationDays: 7 });

        const list = await request(app)
            .get('/api/admin/bans')
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        const banId = list.body[0].id;

        const lift = await request(app)
            .post(`/api/admin/bans/${banId}/lift`)
            .set('Authorization', `Bearer ${superToken()}`)
            .set('X-Forwarded-For', freshIp());
        expect(lift.status).toBe(200);

        const db = await getDatabase();
        const ban = await db.get('SELECT lifted_at FROM user_bans WHERE id = ?', banId);
        expect(ban.lifted_at).not.toBeNull();
        void playerId;
    });
});
