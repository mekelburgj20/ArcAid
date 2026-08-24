import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { ThrowdownService } from '../services/ThrowdownService.js';
import { EventService } from '../services/EventService.js';

/**
 * The Throwdown API (v2.136.0, ADR 0018).
 *
 * The through-line: a player with NO room and NO admin rights can create a
 * challenge, share its code, and have scores land — while the window is still
 * enforced by the same gate a hosted event uses.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

/** A plain player token: no room grants at all, which is the point. */
const playerToken = (discordId: string, username = discordId) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username });

const MINUTE = 60_000;

beforeEach(async () => { await setupTestDb(); });

describe('POST /api/throwdowns', () => {
    it('lets a player with no room create one and returns its link', async () => {
        const app = await createTestApp();
        const res = await request(app)
            .post('/api/throwdowns')
            .set('Authorization', `Bearer ${playerToken('u-1', 'Wyo')}`)
            .send({ gameName: 'Medieval Madness', durationMinutes: 60 });

        expect(res.status).toBe(201);
        expect(res.body.code).toMatch(/^[A-Z2-9]{8}$/);
        expect(res.body.url).toBe(`/throwdown/${res.body.code}`);

        const db = await getDatabase();
        const row = await db.get<{ game_room_id: string | null; format: string }>(
            'SELECT game_room_id, format FROM tournaments WHERE id = ?', res.body.tournamentId,
        );
        expect(row!.game_room_id).toBeNull();
        expect(row!.format).toBe('event');
    });

    it('requires a login', async () => {
        const app = await createTestApp();
        const res = await request(app).post('/api/throwdowns').send({ gameName: 'X', durationMinutes: 60 });
        expect(res.status).toBe(401);
    });

    it('validates the game name — required, and length-capped', async () => {
        const app = await createTestApp();
        const post = (gameName: unknown) => request(app)
            .post('/api/throwdowns')
            .set('Authorization', `Bearer ${playerToken('u-1')}`)
            .send({ gameName, durationMinutes: 60 });

        expect((await post('')).status).toBe(400);
        expect((await post('x'.repeat(201))).status).toBe(400);

        // The schema also runs the shared blocklist refinement on this field,
        // because the name lands in a shareable link's preview — the widest
        // audience any user-typed string in Arcaid reaches. That refinement's
        // behaviour (l33t-speak, diacritics, zero-width splits) is covered in
        // contentBlocklist.test.ts; it is not re-fixtured here. NOTE: the list
        // is unambiguous-slurs-only by design, so ordinary profanity passes —
        // that is the Scunthorpe trade-off, not a gap in this route.
    });

    it('rejects an out-of-range duration', async () => {
        const app = await createTestApp();
        for (const durationMinutes of [1, 60 * 24 * 30]) {
            const res = await request(app)
                .post('/api/throwdowns')
                .set('Authorization', `Bearer ${playerToken('u-1')}`)
                .send({ gameName: 'X', durationMinutes });
            expect(res.status, String(durationMinutes)).toBe(400);
        }
    });
});

describe('GET /api/throwdowns/:code', () => {
    it('is readable without logging in — the link IS the access control', async () => {
        const app = await createTestApp();
        const td = await ThrowdownService.create('u-1', { gameName: 'Medieval Madness', durationMinutes: 60 });

        const res = await request(app).get(`/api/throwdowns/${td.code}`);
        expect(res.status).toBe(200);
        expect(res.body.event.name).toBe('Medieval Madness');
        expect(res.body.event.state).toBe('live');
        expect(res.body.checkin.required).toBe(false);
        expect(res.body.rounds).toHaveLength(1);
        // Shaped like the room event read, so one component renders both.
        expect(res.body.viewer.reason).toBe('LOGIN_REQUIRED');
        expect(res.body.viewer.canSubmit).toBe(false);
    });

    it('404s an unknown code', async () => {
        const app = await createTestApp();
        expect((await request(app).get('/api/throwdowns/NOTREAL9')).status).toBe(404);
    });
});

describe('POST /api/throwdowns/:code/scores', () => {
    it('accepts a score inside the window and ranks it', async () => {
        const app = await createTestApp();
        const td = await ThrowdownService.create('u-1', { gameName: 'Medieval Madness', durationMinutes: 60 });

        const first = await request(app)
            .post(`/api/throwdowns/${td.code}/scores`)
            .set('Authorization', `Bearer ${playerToken('u-2', 'Ann')}`)
            .send({ score: 5000, engine: 'vpx', device: 'pc' });
        expect(first.status).toBe(201);
        expect(first.body.rank).toBe(1);

        const second = await request(app)
            .post(`/api/throwdowns/${td.code}/scores`)
            .set('Authorization', `Bearer ${playerToken('u-3', 'Bob')}`)
            .send({ score: 9000 });
        expect(second.body.rank).toBe(1);

        const db = await getDatabase();
        const rows = await db.all<Array<{ game_room_id: string | null; submitted_during_tournament_id: string }>>(
            'SELECT game_room_id, submitted_during_tournament_id FROM score_history',
        );
        expect(rows).toHaveLength(2);
        // The whole point of migration 164.
        expect(rows.every(r => r.game_room_id === null)).toBe(true);
        expect(rows.every(r => r.submitted_during_tournament_id === td.tournamentId)).toBe(true);
        // A Throwdown writes score_history ONLY — community_scores stays room-scoped.
        const community = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_scores');
        expect(community!.n).toBe(0);
    });

    it('refuses a score after the buzzer, writing nothing', async () => {
        const app = await createTestApp();
        const td = await ThrowdownService.create('u-1', { gameName: 'X', durationMinutes: 5 });

        // Wind the round back so it is long over.
        const db = await getDatabase();
        const rounds = await EventService.getRounds(td.tournamentId);
        await db.run(
            'UPDATE games SET scheduled_start_at = ?, scheduled_end_at = ? WHERE id = ?',
            new Date(Date.now() - 120 * MINUTE).toISOString(),
            new Date(Date.now() - 60 * MINUTE).toISOString(),
            rounds[0]!.id,
        );

        const res = await request(app)
            .post(`/api/throwdowns/${td.code}/scores`)
            .set('Authorization', `Bearer ${playerToken('u-2')}`)
            .send({ score: 5000 });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EVENT_ROUND_ENDED');

        const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM score_history');
        expect(count!.n).toBe(0);
    });

    it('requires a login and 404s an unknown code', async () => {
        const app = await createTestApp();
        const td = await ThrowdownService.create('u-1', { gameName: 'X', durationMinutes: 60 });

        expect((await request(app).post(`/api/throwdowns/${td.code}/scores`).send({ score: 1 })).status).toBe(401);
        expect((await request(app)
            .post('/api/throwdowns/NOTREAL9/scores')
            .set('Authorization', `Bearer ${playerToken('u-2')}`)
            .send({ score: 1 })).status).toBe(404);
    });

    it('shows up on the board the shared page reads', async () => {
        const app = await createTestApp();
        const td = await ThrowdownService.create('u-1', { gameName: 'Medieval Madness', durationMinutes: 60 });
        await request(app)
            .post(`/api/throwdowns/${td.code}/scores`)
            .set('Authorization', `Bearer ${playerToken('u-2', 'Ann')}`)
            .send({ score: 5000 });

        const page = await request(app).get(`/api/throwdowns/${td.code}`);
        expect(page.body.rounds[0].scores).toHaveLength(1);
        expect(page.body.rounds[0].scores[0].score).toBe(5000);
        // checkin_required = 0, so nobody is greyed out as a non-participant.
        expect(page.body.rounds[0].scores[0].participant).toBe(true);
        expect(page.body.standings.standings[0].total).toBe(5000);
    });
});

describe('GET /api/me/throwdowns', () => {
    it('lists only the caller\'s own', async () => {
        const app = await createTestApp();
        const mine = await ThrowdownService.create('u-1', { gameName: 'Mine', durationMinutes: 60 });
        await ThrowdownService.create('u-2', { gameName: 'Theirs', durationMinutes: 60 });

        const res = await request(app)
            .get('/api/me/throwdowns')
            .set('Authorization', `Bearer ${playerToken('u-1')}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].code).toBe(mine.code);
        expect(res.body[0].url).toBe(`/throwdown/${mine.code}`);
    });
});

describe('rematch through the API', () => {
    it('hands the second clicker the first rematch\'s link with a 409', async () => {
        const app = await createTestApp();
        const original = await ThrowdownService.create('u-1', { gameName: 'X', durationMinutes: 60 });
        const first = await ThrowdownService.create('u-2', {
            gameName: 'X', durationMinutes: 60, rematchOf: original.tournamentId,
        });

        const res = await request(app)
            .post('/api/throwdowns')
            .set('Authorization', `Bearer ${playerToken('u-3')}`)
            .send({ gameName: 'X', durationMinutes: 60, rematchOf: original.tournamentId });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('REMATCH_EXISTS');
        // Not just an error — the link they should be joining instead.
        expect(res.body.existingCode).toBe(first.code);
        expect(res.body.url).toBe(`/throwdown/${first.code}`);
    });
});
