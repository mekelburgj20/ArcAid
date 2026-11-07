import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';
import { signToken } from '../api/auth.js';
import { ActivityLogService } from '../services/ActivityLogService.js';
import { diffSettings, diffTournament } from '../utils/activityDiff.js';
import { maskFor } from '../utils/secrets.js';

/**
 * G15 (v2.228.0, ADR 0037 §10 amendment) - the activity details panel.
 *
 *   1. A settings save records ONLY the keys whose value changed, with
 *      before/after; a secret records "changed" and never a value (not even
 *      ciphertext); a save that changed nothing writes no row at all.
 *   2. A tournament edit records its changed fields the same way.
 *   3. Readers: every row carries a curated `detail` (no ids, IPs, tokens);
 *      only the super-admin also gets the raw JSON. Admin rows read as
 *      sentences, including rows written before v2.228.0.
 */

const ADMIN_ID = '999999999999999999';
const USER = '123456789012345678';
const NO_RULES = { engines: { required: [], excluded: [] }, devices: { required: [], excluded: [] } };

const roomAdminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: ADMIN_ID, username: 'RoomAdmin' } as never);
const superToken = () => signToken({ role: 'super_admin', gameRoomIds: [], discordId: ADMIN_ID, username: 'admin' } as never);

async function rows(where = '1=1', ...params: unknown[]) {
    await drainBackgroundTasks();
    const db = await getDatabase();
    return db.all<Array<Record<string, any>>>(`SELECT * FROM activity_log WHERE ${where} ORDER BY id`, ...params);
}

async function app() {
    const { activityAdminLog } = await import('../api/activityAdminMiddleware.js');
    const a = express();
    a.use(express.json());
    a.use('/api/rooms/:roomId', activityAdminLog);
    a.use('/api/admin', activityAdminLog);
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    const { default: adminRouter } = await import('../api/routes/admin.js');
    a.use('/api/rooms', roomsRouter);
    a.use('/api/admin', adminRouter);
    return a;
}

describe('diffSettings / diffTournament', () => {
    it('keeps only changed keys, skips masks, treats empty as unset, hides secrets', () => {
        const before = { ROOM_TIMEZONE: 'America/Chicago', THEME: 'neon', ISCORED_PASSWORD: 'old-pw', KIOSK_ZOOM: '120' };
        const changes = diffSettings(before, {
            ROOM_TIMEZONE: 'America/New_York', THEME: 'neon', ISCORED_PASSWORD: 'new-pw',
            ATGAMES_PASSWORD: maskFor('ATGAMES_PASSWORD'), KIOSK_ZOOM: '', SCOREBOARD_ZOOM: '',
        });
        expect(changes).toEqual([
            { key: 'ROOM_TIMEZONE', label: 'Room timezone', from: 'America/Chicago', to: 'America/New_York' },
            { key: 'ISCORED_PASSWORD', label: 'iScored password', secret: true },
            { key: 'KIOSK_ZOOM', label: 'Kiosk zoom (%)', from: '120', to: null },
        ]);
        expect(JSON.stringify(changes)).not.toMatch(/old-pw|new-pw/);
        // Same secret value re-sent: no change.
        expect(diffSettings(before, { ISCORED_PASSWORD: 'old-pw' })).toEqual([]);
        // An unknown key shows as the key.
        expect(diffSettings({}, { SOME_NEW_KEY: 'x' })[0]!.label).toBe('SOME_NEW_KEY');
    });

    it('diffs a tournament by field, flattening cadence and skipping ids/codes', () => {
        const before = { id: 't', name: 'A', max_active_games: 1, cadence: '{"cron":"0 0 * * *","timezone":"UTC"}', invite_code: 'x', created_by_user_id: USER };
        const after = { id: 't', name: 'A', max_active_games: 3, cadence: '{"timezone":"UTC","cron":"0 6 * * *"}', invite_code: 'y', created_by_user_id: 'other' };
        expect(diffTournament(before, after)).toEqual([
            { key: 'max_active_games', label: 'Max active games', from: '1', to: '3' },
            { key: 'cadence.cron', label: 'Schedule (cron)', from: '0 0 * * *', to: '0 6 * * *' },
        ]);
    });
});

describe('admin edits record a changed-keys diff', () => {
    beforeEach(async () => {
        await setupTestDb();
        const db = await getDatabase();
        await db.run(`INSERT OR REPLACE INTO user_profiles (discord_user_id, display_name) VALUES (?, 'RoomAdmin')`, ADMIN_ID);
    });

    it('Save-all with one change records one change; a no-change save writes no row; a secret is never stored', async () => {
        const a = await app();
        const roomId = await createTestRoom('a', 'Room A');
        const auth = { Authorization: `Bearer ${roomAdminToken(roomId)}` };

        // Seed the stored settings.
        let res = await request(a).post(`/api/rooms/${roomId}/settings`).set(auth)
            .send({ ROOM_TIMEZONE: 'America/Chicago', THEME: 'neon', ISCORED_PASSWORD: 'hunter2' });
        expect(res.status).toBe(200);
        expect(await rows(`category = 'admin'`)).toHaveLength(1);

        // Save-all: every key sent (the secret as its mask), one actually changed.
        res = await request(a).post(`/api/rooms/${roomId}/settings`).set(auth).send({
            ROOM_TIMEZONE: 'America/New_York', THEME: 'neon', ISCORED_PASSWORD: maskFor('ISCORED_PASSWORD'),
        });
        expect(res.status).toBe(200);
        let admin = await rows(`category = 'admin'`);
        expect(admin).toHaveLength(2);
        expect(admin[1]).toMatchObject({ event_type: 'settings_change', game_room_id: roomId, actor_user_id: ADMIN_ID });
        expect(JSON.parse(admin[1]!.details).changes).toEqual([
            { key: 'ROOM_TIMEZONE', label: 'Room timezone', from: 'America/Chicago', to: 'America/New_York' },
        ]);
        expect(admin[1]!.summary).toBe('Changed 1 setting: Room timezone');

        // Nothing changed: no settings row and no generic middleware row either.
        res = await request(a).post(`/api/rooms/${roomId}/settings`).set(auth).send({
            ROOM_TIMEZONE: 'America/New_York', THEME: 'neon', ISCORED_PASSWORD: maskFor('ISCORED_PASSWORD'),
        });
        expect(res.status).toBe(200);
        expect(await rows(`category = 'admin'`)).toHaveLength(2);

        // A changed secret: "changed", never a value or ciphertext.
        res = await request(a).post(`/api/rooms/${roomId}/settings`).set(auth).send({ ISCORED_PASSWORD: 'correct horse' });
        expect(res.status).toBe(200);
        admin = await rows(`category = 'admin'`);
        expect(admin).toHaveLength(3);
        expect(JSON.parse(admin[2]!.details).changes).toEqual([{ key: 'ISCORED_PASSWORD', label: 'iScored password', secret: true }]);
        const everything = JSON.stringify(await rows());
        expect(everything).not.toMatch(/hunter2|correct horse|enc:v1:/);

        // The room admin reads a sentence and a change table.
        const read = await request(a).get(`/api/rooms/${roomId}/admin/activity?category=admin`).set(auth);
        expect(read.status).toBe(200);
        const tz = read.body.rows.find((r: any) => r.detail.changes?.[0]?.key === 'ROOM_TIMEZONE');
        expect(tz.summary).toBe('RoomAdmin changed 1 setting: Room timezone');
        expect(tz).not.toHaveProperty('details');
    });

    it('a tournament edit records only the fields that changed', async () => {
        const a = await app();
        const roomId = await createTestRoom('t', 'Room T');
        const db = await getDatabase();
        await db.run(`INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`, roomId);
        const tid = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Weekly Grind', 'WG', 'pinball', '{"cron":"0 0 * * 1"}', 1, ?, 'rotation')`,
            tid, roomId,
        );
        const auth = { Authorization: `Bearer ${roomAdminToken(roomId)}` };
        const body = { name: 'Weekly Grind', type: 'WG', format: 'rotation', cadence: { cron: '0 0 * * 1' }, platform_rules: NO_RULES };
        // First save normalises the stored row (defaults); then the real edit.
        expect((await request(a).put(`/api/rooms/${roomId}/tournaments/${tid}`).set(auth).send(body)).status).toBe(200);
        const baseline = (await rows(`event_type = 'tournament_updated'`)).length;

        expect((await request(a).put(`/api/rooms/${roomId}/tournaments/${tid}`).set(auth)
            .send({ ...body, max_active_games: 3 })).status).toBe(200);
        const edits = await rows(`event_type = 'tournament_updated'`);
        expect(edits).toHaveLength(baseline + 1);
        const last = edits[edits.length - 1]!;
        expect(last).toMatchObject({ game_room_id: roomId, tournament_id: tid, tournament_name: 'Weekly Grind', actor_user_id: ADMIN_ID });
        expect(JSON.parse(last.details).changes).toEqual([
            { key: 'max_active_games', label: 'Max active games', from: '1', to: '3' },
        ]);

        // The same edit again changes nothing: no row, generic or otherwise.
        const before = (await rows(`category = 'admin'`)).length;
        expect((await request(a).put(`/api/rooms/${roomId}/tournaments/${tid}`).set(auth)
            .send({ ...body, max_active_games: 3 })).status).toBe(200);
        expect(await rows(`category = 'admin'`)).toHaveLength(before);

        const read = await ActivityLogService.query({ roomId, eventType: 'tournament_updated' }, { superAdmin: false });
        expect(read.rows[0]!.summary).toBe('RoomAdmin changed 1 tournament setting on Weekly Grind: Max active games');
    });

    it('the global settings save records a room-less diff (super-admin only)', async () => {
        const a = await app();
        const auth = { Authorization: `Bearer ${superToken()}` };
        expect((await request(a).post('/api/admin/settings').set(auth).send({ BOT_TIMEZONE: 'UTC', OPDB_API_KEY: 'k-1' })).status).toBe(200);
        expect((await request(a).post('/api/admin/settings').set(auth).send({ BOT_TIMEZONE: 'America/Chicago', OPDB_API_KEY: 'k-1' })).status).toBe(200);
        const admin = await rows(`category = 'admin' AND event_type = 'settings_change'`);
        expect(admin).toHaveLength(2);
        expect(admin.every(r => r.game_room_id === null)).toBe(true);
        expect(JSON.parse(admin[1]!.details).changes).toEqual([
            { key: 'BOT_TIMEZONE', label: 'Server timezone', from: 'UTC', to: 'America/Chicago' },
        ]);
        expect(JSON.stringify(admin)).not.toContain('k-1');
        // No change: nothing.
        expect((await request(a).post('/api/admin/settings').set(auth).send({ BOT_TIMEZONE: 'America/Chicago' })).status).toBe(200);
        expect(await rows(`category = 'admin'`)).toHaveLength(2);
    });
});

describe('reading details', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('room admins get curated details only: no ids, IPs or tokens; the super-admin also gets the raw JSON', async () => {
        const roomId = await createTestRoom('r', 'Room R');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, device_model_name)
             VALUES ('dev-secret-1', ?, 'hash-abc', 'Legends Ultimate')`, USER,
        );
        await ActivityLogService.record({
            roomId, category: 'score', eventType: 'witness_attempt_refused', severity: 'problem', userId: USER,
            deviceId: 'dev-secret-1', tableName: 'Twilight Zone', source: 'vpx', score: 1234567,
            summary: 'Score 1,234,567 on Twilight Zone refused by Limited attempts',
            details: {
                reasons: ['Out of attempts'], playedAt: '2026-11-06T03:14:00.000Z', deviceType: 'desktop', verdict: 'clean',
                ip: '10.0.0.1', token: 'tok-xyz', tokenHash: 'h', otherRoomId: 'room-elsewhere',
            },
        });

        const room = await ActivityLogService.query({ roomId }, { superAdmin: false });
        const row = room.rows[0]!;
        expect(row).not.toHaveProperty('details');
        const facts = Object.fromEntries(row.detail.facts.map(f => [f.label, f.value]));
        expect(facts).toMatchObject({
            Score: '1,234,567', Table: 'Twilight Zone', Outcome: 'Refused by Limited attempts',
            Source: 'Witness / Castcade', 'Witness verdict': 'clean', 'Played at': '2026-11-06 03:14:00', Device: 'Castcade (PC)',
            'Device model': 'Legends Ultimate',
        });
        const json = JSON.stringify(room.rows);
        for (const secret of ['dev-secret-1', USER, '10.0.0.1', 'tok-xyz', 'hash-abc', 'room-elsewhere']) {
            expect(json).not.toContain(secret);
        }

        const sup = await ActivityLogService.query({ roomId }, { superAdmin: true });
        expect(sup.rows[0]!.details).toMatchObject({ ip: '10.0.0.1' });
        expect(sup.rows[0]!.detail.facts.length).toBeGreaterThan(0);
    });

    it('rows from before v2.228.0 read as sentences with the recorded setting names and a note', async () => {
        const roomId = await createTestRoom('p', 'Room P');
        const db = await getDatabase();
        const audit = await db.run(
            `INSERT INTO audit_log (actor, action, target_type, target_id, details, ip_address, correlation_id)
             VALUES (?, 'room.settings_update', 'room', ?, ?, '1.2.3.4', '')`,
            ADMIN_ID, roomId, JSON.stringify({ keys: ['ROOM_TIMEZONE', 'THEME', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'] }),
        );
        await db.run(
            `INSERT INTO activity_log (game_room_id, category, event_type, severity, actor_user_id, summary, details, dedupe_key)
             VALUES (?, 'admin', 'admin_action', 'info', ?, 'Admin action: room.settings_update', '{"backfilled":1}', ?)`,
            roomId, ADMIN_ID, `al:${audit.lastID}`,
        );
        await db.run(
            `INSERT INTO activity_log (game_room_id, category, event_type, severity, actor_user_id, summary, details)
             VALUES (?, 'admin', 'admin_action', 'info', ?, 'Admin action: season.poll_create', '{"backfilled":1}')`,
            roomId, ADMIN_ID,
        );
        await db.run(
            `INSERT INTO activity_log (game_room_id, category, event_type, severity, actor_user_id, summary, details)
             VALUES (?, 'admin', 'settings_change', 'info', ?, 'Settings changed: THEME', '{"keys":["THEME"]}')`,
            roomId, ADMIN_ID,
        );
        await db.run(
            `INSERT INTO activity_log (game_room_id, category, event_type, severity, actor_user_id, summary, details)
             VALUES (?, 'admin', 'admin_action', 'info', ?, 'Admin ran tournaments/:id/season/polls', '{"method":"POST","path":"tournaments/:id/season/polls","fields":["candidates"]}')`,
            roomId, ADMIN_ID,
        );
        await db.run(
            `INSERT INTO activity_log (game_room_id, category, event_type, severity, actor_user_id, summary, details)
             VALUES (?, 'admin', 'admin_action', 'info', ?, 'Admin action: some.new_thing', null)`,
            roomId, ADMIN_ID,
        );
        await db.run(
            `INSERT OR REPLACE INTO user_profiles (discord_user_id, display_name) VALUES (?, 'GamerDad89')`, ADMIN_ID,
        );

        const { rows: read } = await ActivityLogService.query({ roomId }, { superAdmin: false });
        const [unknown, generic, keysRow, poll, saveAll] = read;
        expect(saveAll!.summary).toBe('GamerDad89 saved 3 settings: Room timezone, Theme, Default announcement channel');
        expect(saveAll!.detail.recordedKeys).toEqual(['Room timezone', 'Theme', 'Default announcement channel']);
        expect(saveAll!.detail.notes!.join(' ')).toMatch(/Values weren't recorded before v2\.228\.0/);
        expect(saveAll!.detail.notes!.join(' ')).toMatch(/may include settings that did not change/);
        expect(JSON.stringify(saveAll)).not.toContain('1.2.3.4');
        expect(poll!.summary).toBe('GamerDad89 created a pick poll');
        expect(keysRow!.summary).toBe('GamerDad89 saved 1 setting: Theme');
        expect(keysRow!.detail.notes!.join(' ')).not.toMatch(/may include/);
        expect(generic!.summary).toBe('GamerDad89 created a pick poll');
        expect(unknown!.summary).toBe('GamerDad89 did "some new thing"');
    });
});
