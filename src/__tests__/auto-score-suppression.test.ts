import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';
import { GlobalScoreService } from '../services/GlobalScoreService.js';
import { VpxScoreIngestService } from '../services/VpxScoreIngestService.js';
import { AutoScoreSuppressionService, toPlayedAt } from '../services/AutoScoreSuppressionService.js';
import { AtGamesPrivateClient } from '../services/AtGamesPrivateClient.js';
import type { AtGamesPrivateTournamentDetail } from '../services/AtGamesPrivateClient.js';
import { AtGamesEventSyncService } from '../services/AtGamesEventSyncService.js';

/**
 * v2.156.0 (ADR 0024) — players may delete their own AUTO-POSTED scores, and
 * the decision survives the next replay.
 *
 * Owner ruling 2026-09-28: "Players should have the option to delete their own
 * auto-posted scores and we need a mechanism that persists this decision in
 * case the same score tries to auto post again (for the same game/date/time)."
 *
 * What these tests pin:
 *   1. A deleted cabinet play stays deleted on EVERY board — the room it was
 *      deleted from, and the Global Scoreboard it would fall through to once
 *      the table rotates off the card.
 *   2. The tombstone is the PLAY: a different time, or a different player, is
 *      a different play and lands normally.
 *   3. The AtGames preview and the real pull agree about a deleted play.
 *   4. Typed scores keep exactly the delete behaviour they had.
 */

const USER = '123456789012345678';
const OTHER = '876543210987654321';
const DEVICE = 'fp-device-uuid-suppress';
const MINUTE = 60_000;

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const adminToken = (roomId: string, discordId = 'admin-1') =>
    signToken({ role: 'room_admin', discordId, username: 'Admin', gameRoomIds: [roomId] });

// The rooms router is large; its first import can outlast the 10s hook
// timeout on a cold run, so warm both routers once up front.
beforeAll(async () => {
    await import('../api/routes/rooms.js');
    await import('../api/routes/global.js');
}, 60_000);

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    app.use('/api', globalRouter);
    return app;
}

async function pairDevice(app: express.Express) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: DEVICE, username: 'CabinetOwner' });
    return pairRes.body.token as string;
}

async function addMember(roomId: string, userId = USER) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`,
        userId, roomId,
    );
}

async function createRotationGame(roomId: string, name: string) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Weekly VPXS', 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

async function seedCatalogue(name: string, manufacturer: string | null = null, year: number | null = null) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, status)
         VALUES (?, ?, 'pinball', ?, ?, 'approved')`,
        id, name, manufacturer, year,
    );
    return id;
}

/** One fixed play — the replay must present exactly these fields again. */
const ENDED = Math.floor(Date.now() / 1000) - 120;
function scoreQuery(overrides: Record<string, unknown> = {}) {
    return {
        table: 'Bad Cats (Williams 1989)',
        rom: 'bcats_l5',
        slug: 'vpx-badcats',
        score: 8366650,
        started: ENDED - 300,
        ended: ENDED,
        dur: 300,
        reason: 'game_over',
        ...overrides,
    };
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
    const db = await getDatabase();
    const row = await db.get<{ n: number }>(sql, ...params);
    return row?.n ?? 0;
}

describe('auto-posted VPX scores — delete, then replay', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;
    let gameId: string;
    let tournamentId: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairDevice(app);
        await addMember(roomId);
        ({ gameId, tournamentId } = await createRotationGame(roomId, 'Bad Cats'));
        const { WitnessService } = await import('../services/WitnessService.js');
        await WitnessService.setDeviceTarget(USER, DEVICE, { roomId, tournamentId: null });
        // Catalogue row, so the first ingest fans out to Global and the replay
        // has a Global destination it must also be kept off.
        await seedCatalogue('Bad Cats', 'Williams', 1989);
    });

    async function ingestOnce(overrides: Record<string, unknown> = {}) {
        return request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery(overrides) });
    }

    async function vpxRow() {
        const db = await getDatabase();
        return db.get<{ id: number; created_at: string; submitted_by_user_id: string }>(
            `SELECT id, created_at, submitted_by_user_id FROM score_history WHERE source = 'vpx' ORDER BY id DESC LIMIT 1`,
        );
    }

    it('lets the owner delete their own vpx row, and refuses the same play when the cabinet replays it', async () => {
        const first = await ingestOnce();
        expect(first.body).toMatchObject({ ok: true, status: 'ingested' });
        const row = await vpxRow();
        expect(row!.submitted_by_user_id).toBe(USER);
        expect(await count(`SELECT COUNT(*) AS n FROM global_scores WHERE deleted_at IS NULL`)).toBe(1);

        const del = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${row!.id}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(del.status).toBe(200);

        expect(await count(`SELECT COUNT(*) AS n FROM score_history WHERE source = 'vpx'`)).toBe(0);
        const db = await getDatabase();
        const tomb = await db.all(`SELECT * FROM auto_score_suppressions`);
        expect(tomb).toHaveLength(1);
        expect(tomb[0]).toMatchObject({
            source: 'vpx', owner_key: USER, game_key: normalizeGameName('Bad Cats'),
            score: 8366650, played_at: row!.created_at, deleted_by_user_id: USER,
        });
        // The fan-out went with the row (existing cascade) — and did NOT add a
        // second, time-unknown tombstone on top of the exact one.
        expect(await count(`SELECT COUNT(*) AS n FROM global_scores WHERE deleted_at IS NULL`)).toBe(0);
        // Auto-posted scores are never pushed to iScored: no iScored tombstone.
        expect(await count(`SELECT COUNT(*) AS n FROM deleted_score_suppressions`)).toBe(0);

        await db.run(`DELETE FROM witness_observations`);
        const replay = await ingestOnce();
        // The cabinet's contract knows 'duplicate'; no new status on the wire.
        expect(replay.body).toMatchObject({ ok: true, status: 'duplicate' });
        expect(await count(`SELECT COUNT(*) AS n FROM score_history`)).toBe(0);
        expect(await count(`SELECT COUNT(*) AS n FROM global_scores WHERE deleted_at IS NULL`)).toBe(0);
        expect(await count(`SELECT COUNT(*) AS n FROM global_scores`)).toBe(1);
        expect(await count(`SELECT COUNT(*) AS n FROM witness_observations`)).toBe(0);
    });

    it('lands the same score at a DIFFERENT time normally — that is a different play', async () => {
        await ingestOnce();
        const row = await vpxRow();
        await ScoreHistoryService.deleteEvent((await ScoreHistoryService.getDeletableRow(row!.id))!, USER);

        const later = await ingestOnce({ started: ENDED + 60, ended: ENDED + 400 });
        expect(later.body).toMatchObject({ status: 'ingested' });
        expect(await count(`SELECT COUNT(*) AS n FROM score_history WHERE source = 'vpx'`)).toBe(1);
    });

    it('keeps a deleted play off the Global Scoreboard once the table has rotated off the card', async () => {
        await ingestOnce();
        const row = await vpxRow();
        await ScoreHistoryService.deleteEvent((await ScoreHistoryService.getDeletableRow(row!.id))!, USER);

        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id = ?`, gameId);
        await db.run(`UPDATE tournaments SET is_active = 0 WHERE id = ?`, tournamentId);

        const replay = await ingestOnce();
        expect(replay.body.status).toBe('duplicate');
        expect(await count(`SELECT COUNT(*) AS n FROM global_scores WHERE deleted_at IS NULL`)).toBe(0);
    });

    it('does not touch a different player who posted the same score at the same time', async () => {
        await ingestOnce();
        const row = await vpxRow();
        await ScoreHistoryService.deleteEvent((await ScoreHistoryService.getDeletableRow(row!.id))!, USER);

        await addMember(roomId, OTHER);
        const q = scoreQuery();
        const result = await VpxScoreIngestService.ingest({
            canonicalUserId: OTHER,
            target: { roomId, tournamentId: null, globalFallback: true },
            tableName: q.table, rom: q.rom, slug: q.slug, score: q.score,
            startedTs: q.started, endedTs: q.ended, durationSec: q.dur, reason: q.reason,
        });
        expect(result.status).toBe('ingested');
    });

    it('refuses a non-owner player, and keeps an unlinked row admin-only', async () => {
        await ingestOnce();
        const row = await vpxRow();

        const stranger = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${row!.id}`)
            .set('Authorization', `Bearer ${playerToken(OTHER)}`);
        expect(stranger.status).toBe(403);

        // An unlinked AtGames row belongs to nobody an Arcaid login can prove.
        const unlinkedId = await ScoreHistoryService.log({
            gameName: 'Bad Cats', gameRoomId: roomId, gameId, username: 'CabHero',
            discordUserId: 'atgames:50177', score: 4200, source: 'atgames',
            tournamentId, platform: 'atgames', engine: 'vpx', device: 'atgames',
            createdAt: '2026-09-01 20:10:00',
        });
        expect(unlinkedId).not.toBeNull();

        const asPlayer = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${unlinkedId}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(asPlayer.status).toBe(403);

        const asAdmin = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${unlinkedId}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(asAdmin.status).toBe(200);
        const db = await getDatabase();
        const tomb = await db.get(`SELECT * FROM auto_score_suppressions WHERE source = 'atgames'`);
        expect(tomb).toMatchObject({ owner_key: 'atgames:50177', score: 4200, played_at: '2026-09-01 20:10:00' });
    });

    it('suppresses a replay of the ORIGINAL value after a correction', async () => {
        await ingestOnce();
        const row = await vpxRow();
        await ScoreHistoryService.correctScore((await ScoreHistoryService.getDeletableRow(row!.id))!, 836665, USER);

        const replay = await ingestOnce();
        expect(replay.body.status).toBe('duplicate');
        const db = await getDatabase();
        const scores = await db.all<Array<{ score: number }>>(`SELECT score FROM score_history WHERE source = 'vpx'`);
        expect(scores.map(s => s.score)).toEqual([836665]);
    });

    it('tombstones every auto-posted row the admin "wipe player from game" sweep removes', async () => {
        await ingestOnce();
        const row = await vpxRow();
        const db = await getDatabase();
        const hist = await db.get<{ iscored_username: string }>(
            `SELECT iscored_username FROM score_history WHERE id = ?`, row!.id,
        );
        await createTestSubmission(gameId, { username: hist!.iscored_username, discordUserId: USER, score: 8366650 });
        const submissionId = `${gameId}-${hist!.iscored_username.toLowerCase()}`;

        const wipe = await request(app)
            .delete(`/api/rooms/${roomId}/admin/games/${gameId}/submissions/${encodeURIComponent(submissionId)}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(wipe.status).toBe(200);
        expect(await count(`SELECT COUNT(*) AS n FROM auto_score_suppressions`)).toBe(1);

        const replay = await ingestOnce();
        expect(replay.body.status).toBe('duplicate');
        expect(await count(`SELECT COUNT(*) AS n FROM score_history`)).toBe(0);
    });
});

describe('auto-posted VPX scores on the Global Scoreboard', () => {
    let app: express.Express;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        token = await pairDevice(app);
        await seedCatalogue('Bad Cats', 'Williams', 1989);
    });

    it('writes cabinet leftovers with source vpx, suppresses a replay after delete, and lets one land again after an admin restore', async () => {
        const first = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        expect(first.body.status).toBe('global');
        const db = await getDatabase();
        const global = await db.get<{ id: string; source: string }>(`SELECT id, source FROM global_scores`);
        expect(global!.source).toBe('vpx');

        const del = await request(app)
            .delete(`/api/me/global-scores/${global!.id}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(del.status).toBe(200);
        const tomb = await db.get(`SELECT * FROM auto_score_suppressions`);
        // `submitted_at` is the INGEST time, so the play time is unknown.
        expect(tomb).toMatchObject({ source: 'vpx', owner_key: USER, played_at: null, score: 8366650 });

        const replay = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        expect(replay.body.status).toBe('duplicate');
        expect(await count(`SELECT COUNT(*) AS n FROM global_scores`)).toBe(1);

        expect(await GlobalScoreService.restore(global!.id)).toBe(true);
        expect(await count(`SELECT COUNT(*) AS n FROM auto_score_suppressions`)).toBe(0);

        // Not suppressed any more — it reaches the Global dedup, which sees the
        // restored row.
        const again = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        expect(again.body.status).toBe('global_duplicate');

        // And with the restored row gone again via a hard delete, the play
        // stays suppressed (hardDelete tombstones too).
        expect(await GlobalScoreService.hardDelete(global!.id, 'admin-1')).toBe(true);
        const afterHard = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        expect(afterHard.body.status).toBe('duplicate');
        expect(await count(`SELECT COUNT(*) AS n FROM global_scores`)).toBe(0);
    });
});

describe('auto-posted AtGames scores — preview and pull agree about a deleted play', () => {
    let roomId: string;
    let tournamentId: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');
    const ATGAMES_GAME_ID = 50334;
    const atgamesTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19) + '.0';

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        for (const [key, value] of [['ATGAMES_EMAIL', 'owner@example.com'], ['ATGAMES_PASSWORD', 'pw'], ['ATGAMES_DEVICE_FP', 'fp']]) {
            await db.run(
                `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                roomId, key, value,
            );
        }
        await db.run(
            `INSERT INTO global_games (id, name, normalized_name, type, atgames_id, status, platforms, features)
             VALUES (?, 'Attack from Mars', ?, 'pinball', ?, 'approved', '["atgames_native"]', '[]')`,
            crypto.randomUUID(), normalizeGameName('Attack from Mars'), ATGAMES_GAME_ID,
        );
        tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, end_grace_sec, atgames_tournament_id)
             VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 60, '1170')`,
            tournamentId, roomId,
        );
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Attack from Mars', 'SCHEDULED', ?, 1, ?, ?)`,
            crypto.randomUUID(), tournamentId, roomId,
            new Date(base).toISOString(), new Date(base + 20 * MINUTE).toISOString(),
        );
        vi.spyOn(AtGamesPrivateClient.prototype, 'getPrivateTournament').mockResolvedValue({
            id: 1170, name: 'Stream Night',
            games: [{
                game_id: ATGAMES_GAME_ID,
                rankings: [
                    { account: 11, user_name: 'Wyo', game_id: ATGAMES_GAME_ID, score: '1200000', created_at: atgamesTime(base + 5 * MINUTE) },
                ],
            }],
        } as AtGamesPrivateTournamentDetail);
    });

    afterEach(() => vi.restoreAllMocks());

    it('reports the deleted play as already-had in BOTH the preview and the real pull', async () => {
        const first = await AtGamesEventSyncService.syncTournament(tournamentId);
        expect(first.ingested).toBe(1);

        const db = await getDatabase();
        const row = await db.get<{ id: number }>(`SELECT id FROM score_history WHERE source = 'atgames'`);
        await ScoreHistoryService.deleteEvent((await ScoreHistoryService.getDeletableRow(row!.id))!, 'admin-1');
        expect(await count(`SELECT COUNT(*) AS n FROM deleted_score_suppressions`)).toBe(0);

        const preview = await AtGamesEventSyncService.syncTournament(tournamentId, { dryRun: true });
        const real = await AtGamesEventSyncService.syncTournament(tournamentId);

        expect(preview.ingested).toBe(0);
        expect(preview.duplicates).toBe(1);
        expect(real.ingested).toBe(preview.ingested);
        expect(real.duplicates).toBe(preview.duplicates);
        expect(await count(`SELECT COUNT(*) AS n FROM score_history WHERE source = 'atgames'`)).toBe(0);
    });
});

describe('typed scores — delete behaviour unchanged', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
    });

    it('still writes the iScored tombstone and no auto-score tombstone', async () => {
        const { gameId, tournamentId } = await createRotationGame(roomId, 'Whirlwind');
        for (const source of ['tournament', 'community', 'sync'] as const) {
            const id = await ScoreHistoryService.log({
                gameName: 'Whirlwind', gameRoomId: roomId, gameId,
                username: `P-${source}`, discordUserId: USER, score: 5000, source, tournamentId,
            });
            const del = await request(app)
                .delete(`/api/rooms/${roomId}/score-history/${id}`)
                .set('Authorization', `Bearer ${playerToken(USER)}`);
            expect(del.status).toBe(200);
        }
        expect(await count(`SELECT COUNT(*) AS n FROM deleted_score_suppressions WHERE game_id = ?`, gameId)).toBe(3);
        expect(await count(`SELECT COUNT(*) AS n FROM auto_score_suppressions`)).toBe(0);
    });
});

describe('AutoScoreSuppressionService — the one predicate', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('matches any supplied name, and a time-unknown tombstone matches every time', async () => {
        await AutoScoreSuppressionService.record({
            source: 'vpx', ownerKey: USER, gameName: 'Bad Cats', score: 100, playedAt: '2026-09-01 20:10:00',
        });
        await AutoScoreSuppressionService.record({
            source: 'vpx', ownerKey: USER, gameName: 'Bad Cats', score: 100, playedAt: '2026-09-01 20:10:00',
        });
        expect(await count(`SELECT COUNT(*) AS n FROM auto_score_suppressions`)).toBe(1);

        const check = (playedAt: string | null, names = ['bcats_l5', 'Bad Cats (Williams 1989)']) =>
            AutoScoreSuppressionService.isSuppressed({ source: 'vpx', ownerKey: USER, gameNames: names, score: 100, playedAt });
        expect(await check('2026-09-01 20:10:00')).toBe(true);
        expect(await check('2026-09-01T20:10:00.000Z')).toBe(true);
        expect(await check('2026-09-01 20:10:01')).toBe(false);
        expect(await check('2026-09-01 20:10:00', ['Medieval Madness'])).toBe(false);
        expect(await AutoScoreSuppressionService.isSuppressed({
            source: 'atgames', ownerKey: USER, gameNames: ['Bad Cats'], score: 100, playedAt: '2026-09-01 20:10:00',
        })).toBe(false);

        await AutoScoreSuppressionService.record({
            source: 'vpx', ownerKey: USER, gameName: 'Bad Cats', score: 200, playedAt: null,
        });
        expect(await AutoScoreSuppressionService.isSuppressed({
            source: 'vpx', ownerKey: USER, gameNames: ['Bad Cats'], score: 200, playedAt: '2030-01-01 00:00:00',
        })).toBe(true);
    });

    it('never answers for a typed source', async () => {
        await AutoScoreSuppressionService.record({
            source: 'vpx', ownerKey: USER, gameName: 'Bad Cats', score: 100, playedAt: null,
        });
        expect(await AutoScoreSuppressionService.isSuppressed({
            source: 'tournament', ownerKey: USER, gameNames: ['Bad Cats'], score: 100, playedAt: null,
        })).toBe(false);
        expect(toPlayedAt('not a time')).toBeNull();
    });
});
