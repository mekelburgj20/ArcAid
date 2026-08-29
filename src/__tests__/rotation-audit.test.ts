import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { TournamentEngine, queueSourceForPlace } from '../engine/TournamentEngine.js';
import {
    RotationAuditService,
    type RotationAuditEntry,
    type RotationEventType,
} from '../services/RotationAuditService.js';

// ---------------------------------------------------------------------------
// Rotation audit trail (v2.146.0, migration 170).
//
// Owner-asked after the 2026-08-27 WG-VR / WG-VPXS over-activation: "who or
// what picked what, and what triggered it" had to be reconstructed by grepping
// prod logs. These tests defend the three things that failure mode needs:
//
//   1. Every column actually lands. `RotationAuditService.log` swallows its own
//      errors by design (an audit write must never break a rotation), which is
//      exactly the "fan-out try/catch swallows column errors silently" trap in
//      CLAUDE.md — so a round trip over EVERY event type is the CI guard
//      against schema/column drift.
//   2. The maintenance cascade emits the interesting rows with the right
//      SOURCE and queue owner — the two facts the incident was missing.
//   3. The read path (auth, tournament filter, cursor pagination, ordering,
//      retention prune) behaves.
// ---------------------------------------------------------------------------

const PLAYER_A = '111111111111111111';
const PLAYER_B = '222222222222222222';
const ADMIN_DISCORD = '999999999999999999';

let roomCounter = 0;

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: ADMIN_DISCORD, username: 'RoomAdmin' } as never);

/** Top score attributed to a real player id, so the cascade resolves a winner. */
async function seedWinningScore(gameId: string, playerId: string, username: string, score = 99999) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        `${gameId}-${username.toLowerCase()}`, gameId, playerId, playerId, username, score,
        new Date().toISOString(),
    );
}

/**
 * A room + tournament wired for a real `runMaintenance` pass:
 * `ISCORED_ENABLED=false` short-circuits `getIScoredCredsForRoom`, so the run
 * never launches Playwright (same idiom as maintenance-stale-queue.test.ts).
 */
async function setupTournament(opts: { maxActive?: number; winnerPicks?: number } = {}) {
    const db = await getDatabase();
    const roomId = await createTestRoom(`rot-audit-${++roomCounter}`, 'Rotation Audit Room');
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: 'WG-VPXS' });
    await db.run(
        'UPDATE tournaments SET max_active_games = ?, winner_picks = ?, auto_pick = 0 WHERE id = ?',
        opts.maxActive ?? 1, opts.winnerPicks ?? 1, tournamentId,
    );
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

async function queuedGameFor(tournamentId: string, playerId: string, name: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, queue_order)
         VALUES (?, ?, ?, 'QUEUED', ?, 1)`,
        id, tournamentId, name, playerId,
    );
    return id;
}

async function rowsFor(roomId: string) {
    const db = await getDatabase();
    return db.all(
        'SELECT * FROM rotation_events WHERE game_room_id = ? ORDER BY id ASC',
        roomId,
    );
}

// ---------------------------------------------------------------------------
// 1. Column-drift guard — one row of EVERY event type, read back in full.
// ---------------------------------------------------------------------------

/**
 * Kept as a literal list rather than derived from the type: the point is that
 * ADDING an event type forces a deliberate edit here, and that every type has
 * at least one row that survived a real INSERT.
 */
const ALL_EVENT_TYPES: RotationEventType[] = [
    'winner_resolved',
    'disposition_applied',
    'pick_window_granted',
    'pick_window_cleared',
    'game_activated',
    'placeholder_created',
    'placeholder_deleted',
    'game_deactivated',
    'game_deleted',
    'cleanup_action',
    'timeout_pivot',
];

describe('RotationAuditService.log — round trip', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('writes and reads back every column, for every event type', async () => {
        const roomId = await createTestRoom('rot-roundtrip', 'Round Trip');
        const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });

        for (const eventType of ALL_EVENT_TYPES) {
            const entry: RotationAuditEntry = {
                gameRoomId: roomId,
                tournamentId,
                tournamentName: 'Daily Grind',
                eventType,
                actor: `player:${PLAYER_A}`,
                source: 'winner_queue',
                queueOwner: PLAYER_B,
                gameId: `game-${eventType}`,
                gameName: `Game for ${eventType}`,
                details: { marker: eventType, nested: { n: 1 }, list: ['a', 'b'] },
            };
            await RotationAuditService.log(entry);
        }
        await drainBackgroundTasks();

        const rows = await rowsFor(roomId);
        expect(rows).toHaveLength(ALL_EVENT_TYPES.length);

        for (const eventType of ALL_EVENT_TYPES) {
            const row = rows.find((r: any) => r.event_type === eventType);
            expect(row, `no row landed for ${eventType}`).toBeTruthy();
            // Every column, explicitly — this is the drift guard.
            expect(row.game_room_id).toBe(roomId);
            expect(row.tournament_id).toBe(tournamentId);
            expect(row.tournament_name).toBe('Daily Grind');
            expect(row.actor).toBe(`player:${PLAYER_A}`);
            expect(row.source).toBe('winner_queue');
            expect(row.queue_owner).toBe(PLAYER_B);
            expect(row.game_id).toBe(`game-${eventType}`);
            expect(row.game_name).toBe(`Game for ${eventType}`);
            expect(JSON.parse(row.details)).toEqual({ marker: eventType, nested: { n: 1 }, list: ['a', 'b'] });
            expect(row.created_at).toBeTruthy();
        }

        // …and the same rows survive the service's own read path with their
        // details parsed back into objects.
        const page = await RotationAuditService.list(roomId, { limit: 200 });
        expect(page.events).toHaveLength(ALL_EVENT_TYPES.length);
        expect(page.events.every(e => (e.details as any).marker === e.event_type)).toBe(true);
    });

    it('stores nullable columns as NULL rather than the string "null"', async () => {
        const roomId = await createTestRoom('rot-nulls', 'Nulls');
        await RotationAuditService.log({
            gameRoomId: roomId,
            eventType: 'cleanup_action',
            actor: 'system:cron',
        });
        await drainBackgroundTasks();

        const [row] = await rowsFor(roomId);
        expect(row.tournament_id).toBeNull();
        expect(row.tournament_name).toBeNull();
        expect(row.source).toBeNull();
        expect(row.queue_owner).toBeNull();
        expect(row.game_id).toBeNull();
        expect(row.game_name).toBeNull();
        expect(row.details).toBeNull();
        // A NULL blob still reads as an empty object, never a crash.
        const page = await RotationAuditService.list(roomId, {});
        expect(page.events[0].details).toEqual({});
    });

    it('never throws — a failed write is swallowed, not propagated', async () => {
        const roomId = await createTestRoom('rot-throws', 'Throws');
        const db = await getDatabase();
        const runSpy = vi.spyOn(db, 'run').mockRejectedValueOnce(new Error('disk on fire'));

        await expect(RotationAuditService.log({
            gameRoomId: roomId,
            eventType: 'game_activated',
            actor: 'system:cron',
            source: 'auto_pick',
        })).resolves.toBeUndefined();

        runSpy.mockRestore();
    });

    it('skips the write for a room-less decision (there is nowhere to show it)', async () => {
        const db = await getDatabase();
        await RotationAuditService.log({
            gameRoomId: null,
            eventType: 'game_activated',
            actor: 'system:cron',
            source: 'auto_pick',
        });
        await drainBackgroundTasks();
        const all = await db.all('SELECT * FROM rotation_events');
        expect(all).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 2. The maintenance cascade emits the interesting decisions.
// ---------------------------------------------------------------------------

describe('rotation audit — maintenance flow', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
        vi.restoreAllMocks();
    });

    it('records winner_resolved + game_activated from the winner\'s queue', async () => {
        const { roomId, tournamentId } = await setupTournament();
        const activeId = await createTestGame(tournamentId, { name: 'Bad Cats', status: 'ACTIVE' });
        await seedWinningScore(activeId, PLAYER_A, 'WinnerA', 500000);
        const queuedId = await queuedGameFor(tournamentId, PLAYER_A, 'Medieval Madness');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);
        await drainBackgroundTasks();

        const rows = await rowsFor(roomId);
        const byType = (t: string) => rows.filter((r: any) => r.event_type === t);

        const winner = byType('winner_resolved')[0];
        expect(winner).toBeTruthy();
        expect(winner.game_id).toBe(activeId);
        expect(JSON.parse(winner.details)).toMatchObject({
            winnerName: 'WinnerA', winnerId: PLAYER_A, score: 500000, resolved: true,
        });

        // The slot closing is its own decision.
        const closed = byType('game_deactivated')[0];
        expect(closed.game_id).toBe(activeId);
        expect(JSON.parse(closed.details).trigger).toBe('end_of_round');

        // The activation names the branch AND whose queue it consumed — the
        // two facts the 2026-08-27 incident could not answer.
        const activated = byType('game_activated');
        expect(activated).toHaveLength(1);
        expect(activated[0].game_id).toBe(queuedId);
        expect(activated[0].game_name).toBe('Medieval Madness');
        expect(activated[0].source).toBe('winner_queue');
        expect(activated[0].queue_owner).toBe(PLAYER_A);
        expect(activated[0].actor).toBe('system:cron');
        expect(activated[0].tournament_name).toBe('WG-VPXS');
        expect(JSON.parse(activated[0].details).replacedGame).toBe('Bad Cats');
    });

    it('records pick_window_granted + placeholder_created when the winner has nothing queued', async () => {
        const { roomId, tournamentId } = await setupTournament();
        const activeId = await createTestGame(tournamentId, { name: 'Blackbelt', status: 'ACTIVE' });
        await seedWinningScore(activeId, PLAYER_A, 'WinnerA', 42);

        await TournamentEngine.getInstance().runMaintenance(tournamentId);
        await drainBackgroundTasks();

        const rows = await rowsFor(roomId);
        const placeholder = rows.find((r: any) => r.event_type === 'placeholder_created');
        const window = rows.find((r: any) => r.event_type === 'pick_window_granted');

        expect(placeholder).toBeTruthy();
        expect(JSON.parse(placeholder.details)).toMatchObject({
            picker: PLAYER_A, pickerType: 'WINNER', wonGameId: activeId, wonGameName: 'Blackbelt',
        });

        expect(window).toBeTruthy();
        expect(window.actor).toBe('system:cron');
        const wd = JSON.parse(window.details);
        expect(wd.picker).toBe(PLAYER_A);
        expect(wd.pickerType).toBe('WINNER');
        expect(wd.windowMin).toBeGreaterThan(0);
        expect(typeof wd.deadline).toBe('string');

        // Nothing was activated — the slot is reserved, not filled.
        expect(rows.filter((r: any) => r.event_type === 'game_activated')).toHaveLength(0);
    });

    it('names the runner-up\'s queue when the cascade walks past the winner', async () => {
        const { roomId, tournamentId } = await setupTournament();
        const activeId = await createTestGame(tournamentId, { name: 'Xenon', status: 'ACTIVE' });
        await seedWinningScore(activeId, PLAYER_A, 'WinnerA', 900);
        await seedWinningScore(activeId, PLAYER_B, 'RunnerB', 100);
        // The winner forfeits, so the pick moves down a place — and the
        // runner-up already has something queued.
        const { PickDispositionService } = await import('../services/PickDispositionService.js');
        await PickDispositionService.set(tournamentId, PLAYER_A, 'forfeit');
        const queuedId = await queuedGameFor(tournamentId, PLAYER_B, 'Attack from Mars');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);
        await drainBackgroundTasks();

        const rows = await rowsFor(roomId);
        const disposition = rows.find((r: any) => r.event_type === 'disposition_applied');
        expect(disposition).toBeTruthy();
        expect(disposition.actor).toBe(`player:${PLAYER_A}`);
        expect(JSON.parse(disposition.details)).toMatchObject({ disposition: 'forfeit', placeIndex: 0 });

        const activated = rows.find((r: any) => r.event_type === 'game_activated');
        expect(activated.game_id).toBe(queuedId);
        expect(activated.source).toBe('runner_up_queue');
        expect(activated.queue_owner).toBe(PLAYER_B);
    });

    it('maps a finishing place to the activation source', () => {
        expect(queueSourceForPlace(0)).toBe('winner_queue');
        expect(queueSourceForPlace(1)).toBe('runner_up_queue');
        expect(queueSourceForPlace(2)).toBe('third_place_queue');
        expect(queueSourceForPlace(7)).toBe('third_place_queue');
    });
});

// ---------------------------------------------------------------------------
// 3. Read path — ordering, filtering, pagination, prune.
// ---------------------------------------------------------------------------

describe('RotationAuditService.list / prune', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    async function seedSequence(roomId: string, tournamentId: string | null, count: number) {
        const ids: number[] = [];
        for (let i = 0; i < count; i++) {
            await RotationAuditService.log({
                gameRoomId: roomId,
                tournamentId,
                eventType: 'game_activated',
                actor: 'system:cron',
                source: 'auto_pick',
                gameName: `Game ${i}`,
            });
        }
        await drainBackgroundTasks();
        const db = await getDatabase();
        const rows = await db.all('SELECT id FROM rotation_events WHERE game_room_id = ? ORDER BY id ASC', roomId);
        for (const r of rows) ids.push(r.id);
        return ids;
    }

    it('returns newest-first and never mixes in another room', async () => {
        const roomA = await createTestRoom('rot-list-a', 'A');
        const roomB = await createTestRoom('rot-list-b', 'B');
        await seedSequence(roomA, null, 3);
        await seedSequence(roomB, null, 2);

        const page = await RotationAuditService.list(roomA, {});
        expect(page.events).toHaveLength(3);
        expect(page.events.map(e => e.game_name)).toEqual(['Game 2', 'Game 1', 'Game 0']);
        expect(page.nextCursor).toBeNull();
    });

    it('filters by tournament', async () => {
        const roomId = await createTestRoom('rot-list-filter', 'Filter');
        const t1 = await createTestTournament(roomId, { name: 'T1' });
        const t2 = await createTestTournament(roomId, { name: 'T2' });
        await seedSequence(roomId, t1, 2);
        await seedSequence(roomId, t2, 3);

        expect((await RotationAuditService.list(roomId, { tournamentId: t1 })).events).toHaveLength(2);
        expect((await RotationAuditService.list(roomId, { tournamentId: t2 })).events).toHaveLength(3);
        expect((await RotationAuditService.list(roomId, {})).events).toHaveLength(5);
    });

    it('pages with the cursor even when every row shares a created_at second', async () => {
        const roomId = await createTestRoom('rot-list-page', 'Page');
        await seedSequence(roomId, null, 5);

        // `created_at` is a CURRENT_TIMESTAMP with second resolution, so these
        // five rows very likely share one value — which is exactly why the
        // cursor carries `id` as a tiebreak.
        const seen: string[] = [];
        let cursor: string | null | undefined = undefined;
        for (let guard = 0; guard < 10; guard++) {
            const page: { events: { game_name: string | null }[]; nextCursor: string | null } =
                await RotationAuditService.list(roomId, { before: cursor, limit: 2 });
            seen.push(...page.events.map(e => e.game_name!));
            cursor = page.nextCursor;
            if (!cursor) break;
        }

        expect(seen).toEqual(['Game 4', 'Game 3', 'Game 2', 'Game 1', 'Game 0']);
        expect(new Set(seen).size).toBe(5); // no row served twice
    });

    it('clamps limit to the documented maximum', async () => {
        const roomId = await createTestRoom('rot-list-clamp', 'Clamp');
        await seedSequence(roomId, null, 3);
        const page = await RotationAuditService.list(roomId, { limit: 100000 });
        expect(page.events).toHaveLength(3);
    });

    it('prune drops rows past the retention window and keeps the rest', async () => {
        const roomId = await createTestRoom('rot-prune', 'Prune');
        await seedSequence(roomId, null, 3);
        const db = await getDatabase();
        // Age the first row past a 180-day retention.
        const [oldest] = await db.all('SELECT id FROM rotation_events WHERE game_room_id = ? ORDER BY id ASC LIMIT 1', roomId);
        await db.run(
            "UPDATE rotation_events SET created_at = datetime('now', '-200 days') WHERE id = ?",
            oldest.id,
        );

        const deleted = await RotationAuditService.prune(180);
        expect(deleted).toBe(1);
        const rows = await rowsFor(roomId);
        expect(rows).toHaveLength(2);
        expect(rows.some((r: any) => r.id === oldest.id)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 4. GET /:roomId/admin/rotation-log
// ---------------------------------------------------------------------------

describe('GET /:roomId/admin/rotation-log', () => {
    beforeEach(async () => {
        await setupTestDb();
        vi.restoreAllMocks();
    });

    async function seed(roomId: string, tournamentId: string | null, count: number, namePrefix = 'Game') {
        for (let i = 0; i < count; i++) {
            await RotationAuditService.log({
                gameRoomId: roomId,
                tournamentId,
                eventType: 'game_activated',
                actor: 'system:cron',
                source: 'fill_loop',
                gameName: `${namePrefix} ${i}`,
            });
        }
        await drainBackgroundTasks();
    }

    it('requires authentication', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rot-api-auth', 'Auth');
        const res = await request(app).get(`/api/rooms/${roomId}/admin/rotation-log`);
        expect(res.status).toBe(401);
    });

    it('refuses a token scoped to a different room', async () => {
        const app = await createTestApp();
        const mine = await createTestRoom('rot-api-mine', 'Mine');
        const theirs = await createTestRoom('rot-api-theirs', 'Theirs');
        const res = await request(app)
            .get(`/api/rooms/${theirs}/admin/rotation-log`)
            .set('Authorization', `Bearer ${adminToken(mine)}`);
        expect(res.status).toBe(403);
    });

    it('returns the room\'s events newest-first with a null cursor on the last page', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rot-api-list', 'List');
        await seed(roomId, null, 3);

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/rotation-log`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        expect(res.status).toBe(200);
        expect(res.body.events.map((e: any) => e.game_name)).toEqual(['Game 2', 'Game 1', 'Game 0']);
        expect(res.body.events[0].source).toBe('fill_loop');
        expect(res.body.events[0].details).toEqual({});
        expect(res.body.nextCursor).toBeNull();
    });

    it('filters by tournamentId', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rot-api-filter', 'Filter');
        const t1 = await createTestTournament(roomId, { name: 'T1' });
        const t2 = await createTestTournament(roomId, { name: 'T2' });
        await seed(roomId, t1, 2, 'One');
        await seed(roomId, t2, 3, 'Two');

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/rotation-log?tournamentId=${t1}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);

        expect(res.status).toBe(200);
        expect(res.body.events).toHaveLength(2);
        expect(res.body.events.every((e: any) => e.tournament_id === t1)).toBe(true);
    });

    it('pages through with nextCursor', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rot-api-page', 'Page');
        await seed(roomId, null, 5);
        const token = adminToken(roomId);

        const first = await request(app)
            .get(`/api/rooms/${roomId}/admin/rotation-log?limit=2`)
            .set('Authorization', `Bearer ${token}`);
        expect(first.status).toBe(200);
        expect(first.body.events.map((e: any) => e.game_name)).toEqual(['Game 4', 'Game 3']);
        expect(first.body.nextCursor).toBeTruthy();

        const second = await request(app)
            .get(`/api/rooms/${roomId}/admin/rotation-log?limit=2&before=${encodeURIComponent(first.body.nextCursor)}`)
            .set('Authorization', `Bearer ${token}`);
        expect(second.body.events.map((e: any) => e.game_name)).toEqual(['Game 2', 'Game 1']);

        const third = await request(app)
            .get(`/api/rooms/${roomId}/admin/rotation-log?limit=2&before=${encodeURIComponent(second.body.nextCursor)}`)
            .set('Authorization', `Bearer ${token}`);
        expect(third.body.events.map((e: any) => e.game_name)).toEqual(['Game 0']);
        expect(third.body.nextCursor).toBeNull();
    });

    it('rejects an out-of-range limit', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rot-api-limit', 'Limit');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/rotation-log?limit=9999`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(res.status).toBe(400);
    });
});
