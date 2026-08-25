import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { PreferencesService } from '../services/PreferencesService.js';

/**
 * Per-player Global Scoreboard opt-out (v2.137.0).
 *
 * The reason this preference is resolved SERVER-side rather than by defaulting
 * a checkbox is worth restating, because it is the whole design: **Discord
 * `/submit-score` has no checkbox**. A client-only default would apply on the
 * web and be silently ignored in Discord — the player would turn sharing off,
 * see it respected on the site, and find their Discord scores still on the
 * global board.
 *
 * So the rule under test is: an explicit per-submission choice wins; the stored
 * preference fills in only when the request said nothing.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api', globalRouter);
    app.use('/api/rooms', roomsRouter);
    return app;
}

const playerToken = (discordId: string, roomId?: string) =>
    signToken({ role: 'player', gameRoomIds: roomId ? [roomId] : [], discordId, username: discordId });

beforeEach(async () => { await setupTestDb(); });

describe('PreferencesService — share to global', () => {
    it('defaults to sharing for a player who has never chosen', async () => {
        // The stored column is NULL until somebody opts out, so no migration
        // had to guess at intent for existing users.
        expect(await PreferencesService.getShareToGlobal('u-new')).toBe(true);
    });

    it('round-trips an explicit choice', async () => {
        await PreferencesService.setShareToGlobal('u-1', false);
        expect(await PreferencesService.getShareToGlobal('u-1')).toBe(false);
        await PreferencesService.setShareToGlobal('u-1', true);
        expect(await PreferencesService.getShareToGlobal('u-1')).toBe(true);
    });

    it('does not disturb other preferences on the same row', async () => {
        await PreferencesService.setAppearance('u-1', 'light');
        await PreferencesService.setShareToGlobal('u-1', false);
        expect(await PreferencesService.getAppearance('u-1')).toBe('light');
        expect(await PreferencesService.getShareToGlobal('u-1')).toBe(false);
    });
});

describe('resolveExcludeFromGlobal — the precedence rule', () => {
    it('lets an explicit choice win in BOTH directions', async () => {
        await PreferencesService.setShareToGlobal('u-optout', false);
        // Opted out, but explicitly sharing this one.
        expect(await PreferencesService.resolveExcludeFromGlobal('u-optout', false)).toBe(false);

        await PreferencesService.setShareToGlobal('u-sharer', true);
        // Sharing by default, but holding this one back.
        expect(await PreferencesService.resolveExcludeFromGlobal('u-sharer', true)).toBe(true);
    });

    it('falls back to the preference when the request says nothing', async () => {
        await PreferencesService.setShareToGlobal('u-optout', false);
        expect(await PreferencesService.resolveExcludeFromGlobal('u-optout', undefined)).toBe(true);

        expect(await PreferencesService.resolveExcludeFromGlobal('u-default', undefined)).toBe(false);
    });

    it('shares when there is no user to have a preference', async () => {
        expect(await PreferencesService.resolveExcludeFromGlobal(undefined, undefined)).toBe(false);
    });
});

describe('GET/POST /api/me/preferences', () => {
    it('reports the default and persists a change', async () => {
        const app = await createTestApp();
        const token = playerToken('u-1');

        const before = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(before.status).toBe(200);
        expect(before.body.share_to_global).toBe(true);

        const save = await request(app)
            .post('/api/me/preferences')
            .set('Authorization', `Bearer ${token}`)
            .send({ share_to_global: false });
        expect(save.status).toBe(200);

        const after = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(after.body.share_to_global).toBe(false);
    });

    it('writes only what was sent — a sharing change must not clobber the theme', async () => {
        const app = await createTestApp();
        const token = playerToken('u-1');
        await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`)
            .send({ appearance: 'light' });
        await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`)
            .send({ share_to_global: false });

        const res = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(res.body.appearance).toBe('light');
        expect(res.body.share_to_global).toBe(false);
    });

    it('still rejects a body with nothing in it', async () => {
        const app = await createTestApp();
        const res = await request(app)
            .post('/api/me/preferences')
            .set('Authorization', `Bearer ${playerToken('u-1')}`)
            .send({});
        expect(res.status).toBe(400);
    });
});

describe('the preference reaches the room submit path', () => {
    async function seedGame(roomId: string, gameName: string) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
            crypto.randomUUID(), gameName, JSON.stringify(['real']),
        );
        const tid = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'DG', 'DG', 'pinball', '{"cron":"0 22 * * *"}', 1, ?)`, tid, roomId,
        );
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
             VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
            crypto.randomUUID(), tid, gameName, roomId, new Date().toISOString(),
        );
    }

    const post = (app: express.Express, roomId: string, token: string, body: Record<string, unknown>) =>
        request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent('Medieval Madness')}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ score: 5000, platform: 'real', engine: 'real', device: 'real_cabinet', ...body });

    it('keeps an opted-out player off the global board', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('pref-out', 'Pref Out');
        await seedGame(roomId, 'Medieval Madness');
        await PreferencesService.setShareToGlobal('u-1', false);

        // No per-submission field at all — the preference has to speak.
        expect((await post(app, roomId, playerToken('u-1', roomId), {})).status).toBe(201);

        const db = await getDatabase();
        // By design the row IS recorded, with the flag set — GlobalScoreService
        // keeps it so the player's own history stays complete while the public
        // board hides it. "Opted out" means flagged, not absent.
        const row = await db.get<{ exclude_from_global: number }>(
            'SELECT exclude_from_global FROM global_scores',
        );
        expect(row!.exclude_from_global).toBe(1);
        // The score itself still landed in the room.
        const local = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM score_history WHERE game_room_id = ?', roomId);
        expect(local!.n).toBe(1);
    });

    it('lets that same player share one score explicitly', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('pref-override', 'Pref Override');
        await seedGame(roomId, 'Medieval Madness');
        await PreferencesService.setShareToGlobal('u-1', false);

        expect((await post(app, roomId, playerToken('u-1', roomId), { excludeGlobal: false })).status).toBe(201);

        const db = await getDatabase();
        const row = await db.get<{ exclude_from_global: number }>(
            'SELECT exclude_from_global FROM global_scores',
        );
        // Opted out overall, but this one was deliberately shared.
        expect(row!.exclude_from_global).toBe(0);
    });

    it('leaves the default player sharing, exactly as before', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('pref-default', 'Pref Default');
        await seedGame(roomId, 'Medieval Madness');

        expect((await post(app, roomId, playerToken('u-1', roomId), {})).status).toBe(201);

        const db = await getDatabase();
        const row = await db.get<{ exclude_from_global: number }>(
            'SELECT exclude_from_global FROM global_scores',
        );
        expect(row!.exclude_from_global).toBe(0);
    });
});
