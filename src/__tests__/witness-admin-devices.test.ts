import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { EventService } from '../services/EventService.js';
import { WitnessService } from '../services/WitnessService.js';
import { WitnessAdminViewService } from '../services/WitnessAdminViewService.js';

/**
 * The runner's live device view (v2.189.0, W5): `GET /api/rooms/:roomId/admin/witness/devices`.
 *
 * What these pin, worst-bug-first:
 *   1. Privacy: only devices of this room's members (or direct entrants) are
 *      listed, never a revoked one, never a stranger's; and only a room admin
 *      of THAT room can read it.
 *   2. A name is never a raw id.
 *   3. A cabinet that has never heartbeated is `unknown`, never `offline`
 *      (the lobby's own rule); a stale heartbeat is `offline`.
 *   4. The routing entry is the one the player's own "Your scores go to" line
 *      is built from, and the event counts are the lobby's.
 */

const MINUTE = 60_000;
const ADMIN = '999999999999999999';
const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const CARL = '333333333333333333';
const DANA = '444444444444444444';

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: ADMIN, username: 'RoomAdmin' } as never);

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: router } = await import('../api/routes/witnessAdmin.js');
    app.use('/api', router);
    return app;
}

async function member(roomId: string, userId: string, name: string | null) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, userId, roomId);
    if (name) {
        await db.run(
            `INSERT OR REPLACE INTO user_profiles (discord_user_id, display_name, username) VALUES (?, ?, ?)`,
            userId, name, name,
        );
    }
}

async function pair(userId: string, deviceId: string, opts: {
    type?: 'atgames' | 'desktop'; heartbeat?: Date | null; revoked?: boolean; targetRoomId?: string | null;
} = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, last_seen_at, heartbeat_at, revoked_at, device_type, target_room_id)
         VALUES (?, ?, 'hash', datetime('now'), ?, ?, ?, ?)`,
        deviceId, userId,
        opts.heartbeat ? opts.heartbeat.toISOString() : null,
        opts.revoked ? new Date().toISOString() : null,
        opts.type ?? 'atgames', opts.targetRoomId ?? null,
    );
}

async function checkin(userId: string, deviceId: string, at: Date) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_checkins (atgames_unique_id, canonical_user_id, server_ts) VALUES (?, ?, ?)`,
        deviceId, userId, at.toISOString().replace('T', ' ').slice(0, 19),
    );
}

async function session(userId: string, deviceId: string, table: string, launchedAt: Date, exited = false) {
    const db = await getDatabase();
    const launch = Math.floor(launchedAt.getTime() / 1000);
    await db.run(
        `INSERT INTO witness_observations (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, kind)
         VALUES (?, ?, ?, ?, ?, 'session')`,
        deviceId, userId, table, launch, exited ? launch + 600 : null,
    );
}

async function createEvent(roomId: string, opts: { checkinOpensAt: Date; round1Start: Date; name?: string }) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_opens_at, checkin_required)
         VALUES (?, ?, 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', ?, 1)`,
        id, opts.name ?? 'Friday Night', roomId, opts.checkinOpensAt.toISOString(),
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
         VALUES (?, ?, 'Medieval Madness', 'SCHEDULED', ?, 1, ?, ?)`,
        crypto.randomUUID(), id, roomId,
        opts.round1Start.toISOString(), new Date(opts.round1Start.getTime() + 30 * MINUTE).toISOString(),
    );
    return id;
}

describe('WitnessAdminViewService.roomDevices', () => {
    let roomId: string;
    let otherRoomId: string;
    const now = new Date();

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom('wizard', 'The Wizard Room');
        otherRoomId = await createTestRoom('rtx', 'RTX Pinball');
    });

    it('lists members\' devices with names (never raw ids) and leaves out strangers and revoked devices', async () => {
        await member(roomId, ALICE, 'Alice');
        await member(roomId, BOB, null); // no profile at all
        await member(otherRoomId, CARL, 'Carl'); // member of ANOTHER room only
        await pair(ALICE, 'cab-alice', { heartbeat: now });
        await pair(BOB, 'cab-bob', { heartbeat: now });
        await pair(CARL, 'cab-carl', { heartbeat: now });
        await pair(ALICE, 'cab-alice-old', { heartbeat: now, revoked: true });

        const { devices } = await WitnessAdminViewService.roomDevices(roomId, now);
        expect(devices.map(d => d.deviceId).sort()).toEqual(['cab-alice', 'cab-bob']);
        const alice = devices.find(d => d.deviceId === 'cab-alice')!;
        expect(alice).toMatchObject({ playerName: 'Alice', userId: ALICE, member: true, deviceType: 'atgames', label: null });
        // Nobody renders as a snowflake.
        for (const d of devices) expect(d.playerName).not.toMatch(/^\d{15,}$/);
        expect(devices.find(d => d.deviceId === 'cab-bob')!.playerName).toBe('Unknown player');
    });

    it('includes a direct entrant of this room\'s tournament who is not a member, flagged member:false', async () => {
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        await member(roomId, ALICE, 'Alice');
        await member(otherRoomId, DANA, 'Dana');
        await EventService.checkIn(eventId, DANA, 'admin');
        await pair(ALICE, 'cab-alice', { heartbeat: now });
        await pair(DANA, 'pc-dana', { type: 'desktop', heartbeat: now });

        const { devices } = await WitnessAdminViewService.roomDevices(roomId, now);
        const dana = devices.find(d => d.deviceId === 'pc-dana')!;
        expect(dana).toMatchObject({ member: false, deviceType: 'desktop', playerName: 'Dana' });
        expect(devices.find(d => d.deviceId === 'cab-alice')!.member).toBe(true);
    });

    it('online: fresh heartbeat online, stale offline, never-heartbeated unknown', async () => {
        for (const [u, n] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CARL, 'Carl']] as const) await member(roomId, u, n);
        await pair(ALICE, 'd-fresh', { heartbeat: new Date(now.getTime() - 60_000) });
        await pair(BOB, 'd-stale', { heartbeat: new Date(now.getTime() - 20 * MINUTE) });
        await pair(CARL, 'd-never', { heartbeat: null });

        const { devices } = await WitnessAdminViewService.roomDevices(roomId, now);
        const by = Object.fromEntries(devices.map(d => [d.deviceId, d]));
        expect(by['d-fresh']!.online).toBe('online');
        expect(by['d-stale']!.online).toBe('offline');
        expect(by['d-never']!.online).toBe('unknown');
    });

    it('openTable: open session shown, none after exit, none when older than the max age; last check-in any time', async () => {
        for (const [u, n] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CARL, 'Carl']] as const) await member(roomId, u, n);
        await pair(ALICE, 'd-open', { heartbeat: now });
        await pair(BOB, 'd-exited', { heartbeat: now });
        await pair(CARL, 'd-old', { heartbeat: now });
        const launched = new Date(now.getTime() - 5 * MINUTE);
        await session(ALICE, 'd-open', 'Attack from Mars (Williams 1995)', launched);
        await session(BOB, 'd-exited', 'Whirlwind (Williams 1990)', launched, true);
        await session(CARL, 'd-old', 'Missed Exit (Stern 2000)', new Date(now.getTime() - 6 * 3600_000));
        // A check-in from last week still shows (no window floor in the runner's view).
        const lastWeek = new Date(now.getTime() - 7 * 24 * 3600_000);
        await checkin(ALICE, 'd-open', lastWeek);

        const { devices } = await WitnessAdminViewService.roomDevices(roomId, now);
        const by = Object.fromEntries(devices.map(d => [d.deviceId, d]));
        expect(by['d-open']).toMatchObject({ openTable: 'Attack from Mars (Williams 1995)' });
        expect(by['d-open']!.openSince).toBe(new Date(Math.floor(launched.getTime() / 1000) * 1000).toISOString());
        expect(Date.parse(by['d-open']!.lastCheckinAt!)).toBeLessThan(now.getTime() - 6 * 24 * 3600_000);
        expect(by['d-exited']).toMatchObject({ openTable: null, openSince: null, lastCheckinAt: null });
        expect(by['d-old']!.openTable).toBeNull();
        // Open table sorts first.
        expect(devices[0]!.deviceId).toBe('d-open');
    });

    it('routing is the matching routingForRoom entry, and target is describeTarget', async () => {
        await member(roomId, ALICE, 'Alice');
        await member(roomId, BOB, 'Bob');
        await pair(ALICE, 'cab-alice', { heartbeat: now });
        await pair(BOB, 'cab-bob', { heartbeat: now, targetRoomId: otherRoomId });

        const { devices } = await WitnessAdminViewService.roomDevices(roomId, now);
        for (const [user, device] of [[ALICE, 'cab-alice'], [BOB, 'cab-bob']] as const) {
            const expected = (await WitnessService.routingForRoom(user, roomId)).find(r => r.deviceId === device);
            const got = devices.find(d => d.deviceId === device)!;
            expect(got.routing).toEqual(expected);
            expect(got.target).toBe(await WitnessService.describeTarget(device));
        }
        expect(devices.find(d => d.deviceId === 'cab-bob')!.routing).toMatchObject({ sendsHere: 'no', why: 'other_room' });
    });

    it('events: the check-in lobby counts appear for an event in check-in and vanish once round 1 has started', async () => {
        for (const [u, n] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CARL, 'Carl'], [DANA, 'Dana']] as const) await member(roomId, u, n);
        const eventId = await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        for (const u of [ALICE, BOB, CARL, DANA]) await EventService.checkIn(eventId, u);
        const checkedIn = new Date(now.getTime() - 10 * MINUTE);
        await pair(ALICE, 'cab-a', { heartbeat: now });          // ready
        await checkin(ALICE, 'cab-a', checkedIn);
        await pair(BOB, 'cab-b', { heartbeat: now });            // table open
        await checkin(BOB, 'cab-b', checkedIn);
        await session(BOB, 'cab-b', 'Busy Table', new Date(now.getTime() - 2 * MINUTE));
        await pair(CARL, 'cab-c', { heartbeat: now });           // no check-in
        // DANA: no device at all.

        const view = await WitnessAdminViewService.roomDevices(roomId, now);
        expect(view.events).toHaveLength(1);
        expect(view.events[0]).toMatchObject({ tournamentId: eventId, name: 'Friday Night', state: 'checkin' });
        expect(view.events[0]!.counts).toEqual({
            ready: 1, table_open: 1, no_checkin: 1, offline: 0, not_routed: 0, no_cabinet: 1,
        });
        expect(view.events[0]!.roster).toHaveLength(4);

        // Round 1 has started: the lobby is over, the block disappears.
        const later = new Date(now.getTime() + 20 * MINUTE);
        expect((await WitnessAdminViewService.roomDevices(roomId, later)).events).toEqual([]);
    });

    it('an event with nobody checked in has all-zero counts', async () => {
        await createEvent(roomId, {
            checkinOpensAt: new Date(now.getTime() - 30 * MINUTE), round1Start: new Date(now.getTime() + 15 * MINUTE),
        });
        const { events } = await WitnessAdminViewService.roomDevices(roomId, now);
        expect(events).toHaveLength(1);
        expect(Object.values(events[0]!.counts).every(n => n === 0)).toBe(true);
        expect(events[0]!.roster).toEqual([]);
    });
});

describe('GET /api/rooms/:roomId/admin/witness/devices', () => {
    let app: express.Express;
    let roomId: string;
    let otherRoomId: string;

    beforeEach(async () => {
        await setupTestDb();
        app = await createTestApp();
        roomId = await createTestRoom('wizard', 'The Wizard Room');
        otherRoomId = await createTestRoom('rtx', 'RTX Pinball');
        await member(roomId, ALICE, 'Alice');
        await pair(ALICE, 'cab-alice', { heartbeat: new Date() });
    }, 30_000);

    it('401 without a token, 403 for an admin of another room, 200 for this room\'s admin', async () => {
        const anon = await request(app).get(`/api/rooms/${roomId}/admin/witness/devices`);
        expect(anon.status).toBe(401);

        const wrong = await request(app).get(`/api/rooms/${roomId}/admin/witness/devices`)
            .set('Authorization', `Bearer ${adminToken(otherRoomId)}`);
        expect(wrong.status).toBe(403);

        const ok = await request(app).get(`/api/rooms/${roomId}/admin/witness/devices`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(ok.status).toBe(200);
        expect(ok.body.devices).toEqual([expect.objectContaining({ deviceId: 'cab-alice', playerName: 'Alice', online: 'online' })]);
        expect(ok.body.events).toEqual([]);
    });

    it('a plain player token is refused', async () => {
        const player = signToken({ role: 'player', gameRoomIds: [], discordId: ALICE, username: 'Alice' } as never);
        const res = await request(app).get(`/api/rooms/${roomId}/admin/witness/devices`)
            .set('Authorization', `Bearer ${player}`);
        expect([401, 403]).toContain(res.status);
    });
});
