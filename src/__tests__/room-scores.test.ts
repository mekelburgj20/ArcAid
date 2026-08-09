import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * scores-page-redesign (WP4) — GET /:roomId/room-scores.
 *
 * Bootstrap pattern copied verbatim from api-rooms.test.ts: mount rooms.ts at
 * /api/rooms against a fresh setupTestDb() per test (setup.ts's global
 * beforeEach already calls _resetForTesting(), so each `it()` gets its own
 * in-memory database).
 */
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

/**
 * Direct score_history seeding for cases the `submissions`-flavored
 * createTestSubmission() helper can't express (explicit submitted_by_user_id,
 * orphaned_at, source, created_at). Mirrors the column set ScoreHistoryService
 * and the sync poller actually write.
 */
async function insertScoreHistoryRow(opts: {
    gameRoomId: string;
    gameName: string;
    iscoredUsername: string;
    score: number;
    discordUserId?: string | null;
    submittedByUserId?: string | null;
    source?: 'tournament' | 'community' | 'sync';
    orphanedAt?: string | null;
    createdAt?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id, orphaned_at, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        opts.gameName, opts.gameRoomId, opts.iscoredUsername,
        opts.discordUserId ?? 'SYSTEM', opts.score, opts.source ?? 'community',
        opts.gameRoomId, opts.submittedByUserId ?? null, opts.orphanedAt ?? null,
        opts.createdAt ?? new Date().toISOString(),
    );
}

describe('GET /api/rooms/:roomId/room-scores', () => {
    it('(a) cross-source best-per-player: a higher community score outranks an earlier tournament score', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Cross Source' });
        await createTestSubmission(gameId, { username: 'Alice', discordUserId: 'DALICE', score: 5000 });

        const { CommunityScoreService } = await import('../services/CommunityScoreService.js');
        await CommunityScoreService.submitScore(roomId, 'Cross Source', 'Alice', 7000, 'DALICE');

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        expect(res.status).toBe(200);
        const card = res.body.data.find((c: any) => c.gameName === 'Cross Source');
        expect(card).toBeTruthy();
        // All-time best across sources — NOT window-bounded like the Tournaments tab.
        expect(card.rankings[0].score).toBe(7000);
    });

    it('(b) multi-alias collapse: two aliases of one Discord user become one ranking row', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Alias Game', iscoredUsername: 'Bob1',
            submittedByUserId: 'DBOB', score: 1000,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Alias Game', iscoredUsername: 'Bob2',
            submittedByUserId: 'DBOB', score: 2000,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        const card = res.body.data.find((c: any) => c.gameName === 'Alias Game');
        expect(card.rankings).toHaveLength(1);
        expect(card.rankings[0].score).toBe(2000);
    });

    it('(c) display_name resolution: user_profiles.display_name is joined onto the ranking row', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Named Game', iscoredUsername: 'Carol',
            submittedByUserId: 'DCAROL', score: 3000,
        });
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`,
            'DCAROL', 'CarolDisplay',
        );

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        const card = res.body.data.find((c: any) => c.gameName === 'Named Game');
        // Regression vs the old community-leaderboards handler, which never
        // JOINed user_profiles and always fell back to iscored_username.
        expect(card.rankings[0].display_name).toBe('CarolDisplay');
    });

    it('(d) iscored:* synthetic id resolves to a real Discord user + display_name via user_mappings', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Synced Game', iscoredUsername: 'Zeta',
            discordUserId: 'iscored:Zeta', submittedByUserId: null, source: 'sync', score: 4000,
        });
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`,
            'DZETA', 'ZETA',
        );
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`,
            'DZETA', 'ZetaDisplay',
        );

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        const card = res.body.data.find((c: any) => c.gameName === 'Synced Game');
        expect(card.rankings[0].discord_user_id).toBe('DZETA');
        expect(card.rankings[0].display_name).toBe('ZetaDisplay');
    });

    it('(e) player_count uses the canonical partition, not raw distinct iscored_username', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Carl Game', iscoredUsername: 'Carl1',
            submittedByUserId: 'DCARL', score: 100,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Carl Game', iscoredUsername: 'Carl2',
            submittedByUserId: 'DCARL', score: 200,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        const card = res.body.data.find((c: any) => c.gameName === 'Carl Game');
        expect(card.playerCount).toBe(1);
        expect(card.totalScores).toBe(2);
    });

    it('(f) game_id-NULL community rows still appear, keyed by game_name alone', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        // No `games` row backs this at all — pure freeplay/community submission.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Freeplay Only Game', iscoredUsername: 'Dana',
            submittedByUserId: 'DDANA', score: 500, source: 'community',
        });

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        const card = res.body.data.find((c: any) => c.gameName === 'Freeplay Only Game');
        expect(card).toBeTruthy();
        expect(card.rankings[0].score).toBe(500);
    });

    it('(g) orphaned_at rows are excluded from rankings, player_count and total_scores', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Orphan Game', iscoredUsername: 'Live',
            submittedByUserId: 'DLIVE', score: 100,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Orphan Game', iscoredUsername: 'Ghost',
            submittedByUserId: 'DGHOST', score: 999, orphanedAt: new Date().toISOString(),
        });

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        const card = res.body.data.find((c: any) => c.gameName === 'Orphan Game');
        expect(card.playerCount).toBe(1);
        expect(card.totalScores).toBe(1);
        expect(card.rankings).toHaveLength(1);
        expect(card.rankings[0].score).toBe(100);
    });

    it('(h) search + sort=recent|alpha|most_played + limit/offset + total/hasMore', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        // Alpha Game: 1 score, oldest.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Alpha Game', iscoredUsername: 'P1',
            submittedByUserId: 'D1', score: 10, createdAt: '2026-01-01T00:00:00.000Z',
        });
        // Gamma Game: 2 scores, middle recency.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Gamma Game', iscoredUsername: 'P2',
            submittedByUserId: 'D2', score: 20, createdAt: '2026-01-02T00:00:00.000Z',
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Gamma Game', iscoredUsername: 'P3',
            submittedByUserId: 'D3', score: 30, createdAt: '2026-01-02T01:00:00.000Z',
        });
        // Beta Game: 3 scores, newest.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Beta Game', iscoredUsername: 'P4',
            submittedByUserId: 'D4', score: 40, createdAt: '2026-01-03T00:00:00.000Z',
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Beta Game', iscoredUsername: 'P5',
            submittedByUserId: 'D5', score: 50, createdAt: '2026-01-03T01:00:00.000Z',
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Beta Game', iscoredUsername: 'P6',
            submittedByUserId: 'D6', score: 60, createdAt: '2026-01-03T02:00:00.000Z',
        });

        const recent = await request(app).get(`/api/rooms/${roomId}/room-scores?sort=recent`);
        expect(recent.body.data.map((c: any) => c.gameName)).toEqual(['Beta Game', 'Gamma Game', 'Alpha Game']);
        expect(recent.body.total).toBe(3);
        expect(recent.body.hasMore).toBe(false);

        const alpha = await request(app).get(`/api/rooms/${roomId}/room-scores?sort=alpha`);
        expect(alpha.body.data.map((c: any) => c.gameName)).toEqual(['Alpha Game', 'Beta Game', 'Gamma Game']);

        const mostPlayed = await request(app).get(`/api/rooms/${roomId}/room-scores?sort=most_played`);
        expect(mostPlayed.body.data.map((c: any) => c.gameName)).toEqual(['Beta Game', 'Gamma Game', 'Alpha Game']);

        const searched = await request(app).get(`/api/rooms/${roomId}/room-scores?search=gamma`);
        expect(searched.body.data).toHaveLength(1);
        expect(searched.body.data[0].gameName).toBe('Gamma Game');

        const paged = await request(app).get(`/api/rooms/${roomId}/room-scores?sort=alpha&limit=1&offset=1`);
        expect(paged.body.data).toHaveLength(1);
        expect(paged.body.data[0].gameName).toBe('Beta Game');
        expect(paged.body.total).toBe(3);
        expect(paged.body.hasMore).toBe(true);
    });

    it('(i) viewerEntry: present with a valid player token, absent without one, never 401 with a bad token', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Viewer Game', iscoredUsername: 'ViewAlias',
            submittedByUserId: 'DVIEW', score: 555,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Viewer Game', iscoredUsername: 'Rival',
            submittedByUserId: 'DRIVAL', score: 111,
        });

        const token = playerToken('DVIEW', 'ViewAlias', roomId);
        const withToken = await request(app)
            .get(`/api/rooms/${roomId}/room-scores`)
            .set('Authorization', `Bearer ${token}`);
        expect(withToken.status).toBe(200);
        const cardWithToken = withToken.body.data.find((c: any) => c.gameName === 'Viewer Game');
        expect(cardWithToken.viewerEntry).toBeTruthy();
        expect(cardWithToken.viewerEntry.rank).toBe(1);
        expect(cardWithToken.viewerEntry.score).toBe(555);

        const withoutToken = await request(app).get(`/api/rooms/${roomId}/room-scores`);
        expect(withoutToken.status).toBe(200);
        const cardWithoutToken = withoutToken.body.data.find((c: any) => c.gameName === 'Viewer Game');
        expect(cardWithoutToken.viewerEntry).toBeFalsy();

        const withBadToken = await request(app)
            .get(`/api/rooms/${roomId}/room-scores`)
            .set('Authorization', 'Bearer not-a-real-jwt');
        expect(withBadToken.status).toBe(200);
    });

    it('(j) agreement: tournament-only game top row matches between /leaderboard and /room-scores', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Solo Game' });
        await createTestSubmission(gameId, { username: 'Solo', score: 4321 });

        const leaderboardRes = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        const roomScoresRes = await request(app).get(`/api/rooms/${roomId}/room-scores`);

        const lb = leaderboardRes.body.find((l: any) => l.gameName === 'Solo Game');
        const rs = roomScoresRes.body.data.find((c: any) => c.gameName === 'Solo Game');

        expect(lb.rankings[0].score).toBe(rs.rankings[0].score);
        expect(lb.rankings[0].iscored_username).toBe(rs.rankings[0].iscored_username);
    });

    it('(k) the old /:roomId/community-leaderboards path is gone', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        const res = await request(app).get(`/api/rooms/${roomId}/community-leaderboards`);

        expect(res.status).toBe(404);
    });

    /**
     * RTX demo bug fix (2026-08-09): a game's card background on Room Scores
     * must resolve the same way it does on Tournaments — `games`-row style
     * overrides (written by the admin Leaderboard page's per-game Style
     * button via `StyleCatalogueService.assignImageToGame`) take precedence
     * over the `game_room_game_library` overlay (written via
     * `assignImageToLibrary`). Pre-fix, `RoomScoresService.resolveCardChrome`
     * only ever consulted the library row, so a game styled through the
     * per-game button rendered no background on this tab.
     */
    it('(l) card bg resolution: games-row style wins over library overlay, library-only still works, neither ships none', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const db = await getDatabase();

        await db.run(
            `INSERT INTO style_catalogue (id, name, has_background, has_header) VALUES (?, ?, 1, 0)`,
            'style-games-row', 'Games Row Style',
        );
        await db.run(
            `INSERT INTO style_catalogue (id, name, has_background, has_header) VALUES (?, ?, 1, 0)`,
            'style-library', 'Library Style',
        );

        // Game A: an active `games` row with its own bg_style_id, PLUS a
        // library row with a DIFFERENT bg_style_id — games row must win.
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Bg Game A' });
        await db.run(
            `UPDATE games SET game_room_id = ?, bg_style_id = ? WHERE id = ?`,
            roomId, 'style-games-row', gameId,
        );
        await db.run(
            `INSERT INTO game_room_game_library (game_room_id, game_name, bg_style_id) VALUES (?, ?, ?)`,
            roomId, 'Bg Game A', 'style-library',
        );
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Bg Game A', iscoredUsername: 'PlayerA',
            submittedByUserId: 'DPLAYERA', score: 100,
        });

        // Game B: no `games` row at all (pure freeplay name) — library-only
        // overlay must still resolve.
        await db.run(
            `INSERT INTO game_room_game_library (game_room_id, game_name, bg_style_id) VALUES (?, ?, ?)`,
            roomId, 'Bg Game B', 'style-library',
        );
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Bg Game B', iscoredUsername: 'PlayerB',
            submittedByUserId: 'DPLAYERB', score: 100,
        });

        // Game C: neither a styled `games` row nor a library overlay — no bg.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Bg Game C', iscoredUsername: 'PlayerC',
            submittedByUserId: 'DPLAYERC', score: 100,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/room-scores`);
        expect(res.status).toBe(200);

        const cardA = res.body.data.find((c: any) => c.gameName === 'Bg Game A');
        expect(cardA.bgStyleId).toBe('style-games-row');
        expect(cardA.bgHasBg).toBe(1);

        const cardB = res.body.data.find((c: any) => c.gameName === 'Bg Game B');
        expect(cardB.bgStyleId).toBe('style-library');
        expect(cardB.bgHasBg).toBe(1);

        const cardC = res.body.data.find((c: any) => c.gameName === 'Bg Game C');
        expect(cardC.bgStyleId).toBeNull();
        expect(cardC.bgHasBg).toBeNull();
    });
});

/**
 * Migration 107 (`107_backfill_community_scores_into_score_history`, see
 * database.ts) already runs — idempotently, against an empty community_scores
 * table — as part of every setupTestDb() call. There's no exported migration
 * runner and the module-level `db` singleton can't be closed/reopened without
 * losing the `:memory:` data (see database.ts's `_resetForTesting`), so these
 * tests exercise the exact backfill SQL (copied verbatim from database.ts)
 * directly against a seeded DB — the only way to observe it acting on
 * pre-existing rows.
 */
describe('migration 107 backfill (community_scores -> score_history)', () => {
    const BACKFILL_SQL = `
        INSERT INTO score_history
            (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, photo_url, source,
             submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
             submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform, created_at, orphaned_at)
        SELECT cs.game_name, cs.game_room_id, NULL, cs.iscored_username, cs.discord_user_id, cs.score, cs.photo_url, 'community',
               cs.submitted_from_room_id, NULL, cs.submitted_by_user_id, cs.submitted_by_anonymous_name,
               cs.merged_from_anonymous_identity_id, cs.platform, cs.created_at, cs.orphaned_at
        FROM community_scores cs
        WHERE NOT EXISTS (
            SELECT 1 FROM score_history sh
            WHERE sh.game_room_id = cs.game_room_id
              AND LOWER(sh.game_name) = LOWER(cs.game_name)
              AND LOWER(sh.iscored_username) = LOWER(cs.iscored_username)
              AND sh.score = cs.score
        )
        AND NOT EXISTS (
            SELECT 1 FROM deleted_score_suppressions dss
            JOIN games g ON g.id = dss.game_id
            WHERE g.game_room_id = cs.game_room_id
              AND LOWER(g.name) = LOWER(cs.game_name)
              AND dss.iscored_username_lower = LOWER(cs.iscored_username)
              AND dss.suppressed_score >= cs.score
        )
    `;

    it('backfills a legacy community-only row exactly once (idempotent on re-run)', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();

        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score)
             VALUES ('Legacy Game', ?, 'OldPlayer', 'SYSTEM', 4242)`,
            roomId,
        );

        const before = await db.get(
            `SELECT COUNT(*) as c FROM score_history WHERE game_room_id = ? AND LOWER(game_name) = 'legacy game'`,
            roomId,
        );
        expect(before.c).toBe(0);

        await db.run(BACKFILL_SQL);

        const afterFirst = await db.get(
            `SELECT COUNT(*) as c FROM score_history WHERE game_room_id = ? AND LOWER(game_name) = 'legacy game'`,
            roomId,
        );
        expect(afterFirst.c).toBe(1);
        const row = await db.get(
            `SELECT * FROM score_history WHERE game_room_id = ? AND LOWER(game_name) = 'legacy game'`,
            roomId,
        );
        expect(row.source).toBe('community');
        expect(row.score).toBe(4242);

        await db.run(BACKFILL_SQL); // Re-run: must insert 0 additional rows.

        const afterSecond = await db.get(
            `SELECT COUNT(*) as c FROM score_history WHERE game_room_id = ? AND LOWER(game_name) = 'legacy game'`,
            roomId,
        );
        expect(afterSecond.c).toBe(1);
    });

    it('does not resurrect an admin-wiped score covered by a deleted_score_suppressions tombstone', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Wiped Game' });
        // createTestGame doesn't populate the denormalized games.game_room_id
        // column (only production write-paths do) — set it explicitly so the
        // suppression guard's `g.game_room_id = cs.game_room_id` join matches.
        await db.run(`UPDATE games SET game_room_id = ? WHERE id = ?`, roomId, gameId);

        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score)
             VALUES ('Wiped Game', ?, 'WipedPlayer', 'SYSTEM', 999)`,
            roomId,
        );
        await db.run(
            `INSERT INTO deleted_score_suppressions (game_id, iscored_username_lower, suppressed_score)
             VALUES (?, 'wipedplayer', 999)`,
            gameId,
        );

        await db.run(BACKFILL_SQL);

        const row = await db.get(
            `SELECT COUNT(*) as c FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = 'wiped game' AND LOWER(iscored_username) = 'wipedplayer'`,
            roomId,
        );
        expect(row.c).toBe(0);
    });
});
