import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { repairAmbiguousSubmissionGames } from '../database/migrations/repairAmbiguousSubmissionGames.js';

/**
 * v2.155.1 — the ambiguous-active-games bug.
 *
 * Production incident: a room can have TWO ACTIVE `games` rows with the same
 * name in two different tournaments (Weekly Grind - VR's "Black Rose" since
 * 09-03, Daily Grind's "Black Rose" picked 09-06). The submit routes'
 * `submissions` upsert and `ScoreHistoryService.log`'s tournament auto-resolve
 * each ran their OWN name lookup with different (or no) `ORDER BY`, so a
 * single submit could stamp `submissions` with ONE tournament and
 * `score_history` with the OTHER — leaving the score on neither leaderboard
 * (each board reads `score_history` filtered by ITS tournament id) and never
 * invalidating the card that actually needed it.
 *
 * `SubmissionGameResolver.resolveSubmissionGame` is now the ONE lookup both
 * paths share: an explicit `gameId` wins when it matches; otherwise the
 * EARLIEST-`start_date` ACTIVE row wins (mirroring the real incident, where
 * the long-running Weekly Grind - VR game should have won over the
 * just-picked Daily Grind game, which a `created_at DESC` rule wrongly
 * preferred).
 */

vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return { ...actual, logWarn: vi.fn() };
});
import { logWarn } from '../utils/logger.js';

// Minimal valid PNG signature — passes isAllowedImage's magic-byte check.
const VALID_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
]);

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function playerToken(discordId: string, username: string, roomId: string) {
    return signToken({ role: 'player', gameRoomIds: [roomId], discordId, username });
}

async function seedCatalogueGame(gameName: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status)
         VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, gameName, JSON.stringify(['real']),
    );
    return id;
}

/**
 * Two tournaments in one room, each with an ACTIVE game named `gameName`.
 * Mirrors the production incident: the long-running tournament's game has
 * the EARLIER `start_date`; the just-picked tournament's game has a LATER
 * `start_date` (even though it may be created after, or in test setup here,
 * regardless of insertion order — the resolver never looks at created_at
 * except as a tie-break).
 */
async function seedAmbiguousFixture(roomId: string, gameName: string) {
    const longRunningTournamentId = await createTestTournament(roomId, { name: 'Weekly Grind - VR' });
    const justPickedTournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });

    // Later-start-date game inserted FIRST, so a naive `created_at DESC` rule
    // (the pre-fix behavior) would prefer the OTHER (earlier-start) game,
    // proving the fix isn't accidentally still keying off insertion order.
    const justPickedGameId = await createTestGame(justPickedTournamentId, {
        name: gameName, status: 'ACTIVE', startDate: '2026-09-06T03:00:00.000Z',
    });
    const longRunningGameId = await createTestGame(longRunningTournamentId, {
        name: gameName, status: 'ACTIVE', startDate: '2026-09-03T00:00:00.000Z',
    });

    return { longRunningTournamentId, longRunningGameId, justPickedTournamentId, justPickedGameId };
}

beforeEach(() => {
    vi.mocked(logWarn).mockClear();
});

describe('ambiguous ACTIVE games with the same name — submit-score', () => {
    it('an explicit gameId wins even when it is NOT the earliest-start-date game', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ambig-submit-1', 'Ambig Submit 1');
        const gameName = 'Black Rose';
        await seedCatalogueGame(gameName);
        const fixture = await seedAmbiguousFixture(roomId, gameName);

        const token = playerToken('ambig-player-1', 'AmbigPlayer1', roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '5000')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .field('gameId', fixture.justPickedGameId);

        expect(res.status).toBe(201);

        const db = await getDatabase();
        const submissionId = `${fixture.justPickedGameId}-ambigplayer1`;
        const submission = await db.get(`SELECT game_id, score FROM submissions WHERE id = ?`, submissionId);
        expect(submission).toBeTruthy();
        expect(submission.game_id).toBe(fixture.justPickedGameId);

        const history = await db.get(
            `SELECT submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 5000`,
            roomId, gameName,
        );
        expect(history.submitted_during_tournament_id).toBe(fixture.justPickedTournamentId);

        const rankings = await LeaderboardService.getForGame(fixture.justPickedGameId);
        expect(rankings.some(r => r.score === 5000)).toBe(true);
    });

    it('with no gameId, the earliest-start-date ACTIVE game wins on both tables and a WARN is logged', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ambig-submit-2', 'Ambig Submit 2');
        const gameName = 'Black Rose';
        await seedCatalogueGame(gameName);
        const fixture = await seedAmbiguousFixture(roomId, gameName);

        const token = playerToken('ambig-player-2', 'AmbigPlayer2', roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '6000')
            .field('engine', 'real')
            .field('device', 'real_cabinet');

        expect(res.status).toBe(201);

        const db = await getDatabase();
        const submissionId = `${fixture.longRunningGameId}-ambigplayer2`;
        const submission = await db.get(`SELECT game_id FROM submissions WHERE id = ?`, submissionId);
        expect(submission).toBeTruthy();
        expect(submission.game_id).toBe(fixture.longRunningGameId);

        const history = await db.get(
            `SELECT submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 6000`,
            roomId, gameName,
        );
        expect(history.submitted_during_tournament_id).toBe(fixture.longRunningTournamentId);

        const rankings = await LeaderboardService.getForGame(fixture.longRunningGameId);
        expect(rankings.some(r => r.score === 6000)).toBe(true);

        expect(logWarn).toHaveBeenCalled();
        const messages = vi.mocked(logWarn).mock.calls.map(c => String(c[0]));
        expect(messages.some(m => m.includes('ambiguous ACTIVE game') && m.includes(gameName))).toBe(true);
    });

    it('a gameId from a DIFFERENT room is ignored and the name rule applies', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ambig-submit-3', 'Ambig Submit 3');
        const otherRoomId = await createTestRoom('ambig-other-room', 'Ambig Other Room');
        const gameName = 'Black Rose';
        await seedCatalogueGame(gameName);
        const fixture = await seedAmbiguousFixture(roomId, gameName);

        // A perfectly valid game id — just in the WRONG room.
        const otherTournamentId = await createTestTournament(otherRoomId, { name: 'Unrelated' });
        const otherGameId = await createTestGame(otherTournamentId, { name: gameName, status: 'ACTIVE' });

        const token = playerToken('ambig-player-3', 'AmbigPlayer3', roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '7000')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .field('gameId', otherGameId);

        expect(res.status).toBe(201);

        const db = await getDatabase();
        const submissionId = `${fixture.longRunningGameId}-ambigplayer3`;
        const submission = await db.get(`SELECT game_id FROM submissions WHERE id = ?`, submissionId);
        expect(submission).toBeTruthy();
        expect(submission.game_id).toBe(fixture.longRunningGameId);

        const messages = vi.mocked(logWarn).mock.calls.map(c => String(c[0]));
        expect(messages.some(m => m.includes('ignoring gameId'))).toBe(true);
    });
});

describe('ambiguous ACTIVE games with the same name — freeplay-score', () => {
    it('an explicit gameId wins even when it is NOT the earliest-start-date game', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('ambig-freeplay-1', 'Ambig Freeplay 1');
        const gameName = 'Black Rose';
        const ggId = await seedCatalogueGame(gameName);
        const fixture = await seedAmbiguousFixture(roomId, gameName);

        const token = playerToken('ambig-fp-player-1', 'AmbigFpPlayer1', roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/freeplay-score`)
            .set('Authorization', `Bearer ${token}`)
            .field('globalGameId', ggId)
            .field('score', '5500')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .field('gameId', fixture.justPickedGameId)
            .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });

        expect(res.status).toBe(201);

        const db = await getDatabase();
        const submissionId = `${fixture.justPickedGameId}-ambigfpplayer1`;
        const submission = await db.get(`SELECT game_id FROM submissions WHERE id = ?`, submissionId);
        expect(submission).toBeTruthy();
        expect(submission.game_id).toBe(fixture.justPickedGameId);

        const history = await db.get(
            `SELECT submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 5500`,
            roomId, gameName,
        );
        expect(history.submitted_during_tournament_id).toBe(fixture.justPickedTournamentId);
    });
});

describe('migration 175 — repairAmbiguousSubmissionGames', () => {
    it('moves a submissions row onto the game score_history actually stamped, and is idempotent', async () => {
        await setupTestDb();
        const db = await getDatabase();

        const roomId = await createTestRoom('repair-room', 'Repair Room');
        const tournamentA = await createTestTournament(roomId, { name: 'Weekly Grind - VR' });
        const tournamentB = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gameName = 'Black Rose';
        const gameA = await createTestGame(tournamentA, { name: gameName, status: 'ACTIVE' });
        const gameB = await createTestGame(tournamentB, { name: gameName, status: 'ACTIVE' });

        // The production shape: submissions landed on B, score_history was
        // stamped with A, for the SAME (player, score) — one second apart.
        const username = 'TestPlayer';
        const score = 5000;
        const submissionTimestamp = '2026-09-06T03:20:05.000Z';
        const historyCreatedAt = '2026-09-06 03:20:04'; // SQLite UTC shape, 1s earlier

        const oldSubmissionId = `${gameB}-${username.toLowerCase()}`;
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp,
                submitted_from_room_id, submitted_during_tournament_id)
             VALUES (?, ?, 'COMMUNITY', ?, ?, ?, ?, ?)`,
            oldSubmissionId, gameB, username, score, submissionTimestamp, roomId, tournamentB,
        );
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id, created_at
             ) VALUES (?, ?, ?, 'DISC1', ?, 'community', ?, ?, ?)`,
            gameName, roomId, username, score, roomId, tournamentA, historyCreatedAt,
        );

        // A stale leaderboard_cache row for A's game — the card the WG-VR
        // incident showed as never updated.
        await db.run(
            `INSERT INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, '{"v":1,"rows":[]}', ?)`,
            gameA, new Date().toISOString(),
        );

        const result = await repairAmbiguousSubmissionGames(db as any);
        expect(result.moved).toBe(1);

        const newSubmissionId = `${gameA}-${username.toLowerCase()}`;
        const moved = await db.get(`SELECT game_id, submitted_during_tournament_id, score FROM submissions WHERE id = ?`, newSubmissionId);
        expect(moved).toBeTruthy();
        expect(moved.game_id).toBe(gameA);
        expect(moved.submitted_during_tournament_id).toBe(tournamentA);
        expect(moved.score).toBe(score);

        const oldRow = await db.get(`SELECT id FROM submissions WHERE id = ?`, oldSubmissionId);
        expect(oldRow).toBeUndefined();

        const cacheA = await db.get(`SELECT game_id FROM leaderboard_cache WHERE game_id = ?`, gameA);
        const cacheB = await db.get(`SELECT game_id FROM leaderboard_cache WHERE game_id = ?`, gameB);
        expect(cacheA).toBeUndefined();
        expect(cacheB).toBeUndefined();

        // Idempotent: running again finds nothing left to move.
        const second = await repairAmbiguousSubmissionGames(db as any);
        expect(second.moved).toBe(0);
    });
});
