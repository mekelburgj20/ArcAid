import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Season API (docs/season-format-plan.md §7) — route wiring and shapes.
 * Discord REST is mocked; nothing leaves the process.
 */

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('discord.js')>();
    class REST {
        constructor(_opts?: unknown) {}
        setToken() { return this; }
        post = post;
        get = vi.fn(async () => ({ users: [] }));
        patch = vi.fn(async () => ({}));
    }
    return { ...actual, REST };
});

process.env.DISCORD_BOT_TOKEN = 'test-token';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const crypto = await import('crypto');
const { setupTestDb, createTestRoom } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { signToken } = await import('../api/auth.js');
const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
const { addCatalogueGame, openPollDirect } = await import('./seasonHelpers.js');

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'admin', discordId: '300000000000000009' });
const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

async function createApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

beforeEach(async () => {
    await setupTestDb();
    post.mockReset().mockResolvedValue({});
});

async function seasonViaApi(app: any) {
    const roomId = await createTestRoom(`api-${crypto.randomUUID().slice(0, 6)}`, 'Season API Room');
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const id = crypto.randomUUID();
    const res = await request(app)
        .post(`/api/rooms/${roomId}/tournaments`)
        .set('Authorization', `Bearer ${adminToken(roomId)}`)
        .send({
            id, name: 'Mox Season', type: 'WG',
            cadence: { cron: '0 0 * * 5', timezone: 'America/New_York' },
            season_table_count: 12, season_points_top: 50,
            winner_picks: true, auto_pick: true, max_active_games: 2,
        });
    expect(res.status).toBe(200);
    return { roomId, tournamentId: id };
}

describe('season routes', () => {
    it('creates a season, lists it with a `season` sub-object, and normalises the pick flags', async () => {
        const app = await createApp();
        const { roomId, tournamentId } = await seasonViaApi(app);
        const list = await request(app).get(`/api/rooms/${roomId}/tournaments`);
        const row = list.body.find((t: any) => t.id === tournamentId);
        expect(row).toMatchObject({ winner_picks: 0, auto_pick: 0, max_active_games: 1, season_table_count: 12 });
        expect(row.season).toEqual({ tables_done: 0, table_count: 12, paused: false, finished: false, open_poll_id: null });
    });

    it('rejects a season with an inverted poll window', async () => {
        const app = await createApp();
        const roomId = await createTestRoom(`bad-${crypto.randomUUID().slice(0, 6)}`, 'Bad');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({
                id: crypto.randomUUID(), name: 'Bad', type: 'WG', cadence: { cron: '0 0 * * 5' },
                season_table_count: 12, season_poll_opens_before_h: 2, season_poll_closes_before_h: 3,
            });
        expect(res.status).toBe(400);
    });

    it('poll CRUD, vote, pause/resume and the public summary', async () => {
        const app = await createApp();
        const { roomId, tournamentId } = await seasonViaApi(app);
        await addCatalogueGame('Attack from Mars');
        await addCatalogueGame('Medieval Madness');
        const auth = { Authorization: `Bearer ${adminToken(roomId)}` };
        const base = `/api/rooms/${roomId}/tournaments/${tournamentId}/season`;

        const cands = await request(app).get(`${base}/candidates?q=mars`).set(auth);
        expect(cands.status).toBe(200);
        expect(cands.body.candidates).toEqual([
            expect.objectContaining({ name: 'Attack from Mars', played_before: false }),
        ]);

        const created = await request(app).post(`${base}/polls`).set(auth)
            .send({ candidates: [{ game_name: 'Attack from Mars' }, { game_name: 'Medieval Madness' }] });
        expect(created.status).toBe(201);
        const pollId = created.body.poll.id;
        expect(created.body.poll).toMatchObject({ slot_no: 1, status: 'draft' });

        const edited = await request(app).put(`${base}/polls/${pollId}`).set(auth).send({ question: 'Week 1 — pick it' });
        expect(edited.status).toBe(200);
        expect(edited.body.poll.question).toBe('Week 1 — pick it');

        const listed = await request(app).get(`${base}/polls`).set(auth);
        expect(listed.status).toBe(200);
        expect(listed.body).toMatchObject({ table_count: 12, tables_done: 0, resolved_count: 0, bound_reached: false });
        expect(listed.body.polls[0].candidates.map((c: any) => c.game_name)).toEqual(['Attack from Mars', 'Medieval Madness']);

        // Voting needs an open poll.
        const voter = '400000000000000001';
        let vote = await request(app).post(`/api/rooms/${roomId}/season-polls/${pollId}/vote`)
            .set('Authorization', `Bearer ${playerToken(voter)}`).send({ position: 2 });
        expect(vote.status).toBe(409);

        await openPollDirect(pollId, { closesAt: new Date(Date.now() + 48 * 3_600_000).toISOString(), messageId: null });
        vote = await request(app).post(`/api/rooms/${roomId}/season-polls/${pollId}/vote`)
            .set('Authorization', `Bearer ${playerToken(voter)}`).send({ position: 2 });
        expect(vote.status).toBe(200);
        expect(vote.body).toEqual({ success: true, my_vote: 2 });

        const summary = await request(app).get(base).set('Authorization', `Bearer ${playerToken(voter)}`);
        expect(summary.status).toBe(200);
        expect(summary.body.open_poll).toMatchObject({ id: pollId, total_votes: 1, my_vote: 2 });
        expect(summary.body.open_poll.candidates[1]).toMatchObject({ position: 2, game_name: 'Medieval Madness', votes: 1 });
        expect(summary.body.progress).toEqual({ tables_done: 0, table_count: 12 });

        const anon = await request(app).get(base);
        expect(anon.body.open_poll.my_vote).toBeNull();

        const withdraw = await request(app).delete(`/api/rooms/${roomId}/season-polls/${pollId}/vote`)
            .set('Authorization', `Bearer ${playerToken(voter)}`);
        expect(withdraw.body).toEqual({ success: true, my_vote: null });

        const paused = await request(app).post(`${base}/pause`).set(auth);
        expect(paused.body).toMatchObject({ success: true, paused: true });
        const resumed = await request(app).post(`${base}/resume`).set(auth);
        expect(resumed.body).toMatchObject({ success: true, paused: false });

        expect((await request(app).post(`${base}/bogus`).set(auth)).status).toBe(404);
        expect((await request(app).post(`${base}/polls/${pollId}/bogus`).set(auth)).status).toBe(404);

        const cancelled = await request(app).post(`${base}/polls/${pollId}/cancel`).set(auth);
        expect(cancelled.body.poll.status).toBe('cancelled');
        const reposted = await request(app).post(`${base}/polls/${pollId}/repost`).set(auth);
        expect(reposted.body.poll).toMatchObject({ status: 'draft', slot_no: 1 });

        const db = await getDatabase();
        const audits = await db.all(`SELECT action FROM audit_log WHERE target_id = ? ORDER BY id`, tournamentId);
        expect(audits.map((a: any) => a.action)).toEqual(expect.arrayContaining([
            'season.poll_create', 'season.poll_update', 'season.pause', 'season.resume', 'season.poll_cancel', 'season.poll_repost',
        ]));
    });

    it('admin routes refuse a non-season tournament and other rooms', async () => {
        const app = await createApp();
        const { tournamentId } = await seasonViaApi(app);
        const otherRoom = await createTestRoom(`other-${crypto.randomUUID().slice(0, 6)}`, 'Other');
        const res = await request(app)
            .get(`/api/rooms/${otherRoom}/tournaments/${tournamentId}/season/polls`)
            .set('Authorization', `Bearer ${adminToken(otherRoom)}`);
        expect(res.status).toBe(404);
    });
});
