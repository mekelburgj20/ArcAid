import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';

/**
 * ADR 0016 Phase 2, Section 3 — iScored provenance integrity.
 *
 * Three invariants, each with a way it could silently regress:
 *
 *   §3a  Sync applies to TOURNAMENT games only. Structural today (an INNER JOIN
 *        in `findLocalGameForIscoredId`); one keystroke from a LEFT JOIN.
 *   §3b  Synced scores are ALWAYS `unknown`/`unknown` — no inference from
 *        tournament rules, from `tournaments.iscored_default_engine`/`_device`,
 *        or from anything else. Both import paths.
 *   §3c  Synced scores never reach the Global Scoreboard. Enforced inside
 *        `GlobalScoreService.fanOutFromRoomSubmission`, so a future caller
 *        cannot reinstate the fan-out by accident.
 *   §3d  Migration 128 removes the rows that predate all of the above.
 */

// ─────────────────────────────────────────────────────────────────────────────
// iScored API seam
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable payloads the mocked iScored client hands back to each import path. */
const iscored: {
    allScores: { scores: Array<{ name: string; game: string; gameName: string; score: string }> };
    gameScores: { scores: Array<{ name: string; score: string }> };
} = { allScores: { scores: [] }, gameScores: { scores: [] } };

vi.mock('../engine/IScoredApiClient.js', () => ({
    IScoredApiClient: class {
        constructor(_opts: unknown) { /* no network in tests */ }
        static parseGameroomName(url: string) { return url.split('/').pop() || null; }
        async getAllScores() { return iscored.allScores; }
        async getGameScores(_gameId: string, _limit: number) { return iscored.gameScores; }
    },
}));

const { ScoreSyncPoller } = await import('../engine/ScoreSyncPoller.js');
const { TournamentEngine } = await import('../engine/TournamentEngine.js');
const { GlobalScoreService } = await import('../services/GlobalScoreService.js');
const { purgeSyncAndUnknownScores } = await import('../database/migrations/purgeSyncAndUnknownScores.js');

/**
 * A room whose tournament permits exactly ONE engine. This is the fixture that
 * matters: it is precisely the shape someone would look at and think "we can
 * obviously infer the engine here". §3b says no.
 */
async function seedSingleEngineTournamentRoom(slug: string) {
    const db = await getDatabase();
    const roomId = await createTestRoom(slug, slug);

    // iScored creds so getIScoredCredsForRoom resolves (final-sync path).
    for (const [key, value] of [
        ['ISCORED_USERNAME', 'acct'], ['ISCORED_PASSWORD', 'pw'],
        ['ISCORED_PUBLIC_URL', 'https://example.invalid/acct'],
    ]) {
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
            roomId, key, value,
        );
    }

    const globalGameId = `gg-${slug}`;
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status)
         VALUES (?, 'WHO dunnit', 'pinball', ?, 'approved')`,
        globalGameId, JSON.stringify(['vpx']),
    );

    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, platform_rules,
                                  iscored_default_engine, iscored_default_device, iscored_default_platform)
         VALUES (?, 'Single Engine', 'DG', 'pinball', '{}', 1, ?, ?, 'fx', 'vr_headset', 'vpx')`,
        tournamentId, roomId,
        // Exactly one engine permitted, and one device.
        JSON.stringify({ engines: { required: ['vpx'], excluded: [] }, devices: { required: ['pc'], excluded: [] } }),
    );

    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, iscored_id, status, game_room_id, global_game_id, created_at)
         VALUES (?, ?, 'WHO dunnit', '95570', 'ACTIVE', ?, ?, datetime('now'))`,
        gameId, tournamentId, roomId, globalGameId,
    );

    return { db, roomId, tournamentId, gameId, globalGameId };
}

const CREDS = {
    username: 'acct', password: 'pw', publicUrl: 'https://example.invalid/acct',
    gameroomName: 'acct', source: 'room' as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// §3a — tournament-only lock
// ─────────────────────────────────────────────────────────────────────────────

describe('§3a — ScoreSyncPoller.findLocalGameForIscoredId is tournament-only', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('does NOT match a pinned game that carries an iscored_id', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom('pinned-sync', 'Pinned Sync');

        // A pinned row: tournament_id IS NULL is the canonical pinned signal
        // (ADR 0005). Pins can carry an iscored_id — nothing stops an admin
        // pinning a game that also exists on iScored.
        const pinnedId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, iscored_id, status, game_room_id, created_at)
             VALUES (?, NULL, 'Pinned WHO dunnit', '95570', 'ACTIVE', ?, datetime('now'))`,
            pinnedId, roomId,
        );

        const row = await ScoreSyncPoller.findLocalGameForIscoredId(db, '95570', [roomId]);
        expect(
            row,
            'a pinned game was matched by the sync poller — the JOIN in findLocalGameForIscoredId '
            + 'must stay an INNER JOIN on tournaments (ADR 0016 §3a). Sync is tournament-only.',
        ).toBeUndefined();
    });

    it('still matches a tournament game in the same room (positive control)', async () => {
        const { db, gameId } = await seedSingleEngineTournamentRoom('tournament-sync');
        const roomRow = await db.get(`SELECT game_room_id AS r FROM games WHERE id = ?`, gameId);
        const row = await ScoreSyncPoller.findLocalGameForIscoredId(db, '95570', [roomRow.r]);
        expect(row?.id).toBe(gameId);
    });

    it('ignores a pinned row even when a tournament row shares the iscored_id', async () => {
        const { db, roomId, gameId } = await seedSingleEngineTournamentRoom('mixed-sync');
        await db.run(
            `INSERT INTO games (id, tournament_id, name, iscored_id, status, game_room_id, created_at)
             VALUES (?, NULL, 'WHO dunnit (pinned)', '95570', 'ACTIVE', ?, datetime('now', '+1 day'))`,
            crypto.randomUUID(), roomId,
        );
        const row = await ScoreSyncPoller.findLocalGameForIscoredId(db, '95570', [roomId]);
        expect(row?.id).toBe(gameId);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3b — no inference, ever
// ─────────────────────────────────────────────────────────────────────────────

describe('§3b — synced scores are always unknown/unknown', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('ScoreSyncPoller stamps unknown/unknown even when the tournament permits exactly one engine', async () => {
        const { db, roomId, gameId, tournamentId } = await seedSingleEngineTournamentRoom('poller-unknown');
        iscored.allScores = {
            scores: [{ name: 'SyncPlayer', game: '95570', gameName: 'WHO dunnit', score: '1,234,567' }],
        };

        await (ScoreSyncPoller.getInstance() as unknown as {
            pollOneAccount: (...a: unknown[]) => Promise<void>;
        }).pollOneAccount(db, CREDS, [roomId], new Map(), new Map(), new Set());

        const sub = await db.get(
            `SELECT score, engine, device FROM submissions WHERE game_id = ?`, gameId);
        expect(sub).toMatchObject({ score: 1234567, engine: UNKNOWN, device: UNKNOWN });

        const hist = await db.get(
            `SELECT source, engine, device, submitted_during_tournament_id AS t
               FROM score_history WHERE game_id = ?`, gameId);
        expect(hist).toMatchObject({ source: 'sync', engine: UNKNOWN, device: UNKNOWN, t: tournamentId });
    });

    it('ScoreSyncPoller ignores tournaments.iscored_default_engine/_device entirely', async () => {
        // The fixture sets them to 'fx'/'vr_headset'. Pre-§3b those values were
        // read and stamped onto the row; they must now be inert.
        const { db, roomId, gameId } = await seedSingleEngineTournamentRoom('poller-vestigial');
        iscored.allScores = {
            scores: [{ name: 'SyncPlayer', game: '95570', gameName: 'WHO dunnit', score: '500' }],
        };
        await (ScoreSyncPoller.getInstance() as unknown as {
            pollOneAccount: (...a: unknown[]) => Promise<void>;
        }).pollOneAccount(db, CREDS, [roomId], new Map(), new Map(), new Set());

        const sub = await db.get(`SELECT engine, device FROM submissions WHERE game_id = ?`, gameId);
        expect(sub.engine).not.toBe('fx');
        expect(sub.device).not.toBe('vr_headset');
        expect(sub).toMatchObject({ engine: UNKNOWN, device: UNKNOWN });
    });

    it('TournamentEngine.finalSyncScoresForGame stamps unknown/unknown on the same single-engine tournament', async () => {
        const { db, roomId, gameId, tournamentId } = await seedSingleEngineTournamentRoom('finalsync-unknown');
        iscored.gameScores = { scores: [{ name: 'FinalPlayer', score: '9000' }] };

        const captured = await (TournamentEngine.getInstance() as unknown as {
            finalSyncScoresForGame: (row: unknown) => Promise<number>;
        }).finalSyncScoresForGame({
            id: gameId, name: 'WHO dunnit', iscored_id: '95570',
            tournament_id: tournamentId, game_room_id: roomId,
            iscored_default_platform: 'vpx',
        });
        expect(captured).toBe(1);

        const sub = await db.get(
            `SELECT score, engine, device FROM submissions WHERE game_id = ?`, gameId);
        expect(sub).toMatchObject({ score: 9000, engine: UNKNOWN, device: UNKNOWN });

        const hist = await db.get(
            `SELECT source, engine, device FROM score_history WHERE game_id = ?`, gameId);
        expect(hist).toMatchObject({ source: 'sync', engine: UNKNOWN, device: UNKNOWN });
    });

    it('a synced score creates submissions + score_history rows and NO global_scores row', async () => {
        const { db, roomId, gameId } = await seedSingleEngineTournamentRoom('sync-no-global');
        iscored.allScores = {
            scores: [{ name: 'SyncPlayer', game: '95570', gameName: 'WHO dunnit', score: '4242' }],
        };

        await (ScoreSyncPoller.getInstance() as unknown as {
            pollOneAccount: (...a: unknown[]) => Promise<void>;
        }).pollOneAccount(db, CREDS, [roomId], new Map(), new Map(), new Set());

        const subs = await db.get(`SELECT COUNT(*) AS n FROM submissions WHERE game_id = ?`, gameId);
        const hist = await db.get(`SELECT COUNT(*) AS n FROM score_history WHERE game_id = ?`, gameId);
        const global = await db.get(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(subs.n).toBe(1);
        expect(hist.n).toBe(1);
        expect(global.n, 'a synced score reached the Global Scoreboard (ADR 0016 §3c)').toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3c — the invariant lives in the service
// ─────────────────────────────────────────────────────────────────────────────

describe("§3c — GlobalScoreService.fanOutFromRoomSubmission rejects source: 'sync'", () => {
    beforeEach(async () => { await setupTestDb(); });

    /** Everything a fan-out needs to succeed, so only `source` is under test. */
    async function fanOutFixture(slug: string) {
        const db = await getDatabase();
        const roomId = await createTestRoom(slug, slug);
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, status)
             VALUES (?, 'Fan Out Game', 'pinball', '["vpx"]', 'approved')`,
            `gg-${slug}`,
        );
        return { db, roomId };
    }

    it("returns null and writes nothing for source: 'sync'", async () => {
        const { db, roomId } = await fanOutFixture('fanout-sync');
        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'Fan Out Game',
            playerId: 'iscored:SyncPlayer', iscoredUsername: 'SyncPlayer', score: 5000,
            engine: 'vpx', device: 'pc',   // even a fully-specified pair is refused
            source: 'sync',
        });
        expect(result).toBeNull();
        const row = await db.get(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(row.n).toBe(0);
    });

    it("still fans out for source: 'tournament' and 'community' (control)", async () => {
        const { db, roomId } = await fanOutFixture('fanout-web');
        const tournament = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'Fan Out Game',
            playerId: 'discord-1', iscoredUsername: 'WebPlayer', score: 5000,
            source: 'tournament',
        });
        expect(tournament).not.toBeNull();

        const community = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'Fan Out Game',
            playerId: 'discord-2', iscoredUsername: 'CommunityPlayer', score: 6000,
            source: 'community',
        });
        expect(community).not.toBeNull();

        const row = await db.get(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(row.n).toBe(2);
    });

    it('rejects sync before any other gate — an otherwise-perfect submission still fails', async () => {
        // Same room, same game, same player as the passing control above; only
        // `source` differs. Proves the rejection is not incidental.
        const { db, roomId } = await fanOutFixture('fanout-parity');
        const ok = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'Fan Out Game',
            playerId: 'discord-3', iscoredUsername: 'ParityPlayer', score: 777,
            source: 'tournament',
        });
        expect(ok).not.toBeNull();

        const refused = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'Fan Out Game',
            playerId: 'discord-4', iscoredUsername: 'ParityPlayer2', score: 778,
            source: 'sync',
        });
        expect(refused).toBeNull();
        const row = await db.get(
            `SELECT COUNT(*) AS n FROM global_scores WHERE iscored_username = 'ParityPlayer2'`);
        expect(row.n).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3d — migration 128
// ─────────────────────────────────────────────────────────────────────────────

describe('§3d — migration 128 purges sync-origin and unknown-engine score rows', () => {
    /**
     * Seeds the four score tables with rows that must die and rows that must
     * survive, including the adversarial case the join has to get right: a
     * web-submitted global row carrying the SAME (game, username, score) triple
     * as a sync-origin one.
     */
    async function seedPurgeFixture() {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('purge-room', 'Purge Room');
        const globalGameId = 'gg-purge';
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, status)
             VALUES (?, 'WHO dunnit', 'pinball', '["vpx"]', 'approved')`, globalGameId);
        const tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'T', 'DG', 'pinball', '{}', 1, ?)`, tournamentId, roomId);
        const gameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, global_game_id, created_at)
             VALUES (?, ?, 'WHO dunnit', 'ACTIVE', ?, ?, datetime('now'))`,
            gameId, tournamentId, roomId, globalGameId);

        const globalScore = async (
            id: string, username: string, score: number, engine: string,
            opts: { originType?: string; originGameId?: string | null; roomId?: string | null } = {},
        ) => db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score,
                                        origin_type, origin_game_room_id, origin_game_id,
                                        submitted_at, engine, device)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'unknown')`,
            id, globalGameId, `player-${username}`, username, score,
            opts.originType ?? 'game_room',
            opts.roomId === undefined ? roomId : opts.roomId,
            opts.originGameId === undefined ? gameId : opts.originGameId,
            engine,
        );

        const history = async (username: string, score: number, source: string, engine: string | null) => db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username,
                                        discord_user_id, score, source, engine, device)
             VALUES ('WHO dunnit', ?, ?, ?, 'SYSTEM', ?, ?, ?, 'unknown')`,
            roomId, gameId, username, score, source, engine);

        // (a) Sync-origin global row with a CONCRETE engine. Cleanup 2 would
        //     never touch it — only the (game, username, score) match to
        //     sync-origin history finds it. Its history row deliberately also
        //     carries a concrete engine, so it survives and proves cleanup 1
        //     acted on global_scores alone.
        await globalScore('gs-sync-concrete', 'SyncConcrete', 1000, 'vpx');
        await history('SyncConcrete', 1000, 'sync', 'vpx');

        // (b) Ordinary sync-origin row, unknown engine — dies either way.
        await globalScore('gs-sync-unknown', 'SyncUnknown', 1100, 'unknown');
        await history('SyncUnknown', 1100, 'sync', 'unknown');

        // (c) THE FALSE-POSITIVE TRAP: a web-submitted global row whose
        //     (game, username, score) triple is ALSO covered by a sync-origin
        //     history row. The non-sync history row must save it.
        await globalScore('gs-dual', 'DualPlayer', 2000, 'vpx');
        await history('DualPlayer', 2000, 'tournament', 'vpx');
        await history('DualPlayer', 2000, 'sync', 'vpx');

        // (d) A plain web-submitted global row with a known engine — survives.
        await globalScore('gs-web', 'WebPlayer', 3000, 'fx');
        await history('WebPlayer', 3000, 'tournament', 'fx');

        // (e) A DIRECT global submission (origin_type='global'), same score as a
        //     sync row. Never reachable from the poller, so never a candidate.
        await globalScore('gs-direct', 'SyncConcrete', 1000, 'vpx',
            { originType: 'global', originGameId: null, roomId: null });

        // (f) Unknown-engine rows in every score table.
        await globalScore('gs-unknown-web', 'UnknownWeb', 4000, 'unknown');
        await history('UnknownWeb', 4000, 'tournament', 'unknown');
        await history('NullEngine', 4100, 'tournament', null);          // NULL == unknown
        await db.run(
            `INSERT INTO submissions (id, game_id, iscored_username, score, timestamp,
                                      discord_user_id, engine, device)
             VALUES ('sub-unknown', ?, 'UnknownSub', 10, datetime('now'), 'u-1', 'unknown', 'unknown')`,
            gameId);
        await db.run(
            `INSERT INTO submissions (id, game_id, iscored_username, score, timestamp,
                                      discord_user_id, engine, device)
             VALUES ('sub-known', ?, 'KnownSub', 20, datetime('now'), 'u-2', 'vpx', 'pc')`,
            gameId);
        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id,
                                           score, engine, device)
             VALUES ('WHO dunnit', ?, 'UnknownComm', 'ANON', 30, 'unknown', 'unknown')`, roomId);
        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id,
                                           score, engine, device)
             VALUES ('WHO dunnit', ?, 'KnownComm', 'ANON', 40, 'fx', 'pc')`, roomId);

        // (g) Soft references + caches.
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id) VALUES ('rep-doomed', 'gs-sync-unknown', 'u-9')`);
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id) VALUES ('rep-kept', 'gs-web', 'u-9')`);
        await db.run(
            `INSERT INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, '[]', datetime('now'))`, gameId);
        await db.run(
            `INSERT INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at)
             VALUES (?, 'all', '[]', datetime('now'))`, globalGameId);

        return { db, roomId, gameId };
    }

    const ids = async (db: Awaited<ReturnType<typeof getDatabase>>, sql: string) =>
        (await db.all(sql)).map((r: Record<string, unknown>) => Object.values(r)[0]);

    it('deletes sync-origin global rows and every unknown-engine row, and nothing else', async () => {
        const { db } = await seedPurgeFixture();
        const counts = await purgeSyncAndUnknownScores(db);

        // --- Cleanup 1: sync-origin global rows -------------------------
        // gs-sync-concrete + gs-sync-unknown. NOT gs-dual (a non-sync history
        // row explains it), NOT gs-direct (origin_type='global').
        expect(counts.syncOriginGlobalScores).toBe(2);

        // --- Survivors ---------------------------------------------------
        const survivors = await ids(db, `SELECT id FROM global_scores ORDER BY id`);
        expect(survivors).toEqual(['gs-direct', 'gs-dual', 'gs-web']);

        // The adversarial row specifically: same game, same score value as a
        // sync-origin row, and it survived.
        const dual = await db.get(`SELECT score, engine FROM global_scores WHERE id = 'gs-dual'`);
        expect(dual).toMatchObject({ score: 2000, engine: 'vpx' });

        // --- Cleanup 2: unknown-engine rows across all four tables --------
        // score_history: SyncUnknown, UnknownWeb, NullEngine.
        expect(counts.unknownEngine.score_history).toBe(3);
        expect(counts.nullEngine.score_history).toBe(1);
        const historyLeft = await ids(db, `SELECT iscored_username FROM score_history ORDER BY iscored_username`);
        expect(historyLeft).toEqual(['DualPlayer', 'DualPlayer', 'SyncConcrete', 'WebPlayer']);

        expect(counts.unknownEngine.submissions).toBe(1);
        expect(await ids(db, `SELECT id FROM submissions`)).toEqual(['sub-known']);

        expect(counts.unknownEngine.community_scores).toBe(1);
        expect(await ids(db, `SELECT iscored_username FROM community_scores`)).toEqual(['KnownComm']);

        // global_scores: only gs-unknown-web is left to sweep — the two
        // sync-origin rows already went in cleanup 1.
        expect(counts.unknownEngine.global_scores).toBe(1);

        // --- Soft references + caches ------------------------------------
        expect(counts.orphanedScoreReports).toBe(1);
        expect(await ids(db, `SELECT id FROM score_reports`)).toEqual(['rep-kept']);
        expect((await db.get(`SELECT COUNT(*) AS n FROM leaderboard_cache`)).n).toBe(0);
        expect((await db.get(`SELECT COUNT(*) AS n FROM global_leaderboard_cache`)).n).toBe(0);
    });

    it('leaves a known-engine row alone even when it is the ONLY row left', async () => {
        const { db } = await seedPurgeFixture();
        await purgeSyncAndUnknownScores(db);
        const known = await db.get(`SELECT engine, device FROM submissions WHERE id = 'sub-known'`);
        expect(known).toMatchObject({ engine: 'vpx', device: 'pc' });
    });

    it('is idempotent — a second run deletes nothing', async () => {
        const { db } = await seedPurgeFixture();
        await purgeSyncAndUnknownScores(db);
        const second = await purgeSyncAndUnknownScores(db);
        expect(second.syncOriginGlobalScores).toBe(0);
        expect(second.orphanedScoreReports).toBe(0);
        for (const table of Object.keys(second.unknownEngine)) {
            expect(second.unknownEngine[table], table).toBe(0);
        }
    });

    it('runs clean on an empty database (no rows, no FK violations)', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const counts = await purgeSyncAndUnknownScores(db);
        expect(counts.syncOriginGlobalScores).toBe(0);
        const violations = await db.all(`PRAGMA foreign_key_check`);
        expect(violations).toEqual([]);
    });

    it('leaves no foreign-key violations behind after a real purge', async () => {
        const { db } = await seedPurgeFixture();
        await purgeSyncAndUnknownScores(db);
        const violations = await db.all(`PRAGMA foreign_key_check`);
        expect(violations).toEqual([]);
    });
});
