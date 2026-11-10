import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';
import { signToken } from '../api/auth.js';
import { ActivityLogService, zonedDayStartUtc } from '../services/ActivityLogService.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';
import { backfillActivityLog } from '../database/migrations/activityLogBackfill.js';
import { adminPathLabel } from '../api/activityAdminMiddleware.js';

/**
 * G14 (v2.227.0, ADR 0037) - the room activity log.
 *
 *   1. `record` lands every column, never throws, counts its failures.
 *   2. `query` is room-scoped, hides raw ids from room admins, and filters by
 *      player (alias + display name), keyword, problems-only, date, category.
 *   3. Write points: a landed score, a refused typed score (problem row), a
 *      no_match Witness play (room-less), a device routed to another room.
 *   4. Prune at 90 days; the backfill is idempotent and keeps no_match room-less.
 */

const USER = '123456789012345678';
const OTHER = '223456789012345678';

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const roomAdminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: '999999999999999999', username: 'RoomAdmin' } as never);

async function rows(where = '1=1', ...params: unknown[]) {
    await drainBackgroundTasks();
    const db = await getDatabase();
    return db.all<Array<Record<string, any>>>(`SELECT * FROM activity_log WHERE ${where} ORDER BY id`, ...params);
}

async function addMember(roomId: string, userId: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, userId, roomId);
}

async function createGame(roomId: string, opts: { maxAttempts?: number | null; name?: string } = {}) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, max_attempts)
         VALUES (?, 'Weekly Grind', 'WG', 'pinball', '{}', 1, ?, 'rotation', ?)`,
        tournamentId, roomId, opts.maxAttempts ?? null,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, opts.name ?? 'Twilight Zone', roomId, new Date(Date.now() - 3600_000).toISOString(),
    );
    return { tournamentId, gameId };
}

describe('ActivityLogService.record / query', () => {
    beforeEach(async () => {
        await setupTestDb();
        ActivityLogService._resetFailuresForTests();
    });

    it('lands every column and derives the room + names from the game', async () => {
        const roomId = await createTestRoom('a', 'Room A');
        const { tournamentId, gameId } = await createGame(roomId);
        await ActivityLogService.record({
            category: 'score', eventType: 'score_landed', userId: USER, playerAlias: 'Krobs',
            gameId, source: 'tournament', score: 1234, summary: 'Score 1,234 landed',
            details: { a: 1 }, dedupeKey: 'k1',
        });
        await ActivityLogService.record({ category: 'score', eventType: 'x', summary: 'dup', dedupeKey: 'k1' });
        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({
            game_room_id: roomId, tournament_id: tournamentId, tournament_name: 'Weekly Grind',
            game_name: 'Twilight Zone', canonical_user_id: USER, player_alias: 'Krobs', severity: 'info',
            score: 1234, source: 'tournament',
        });
    });

    it('never throws; a failed write is counted', async () => {
        const db = await getDatabase();
        await db.exec('DROP TABLE activity_log');
        await expect(ActivityLogService.record({ category: 'server', eventType: 'x', summary: 'y' })).resolves.toBeUndefined();
        expect(ActivityLogService.writeFailureStats().count).toBe(1);
    });

    it('is room-scoped and hides raw ids from a room admin', async () => {
        const a = await createTestRoom('a', 'Room A');
        const b = await createTestRoom('b', 'Room B');
        await ActivityLogService.record({ roomId: a, category: 'device', eventType: 'device_checkin', userId: USER, deviceId: 'dev-1', summary: 'in A' });
        await ActivityLogService.record({ roomId: b, category: 'device', eventType: 'device_checkin', userId: USER, deviceId: 'dev-1', summary: 'in B' });
        await ActivityLogService.record({ roomId: null, category: 'server', eventType: 'x', summary: 'room-less' });

        const room = await ActivityLogService.query({ roomId: a }, { superAdmin: false });
        expect(room.rows.map(r => r.summary)).toEqual(['in A']);
        expect(room.rows[0]).not.toHaveProperty('canonical_user_id');
        expect(room.rows[0]).not.toHaveProperty('device_id');
        expect(room.rows[0]).not.toHaveProperty('details');
        expect(room.rows[0]!.device).toBe('Witness cabinet');
        expect(JSON.stringify(room.rows)).not.toContain(USER);

        const all = await ActivityLogService.query({}, { superAdmin: true });
        expect(all.rows).toHaveLength(3);
        expect(all.rows.find(r => r.summary === 'in A')!.device_id).toBe('dev-1');
        const roomless = await ActivityLogService.query({ roomless: true }, { superAdmin: true });
        expect(roomless.rows.map(r => r.summary)).toEqual(['room-less']);
    });

    it('filters by player (alias + display name), keyword, problems, category, date and paginates', async () => {
        const roomId = await createTestRoom();
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Krobs')`, USER);
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, 'KROBSTER')`, USER);
        await ActivityLogService.record({ roomId, category: 'score', eventType: 'a', userId: USER, summary: 'Score on Twilight Zone' });
        await ActivityLogService.record({ roomId, category: 'device', eventType: 'b', userId: OTHER, severity: 'problem', summary: 'Device stopped' });
        await ActivityLogService.record({ roomId, category: 'score', eventType: 'c', playerAlias: 'krobster', summary: 'synced', createdAt: '2020-01-01 12:00:00' });

        const by = async (f: Record<string, unknown>) =>
            (await ActivityLogService.query({ roomId, ...f }, { superAdmin: false })).rows.map(r => r.event_type);
        expect(await by({ player: 'krobs' })).toEqual(['c', 'a']);
        expect(await by({ player: 'krobster' })).toEqual(['c', 'a']);
        expect(await by({ keyword: 'twilight' })).toEqual(['a']);
        expect(await by({ problemsOnly: true })).toEqual(['b']);
        expect(await by({ categories: ['device'] })).toEqual(['b']);
        expect(await by({ from: '2019-12-31', to: '2020-01-01', timezone: 'America/Chicago' })).toEqual(['c']);
        const labelled = (await ActivityLogService.query({ roomId, eventType: 'a' }, { superAdmin: false })).rows[0]!;
        expect(labelled.player).toBe('Krobs');

        const page1 = await ActivityLogService.query({ roomId, limit: 2 }, { superAdmin: false });
        expect(page1.rows).toHaveLength(2);
        const page2 = await ActivityLogService.query({ roomId, limit: 2, before: page1.nextBefore! }, { superAdmin: false });
        expect(page2.rows).toHaveLength(1);
        expect(page2.nextBefore).toBeNull();
    });

    it('super-admin date filter reads each row in its own room timezone (room-less: the server zone)', async () => {
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        const nz = await createTestRoom('nz', 'Auckland Room');
        await GameRoomSettingsService.set(nz, 'ROOM_TIMEZONE', 'Pacific/Auckland');
        const plain = await createTestRoom('plain', 'Plain Room');
        // 2026-07-01 20:00 UTC = Jul 2 08:00 in Auckland, Jul 1 15:00 in Chicago.
        const at = '2026-07-01 20:00:00';
        await ActivityLogService.record({ roomId: nz, category: 'server', eventType: 'nz', summary: 'nz', createdAt: at });
        await ActivityLogService.record({ roomId: plain, category: 'server', eventType: 'plain', summary: 'plain', createdAt: at });
        await ActivityLogService.record({ roomId: null, category: 'server', eventType: 'none', summary: 'none', createdAt: at });
        const types = async (day: string) => (await ActivityLogService.query(
            { from: day, to: day, timezone: 'America/Chicago' }, { superAdmin: true },
        )).rows.map(r => r.event_type).sort();
        expect(await types('2026-07-02')).toEqual(['nz']);
        expect(await types('2026-07-01')).toEqual(['none', 'plain']);
    });

    it('exports CSV with formula-safe cells', async () => {
        const roomId = await createTestRoom();
        await ActivityLogService.record({ roomId, category: 'admin', eventType: 'x', summary: '=HYPERLINK("bad")' });
        const csv = await ActivityLogService.exportCsv({ roomId }, { superAdmin: false });
        expect(csv.split('\r\n')[0]).toMatch(/^time,timezone,category/);
        expect(csv).toContain(`"'=HYPERLINK(""bad"")"`);
    });

    it('prunes rows older than 90 days', async () => {
        await ActivityLogService.record({ category: 'server', eventType: 'old', summary: 'old', createdAt: '2000-01-01 00:00:00' });
        await ActivityLogService.record({ category: 'server', eventType: 'new', summary: 'new' });
        await drainBackgroundTasks();
        expect(await ActivityLogService.prune()).toBe(1);
        expect((await rows()).map(r => r.event_type)).toEqual(['new']);
    });

    it('zonedDayStartUtc reads a day in the given zone', () => {
        expect(zonedDayStartUtc('2026-07-01', 'America/Chicago')).toBe('2026-07-01 05:00:00');
        expect(zonedDayStartUtc('2026-01-01', 'America/Chicago', 1)).toBe('2026-01-02 06:00:00');
        expect(zonedDayStartUtc('nope', 'UTC')).toBeNull();
    });

    it('labels an admin path without ids', () => {
        expect(adminPathLabel('/api/rooms/2b1c6f0e-1111-2222-3333-444455556666/admin/tournaments/2b1c6f0e-1111-2222-3333-444455556666/games?x=1'))
            .toBe('tournaments/:id/games');
    });
});

describe('write points', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('a landed typed score is a score row; a vpx landing is left to the ingest trail', async () => {
        const roomId = await createTestRoom();
        await ScoreHistoryService.log({ gameName: 'Twilight Zone', gameRoomId: roomId, username: 'Krobs', discordUserId: USER, score: 500, source: 'tournament' });
        await ScoreHistoryService.log({ gameName: 'Twilight Zone', gameRoomId: roomId, username: 'Krobs', discordUserId: USER, score: 700, source: 'vpx' });
        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ event_type: 'score_landed', game_room_id: roomId, canonical_user_id: USER, score: 500 });
    });

    it('a typed score refused by Limited attempts writes a problem row on the room', async () => {
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        const roomId = await createTestRoom();
        await addMember(roomId, USER);
        const { tournamentId } = await createGame(roomId, { maxAttempts: 3 });
        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent('Twilight Zone')}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ score: 1000, engine: 'vpx', device: 'pc' });
        expect(res.status).toBe(409);
        const refused = await rows(`event_type = 'score_refused'`);
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({
            game_room_id: roomId, severity: 'problem', canonical_user_id: USER, tournament_id: tournamentId,
            tournament_name: 'Weekly Grind', score: 1000,
        });
        expect(refused[0]!.summary).toContain('limited attempts');

        // ...and it reads through the room admin API with no raw ids.
        const api = await request(app).get(`/api/rooms/${roomId}/admin/activity?problems=1`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`);
        expect(api.status).toBe(200);
        expect(api.body.rows).toHaveLength(1);
        expect(JSON.stringify(api.body)).not.toContain(USER);
        const csv = await request(app).get(`/api/rooms/${roomId}/admin/activity.csv`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`);
        expect(csv.status).toBe(200);
        expect(csv.text).toContain('score_refused');
        // Another room's admin cannot read it.
        const other = await createTestRoom('other', 'Other');
        const denied = await request(app).get(`/api/rooms/${roomId}/admin/activity`)
            .set('Authorization', `Bearer ${roomAdminToken(other)}`);
        expect(denied.status).toBe(403);
    });

    it('a no_match Witness play is a room-less problem row', async () => {
        const { VpxScoreIngestService } = await import('../services/VpxScoreIngestService.js');
        const roomId = await createTestRoom();
        await addMember(roomId, USER);
        await createGame(roomId, { name: 'Bad Cats' });
        const now = Math.floor(Date.now() / 1000);
        const result = await VpxScoreIngestService.ingest({
            canonicalUserId: USER, tableName: 'Some Table Nobody Has', score: 4242,
            startedTs: now - 300, endedTs: now, deviceId: 'dev-1',
            target: { roomId: null, tournamentId: null, globalFallback: false },
        });
        expect(result.status).toBe('no_match');
        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ game_room_id: null, severity: 'problem', event_type: 'witness_no_match', score: 4242 });
        expect((await ActivityLogService.query({ roomId }, { superAdmin: false })).rows).toHaveLength(0);
    });

    it('a device routed to another room writes nothing to this room', async () => {
        const db = await getDatabase();
        const mine = await createTestRoom('mine', 'Mine');
        const other = await createTestRoom('other', 'Other');
        await addMember(mine, USER);
        await addMember(other, USER);
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, target_room_id) VALUES ('dev-1', ?, 'h', ?)`,
            USER, other,
        );
        await ActivityLogService.recordForDevice('dev-1', USER, { category: 'device', eventType: 'device_checkin', summary: 'Device checked in' });
        expect((await rows()).map(r => r.game_room_id)).toEqual([other]);

        // "All my rooms": one row per member room.
        await db.run(`UPDATE witness_devices SET target_room_id = NULL WHERE atgames_unique_id = 'dev-1'`);
        await ActivityLogService.recordForDevice('dev-1', USER, { category: 'device', eventType: 'device_online', summary: 'online' });
        const online = await rows(`event_type = 'device_online'`);
        expect(online.map(r => r.game_room_id).sort()).toEqual([mine, other].sort());
    });

    it('the device sweep logs an offline transition once and a launch with no score', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        await addMember(roomId, USER);
        const now = Math.floor(Date.now() / 1000);
        const sql = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, heartbeat_at) VALUES ('dev-1', ?, 'h', ?)`,
            USER, sql(now - 900),
        );
        // One session with a score, one without, one too short.
        await db.run(`INSERT INTO witness_observations (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, kind)
                      VALUES ('dev-1', ?, 'Scored', ?, ?, 1200, 'session'), ('dev-1', ?, 'Twilight Zone', ?, ?, 2280, 'session'),
                             ('dev-1', ?, 'Blink', ?, ?, 20, 'session')`,
            USER, now - 7000, now - 5800, USER, now - 4000, now - 1720, USER, now - 1000, now - 980);
        await db.run(`INSERT INTO witness_evidence (device_id, canonical_user_id, outcome, table_name, score, played_at)
                      VALUES ('dev-1', ?, 'ingested', 'Scored', 100, ?)`, USER, sql(now - 5800));

        expect(await ActivityLogService.sweepDevices(now)).toEqual({ offline: 1, noScore: 1 });
        expect(await ActivityLogService.sweepDevices(now)).toEqual({ offline: 0, noScore: 0 });
        // Nothing was open in the room, so going offline is NOT a problem (owner ruling 2026-11-07).
        const problems = await rows(`severity = 'problem'`);
        expect(problems.map(r => r.event_type)).toEqual(['device_no_score']);
        expect(problems[0]!.game_room_id).toBe(roomId);
        expect(problems[0]!.summary).toContain('Twilight Zone');
        expect((await rows(`event_type = 'device_offline'`)).map(r => r.severity)).toEqual(['info']);
    });

    it('offline is a problem only in the routed room where an event round or a limited tournament was open', async () => {
        const db = await getDatabase();
        const quiet = await createTestRoom('quiet', 'Quiet');
        const live = await createTestRoom('live', 'Live');
        const limited = await createTestRoom('limited', 'Limited');
        for (const r of [quiet, live, limited]) await addMember(r, USER);
        // An open event round in "live".
        const eventId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Friday Event', 'EV', 'pinball', '{}', 1, ?, 'event')`, eventId, live,
        );
        await db.run(`INSERT INTO games (id, tournament_id, name, status, game_room_id) VALUES (?, ?, 'Round 1', 'ACTIVE', ?)`,
            crypto.randomUUID(), eventId, live);
        // An open game in a Limited-attempts tournament in "limited".
        await createGame(limited, { maxAttempts: 3 });
        const now = Math.floor(Date.now() / 1000);
        const stale = new Date((now - 900) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, heartbeat_at) VALUES ('dev-1', ?, 'h', ?)`,
            USER, stale,
        );
        await ActivityLogService.sweepDevices(now);
        const offline = await rows(`event_type = 'device_offline'`);
        const sev = Object.fromEntries(offline.map(r => [r.game_room_id, r.severity]));
        expect(sev).toEqual({ [quiet]: 'info', [live]: 'problem', [limited]: 'problem' });

        // Checked in to an unfinished event (no round open yet) also counts.
        expect(await ActivityLogService.deviceMatteredInRoom(quiet, USER, null)).toBe(false);
        const upcoming = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Next Event', 'EV', 'pinball', '{}', 1, ?, 'event')`, upcoming, quiet,
        );
        await db.run(`INSERT INTO tournament_participants (tournament_id, user_id, checked_in_at) VALUES (?, ?, datetime('now'))`, upcoming, USER);
        expect(await ActivityLogService.deviceMatteredInRoom(quiet, USER, null)).toBe(true);
        // A device pinned to another tournament: that event does not count.
        expect(await ActivityLogService.deviceMatteredInRoom(quiet, USER, 'some-other-tournament')).toBe(false);
    });

    it('a repeated Witness play writes no row (duplicate outcomes are not logged)', async () => {
        const { VpxScoreIngestService } = await import('../services/VpxScoreIngestService.js');
        const roomId = await createTestRoom();
        await addMember(roomId, USER);
        await createGame(roomId, { name: 'Bad Cats' });
        const now = Math.floor(Date.now() / 1000);
        const play = {
            canonicalUserId: USER, tableName: 'Bad Cats', score: 4242,
            startedTs: now - 300, endedTs: now, deviceId: 'dev-1',
            target: { roomId: null, tournamentId: null, globalFallback: false },
        };
        expect((await VpxScoreIngestService.ingest({ ...play })).status).toBe('ingested');
        await VpxScoreIngestService.ingest({ ...play });
        const all = await rows();
        expect(all.map(r => r.event_type)).toEqual(['witness_ingested']);
    });

    it('admin writes: allowlisted route -> one admin row; a handler row replaces it; a player submit is never an admin row', async () => {
        const { activityAdminLog } = await import('../api/activityAdminMiddleware.js');
        const app = express();
        app.use(express.json());
        app.use('/api/rooms/:roomId', activityAdminLog);
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        const roomId = await createTestRoom();
        await addMember(roomId, USER);
        await createGame(roomId);
        const admin = { Authorization: `Bearer ${roomAdminToken(roomId)}` };

        // Outside /admin, allowlisted, behind requireRoomAccess -> a generic admin row.
        const ann = await request(app).post(`/api/rooms/${roomId}/lobby/announcements`).set(admin).send({ title: 'Hi' });
        expect(ann.status).toBe(201);
        let adminRows = await rows(`category = 'admin'`);
        expect(adminRows).toHaveLength(1);
        expect(adminRows[0]).toMatchObject({ event_type: 'admin_action', game_room_id: roomId, actor_user_id: '999999999999999999' });
        expect(adminRows[0]!.summary).toBe('Admin ran lobby/announcements');

        // The settings handler records its own row (forwarder) -> no generic duplicate.
        const set = await request(app).post(`/api/rooms/${roomId}/settings`).set(admin).send({ ROOM_TIMEZONE: 'America/Chicago' });
        expect(set.status).toBe(200);
        adminRows = await rows(`category = 'admin'`);
        expect(adminRows.map(r => r.event_type)).toEqual(['admin_action', 'settings_change']);
        expect(adminRows[1]!.actor_user_id).toBe('999999999999999999');

        // A player's score submission: a score row, never an admin row.
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, 'Twilight Zone', 'pinball', ?, 'approved')`,
            crypto.randomUUID(), JSON.stringify(['real']),
        );
        const sub = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent('Twilight Zone')}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ score: 1000, engine: 'real', device: 'real_cabinet' });
        expect(sub.status).toBeLessThan(300);
        expect((await rows(`category = 'admin'`))).toHaveLength(2);
        expect((await rows(`event_type = 'score_landed'`))).toHaveLength(1);
    });
});

describe('room_events retirement (migrations 209 -> 210)', () => {
    it('a fresh DB never has room_events and has run both migrations', async () => {
        await setupTestDb();
        const db = await getDatabase();
        expect(await db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room_events'`)).toBeUndefined();
        expect(await db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_log'`)).toBeTruthy();
        const names = (await db.all<Array<{ name: string }>>(
            `SELECT name FROM schema_migrations WHERE name IN ('209_activity_log', '210_drop_room_events') ORDER BY id`,
        )).map(r => r.name);
        expect(names).toEqual(['209_activity_log', '210_drop_room_events']);
    });

    it('an upgraded DB copies room_events into activity_log BEFORE the table is dropped', async () => {
        const os = await import('os');
        const fs = await import('fs');
        const path = await import('path');
        const { _resetForTesting, initDatabase } = await import('../database/database.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcaid-g14-'));
        const file = path.join(dir, 'upgrade.db');
        const before = process.env.DB_PATH;
        try {
            await _resetForTesting();
            process.env.DB_PATH = file;
            let db = await initDatabase();
            // Make it look like a pre-v2.227.0 database: room_events with a row, 209/210 not applied.
            const roomId = await createTestRoom('old', 'Old Room');
            await db.exec(`
                DROP TABLE activity_log;
                DELETE FROM schema_migrations WHERE name IN ('209_activity_log', '210_drop_room_events');
                CREATE TABLE room_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, game_room_id TEXT NOT NULL, event_type TEXT NOT NULL,
                    event_data TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
                );
            `);
            await db.run(`INSERT INTO room_events (game_room_id, event_type, event_data) VALUES (?, 'admin_login', ?)`,
                roomId, JSON.stringify({ username: 'host' }));
            await _resetForTesting();

            db = await initDatabase();
            expect(await db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room_events'`)).toBeUndefined();
            const copied = await db.all<Array<{ event_type: string; game_room_id: string; dedupe_key: string }>>(
                `SELECT event_type, game_room_id, dedupe_key FROM activity_log WHERE dedupe_key LIKE 'rev:%'`,
            );
            expect(copied).toEqual([{ event_type: 'admin_login', game_room_id: roomId, dedupe_key: 'rev:1' }]);
        } finally {
            await _resetForTesting();
            process.env.DB_PATH = before;
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
        }
    });
});

describe('backfill (migration 209)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('fills from score_history and witness_evidence, idempotently, with no_match room-less', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source, submitted_by_user_id)
             VALUES ('Twilight Zone', ?, 'Krobs', ?, 900, 'sync', ?)`,
            roomId, USER, USER,
        );
        await db.run(
            `INSERT INTO witness_evidence (device_id, canonical_user_id, outcome, game_room_id, table_name, score, played_at, reasons)
             VALUES ('dev-1', ?, 'no_match', ?, 'Mystery', 5, datetime('now'), '["no open game"]')`,
            USER, roomId,
        );
        // A duplicate outcome is never copied (owner ruling 2026-11-07).
        await db.run(
            `INSERT INTO witness_evidence (device_id, canonical_user_id, outcome, game_room_id, table_name, score, played_at)
             VALUES ('dev-1', ?, 'duplicate', ?, 'Mystery', 5, datetime('now')), ('dev-1', ?, 'global_duplicate', NULL, 'Mystery', 5, datetime('now'))`,
            USER, roomId, USER,
        );
        await db.run(`DELETE FROM activity_log`);
        const first = await backfillActivityLog(db);
        const second = await backfillActivityLog(db);
        expect(first).toBe(2);
        expect(second).toBe(0);
        const all = await rows();
        const landed = all.find(r => r.event_type === 'score_landed')!;
        expect(landed).toMatchObject({ game_room_id: roomId, canonical_user_id: USER, dedupe_key: expect.stringMatching(/^sh:/) });
        const nm = all.find(r => r.event_type === 'witness_no_match')!;
        expect(nm).toMatchObject({ game_room_id: null, severity: 'problem' });
        expect(JSON.parse(nm.details).reasons).toEqual(['no open game']);
    });
});

/**
 * A42 (v2.239.0, owner 2026-11-10) - round timing is the tournament runner's,
 * so it left the public event page and the Discord results post and lives on
 * the activity row: a score that LANDED on an event round says how long after
 * the round opened it landed. Read-time, from the round's scheduled start.
 */
describe('round timing on score rows (A42)', () => {
    beforeEach(async () => {
        await setupTestDb();
        ActivityLogService._resetFailuresForTests();
    });

    async function createRound(roomId: string, startIso: string) {
        const db = await getDatabase();
        const tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'ATGAMES_TEST_3', 'EV', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
            tournamentId, roomId,
        );
        const gameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Aerobatics', 'ACTIVE', ?, ?, 1, ?, ?)`,
            gameId, tournamentId, roomId, startIso, startIso,
            new Date(Date.parse(startIso) + 2 * 86_400_000).toISOString(),
        );
        return { tournamentId, gameId };
    }

    it('times an AtGames landing from the round start, in the row and the details panel', async () => {
        const roomId = await createTestRoom('a42', 'Arcaid Witness Demo');
        const { tournamentId, gameId } = await createRound(roomId, '2026-11-07T18:00:00.000Z');
        await ScoreHistoryService.log({
            gameName: 'Aerobatics', gameRoomId: roomId, gameId, tournamentId,
            username: 'Chalatalove', discordUserId: 'atgames:777', score: 3_206_800, source: 'atgames',
            createdAt: '2026-11-08 10:25:54',
        });
        await drainBackgroundTasks();

        const { rows: page } = await ActivityLogService.query({ roomId }, { superAdmin: false });
        const landed = page.find(r => r.event_type === 'score_landed')!;
        expect(landed.round_time).toBe('16h 25m into round 1');
        expect(landed.detail.facts).toEqual(expect.arrayContaining([
            { label: 'Round', value: 'Round 1' },
            { label: 'Round opened', value: '2026-11-07 18:00:00', time: true },
            { label: 'Into the round', value: '16h 25m 54s' },
        ]));

        const csv = await ActivityLogService.exportCsv({ roomId }, { superAdmin: false });
        expect(csv.split('\r\n')[0]).toContain(',score,round_time,summary,');
        expect(csv).toContain('16h 25m into round 1');
    });

    it("times a Witness landing from its playedAt, not the trail row's write time", async () => {
        const roomId = await createTestRoom('a42w', 'Room W');
        const { gameId } = await createRound(roomId, '2026-11-07T18:00:00.000Z');
        await ActivityLogService.record({
            roomId, category: 'score', eventType: 'witness_ingested', userId: USER, gameId,
            source: 'vpx', score: 50_000, summary: 'Score 50,000 landed on Aerobatics',
            details: { playedAt: '2026-11-07 18:04:12', reasons: [] },
        });
        await drainBackgroundTasks();
        const { rows: page } = await ActivityLogService.query({ roomId }, { superAdmin: false });
        expect(page[0]!.round_time).toBe('4m 12s into round 1');
    });

    it('leaves rotation scores and non-landing rows on a round untimed', async () => {
        const roomId = await createTestRoom('a42n', 'Room N');
        const rotation = await createGame(roomId);
        const { gameId } = await createRound(roomId, '2026-11-07T18:00:00.000Z');
        await ActivityLogService.record({
            category: 'score', eventType: 'score_landed', userId: USER, gameId: rotation.gameId,
            source: 'tournament', score: 10, summary: 'Score 10 landed',
        });
        await ActivityLogService.record({
            roomId, category: 'score', eventType: 'score_deleted', userId: USER, gameId,
            source: 'atgames', score: 20, summary: 'Score 20 deleted',
        });
        await drainBackgroundTasks();
        const { rows: page } = await ActivityLogService.query({ roomId }, { superAdmin: false });
        expect(page).toHaveLength(2);
        for (const r of page) {
            expect(r.round_time).toBeNull();
            expect(r.detail.facts.map(f => f.label)).not.toContain('Into the round');
        }
    });
});
