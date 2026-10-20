import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { getNextRunTime, nextRotationIso } from '../utils/cronUtils.js';
import {
    DEFAULT_TIMEZONE,
    ROOM_TIMEZONE_KEY,
    isValidTimeZone,
    resolveTimezone,
    roomTimezone,
    roomTimezonesFor,
} from '../utils/roomTimezone.js';

// The settings route reloads the Scheduler on a ROOM_TIMEZONE change; a real
// reload would register every cron in the process.
const reloadSpy = vi.fn(async () => {});
vi.mock('../engine/Scheduler.js', () => ({
    Scheduler: { getInstance: () => ({ reload: reloadSpy }) },
}));

/**
 * Room default timezone (owner ruling, ROADMAP "Room default timezone"):
 * a tournament time is interpreted in the tournament's own stored zone →
 * the room's ROOM_TIMEZONE → BOT_TIMEZONE → America/Chicago. No migration:
 * an absent room setting falls through exactly as before.
 */

let savedBotTz: string | undefined;
beforeEach(() => { savedBotTz = process.env.BOT_TIMEZONE; });
afterEach(() => {
    if (savedBotTz === undefined) delete process.env.BOT_TIMEZONE;
    else process.env.BOT_TIMEZONE = savedBotTz;
});

describe('resolveTimezone precedence', () => {
    it('object zone > room zone > BOT_TIMEZONE > America/Chicago', () => {
        process.env.BOT_TIMEZONE = 'Europe/London';
        expect(resolveTimezone('Asia/Tokyo', 'America/Denver')).toBe('Asia/Tokyo');
        expect(resolveTimezone(null, 'America/Denver')).toBe('America/Denver');
        expect(resolveTimezone(undefined, null)).toBe('Europe/London');
        expect(resolveTimezone('', '')).toBe('Europe/London');
        delete process.env.BOT_TIMEZONE;
        expect(resolveTimezone(null, null)).toBe('America/Chicago');
        expect(DEFAULT_TIMEZONE).toBe('America/Chicago');
    });

    it('isValidTimeZone accepts IANA ids and rejects junk', () => {
        expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
        expect(isValidTimeZone('UTC')).toBe(true);
        expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
        expect(isValidTimeZone('')).toBe(false);
    });
});

describe('roomTimezone / roomTimezonesFor', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('returns null for absent, empty and invalid values, the zone for a valid one', async () => {
        const roomId = await createTestRoom('tz-room', 'TZ Room');
        expect(await roomTimezone(roomId)).toBeNull();
        expect(await roomTimezone(null)).toBeNull();

        const db = await getDatabase();
        // `set('')` deletes, so write a whitespace-only row directly.
        await db.run(
            'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
            roomId, ROOM_TIMEZONE_KEY, '   ',
        );
        expect(await roomTimezone(roomId)).toBeNull();

        await GameRoomSettingsService.set(roomId, ROOM_TIMEZONE_KEY, 'Not/AZone');
        expect(await roomTimezone(roomId)).toBeNull();

        await GameRoomSettingsService.set(roomId, ROOM_TIMEZONE_KEY, ' America/Los_Angeles ');
        expect(await roomTimezone(roomId)).toBe('America/Los_Angeles');
    });

    it('batches across rooms and omits rooms with no valid zone', async () => {
        const a = await createTestRoom('tz-a', 'A');
        const b = await createTestRoom('tz-b', 'B');
        const c = await createTestRoom('tz-c', 'C');
        await GameRoomSettingsService.set(a, ROOM_TIMEZONE_KEY, 'America/New_York');
        await GameRoomSettingsService.set(b, ROOM_TIMEZONE_KEY, 'bogus');
        const map = await roomTimezonesFor([a, b, c, a]);
        expect([...map.entries()]).toEqual([[a, 'America/New_York']]);
        expect((await roomTimezonesFor([])).size).toBe(0);
    });
});

describe('nextRotationIso with a room zone', () => {
    const from = new Date('2026-08-27T12:00:00Z');

    it('a cadence with no zone runs on the room zone', () => {
        const cadence = JSON.stringify({ cron: '0 22 * * *' });
        const la = Date.parse(nextRotationIso(cadence, from, 'America/Los_Angeles')!);
        const ny = Date.parse(nextRotationIso(cadence, from, 'America/New_York')!);
        // 22:00 New York fires three hours before 22:00 Los Angeles.
        expect(la - ny).toBe(3 * 3600_000);
        expect(new Date(la).toISOString()).toBe('2026-08-28T05:00:00.000Z');
    });

    it('a cadence WITH a zone ignores the room zone', () => {
        const cadence = JSON.stringify({ cron: '0 22 * * *', timezone: 'America/New_York' });
        expect(nextRotationIso(cadence, from, 'America/Los_Angeles'))
            .toBe(nextRotationIso(cadence, from));
        expect(nextRotationIso(cadence, from, 'America/Los_Angeles')).toBe('2026-08-28T02:00:00.000Z');
    });

    it('no room zone falls back to BOT_TIMEZONE exactly as before', () => {
        process.env.BOT_TIMEZONE = 'UTC';
        const cadence = JSON.stringify({ cron: '0 22 * * *' });
        expect(nextRotationIso(cadence, from, null)).toBe('2026-08-27T22:00:00.000Z');
        expect(nextRotationIso(cadence, from)).toBe('2026-08-27T22:00:00.000Z');
    });
});

describe('getActiveLeaderboards nextMaintenanceAt honours the room zone', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function seed(cadence: Record<string, unknown>) {
        const db = await getDatabase();
        const roomId = await createTestRoom('tz-board', 'TZ Board');
        await GameRoomSettingsService.set(roomId, ROOM_TIMEZONE_KEY, 'America/Los_Angeles');
        const tid = await createTestTournament(roomId, { name: 'Daily' });
        await db.run('UPDATE tournaments SET cadence = ? WHERE id = ?', JSON.stringify(cadence), tid);
        const gid = await createTestGame(tid, { name: 'Medieval Madness' });
        await createTestSubmission(gid, { username: 'Alice', score: 1000 });
        return roomId;
    }

    it('a cadence without a zone fires at the room-zone instant', async () => {
        process.env.BOT_TIMEZONE = 'America/New_York';
        const roomId = await seed({ cron: '0 22 * * *' });
        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(boards).toHaveLength(1);
        const expected = getNextRunTime('0 22 * * *', 'America/Los_Angeles')!.toISOString();
        expect(boards[0]!.nextMaintenanceAt).toBe(expected);
        expect(boards[0]!.nextMaintenanceAt)
            .not.toBe(getNextRunTime('0 22 * * *', 'America/New_York')!.toISOString());
    });

    it("the cadence's own zone beats the room zone", async () => {
        const roomId = await seed({ cron: '0 22 * * *', timezone: 'America/New_York' });
        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(boards[0]!.nextMaintenanceAt)
            .toBe(getNextRunTime('0 22 * * *', 'America/New_York')!.toISOString());
    });
});

describe('POST /:roomId/settings ROOM_TIMEZONE', () => {
    beforeEach(async () => { await setupTestDb(); reloadSpy.mockClear(); });

    async function app() {
        const a = express();
        a.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        a.use('/api/rooms', roomsRouter);
        return a;
    }
    const token = (roomId: string) =>
        signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'ra', discordId: '111' } as never);

    it('refuses a non-IANA zone without saving', async () => {
        const roomId = await createTestRoom('tz-set', 'TZ Set');
        const res = await request(await app())
            .post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${token(roomId)}`)
            .send({ [ROOM_TIMEZONE_KEY]: 'Nowhere/Land' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ROOM_TIMEZONE_INVALID');
        expect(await GameRoomSettingsService.get(roomId, ROOM_TIMEZONE_KEY)).toBeNull();
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('saves a valid zone (trimmed) and reloads the Scheduler; empty clears it', async () => {
        const roomId = await createTestRoom('tz-set2', 'TZ Set 2');
        const a = await app();
        const ok = await request(a)
            .post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${token(roomId)}`)
            .send({ [ROOM_TIMEZONE_KEY]: ' Europe/Berlin ' });
        expect(ok.status).toBe(200);
        expect(await GameRoomSettingsService.get(roomId, ROOM_TIMEZONE_KEY)).toBe('Europe/Berlin');
        expect(reloadSpy).toHaveBeenCalledTimes(1);

        const cleared = await request(a)
            .post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${token(roomId)}`)
            .send({ [ROOM_TIMEZONE_KEY]: '' });
        expect(cleared.status).toBe(200);
        expect(await GameRoomSettingsService.get(roomId, ROOM_TIMEZONE_KEY)).toBeNull();
    });

    it('a save that does not touch the zone does not reload the Scheduler', async () => {
        const roomId = await createTestRoom('tz-set3', 'TZ Set 3');
        const res = await request(await app())
            .post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${token(roomId)}`)
            .send({ ROOM_LISTED: 'true' });
        expect(res.status).toBe(200);
        expect(reloadSpy).not.toHaveBeenCalled();
    });
});
