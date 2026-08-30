import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * P8 round 5 — "Re-run verification" (v2.148.0, ADR 0021).
 *
 * Evidence keeps arriving after an event ends: a cabinet that was offline all
 * night uploads in the morning, a player links their AtGames account the next
 * day, a retro sweep reconstructs sessions the beacon missed. Before this route
 * every one of those landed after `event_result` was frozen and changed
 * nothing. What these tests pin, worst-bug-first:
 *
 *   1. **It must not re-announce.** A second podium post to Discord hours after
 *      the event reads as a second event. This is the expensive bug, because it
 *      is visible to every player in the server and cannot be taken back.
 *   2. **It must not un-finish the event.** `event_finished_at` and
 *      `is_active = 0` are load-bearing (the alias-link freeze gate reads the
 *      latter); a recompute that clears either would let a completed event's
 *      scores start moving again.
 *   3. **It must actually recompute** — from today's score_history,
 *      observations and check-ins, not from the frozen blob.
 */

const sentEmbeds: unknown[] = [];

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        // Forced open: without a bot token every announcement is a silent no-op,
        // which would make "nothing was announced" vacuously true.
        resolveAnnouncementChannelId: async () => 'test-channel',
        sendChannelEmbed: async (_channelId: string, embed: unknown) => { sentEmbeds.push(embed); },
    };
});

const { setupTestDb, createTestRoom } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { signToken } = await import('../api/auth.js');
const { EventService } = await import('../services/EventService.js');
const { EventResultService } = await import('../services/EventResultService.js');

const MINUTE = 60_000;
const BASE = Date.parse('2026-09-01T20:00:00.000Z');
const USER = '123456789012345678';
const DEVICE = 'fp-device-0001';

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'admin', discordId: 'admin-1' });

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

/** SQLite's own UTC shape — what `AtGamesEventSyncService` stores in `created_at`. */
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function makeEventTournament(roomId: string, format = 'event') {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, ?)`,
        id, roomId, format,
    );
    return id;
}

async function atgamesScore(opts: {
    roomId: string; tournamentId: string; gameId: string; gameName: string;
    username: string; userId: string; score: number; at: number;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            platform, engine, device, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'atgames', ?, ?, ?, 'atgames', 'atgames_native', 'atgames', ?)`,
        opts.gameName, opts.roomId, opts.gameId, opts.username, opts.userId, opts.score,
        opts.roomId, opts.tournamentId, opts.userId, sqliteTs(opts.at),
    );
}

async function observe(opts: {
    userId: string; launchMs: number; exitMs: number; via?: 'live' | 'retro';
}) {
    const db = await getDatabase();
    const launch = Math.floor(opts.launchMs / 1000);
    const exit = Math.floor(opts.exitMs / 1000);
    await db.run(
        `INSERT INTO witness_observations
            (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via)
         VALUES (?, ?, 'aerobatics', ?, ?, ?, ?)`,
        DEVICE, opts.userId, launch, exit, exit - launch, opts.via ?? 'live',
    );
}

async function checkin(userId: string, atMs: number) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_checkins (atgames_unique_id, canonical_user_id, server_ts) VALUES (?, ?, ?)`,
        DEVICE, userId, sqliteTs(atMs),
    );
}

/** A finished event with one round and one AtGames score, frozen exactly as the scheduler freezes it. */
async function makeFinishedEvent(roomId: string) {
    const tid = await makeEventTournament(roomId);
    const rounds = await EventService.createOrUpdateEvent(tid, {
        rounds: [{
            roundNo: 1,
            gameName: 'Medieval Madness',
            scheduledStartAt: new Date(BASE).toISOString(),
            scheduledEndAt: new Date(BASE + 20 * MINUTE).toISOString(),
        }],
        checkinRequired: false,
    });
    await atgamesScore({
        roomId, tournamentId: tid, gameId: rounds[0]!.id, gameName: 'Medieval Madness',
        username: 'Ann', userId: USER, score: 900, at: BASE + 10 * MINUTE,
    });

    const finishedAt = new Date(BASE + 30 * MINUTE).toISOString();
    const frozen = (await EventResultService.compute(tid, finishedAt))!;
    const db = await getDatabase();
    await db.run(
        `UPDATE tournaments SET event_result = ?, event_finished_at = ?, is_active = 0 WHERE id = ?`,
        JSON.stringify(frozen), finishedAt, tid,
    );
    return { tid, roundId: rounds[0]!.id, finishedAt, frozen };
}

const storedResult = async (tid: string) => {
    const db = await getDatabase();
    const row = await db.get<{ event_result: string | null; event_finished_at: string | null; is_active: number }>(
        'SELECT event_result, event_finished_at, is_active FROM tournaments WHERE id = ?', tid,
    );
    return {
        result: row?.event_result ? JSON.parse(row.event_result) : null,
        finishedAt: row?.event_finished_at ?? null,
        isActive: row?.is_active,
    };
};

describe('POST /:roomId/admin/tournaments/:tournamentId/reverify', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        sentEmbeds.length = 0;
        app = await createTestApp();
        roomId = await createTestRoom('reverify', 'Reverify Room');
    });

    it('requires an admin token', async () => {
        const { tid } = await makeFinishedEvent(roomId);
        const res = await request(app).post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`).send({});
        expect(res.status).toBe(401);
    });

    it('404s a tournament that is not a Live Event', async () => {
        const tid = await makeEventTournament(roomId, 'rotation');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(res.status).toBe(404);
    });

    it('404s a tournament that is not in this room', async () => {
        const other = await createTestRoom('reverify-other', 'Other Room');
        const { tid } = await makeFinishedEvent(other);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(res.status).toBe(404);
    });

    it('409s an event that has not finished — its standings are still live', async () => {
        const tid = await makeEventTournament(roomId);
        await EventService.createOrUpdateEvent(tid, {
            rounds: [{
                roundNo: 1,
                gameName: 'Medieval Madness',
                scheduledStartAt: new Date(BASE).toISOString(),
                scheduledEndAt: new Date(BASE + 20 * MINUTE).toISOString(),
            }],
            checkinRequired: false,
        });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NOT_FINISHED');
    });

    it('re-freezes from evidence that arrived AFTER the event finished', async () => {
        const { tid, frozen } = await makeFinishedEvent(roomId);
        // Nothing was witnessed at the buzzer.
        expect(frozen.standings[0]!.witnessFlagged).toBe(false);

        // A retro sweep the next morning reconstructs the session — and it shows
        // the table was launched a quarter of an hour before the round opened.
        await observe({ userId: USER, launchMs: BASE - 15 * MINUTE, exitMs: BASE + 10 * MINUTE, via: 'retro' });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, standings: 1, witnessFlagged: 1 });

        const after = await storedResult(tid);
        expect(after.result.standings[0].witnessFlagged).toBe(true);
    });

    it('flips a score to verified/checkin when the check-in lands after the freeze', async () => {
        const { tid } = await makeFinishedEvent(roomId);

        const event = (await EventService.getEvent(tid))!;
        const before = (await EventResultService.getBoards(tid))!;
        expect(before[0]!.scores[0]!.witness?.status).toBe('unwitnessed');

        // The cabinet was offline all night and uploads its check-in trail now.
        await checkin(USER, BASE + 1 * MINUTE);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(res.status).toBe(200);

        const after = (await EventResultService.getBoards(tid))!;
        expect(after[0]!.scores[0]!.witness).toMatchObject({ status: 'verified', method: 'checkin' });
        // A badge, never a gate: the score is still there, still rank 1.
        expect(after[0]!.scores[0]!.rank).toBe(1);
        expect(event.event_finished_at).toBeTruthy();
    });

    it('preserves event_finished_at and is_active, and announces NOTHING', async () => {
        const { tid, finishedAt } = await makeFinishedEvent(roomId);
        await observe({ userId: USER, launchMs: BASE - 15 * MINUTE, exitMs: BASE + 10 * MINUTE });

        await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});

        const after = await storedResult(tid);
        // The event finished when it finished — a recompute is bookkeeping.
        expect(after.finishedAt).toBe(finishedAt);
        expect(after.result.finishedAt).toBe(finishedAt);
        // The alias-link freeze gate reads this; un-setting it would let the
        // event's scores start being re-attributed again.
        expect(after.isActive).toBe(0);
        // THE expensive bug: a second podium post hours later.
        expect(sentEmbeds).toHaveLength(0);
    });

    it('keeps the frozen blob identity-stable — no names, no avatars', async () => {
        const { tid } = await makeFinishedEvent(roomId);
        await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});

        const after = await storedResult(tid);
        const row = after.result.standings[0] as Record<string, unknown>;
        expect(row).not.toHaveProperty('display_name');
        expect(row).not.toHaveProperty('avatar_hash');
        expect(row).not.toHaveProperty('avatar_url');
    });

    it('writes one audit row naming the tournament', async () => {
        const { tid } = await makeFinishedEvent(roomId);
        await request(app)
            .post(`/api/rooms/${roomId}/admin/tournaments/${tid}/reverify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});

        const db = await getDatabase();
        const row = await db.get<{ action: string; target_id: string }>(
            `SELECT action, target_id FROM audit_log WHERE action = 'tournament.event_reverify'`,
        );
        expect(row?.target_id).toBe(tid);
    });
});
