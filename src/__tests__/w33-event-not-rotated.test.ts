import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { Scheduler } from '../engine/Scheduler.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { EventScheduler } from '../engine/EventScheduler.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { resolveSubmissionGame } from '../services/SubmissionGameResolver.js';
import { WitnessService } from '../services/WitnessService.js';
import { VpxScoreIngestService } from '../services/VpxScoreIngestService.js';
import { TournamentService, TournamentFormatLockedError } from '../services/TournamentService.js';
import { repairEventCronAndLeftoverCards } from '../database/migrations/repairEventCronAndLeftoverCards.js';

/**
 * W33 / W34 (WWS 2026-10-23) — an event that carried a rotation cron.
 *
 * TWR Tournament #1 (format=event) was saved with cadence `0 12 * * *`; at noon
 * rotation maintenance completed its live round 13 h early and auto-picked a
 * non-round game, which then sat on the board looking live after the event
 * finished. Pinned here:
 *   1. events never get a maintenance cron, and maintenance never rotates one;
 *   2. a tournament's format cannot change on edit (owner ruling 2026-10-25);
 *   3. one open-card rule — a FINISHED event's leftover card is closed on the
 *      board, in the submit resolver, in witness ingest and designation, while
 *      a PAUSED rotation stays open everywhere (owner ruling 2026-10-25);
 *   4. finishing an event closes its leftover cards, and migration 190 repairs
 *      rows already in that state.
 */

const MINUTE = 60_000;
const NO_RULES = { engines: { required: [], excluded: [] }, devices: { required: [], excluded: [] } };

async function app() {
    const a = express();
    a.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    a.use('/api/rooms', roomsRouter);
    return a;
}

/** iScored OFF for the fixture room: the repo `.env` holds prod creds (see event-format.test.ts). */
async function disableIScored(roomId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
        roomId,
    );
}

async function insertTournament(roomId: string, opts: {
    format?: 'event' | 'rotation'; cadence: object; isActive?: 0 | 1; finishedAt?: string | null; name?: string;
}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, event_finished_at)
         VALUES (?, ?, 'DG', 'pinball', ?, ?, ?, ?, ?)`,
        id, opts.name ?? 'T', JSON.stringify(opts.cadence), opts.isActive ?? 1, roomId,
        opts.format ?? 'rotation', opts.finishedAt ?? null,
    );
    return id;
}

async function insertGame(roomId: string, tournamentId: string, name: string, status: string, roundNo: number | null = null) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, start_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, tournamentId, name, status, roomId, roundNo, new Date().toISOString(),
    );
    return id;
}

describe('W33 — an event never runs on a rotation cron', () => {
    let roomId: string;
    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom(`w33-${crypto.randomUUID().slice(0, 8)}`, 'W33');
        await disableIScored(roomId);
    });

    it('Scheduler registers no maintenance or cleanup task for an event, even one carrying a cron', async () => {
        const eventId = await insertTournament(roomId, { format: 'event', cadence: { cron: '0 12 * * *', timezone: 'America/Chicago' } });
        const rotationId = await insertTournament(roomId, { cadence: { cron: '0 12 * * *' } });
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET cleanup_rule = ? WHERE id IN (?, ?)`,
            JSON.stringify({ mode: 'scheduled', cron: '0 22 * * 3' }), eventId, rotationId,
        );

        const scheduler = Scheduler.getInstance();
        await scheduler.start();
        const tasks = (scheduler as unknown as { tasks: Map<string, unknown> }).tasks;
        expect(tasks.has(eventId)).toBe(false);
        expect(tasks.has(`__cleanup_${eventId}__`)).toBe(false);
        expect(tasks.has(rotationId)).toBe(true); // positive control
        expect(tasks.has(`__cleanup_${rotationId}__`)).toBe(true);
        scheduler.stop();
    });

    it('scheduleTournament refuses an event directly', () => {
        const scheduler = Scheduler.getInstance();
        const id = crypto.randomUUID();
        scheduler.scheduleTournament({
            id, name: 'E', type: 'DG', mode: 'pinball', format: 'event',
            cadence: { cron: '0 12 * * *' }, isActive: true,
        } as any);
        expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.has(id)).toBe(false);
        scheduler.stop();
    });

    it('runMaintenance on an event rotates nothing and records a skip', async () => {
        const eventId = await insertTournament(roomId, { format: 'event', cadence: { cron: '0 12 * * *' } });
        const roundId = await insertGame(roomId, eventId, 'TNA', 'ACTIVE', 1);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, queue_order, game_room_id) VALUES (?, ?, 'Should Not Activate', 'QUEUED', 1, ?)`,
            crypto.randomUUID(), eventId, roomId,
        );

        await TournamentEngine.getInstance().runMaintenance(eventId);

        expect(await db.get(`SELECT status FROM games WHERE id = ?`, roundId)).toMatchObject({ status: 'ACTIVE' });
        expect(await db.get(`SELECT COUNT(*) AS n FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, eventId)).toMatchObject({ n: 1 });
        const run = await db.get<{ outcome: string; summary: string }>(
            `SELECT outcome, summary FROM maintenance_runs WHERE tournament_id = ? ORDER BY rowid DESC LIMIT 1`, eventId,
        );
        expect(run).toMatchObject({ outcome: 'skipped' });
        expect(run!.summary).toMatch(/event/);
    });
});

describe('W33 — format is fixed once created (owner ruling 2026-10-25)', () => {
    let roomId: string;
    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom(`w33f-${crypto.randomUUID().slice(0, 8)}`, 'W33 Format');
        await disableIScored(roomId);
    });

    const token = (r: string) => signToken({ role: 'room_admin', gameRoomIds: [r] });

    it('refuses turning an event into a rotation (409 FORMAT_LOCKED) and writes nothing', async () => {
        const eventId = await insertTournament(roomId, { format: 'event', cadence: { timezone: 'America/Chicago' }, name: 'TWR Tournament #1' });
        const res = await request(await app()).put(`/api/rooms/${roomId}/tournaments/${eventId}`)
            .set('Authorization', `Bearer ${token(roomId)}`)
            .send({ name: 'TWR Tournament #1', type: 'DG', format: 'rotation', cadence: { cron: '0 12 * * *', timezone: 'America/Chicago' }, platform_rules: NO_RULES });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FORMAT_LOCKED');
        const db = await getDatabase();
        const row = await db.get<{ cadence: string; format: string }>(`SELECT cadence, format FROM tournaments WHERE id = ?`, eventId);
        expect(row!.format).toBe('event');
        expect(JSON.parse(row!.cadence).cron).toBeUndefined();
    });

    it('refuses turning a rotation into an event (409) and creates no rounds', async () => {
        const rotationId = await insertTournament(roomId, { cadence: { cron: '0 0 * * *' } });
        const start = Date.now() + 60 * MINUTE;
        const res = await request(await app()).put(`/api/rooms/${roomId}/tournaments/${rotationId}`)
            .set('Authorization', `Bearer ${token(roomId)}`)
            .send({
                name: 'T', type: 'DG', format: 'event', cadence: { timezone: 'UTC' }, platform_rules: NO_RULES,
                event: { rounds: [{ roundNo: 1, gameName: 'TNA', scheduledStartAt: new Date(start).toISOString(), scheduledEndAt: new Date(start + 30 * MINUTE).toISOString() }] },
            });
        expect(res.status).toBe(409);
        const db = await getDatabase();
        expect(await db.get(`SELECT format FROM tournaments WHERE id = ?`, rotationId)).toMatchObject({ format: 'rotation' });
        expect(await db.get(`SELECT COUNT(*) AS n FROM games WHERE tournament_id = ?`, rotationId)).toMatchObject({ n: 0 });
    });

    it('a same-format edit still saves (positive control)', async () => {
        const rotationId = await insertTournament(roomId, { cadence: { cron: '0 0 * * *' } });
        const res = await request(await app()).put(`/api/rooms/${roomId}/tournaments/${rotationId}`)
            .set('Authorization', `Bearer ${token(roomId)}`)
            .send({ name: 'Renamed', type: 'DG', format: 'rotation', cadence: { cron: '0 6 * * *' }, platform_rules: NO_RULES });
        expect(res.status).toBe(200);
        const db = await getDatabase();
        expect(await db.get(`SELECT name FROM tournaments WHERE id = ?`, rotationId)).toMatchObject({ name: 'Renamed' });
    });

    it('the service strips a cron from an event cadence for a caller that skips the HTTP schema', async () => {
        const eventId = await insertTournament(roomId, { format: 'event', cadence: { timezone: 'UTC' } });
        await TournamentService.update(eventId, { name: 'E', type: 'DG', cadence: { cron: '0 12 * * *', timezone: 'UTC' } });
        const db = await getDatabase();
        const row = await db.get<{ cadence: string }>(`SELECT cadence FROM tournaments WHERE id = ?`, eventId);
        expect(JSON.parse(row!.cadence)).toEqual({ timezone: 'UTC' });
        await expect(TournamentService.update(eventId, { name: 'E', type: 'DG', format: 'rotation', cadence: { cron: '0 12 * * *' } }))
            .rejects.toBeInstanceOf(TournamentFormatLockedError);
    });
});

describe('W33 — one open-card rule: finished closes, paused stays open', () => {
    let roomId: string;
    let finishedEventId: string;
    let strayId: string;
    let pausedRotationId: string;
    let pausedGameId: string;
    const USER = 'u-w33-player';

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom(`w33o-${crypto.randomUUID().slice(0, 8)}`, 'W33 Open');
        await disableIScored(roomId);
        finishedEventId = await insertTournament(roomId, {
            format: 'event', cadence: { timezone: 'UTC' }, isActive: 0, finishedAt: new Date().toISOString(), name: 'TWR Tournament #1',
        });
        await insertGame(roomId, finishedEventId, 'TNA', 'COMPLETED', 1);
        strayId = await insertGame(roomId, finishedEventId, "JP's Pokemon Pinball", 'ACTIVE');
        pausedRotationId = await insertTournament(roomId, { cadence: { cron: '0 0 * * *' }, isActive: 0, name: 'Paused Grind' });
        pausedGameId = await insertGame(roomId, pausedRotationId, 'Medieval Madness', 'ACTIVE');
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
    });

    it('board: the finished event\'s leftover card is gone, the paused rotation\'s card is live', async () => {
        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        const ids = boards.map(b => b.gameId);
        expect(ids).not.toContain(strayId);
        expect(ids).toContain(pausedGameId);
    });

    it('submit resolver: the leftover card resolves as COMPLETED (no tournament stamp); the paused card stays ACTIVE', async () => {
        expect(await resolveSubmissionGame({ roomId, gameName: "JP's Pokemon Pinball", gameId: strayId }))
            .toMatchObject({ id: strayId, status: 'COMPLETED' });
        expect(await resolveSubmissionGame({ roomId, gameName: "JP's Pokemon Pinball", gameId: null }))
            .toMatchObject({ id: strayId, status: 'COMPLETED' });
        expect(await resolveSubmissionGame({ roomId, gameName: 'Medieval Madness', gameId: null }))
            .toMatchObject({ id: pausedGameId, status: 'ACTIVE', tournament_id: pausedRotationId });
    });

    it('witness candidates: the paused rotation game is in, the finished event is out', async () => {
        const rows = await (VpxScoreIngestService as unknown as { loadCandidates(u: string): Promise<Array<{ id: string }>> }).loadCandidates(USER);
        const ids = rows.map(r => r.id);
        expect(ids).toContain(pausedGameId);
        expect(ids).not.toContain(strayId);
    });

    it('device designation: a finished event reads as absent, a paused rotation holds', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, target_room_id, target_tournament_id) VALUES ('dev-fin', ?, 'h', ?, ?)`,
            USER, roomId, finishedEventId,
        );
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, target_room_id, target_tournament_id) VALUES ('dev-pause', ?, 'h', ?, ?)`,
            USER, roomId, pausedRotationId,
        );
        expect(await WitnessService.getDeviceTarget('dev-fin')).toMatchObject({ roomId, tournamentId: null });
        expect(await WitnessService.getDeviceTarget('dev-pause')).toMatchObject({ roomId, tournamentId: pausedRotationId });
    });
});

describe('W33 — finishing an event closes its leftover cards', () => {
    it('the finish step completes a non-round ACTIVE game along with the event', async () => {
        await setupTestDb();
        const roomId = await createTestRoom(`w33e-${crypto.randomUUID().slice(0, 8)}`, 'W33 Finish');
        await disableIScored(roomId);
        const eventId = await insertTournament(roomId, { format: 'event', cadence: { timezone: 'UTC' } });
        const db = await getDatabase();
        const ended = new Date(Date.now() - 30 * MINUTE).toISOString();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at, start_date, end_date)
             VALUES (?, ?, 'TNA', 'COMPLETED', ?, 1, ?, ?, ?, ?)`,
            crypto.randomUUID(), eventId, roomId, new Date(Date.now() - 90 * MINUTE).toISOString(), ended,
            new Date(Date.now() - 90 * MINUTE).toISOString(), ended,
        );
        const strayId = await insertGame(roomId, eventId, "JP's Pokemon Pinball", 'ACTIVE');

        await EventScheduler.getInstance().tick(new Date());

        expect(await db.get(`SELECT event_finished_at IS NOT NULL AS done, is_active FROM tournaments WHERE id = ?`, eventId))
            .toMatchObject({ done: 1, is_active: 0 });
        expect(await db.get(`SELECT status FROM games WHERE id = ?`, strayId)).toMatchObject({ status: 'COMPLETED' });
    });
});

describe('W34 — migration 190 repairs rows already broken', () => {
    it('strips an event cron, keeps the zone, closes a finished event\'s ACTIVE game, and is idempotent', async () => {
        await setupTestDb();
        const roomId = await createTestRoom(`w34-${crypto.randomUUID().slice(0, 8)}`, 'W34');
        const finishedAt = '2026-10-25T23:00:00.000Z';
        const brokenEvent = await insertTournament(roomId, {
            format: 'event', cadence: { cron: '0 12 * * *', autoRotate: true, timezone: 'America/Chicago' },
            isActive: 0, finishedAt,
        });
        const stray = await insertGame(roomId, brokenEvent, "JP's Pokemon Pinball", 'ACTIVE');
        const rotation = await insertTournament(roomId, { cadence: { cron: '0 12 * * *' } });
        const rotationGame = await insertGame(roomId, rotation, 'Medieval Madness', 'ACTIVE');
        const liveEvent = await insertTournament(roomId, { format: 'event', cadence: { timezone: 'UTC' } });
        const liveRound = await insertGame(roomId, liveEvent, 'TNA', 'ACTIVE', 1);

        const db = await getDatabase();
        expect(await repairEventCronAndLeftoverCards(db)).toEqual({ cronsRemoved: 1, cardsClosed: 1 });

        const ev = await db.get<{ cadence: string }>(`SELECT cadence FROM tournaments WHERE id = ?`, brokenEvent);
        expect(JSON.parse(ev!.cadence)).toEqual({ autoRotate: true, timezone: 'America/Chicago' });
        expect(await db.get(`SELECT status, end_date FROM games WHERE id = ?`, stray)).toMatchObject({ status: 'COMPLETED' });
        // Untouched: a rotation's cron, a rotation's live game, a running event's live round.
        const rot = await db.get<{ cadence: string }>(`SELECT cadence FROM tournaments WHERE id = ?`, rotation);
        expect(JSON.parse(rot!.cadence).cron).toBe('0 12 * * *');
        expect(await db.get(`SELECT status FROM games WHERE id = ?`, rotationGame)).toMatchObject({ status: 'ACTIVE' });
        expect(await db.get(`SELECT status FROM games WHERE id = ?`, liveRound)).toMatchObject({ status: 'ACTIVE' });

        expect(await repairEventCronAndLeftoverCards(db)).toEqual({ cronsRemoved: 0, cardsClosed: 0 });
    });
});
