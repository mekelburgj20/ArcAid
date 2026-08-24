import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { EventService } from '../services/EventService.js';

/**
 * P2 — the Live Event API (v2.135.0, ADR 0017).
 *
 * Three things under test, in priority order:
 *
 *   1. **A rotation tournament still saves exactly as it always did.** The Zod
 *      schema grew a `format` discriminator and made `cadence.cron` optional;
 *      if that loosened rotation validation, a cron-less rotation tournament
 *      would save and then silently never run.
 *   2. **The two formats cannot be mixed up.** An event with a cron, or a
 *      rotation with rounds, is rejected rather than half-honoured.
 *   3. **Check-in closes when round 1 starts, and only an admin can reopen it**
 *      for one person.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'admin', discordId: 'admin-1' });
const playerToken = (discordId: string, roomId: string) =>
    signToken({ role: 'player', gameRoomIds: [roomId], discordId, username: discordId });

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function eventBody(overrides: Record<string, unknown> = {}, eventOverrides: Record<string, unknown> = {}) {
    const start = Date.now() + 60 * MINUTE;
    return {
        id: crypto.randomUUID(),
        name: 'Stream Night',
        type: 'DG',
        format: 'event',
        cadence: { timezone: 'UTC', autoRotate: true, autoLock: true },
        event: {
            rounds: [{ roundNo: 1, gameName: 'Medieval Madness', scheduledStartAt: iso(start), scheduledEndAt: iso(start + 25 * MINUTE) }],
            checkinOpensAt: iso(start - 30 * MINUTE),
            checkinRequired: true,
            aggregateMethod: 'best',
            endGraceSec: 120,
            ...eventOverrides,
        },
        ...overrides,
    };
}

function rotationBody(overrides: Record<string, unknown> = {}) {
    return {
        id: crypto.randomUUID(),
        name: 'Daily Grind',
        type: 'DG',
        cadence: { cron: '0 22 * * *', autoRotate: true, autoLock: true, timezone: 'UTC' },
        ...overrides,
    };
}

describe('POST /:roomId/tournaments — format discrimination', () => {
    it('still creates a rotation tournament exactly as before', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('fmt-rot', 'Fmt Rotation');
        const body = rotationBody();

        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send(body);
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const row = await db.get<{ format: string; cadence: string }>(
            'SELECT format, cadence FROM tournaments WHERE id = ?', body.id,
        );
        expect(row!.format).toBe('rotation');
        expect(JSON.parse(row!.cadence).cron).toBe('0 22 * * *');
    });

    it('rejects a rotation tournament with no cron instead of saving one that never runs', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('fmt-nocron', 'Fmt NoCron');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send(rotationBody({ cadence: { autoRotate: true, autoLock: true, timezone: 'UTC' } }));
        expect(res.status).toBe(400);
    });

    it('creates an event with its rounds and flips format', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('fmt-evt', 'Fmt Event');
        const body = eventBody();

        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send(body);
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const row = await db.get<{ format: string; checkin_required: number; end_grace_sec: number; cadence: string }>(
            'SELECT format, checkin_required, end_grace_sec, cadence FROM tournaments WHERE id = ?', body.id,
        );
        expect(row!.format).toBe('event');
        expect(row!.checkin_required).toBe(1);
        expect(row!.end_grace_sec).toBe(120);
        // No cron: this is what keeps runMaintenance away from the rounds.
        expect(JSON.parse(row!.cadence).cron).toBeUndefined();

        const rounds = await EventService.getRounds(body.id);
        expect(rounds).toHaveLength(1);
        expect(rounds[0]!.status).toBe('SCHEDULED');
    });

    it('refuses an event that carries a cron, and a rotation that carries rounds', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('fmt-mix', 'Fmt Mixed');
        const token = adminToken(roomId);

        const withCron = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${token}`)
            .send(eventBody({ cadence: { cron: '0 22 * * *', autoRotate: true, autoLock: true, timezone: 'UTC' } }));
        expect(withCron.status).toBe(400);

        const withRounds = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${token}`)
            .send(rotationBody({ event: eventBody().event }));
        expect(withRounds.status).toBe(400);
    });

    it('leaves no half-made tournament behind when the round config is rejected', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('fmt-rollback', 'Fmt Rollback');
        const start = Date.now() + 60 * MINUTE;
        const body = eventBody({}, {
            // Round 2 starts before round 1 ends.
            rounds: [
                { roundNo: 1, gameName: 'A', scheduledStartAt: iso(start), scheduledEndAt: iso(start + 30 * MINUTE) },
                { roundNo: 2, gameName: 'B', scheduledStartAt: iso(start + 10 * MINUTE), scheduledEndAt: iso(start + 40 * MINUTE) },
            ],
        });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ROUNDS_OVERLAP');

        const db = await getDatabase();
        const row = await db.get('SELECT id FROM tournaments WHERE id = ?', body.id);
        expect(row).toBeUndefined();
    });

    it('embeds rounds on event rows in the tournaments list, and nothing on rotation rows', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('fmt-list', 'Fmt List');
        const token = adminToken(roomId);
        await request(app).post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${token}`).send(rotationBody());
        await request(app).post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${token}`).send(eventBody());

        const res = await request(app).get(`/api/rooms/${roomId}/tournaments`);
        expect(res.status).toBe(200);
        const rotation = res.body.find((t: any) => t.format === 'rotation');
        const event = res.body.find((t: any) => t.format === 'event');
        expect(rotation.rounds).toBeUndefined();
        expect(event.rounds).toHaveLength(1);
    });
});

describe('Event check-in API', () => {
    async function seedEvent(app: express.Express, roomId: string, startOffsetMs: number) {
        const start = Date.now() + startOffsetMs;
        const body = eventBody({}, {
            rounds: [{ roundNo: 1, gameName: 'Medieval Madness', scheduledStartAt: iso(start), scheduledEndAt: iso(start + 25 * MINUTE) }],
            // Opens well in the past so these tests exercise the OPEN window;
            // the not-yet-open path is the gate's own concern.
            checkinOpensAt: iso(start - 90 * MINUTE),
        });
        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send(body);
        expect(res.status).toBe(200);
        return body.id;
    }

    it('accepts a check-in before round 1 and is idempotent', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ci-open', 'CI Open');
        const eventId = await seedEvent(app, roomId, 60 * MINUTE);
        const token = playerToken('u1', roomId);

        const first = await request(app).post(`/api/rooms/${roomId}/events/${eventId}/checkin`).set('Authorization', `Bearer ${token}`).send({});
        expect(first.status).toBe(201);
        const second = await request(app).post(`/api/rooms/${roomId}/events/${eventId}/checkin`).set('Authorization', `Bearer ${token}`).send({});
        expect(second.status).toBe(201);
        expect(await EventService.participantCount(eventId)).toBe(1);
    });

    it('refuses a check-in once round 1 has started, and an admin can still add that player', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ci-closed', 'CI Closed');
        // Round 1 started 5 minutes ago.
        const eventId = await seedEvent(app, roomId, -5 * MINUTE);

        const late = await request(app)
            .post(`/api/rooms/${roomId}/events/${eventId}/checkin`)
            .set('Authorization', `Bearer ${playerToken('u1', roomId)}`).send({});
        expect(late.status).toBe(409);
        expect(late.body.code).toBe('CHECKIN_CLOSED');
        expect(await EventService.participantCount(eventId)).toBe(0);

        const added = await request(app)
            .post(`/api/rooms/${roomId}/events/${eventId}/participants`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ userId: 'u1' });
        expect(added.status).toBe(201);
        expect(added.body.participant.source).toBe('admin');
    });

    it('refuses a withdrawal once the event is under way', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ci-withdraw', 'CI Withdraw');
        const eventId = await seedEvent(app, roomId, -5 * MINUTE);
        await EventService.checkIn(eventId, 'u1');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/events/${eventId}/checkin`)
            .set('Authorization', `Bearer ${playerToken('u1', roomId)}`);
        expect(res.status).toBe(409);
        expect(await EventService.participantCount(eventId)).toBe(1);
    });

    it('404s an event belonging to another room rather than leaking that it exists', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('ci-a', 'CI A');
        const roomB = await createTestRoom('ci-b', 'CI B');
        const eventId = await seedEvent(app, roomA, 60 * MINUTE);

        const res = await request(app).get(`/api/rooms/${roomB}/events/${eventId}`);
        expect(res.status).toBe(404);
    });

    it('reports state, check-in and viewer capability on the public read', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ci-state', 'CI State');
        const eventId = await seedEvent(app, roomId, 60 * MINUTE);

        const anon = await request(app).get(`/api/rooms/${roomId}/events/${eventId}`);
        expect(anon.status).toBe(200);
        expect(anon.body.event.state).toBe('checkin');
        expect(anon.body.checkin.required).toBe(true);
        expect(anon.body.viewer.canCheckIn).toBe(false);
        expect(anon.body.viewer.reason).toBe('LOGIN_REQUIRED');
        expect(anon.body.rounds).toHaveLength(1);

        const viewer = await request(app)
            .get(`/api/rooms/${roomId}/events/${eventId}`)
            .set('Authorization', `Bearer ${playerToken('u1', roomId)}`);
        expect(viewer.body.viewer.canCheckIn).toBe(true);

        await EventService.checkIn(eventId, 'u1');
        const after = await request(app)
            .get(`/api/rooms/${roomId}/events/${eventId}`)
            .set('Authorization', `Bearer ${playerToken('u1', roomId)}`);
        expect(after.body.checkin.viewerCheckedIn).toBe(true);
        expect(after.body.viewer.canCheckIn).toBe(false);
        expect(after.body.viewer.reason).toBe('ALREADY_CHECKED_IN');
    });
});

describe('Admin start-now / end-now', () => {
    it('opens a round immediately, keeping its length, and closes it through the same engine path', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('sn-room', 'StartNow');
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        const body = eventBody({}, { checkinRequired: false });
        await request(app).post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${adminToken(roomId)}`).send(body);

        const started = await request(app)
            .post(`/api/rooms/${roomId}/events/${body.id}/rounds/1/start-now`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(started.status).toBe(200);
        expect(started.body.rounds[0].status).toBe('ACTIVE');

        const round = started.body.rounds[0];
        const lengthMin = Math.round(
            (Date.parse(round.scheduled_end_at) - Date.parse(round.scheduled_start_at)) / MINUTE,
        );
        expect(lengthMin).toBe(25);

        const ended = await request(app)
            .post(`/api/rooms/${roomId}/events/${body.id}/rounds/1/end-now`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(ended.status).toBe(200);
        expect(ended.body.rounds[0].status).toBe('COMPLETED');

        // The single-round event is now over, so the same tick froze it.
        const t = await db.get<{ event_finished_at: string | null; is_active: number }>(
            'SELECT event_finished_at, is_active FROM tournaments WHERE id = ?', body.id,
        );
        expect(t!.event_finished_at).not.toBeNull();
        expect(t!.is_active).toBe(0);
    });

    it('refuses start-now on a round that is already running', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('sn-twice', 'StartNow Twice');
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        const body = eventBody({}, { checkinRequired: false });
        await request(app).post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${adminToken(roomId)}`).send(body);
        const url = `/api/rooms/${roomId}/events/${body.id}/rounds/1/start-now`;
        await request(app).post(url).set('Authorization', `Bearer ${adminToken(roomId)}`).send({});

        const again = await request(app).post(url).set('Authorization', `Bearer ${adminToken(roomId)}`).send({});
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('ROUND_NOT_SCHEDULED');
    });
});

describe('DELETE tournament', () => {
    it('blocks deleting an event that still has SCHEDULED rounds', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('del-sched', 'Del Scheduled');
        const body = eventBody();
        await request(app).post(`/api/rooms/${roomId}/tournaments`).set('Authorization', `Bearer ${adminToken(roomId)}`).send(body);

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/tournaments/${body.id}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(res.status).toBe(409);
        expect(res.body.games[0].status).toBe('SCHEDULED');
    });
});
