import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { EventService } from '../services/EventService.js';
import { EventLobbyService } from '../services/EventLobbyService.js';

/**
 * The check-in LOBBY (v2.159.0).
 *
 * Owner rulings 2026-10-01: public roster; opening the Arcaid Witness tile on
 * a cabinet designated to the event IS the event check-in; STRICT open-table
 * rule (green only when no table is open). What these pin, worst-bug-first:
 *
 *   1. A false GREEN is the expensive bug: a table launched after the check-in
 *      must read amber, and a cabinet that never checked in must never read
 *      green on somebody else's check-in.
 *   2. A stale open-session row (a missed exit from before the check-in) must
 *      NOT keep a player amber — the check-in itself proves the table closed.
 *   3. The tile check-in writes the event participant row only inside the
 *      window, only for an EVENT target, and never twice.
 */

const MINUTE = 60_000;
const USER_A = '111111111111111111';
const USER_B = '222222222222222222';
const USER_C = '333333333333333333';
const USER_D = '444444444444444444';
const USER_E = '555555555555555555';

async function createEvent(roomId: string, opts: { checkinOpensAt: Date; round1Start: Date; name?: string }) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_opens_at, checkin_required)
         VALUES (?, ?, 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', ?, 1)`,
        id, opts.name ?? 'Stream Night', roomId, opts.checkinOpensAt.toISOString(),
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
         VALUES (?, ?, 'Medieval Madness', 'SCHEDULED', ?, 1, ?, ?)`,
        crypto.randomUUID(), id, roomId,
        opts.round1Start.toISOString(), new Date(opts.round1Start.getTime() + 30 * MINUTE).toISOString(),
    );
    return id;
}

/**
 * W26 (v2.174.0): the lobby grades a device only when its scores would land on
 * the event, so a grading fixture points the device at the event's room
 * (`targetRoomId`). v2.175.0 (W37): no room = All my rooms (the default);
 * `globalOnly` is the explicit opt-out.
 */
async function pairDevice(userId: string, deviceId: string, targetRoomId: string | null = null, globalOnly = false) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, last_seen_at, target_room_id, global_only)
         VALUES (?, ?, 'hash', datetime('now'), ?, ?)`,
        deviceId, userId, targetRoomId, globalOnly ? 1 : 0,
    );
}

async function witnessCheckin(userId: string, deviceId: string, at: Date) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_checkins (atgames_unique_id, canonical_user_id, server_ts) VALUES (?, ?, ?)`,
        deviceId, userId, at.toISOString().replace('T', ' ').slice(0, 19),
    );
}

async function openSession(userId: string, deviceId: string, table: string, launchedAt: Date) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_observations (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, kind)
         VALUES (?, ?, ?, ?, NULL, 'session')`,
        deviceId, userId, table, Math.floor(launchedAt.getTime() / 1000),
    );
}

describe('EventLobbyService.roster — the strict green light', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('grades every checked-in player: ready, table open, no check-in, no cabinet, stale session', async () => {
        const roomId = await createTestRoom('lobby-room', 'Lobby Room');
        const now = new Date();
        const opened = new Date(now.getTime() - 30 * MINUTE);
        const eventId = await createEvent(roomId, { checkinOpensAt: opened, round1Start: new Date(now.getTime() + 15 * MINUTE) });
        for (const u of [USER_A, USER_B, USER_C, USER_D, USER_E]) await EventService.checkIn(eventId, u);

        // A: paired, checked in 10 min ago, nothing open -> ready.
        await pairDevice(USER_A, 'cab-a', roomId);
        await witnessCheckin(USER_A, 'cab-a', new Date(now.getTime() - 10 * MINUTE));
        // B: checked in, then launched a table 5 min ago and is still in it -> table_open.
        await pairDevice(USER_B, 'cab-b', roomId);
        await witnessCheckin(USER_B, 'cab-b', new Date(now.getTime() - 10 * MINUTE));
        await openSession(USER_B, 'cab-b', 'Attack from Mars (Williams 1995)', new Date(now.getTime() - 5 * MINUTE));
        // C: paired, last check-in was BEFORE the window opened -> no_checkin.
        await pairDevice(USER_C, 'cab-c', roomId);
        await witnessCheckin(USER_C, 'cab-c', new Date(now.getTime() - 60 * MINUTE));
        // D: no cabinet at all.
        // E: a missed exit from BEFORE the check-in must not keep them amber.
        await pairDevice(USER_E, 'cab-e', roomId);
        await openSession(USER_E, 'cab-e', 'Whirlwind (Williams 1990)', new Date(now.getTime() - 20 * MINUTE));
        await witnessCheckin(USER_E, 'cab-e', new Date(now.getTime() - 8 * MINUTE));

        const event = (await EventService.getEvent(eventId))!;
        const rounds = await EventService.getRounds(eventId);
        const roster = await EventLobbyService.roster(event, rounds, now);
        const byUser = Object.fromEntries(roster.map(e => [e.userId, e]));

        expect(roster.map(e => e.userId)).toEqual([USER_A, USER_B, USER_C, USER_D, USER_E]);
        expect(byUser[USER_A]).toMatchObject({ status: 'ready', openTable: null });
        expect(byUser[USER_A]!.witnessCheckinAt).toBeTruthy();
        expect(byUser[USER_B]).toMatchObject({ status: 'table_open', openTable: 'Attack from Mars (Williams 1995)' });
        expect(byUser[USER_C]).toMatchObject({ status: 'no_checkin', witnessCheckinAt: null });
        expect(byUser[USER_D]).toMatchObject({ status: 'no_cabinet', lastSeenAt: null });
        expect(byUser[USER_E]).toMatchObject({ status: 'ready', openTable: null });
    });

    it('takes the best cabinet when a player has two', async () => {
        const roomId = await createTestRoom('lobby-two', 'Two Cabs');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        await EventService.checkIn(eventId, USER_A);
        await pairDevice(USER_A, 'cab-a1', roomId);
        await pairDevice(USER_A, 'cab-a2', roomId);
        await witnessCheckin(USER_A, 'cab-a1', new Date(now.getTime() - 10 * MINUTE));
        await openSession(USER_A, 'cab-a1', 'Busy Table', new Date(now.getTime() - 2 * MINUTE));
        await witnessCheckin(USER_A, 'cab-a2', new Date(now.getTime() - 3 * MINUTE));

        const event = (await EventService.getEvent(eventId))!;
        const [entry] = await EventLobbyService.roster(event, await EventService.getRounds(eventId), now);
        expect(entry).toMatchObject({ status: 'ready' });
    });

    it('W26: a device that sends its scores elsewhere never lights the event green ("not_routed")', async () => {
        const roomId = await createTestRoom('lobby-route', 'Route Room');
        const otherRoomId = await createTestRoom('lobby-route-other', 'Other Room');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        const db = await getDatabase();
        const rotationId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Weekly', 'WG', 'pinball', '{"cron":"0 0 * * *"}', 1, ?, 'rotation')`, rotationId, roomId,
        );
        for (const u of [USER_A, USER_B, USER_C, USER_D, USER_E]) await EventService.checkIn(eventId, u);
        const checkedIn = new Date(now.getTime() - 10 * MINUTE);

        // A: checked in, but "Global Scoreboard only" (ADR 0032) -> not_routed.
        await pairDevice(USER_A, 'cab-a', null, true);
        await witnessCheckin(USER_A, 'cab-a', checkedIn);
        // B: the event's room, but pinned to a DIFFERENT tournament there -> not_routed.
        await pairDevice(USER_B, 'cab-b', roomId);
        await db.run(`UPDATE witness_devices SET target_tournament_id = ? WHERE atgames_unique_id = 'cab-b'`, rotationId);
        await witnessCheckin(USER_B, 'cab-b', checkedIn);
        // C: a checked-in device pointed nowhere, and a routed one not checked in
        // -> graded on the routed one only: no_checkin, never ready.
        await pairDevice(USER_C, 'cab-c1', null, true);
        await witnessCheckin(USER_C, 'cab-c1', checkedIn);
        await pairDevice(USER_C, 'cab-c2', roomId);
        // D: pointed at another room -> not_routed.
        await pairDevice(USER_D, 'cab-d', otherRoomId);
        await witnessCheckin(USER_D, 'cab-d', checkedIn);
        // E: All my rooms (W37's default), checked in -> ready.
        await pairDevice(USER_E, 'cab-e', null);
        await witnessCheckin(USER_E, 'cab-e', checkedIn);

        const event = (await EventService.getEvent(eventId))!;
        const roster = await EventLobbyService.roster(event, await EventService.getRounds(eventId), now);
        const byUser = Object.fromEntries(roster.map(e => [e.userId, e]));
        expect(byUser[USER_A]).toMatchObject({ status: 'not_routed', witnessCheckinAt: null });
        expect(byUser[USER_B]).toMatchObject({ status: 'not_routed' });
        expect(byUser[USER_C]).toMatchObject({ status: 'no_checkin' });
        expect(byUser[USER_D]).toMatchObject({ status: 'not_routed' });
        expect(byUser[USER_E]).toMatchObject({ status: 'ready' });

        // Pinned to THIS event counts.
        await db.run(`UPDATE witness_devices SET target_tournament_id = ? WHERE atgames_unique_id = 'cab-b'`, eventId);
        const again = await EventLobbyService.roster(event, await EventService.getRounds(eventId), now);
        expect(again.find(e => e.userId === USER_B)).toMatchObject({ status: 'ready' });
    });

    it('is empty once round 1 has started — the standings carry verdicts from there', async () => {
        const roomId = await createTestRoom('lobby-live', 'Live');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 60 * MINUTE), round1Start: new Date(now.getTime() - 5 * MINUTE),
        });
        await EventService.checkIn(eventId, USER_A, 'admin');
        const event = (await EventService.getEvent(eventId))!;
        expect(await EventLobbyService.roster(event, await EventService.getRounds(eventId), now)).toEqual([]);
    });
});

describe('EventLobbyService.checkinFromWitness — the tile is the check-in', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function designate(roomId: string, userId: string, deviceId: string, tournamentId: string | null) {
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, userId, roomId);
        await db.run(
            `UPDATE witness_devices SET target_room_id = ?, target_tournament_id = ? WHERE atgames_unique_id = ?`,
            roomId, tournamentId, deviceId,
        );
    }

    it('checks the cabinet owner in to a designated event inside the window, once, and reports READY', async () => {
        const roomId = await createTestRoom('lobby-tile', 'Tile');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 10 * MINUTE), round1Start: new Date(now.getTime() + 20 * MINUTE),
        });
        await pairDevice(USER_A, 'cab-a');
        await designate(roomId, USER_A, 'cab-a', eventId);
        await witnessCheckin(USER_A, 'cab-a', now);

        const first = await EventLobbyService.checkinFromWitness('cab-a', USER_A, now);
        expect(first).toMatchObject({ tournamentId: eventId, eventName: 'Stream Night', alreadyCheckedIn: false, status: 'ready' });
        expect(EventLobbyService.cabinetLine(first)).toBe(' · CHECKED IN · READY');
        expect(await EventService.isParticipant(eventId, USER_A)).toMatchObject({ source: 'checkin' });

        const again = await EventLobbyService.checkinFromWitness('cab-a', USER_A, now);
        expect(again).toMatchObject({ alreadyCheckedIn: true });
        expect(await EventService.participantCount(eventId)).toBe(1);
    });

    it('W37: an "All my rooms" device checks its owner in to a MEMBER room\'s event; a Global-only one does not', async () => {
        const roomId = await createTestRoom('lobby-all', 'All Rooms');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 10 * MINUTE), round1Start: new Date(now.getTime() + 20 * MINUTE),
        });
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER_A, roomId);
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER_B, roomId);
        await pairDevice(USER_A, 'cab-a');              // All my rooms (default)
        await pairDevice(USER_B, 'cab-b', null, true);  // Global Scoreboard only

        const a = await EventLobbyService.checkinFromWitness('cab-a', USER_A, now);
        expect(a).toMatchObject({ tournamentId: eventId, alreadyCheckedIn: false });
        expect(await EventService.isParticipant(eventId, USER_A)).toMatchObject({ source: 'checkin' });

        expect(await EventLobbyService.checkinFromWitness('cab-b', USER_B, now)).toBeNull();
        expect(await EventService.isParticipant(eventId, USER_B)).toBeFalsy();
    });

    it('writes nothing for an undesignated cabinet, a rotation target, or a closed window', async () => {
        const roomId = await createTestRoom('lobby-tile-no', 'Tile No');
        const now = new Date();
        const db = await getDatabase();

        await pairDevice(USER_A, 'cab-a');
        expect(await EventLobbyService.checkinFromWitness('cab-a', USER_A, now)).toBeNull();

        const rotationId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Weekly', 'WG', 'pinball', '{}', 1, ?, 'rotation')`, rotationId, roomId,
        );
        await designate(roomId, USER_A, 'cab-a', rotationId);
        expect(await EventLobbyService.checkinFromWitness('cab-a', USER_A, now)).toBeNull();

        const startedId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 60 * MINUTE), round1Start: new Date(now.getTime() - 1 * MINUTE),
        });
        await designate(roomId, USER_A, 'cab-a', startedId);
        expect(await EventLobbyService.checkinFromWitness('cab-a', USER_A, now)).toBeNull();
        expect(await EventService.participantCount(startedId)).toBe(0);
        expect(EventLobbyService.cabinetLine(null)).toBe('');
    });
});

describe('GET /:roomId/events/:id carries the lobby', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('ships `lobby` to the public page, names resolved, empty after round 1', async () => {
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);

        const roomId = await createTestRoom('lobby-http', 'HTTP');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 10 * MINUTE), round1Start: new Date(now.getTime() + 20 * MINUTE),
        });
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, username, display_name) VALUES (?, 'wyo', 'Wyo')`, USER_A);
        await EventService.checkIn(eventId, USER_A);
        await pairDevice(USER_A, 'cab-a', roomId);
        await witnessCheckin(USER_A, 'cab-a', now);

        const res = await request(app).get(`/api/rooms/${roomId}/events/${eventId}`);
        expect(res.status).toBe(200);
        expect(res.body.lobby).toEqual([
            expect.objectContaining({ userId: USER_A, displayName: 'Wyo', status: 'ready' }),
        ]);
    });
});

describe('EventLobbyService.roster — the 1.0.4 heartbeat (v2.160.0)', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function setHeartbeat(deviceId: string, at: Date | null) {
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_devices SET heartbeat_at = ? WHERE atgames_unique_id = ?`,
            at ? at.toISOString().replace('T', ' ').slice(0, 19) : null, deviceId,
        );
    }

    it('a cabinet that heartbeated before and has gone quiet reads offline even after a check-in; a fresh one is ready; a pre-1.0.4 one is never offline', async () => {
        const roomId = await createTestRoom('lobby-hb', 'Heartbeat');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        for (const u of [USER_A, USER_B, USER_C]) await EventService.checkIn(eventId, u);

        // A: checked in 10 min ago, last heartbeat 9 min ago -> powered off since.
        await pairDevice(USER_A, 'cab-a', roomId);
        await witnessCheckin(USER_A, 'cab-a', new Date(now.getTime() - 10 * MINUTE));
        await setHeartbeat('cab-a', new Date(now.getTime() - 9 * MINUTE));
        // B: same check-in, heartbeat 1 min ago -> ready.
        await pairDevice(USER_B, 'cab-b', roomId);
        await witnessCheckin(USER_B, 'cab-b', new Date(now.getTime() - 10 * MINUTE));
        await setHeartbeat('cab-b', new Date(now.getTime() - 1 * MINUTE));
        // C: never heartbeated (older app), checked in 10 min ago -> ready, not offline.
        await pairDevice(USER_C, 'cab-c', roomId);
        await witnessCheckin(USER_C, 'cab-c', new Date(now.getTime() - 10 * MINUTE));
        await setHeartbeat('cab-c', null);

        const event = (await EventService.getEvent(eventId))!;
        const roster = await EventLobbyService.roster(event, await EventService.getRounds(eventId), now);
        const byUser = Object.fromEntries(roster.map(e => [e.userId, e.status]));
        expect(byUser).toEqual({ [USER_A]: 'offline', [USER_B]: 'ready', [USER_C]: 'ready' });
    });

    it('a desktop device (Castcade companion, v2.163.0) is graded by the cabinet rules: quiet heartbeat reads offline, a fresh one is ready', async () => {
        const roomId = await createTestRoom('lobby-desktop', 'Desktop');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        for (const u of [USER_A, USER_B]) await EventService.checkIn(eventId, u);
        const db = await getDatabase();
        const DESK_A = '7f0c1a9e-3b2d-4c5e-9f6a-1b2c3d4e5f60';
        const DESK_B = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

        // A: checked in 10 min ago, last heartbeat 9 min ago -> the PC went away.
        await pairDevice(USER_A, DESK_A, roomId);
        await db.run(`UPDATE witness_devices SET device_type = 'desktop' WHERE atgames_unique_id = ?`, DESK_A);
        await witnessCheckin(USER_A, DESK_A, new Date(now.getTime() - 10 * MINUTE));
        await setHeartbeat(DESK_A, new Date(now.getTime() - 9 * MINUTE));
        // B: same check-in, heartbeat 1 min ago -> ready.
        await pairDevice(USER_B, DESK_B, roomId);
        await db.run(`UPDATE witness_devices SET device_type = 'desktop' WHERE atgames_unique_id = ?`, DESK_B);
        await witnessCheckin(USER_B, DESK_B, new Date(now.getTime() - 10 * MINUTE));
        await setHeartbeat(DESK_B, new Date(now.getTime() - 1 * MINUTE));

        const event = (await EventService.getEvent(eventId))!;
        const roster = await EventLobbyService.roster(event, await EventService.getRounds(eventId), now);
        const byUser = Object.fromEntries(roster.map(e => [e.userId, e.status]));
        expect(byUser).toEqual({ [USER_A]: 'offline', [USER_B]: 'ready' });
    });
});

describe('EventLobbyService.roster — per-device type (W19, v2.186.0)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('ships the best device type and a best-first devices list; unrouted devices are absent; no device is null/[]', async () => {
        const roomId = await createTestRoom('lobby-w19', 'W19');
        const otherRoom = await createTestRoom('lobby-w19-other', 'Other');
        const now = new Date();
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        for (const u of [USER_A, USER_B, USER_C]) await EventService.checkIn(eventId, u);
        const db = await getDatabase();

        // A: a cabinet that never checked in + a desktop that did -> ready via the desktop.
        await pairDevice(USER_A, 'w19-cab', roomId);
        await pairDevice(USER_A, 'w19-desk', roomId);
        await db.run(`UPDATE witness_devices SET device_type = 'desktop' WHERE atgames_unique_id = ?`, 'w19-desk');
        await witnessCheckin(USER_A, 'w19-desk', new Date(now.getTime() - 5 * MINUTE));
        // B: one routed desktop (no check-in) + a cabinet pointed at another room.
        await pairDevice(USER_B, 'w19-b-desk', roomId);
        await db.run(`UPDATE witness_devices SET device_type = 'desktop' WHERE atgames_unique_id = ?`, 'w19-b-desk');
        await pairDevice(USER_B, 'w19-b-cab', otherRoom);
        // C: no device at all.

        const event = (await EventService.getEvent(eventId))!;
        const roster = await EventLobbyService.roster(event, await EventService.getRounds(eventId), now);
        const byUser = Object.fromEntries(roster.map(e => [e.userId, e]));

        expect(byUser[USER_A]).toMatchObject({ status: 'ready', deviceType: 'desktop' });
        expect(byUser[USER_A]!.devices.map(d => [d.deviceType, d.status])).toEqual([['desktop', 'ready'], ['atgames', 'no_checkin']]);
        expect(byUser[USER_B]).toMatchObject({ status: 'no_checkin', deviceType: 'desktop' });
        expect(byUser[USER_B]!.devices).toHaveLength(1);
        expect(byUser[USER_C]).toMatchObject({ status: 'no_cabinet', deviceType: null, devices: [] });
    });
});
