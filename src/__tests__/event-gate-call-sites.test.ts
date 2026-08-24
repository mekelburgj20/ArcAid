import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { EventService } from '../services/EventService.js';

/**
 * P2 — the Live Event gate at its call sites (v2.135.0, ADR 0017).
 *
 * `event-format.test.ts` proves the gate's own logic. This file proves the
 * WIRING, and the wiring has exactly two jobs:
 *
 *   1. **Refuse outside the window, before anything is written.** A rejected
 *      submission must leave no `score_history` row, no `community_scores` row,
 *      no `submissions` row and no photo on disk.
 *   2. **Leave rotation completely alone.** Every assertion about a
 *      non-event game here is really an assertion that this feature is
 *      invisible to the 100% of submissions that aren't events.
 *
 * The third job is subtler and has bitten before: an accepted event submission
 * must land on the ROUND the gate resolved, not on whatever the old
 * name-lookup happens to find first.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const playerToken = (discordId: string, username: string, roomId: string) =>
    signToken({ role: 'player', gameRoomIds: [roomId], discordId, username });

/** `ensureProvenanceAllowed` must pass so the handler reaches the gate. */
async function seedCatalogue(gameName: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
        crypto.randomUUID(), gameName, JSON.stringify(['real']),
    );
}

const MINUTE = 60_000;

/** An event whose single round is ACTIVE right now. */
async function seedLiveEvent(roomId: string, gameName: string, opts: {
    checkinRequired?: boolean; startOffsetMs?: number; lengthMin?: number;
} = {}) {
    const db = await getDatabase();
    const tid = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
        tid, roomId,
    );
    const start = Date.now() + (opts.startOffsetMs ?? -MINUTE);
    const rounds = await EventService.createOrUpdateEvent(tid, {
        rounds: [{
            roundNo: 1, gameName,
            scheduledStartAt: new Date(start).toISOString(),
            scheduledEndAt: new Date(start + (opts.lengthMin ?? 30) * MINUTE).toISOString(),
        }],
        checkinRequired: opts.checkinRequired ?? false,
    });
    // The scheduler would do this on its next tick; drive it directly so the
    // test isn't clock-dependent.
    if ((opts.startOffsetMs ?? -MINUTE) <= 0) {
        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE id = ?`, rounds[0]!.id);
    }
    return { tournamentId: tid, gameId: rounds[0]!.id };
}

/** A rotation tournament with one ACTIVE game — the regression fixture. */
async function seedRotationGame(roomId: string, gameName: string) {
    const db = await getDatabase();
    const tid = crypto.randomUUID();
    const gid = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, 'Daily Grind', 'DG', 'pinball', '{"cron":"0 22 * * *"}', 1, ?)`,
        tid, roomId,
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gid, tid, gameName, roomId, new Date().toISOString(),
    );
    return { tournamentId: tid, gameId: gid };
}

async function countRows(roomId: string) {
    const db = await getDatabase();
    const history = await db.get<{ n: number }>('SELECT COUNT(*) n FROM score_history WHERE game_room_id = ?', roomId);
    const community = await db.get<{ n: number }>('SELECT COUNT(*) n FROM community_scores WHERE game_room_id = ?', roomId);
    const submissions = await db.get<{ n: number }>('SELECT COUNT(*) n FROM submissions');
    return { history: history!.n, community: community!.n, submissions: submissions!.n };
}

describe('Event gate — POST /community-scores/:gameName', () => {
    const post = (app: express.Express, roomId: string, gameName: string, token: string, score = 1000) =>
        request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ score, platform: 'real', engine: 'real', device: 'real_cabinet' });

    it('lets a rotation game through completely untouched', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('gate-rot', 'Gate Rotation');
        await seedCatalogue('Twilight Zone');
        await seedRotationGame(roomId, 'Twilight Zone');

        const res = await post(app, roomId, 'Twilight Zone', playerToken('u1', 'Ann', roomId));
        expect(res.status).toBe(201);

        const rows = await countRows(roomId);
        expect(rows.history).toBe(1);
        expect(rows.community).toBe(1);
    });

    it('refuses a score before the round opens and writes NOTHING', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('gate-early', 'Gate Early');
        await seedCatalogue('Medieval Madness');
        await seedLiveEvent(roomId, 'Medieval Madness', { startOffsetMs: 30 * MINUTE });

        const res = await post(app, roomId, 'Medieval Madness', playerToken('u1', 'Ann', roomId));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EVENT_NOT_STARTED');

        expect(await countRows(roomId)).toEqual({ history: 0, community: 0, submissions: 0 });
    });

    it('refuses a score after the buzzer plus grace and writes NOTHING', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('gate-late', 'Gate Late');
        await seedCatalogue('Medieval Madness');
        // Opened 90 min ago, ran 30 min → closed an hour ago.
        await seedLiveEvent(roomId, 'Medieval Madness', { startOffsetMs: -90 * MINUTE, lengthMin: 30 });

        const res = await post(app, roomId, 'Medieval Madness', playerToken('u1', 'Ann', roomId));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EVENT_ROUND_ENDED');

        expect(await countRows(roomId)).toEqual({ history: 0, community: 0, submissions: 0 });
    });

    it('refuses a player who never checked in, and accepts them once an admin adds them', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('gate-checkin', 'Gate Checkin');
        await seedCatalogue('Medieval Madness');
        const { tournamentId } = await seedLiveEvent(roomId, 'Medieval Madness', { checkinRequired: true });
        const token = playerToken('u1', 'Ann', roomId);

        const denied = await post(app, roomId, 'Medieval Madness', token);
        expect(denied.status).toBe(409);
        expect(denied.body.code).toBe('EVENT_NOT_CHECKED_IN');
        expect((await countRows(roomId)).history).toBe(0);

        await EventService.checkIn(tournamentId, 'u1', 'admin', 'admin-9');
        const accepted = await post(app, roomId, 'Medieval Madness', token);
        expect(accepted.status).toBe(201);
        expect((await countRows(roomId)).history).toBe(1);
    });

    it('stamps an accepted score with the round it belongs to', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('gate-stamp', 'Gate Stamp');
        await seedCatalogue('Medieval Madness');
        const { tournamentId, gameId } = await seedLiveEvent(roomId, 'Medieval Madness');

        const res = await post(app, roomId, 'Medieval Madness', playerToken('u1', 'Ann', roomId));
        expect(res.status).toBe(201);

        const db = await getDatabase();
        const row = await db.get<{ game_id: string; submitted_during_tournament_id: string }>(
            'SELECT game_id, submitted_during_tournament_id FROM score_history WHERE game_room_id = ?', roomId,
        );
        // Without the explicit stamp, two rounds of the same table are
        // indistinguishable and the standings collapse into one board.
        expect(row!.game_id).toBe(gameId);
        expect(row!.submitted_during_tournament_id).toBe(tournamentId);
    });
});

describe('Event gate — POST /submit-score/:gameName', () => {
    const post = (app: express.Express, roomId: string, gameName: string, token: string, score = 1000) =>
        request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', String(score))
            .field('engine', 'real')
            .field('device', 'real_cabinet');

    it('refuses outside the window and writes nothing', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ss-late', 'SS Late');
        await seedCatalogue('Medieval Madness');
        await seedLiveEvent(roomId, 'Medieval Madness', { startOffsetMs: -90 * MINUTE, lengthMin: 30 });

        const res = await post(app, roomId, 'Medieval Madness', playerToken('u1', 'Ann', roomId));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EVENT_ROUND_ENDED');
        expect(await countRows(roomId)).toEqual({ history: 0, community: 0, submissions: 0 });
    });

    it('upserts `submissions` against the resolved round, not the name lookup', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ss-round', 'SS Round');
        await seedCatalogue('Medieval Madness');
        const { gameId } = await seedLiveEvent(roomId, 'Medieval Madness');

        const res = await post(app, roomId, 'Medieval Madness', playerToken('u1', 'Ann', roomId));
        expect(res.status).toBe(201);

        const db = await getDatabase();
        const sub = await db.get<{ game_id: string }>('SELECT game_id FROM submissions');
        expect(sub!.game_id).toBe(gameId);
    });

    it('still upserts against the rotation game when no event is involved', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ss-rot', 'SS Rotation');
        await seedCatalogue('Twilight Zone');
        const { gameId } = await seedRotationGame(roomId, 'Twilight Zone');

        const res = await post(app, roomId, 'Twilight Zone', playerToken('u1', 'Ann', roomId));
        expect(res.status).toBe(201);

        const db = await getDatabase();
        const sub = await db.get<{ game_id: string }>('SELECT game_id FROM submissions');
        expect(sub!.game_id).toBe(gameId);
    });
});

describe('Event gate — same table in two rounds', () => {
    it('keeps an identical score in both rounds instead of deduping the second away', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('two-rounds', 'Two Rounds');
        await seedCatalogue('Medieval Madness');

        const db = await getDatabase();
        const tid = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Double Header', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
            tid, roomId,
        );
        const now = Date.now();
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [
                { roundNo: 1, gameName: 'Medieval Madness', scheduledStartAt: new Date(now - 60 * MINUTE).toISOString(), scheduledEndAt: new Date(now - 30 * MINUTE).toISOString() },
                { roundNo: 2, gameName: 'Medieval Madness', scheduledStartAt: new Date(now - MINUTE).toISOString(), scheduledEndAt: new Date(now + 30 * MINUTE).toISOString() },
            ],
            checkinRequired: false,
        });
        const token = playerToken('u1', 'Ann', roomId);
        const post = () => request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent('Medieval Madness')}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ score: 5000, platform: 'real', engine: 'real', device: 'real_cabinet' });

        // Round 1 is over; a submission now belongs to round 2.
        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id = ?`, rounds[0]!.id);
        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE id = ?`, rounds[1]!.id);

        // Seed round 1 with the SAME score the player is about to post to
        // round 2. Pre-fix, `ScoreHistoryService.log`'s room-wide dedup would
        // swallow the second one and the standings would show a missed round.
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source, submitted_during_tournament_id)
             VALUES ('Medieval Madness', ?, ?, 'Ann', 'u1', 5000, 'community', ?)`,
            roomId, rounds[0]!.id, tid,
        );

        expect((await post()).status).toBe(201);

        const perRound = await db.all<Array<{ game_id: string }>>(
            'SELECT game_id FROM score_history WHERE game_room_id = ? ORDER BY id', roomId,
        );
        expect(perRound.map(r => r.game_id)).toEqual([rounds[0]!.id, rounds[1]!.id]);
    });
});
