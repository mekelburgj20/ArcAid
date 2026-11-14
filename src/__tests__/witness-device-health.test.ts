import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessService } from '../services/WitnessService.js';
import { NotificationService } from '../services/NotificationService.js';
import { EngagementReminderService, CABINET_WITNESS_LINE } from '../services/EngagementReminderService.js';
import { OpsAlertService } from '../services/OpsAlertService.js';
import { HEARTBEAT_STALE_SEC } from '../services/EventLobbyService.js';

/**
 * W102 (v2.247.0) - device health, the reminder line and the support alert.
 *
 *   - The devices list gains `heartbeatAt`, `watching` (the lobby's one
 *     staleness rule; `unknown` for a build that never heartbeats),
 *     `updatePending`, `lastScoreAt` / `lastScoreTable`; `routingForRoom`
 *     rows carry `watching`.
 *   - A reminder DM about a room gets ONE cabinet line when a heartbeating
 *     cabinet routes there and no device routing there is watching.
 *   - "Send to Arcaid support" alerts the operator with a label, never an id.
 */

const USER = '123456789012345678';
const OTHER = '876543210987654321';
const CABINET = 'CAB0000000000001';
const DESKTOP = 'desk-uuid-0001';

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const auth = (user = USER) => ({ Authorization: `Bearer ${playerToken(user)}` });

async function pair(user: string, deviceId: string, type: 'atgames' | 'desktop' = 'atgames'): Promise<string> {
    const { code } = await WitnessService.createPairingCode(user);
    return (await WitnessService.redeemPairingCode(code, deviceId, null, type)).token;
}

/** `heartbeat_at` this many seconds ago; null = never heartbeated. */
async function heartbeatAgo(deviceId: string, seconds: number | null) {
    const db = await getDatabase();
    await db.run(
        `UPDATE witness_devices SET heartbeat_at = ${seconds === null ? 'NULL' : `datetime('now', '-${seconds} seconds')`}
          WHERE atgames_unique_id = ?`,
        deviceId,
    );
}

async function evidence(deviceId: string, user: string, table: string, createdAt: string, outcome = 'ingested') {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_evidence (device_id, canonical_user_id, outcome, table_name, score, played_at, created_at)
         VALUES (?, ?, ?, ?, 1000, ?, ?)`,
        deviceId, user, outcome, table, createdAt, createdAt,
    );
}

const deviceOf = async (user: string, deviceId: string) =>
    (await WitnessService.listDevices(user)).find(d => d.atgamesUniqueId === deviceId)!;

beforeEach(async () => {
    await setupTestDb();
});

describe('device health fields (W102)', () => {
    it('watching: yes inside HEARTBEAT_STALE_SEC, no after, unknown with no heartbeat', async () => {
        await pair(USER, CABINET);
        let d = await deviceOf(USER, CABINET);
        expect(d).toMatchObject({ heartbeatAt: null, watching: 'unknown' });

        await heartbeatAgo(CABINET, 10);
        d = await deviceOf(USER, CABINET);
        expect(d.watching).toBe('yes');
        expect(d.heartbeatAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

        await heartbeatAgo(CABINET, HEARTBEAT_STALE_SEC - 5);
        expect((await deviceOf(USER, CABINET)).watching).toBe('yes');
        await heartbeatAgo(CABINET, HEARTBEAT_STALE_SEC + 5);
        expect((await deviceOf(USER, CABINET)).watching).toBe('no');
    });

    it('a real heartbeat makes it watching; updatePending follows a staged build newer than the running one', async () => {
        const token = await pair(USER, CABINET);
        const beat = async (q: Record<string, string>) => {
            const { default: globalRouter } = await import('../api/routes/global.js');
            const app = express();
            app.use('/api', globalRouter);
            return request(app).get('/api/witness/heartbeat').query({ device: CABINET, token, ...q });
        };
        expect((await beat({ v: '1.1.0' })).status).toBe(200);
        let d = await deviceOf(USER, CABINET);
        expect(d).toMatchObject({ watching: 'yes', updatePending: false, stagedVersion: null });
        await beat({ v: '1.1.0', staged: '1.1.1' });
        d = await deviceOf(USER, CABINET);
        expect(d).toMatchObject({ updatePending: true, stagedVersion: '1.1.1' });
        await beat({ v: '1.1.1' });
        expect((await deviceOf(USER, CABINET)).updatePending).toBe(false);
    });

    it('lastScoreAt / lastScoreTable: the newest evidence row of that device on this account, any outcome', async () => {
        await pair(USER, CABINET);
        await pair(USER, DESKTOP, 'desktop');
        expect(await deviceOf(USER, CABINET)).toMatchObject({ lastScoreAt: null, lastScoreTable: null });

        await evidence(CABINET, USER, 'Old Table', '2026-11-10 10:00:00');
        await evidence(CABINET, USER, 'Newest Table', '2026-11-12 09:00:00', 'no_match');
        await evidence(CABINET, USER, 'Middle Table', '2026-11-11 10:00:00', 'global');
        await evidence(DESKTOP, USER, 'Desk Table', '2026-11-13 10:00:00');
        // Another account's row for the same device id says nothing about this one.
        await evidence(CABINET, OTHER, 'Not Mine', '2026-11-14 10:00:00');

        expect(await deviceOf(USER, CABINET)).toMatchObject({ lastScoreAt: '2026-11-12 09:00:00', lastScoreTable: 'Newest Table' });
        expect(await deviceOf(USER, DESKTOP)).toMatchObject({ lastScoreAt: '2026-11-13 10:00:00', lastScoreTable: 'Desk Table' });
    });

    it('the devices route carries the new fields, and routingForRoom rows carry watching and deviceType', async () => {
        await pair(USER, CABINET);
        await pair(USER, DESKTOP, 'desktop');
        await heartbeatAgo(CABINET, 30);
        const { default: globalRouter } = await import('../api/routes/global.js');
        const app = express();
        app.use('/api', globalRouter);
        const res = await request(app).get('/api/me/witness/devices').set(auth());
        expect(res.status).toBe(200);
        const cab = res.body.find((d: { atgamesUniqueId: string }) => d.atgamesUniqueId === CABINET);
        expect(cab).toMatchObject({ watching: 'yes', updatePending: false, lastScoreAt: null, lastScoreTable: null });
        expect(typeof cab.heartbeatAt).toBe('string');

        const roomId = await createTestRoom('health-room', 'Health Room');
        const db = await getDatabase();
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, USER, roomId);
        const routing = await WitnessService.routingForRoom(USER, roomId);
        expect(routing.find(r => r.deviceId === CABINET)).toMatchObject({ deviceType: 'atgames', watching: 'yes', sendsHere: 'yes' });
        expect(routing.find(r => r.deviceId === DESKTOP)).toMatchObject({ deviceType: 'desktop', watching: 'unknown', sendsHere: 'yes' });
    });
});

// ---------------------------------------------------------------------------
// The reminder line. Same world as engagement-reminders.test.ts: a weekly UTC
// rotation, the playReminder due 24 h after the table opened. The heartbeat's
// freshness is judged on the real clock (SQLite `now`), the sweep's on `now`.
// ---------------------------------------------------------------------------

const H = 3_600_000;
const S = Date.UTC(2026, 10, 11, 12);

describe('the cabinet line on a reminder DM (W102)', () => {
    let notifySpy: ReturnType<typeof vi.spyOn<typeof NotificationService, 'notify'>>;
    let roomId: string;
    let counter = 0;

    beforeEach(async () => {
        notifySpy = vi.spyOn(NotificationService, 'notify').mockResolvedValue(true);
        counter += 1;
        roomId = await createTestRoom(`rl-room-${counter}`, `RL Room ${counter}`);
        const tournamentId = await createTestTournament(roomId, { name: 'RL Tournament' });
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET cadence = ?, entry_mode = 'members', format = 'rotation', is_active = 1 WHERE id = ?`,
            JSON.stringify({ cron: '0 12 * * 3', timezone: 'UTC' }), tournamentId,
        );
        await createTestGame(tournamentId, { name: 'Medieval Madness', status: 'ACTIVE', startDate: new Date(S).toISOString() });
        await db.run(
            `INSERT INTO room_members (user_id, room_id, joined_at, source) VALUES (?, ?, datetime('now', '-60 days'), 'claim')`,
            USER, roomId,
        );
        await NotificationService.mergePrefs(USER, { playReminder: true });
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const dm = async () => {
        await EngagementReminderService.sweep(new Date(S + 25 * H));
        const calls = notifySpy.mock.calls.map(c => c[0]).filter(p => p.userId === USER);
        expect(calls).toHaveLength(1);
        return calls[0]!.message;
    };
    const lineCount = (message: string) => message.split(CABINET_WITNESS_LINE).length - 1;

    it('a heartbeating cabinet routed here that is not watching: one line, before the link', async () => {
        await pair(USER, CABINET);
        await heartbeatAgo(CABINET, HEARTBEAT_STALE_SEC + 60);
        const message = await dm();
        expect(lineCount(message)).toBe(1);
        expect(message.indexOf(CABINET_WITNESS_LINE)).toBeLessThan(message.lastIndexOf('\n'));
        expect(message).toContain('**Medieval Madness**');
    });

    it('a cabinet watching now: no line', async () => {
        await pair(USER, CABINET);
        await heartbeatAgo(CABINET, 20);
        expect(lineCount(await dm())).toBe(0);
    });

    it('a cabinet that never heartbeats (unknown): no line', async () => {
        await pair(USER, CABINET);
        expect(lineCount(await dm())).toBe(0);
    });

    it('a cabinet that does not route here: no line', async () => {
        await pair(USER, CABINET);
        await heartbeatAgo(CABINET, HEARTBEAT_STALE_SEC + 60);
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET global_only = 1 WHERE atgames_unique_id = ?`, CABINET);
        expect(lineCount(await dm())).toBe(0);
    });

    it('another device routed here that IS watching: no line', async () => {
        await pair(USER, CABINET);
        await heartbeatAgo(CABINET, HEARTBEAT_STALE_SEC + 60);
        await pair(USER, DESKTOP, 'desktop');
        await heartbeatAgo(DESKTOP, 15);
        expect(lineCount(await dm())).toBe(0);
    });

    it('only a desktop (not watching): no line', async () => {
        await pair(USER, DESKTOP, 'desktop');
        await heartbeatAgo(DESKTOP, HEARTBEAT_STALE_SEC + 60);
        expect(lineCount(await dm())).toBe(0);
    });

    it('no device at all: no line', async () => {
        expect(lineCount(await dm())).toBe(0);
    });

    it('a failing lookup adds nothing and never stops the DM', async () => {
        await pair(USER, CABINET);
        await heartbeatAgo(CABINET, HEARTBEAT_STALE_SEC + 60);
        vi.spyOn(WitnessService, 'routingForRoom').mockRejectedValue(new Error('boom'));
        const message = await dm();
        expect(lineCount(message)).toBe(0);
    });
});

describe('"Send to Arcaid support" alerts the operator (W102)', () => {
    let app: express.Express;
    const REQUEST_ID = 'a'.repeat(32);

    beforeEach(async () => {
        const { default: globalRouter } = await import('../api/routes/global.js');
        app = express();
        app.use(express.json());
        app.use('/api', globalRouter);
        await pair(USER, CABINET);
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET device_model_name = 'Legends Ultimate', atgames_username = 'krobs_ag' WHERE atgames_unique_id = ?`, CABINET);
        await db.run(
            `INSERT INTO witness_log_requests (id, atgames_unique_id, canonical_user_id, status, ready_at, size_bytes)
             VALUES (?, ?, ?, 'ready', datetime('now'), 2048)`,
            REQUEST_ID, CABINET, USER,
        );
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('names the player by label, the cabinet model, the note (200 chars) and where to read it', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Krobs')`, USER);
        const alert = vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        const note = `  ${'x'.repeat(300)}  `;
        const res = await request(app).post(`/api/me/witness/log-requests/${REQUEST_ID}/share`).set(auth()).send({ note });
        expect(res.status).toBe(200);
        expect(alert).toHaveBeenCalledTimes(1);
        const text = alert.mock.calls[0]![0];
        expect(text).toContain('Krobs');
        expect(text).toContain('Legends Ultimate');
        expect(text).toContain(`Note: ${'x'.repeat(200)}`);
        expect(text).not.toContain('x'.repeat(201));
        expect(text).toContain('Super Admin → Witness releases and logs');
        expect(text).not.toContain(USER);
    });

    it('with no label it falls back to the cabinet name, never the raw id; no note, no note line', async () => {
        const alert = vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        const res = await request(app).post(`/api/me/witness/log-requests/${REQUEST_ID}/share`).set(auth()).send({});
        expect(res.status).toBe(200);
        const text = alert.mock.calls[0]![0];
        expect(text).toContain('krobs_ag');
        expect(text).not.toContain(USER);
        expect(text).not.toContain('Note:');
    });

    it('a share that is refused sends nothing; an alert failure never fails the share', async () => {
        const alert = vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        expect((await request(app).post(`/api/me/witness/log-requests/${'b'.repeat(32)}/share`).set(auth()).send({})).status).toBe(404);
        expect(alert).not.toHaveBeenCalled();

        alert.mockImplementation(() => { throw new Error('discord down'); });
        const res = await request(app).post(`/api/me/witness/log-requests/${REQUEST_ID}/share`).set(auth()).send({ note: 'hi' });
        expect(res.status).toBe(200);
        expect(res.body.request.sharedAt).toBeTruthy();
    });
});
