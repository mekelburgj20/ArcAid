import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * W52 (v2.194.0) - an event round ranks as its standings do EVERYWHERE.
 *
 * W22 (v2.190.0) made the room board and the game page derive an event round's
 * rows from `EventResultService.getRoundBoardDetail` (ADR 0031: under
 * 'prevent' a score the witness saw start before the round opened does not
 * count). It left the CACHED reads alone, so a prevented score could still lead
 * on Discord `/list-scores`, the `/submit-score` rank reply, the chat
 * `leaders` / `my_rank` actions, and the game page's Player Stats / Recent
 * results. These tests pin, worst-bug-first:
 *   1. `getForGame` / `getForGameByProvenance` / `getForGameByPlatform` on an
 *      event round return the round board's order (prevented score absent).
 *   2. Discord `/list-scores` and the chat `leaders` action name the clean leader.
 *   3. A rotation game's read is exactly the cached rows.
 *   4. `getGameStats` with the prevented ids leaves the score out of avg /
 *      unique players / all-time high; `recentResults` names the round board's
 *      winner for a finished round (and the `submissions` winner otherwise).
 *   5. `getGamePlayerRankings` with the ids drops the score; both functions
 *      without the parameter are unchanged.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { EventService } = await import('../services/EventService.js');
const { EventResultService } = await import('../services/EventResultService.js');
const { LeaderboardService } = await import('../services/LeaderboardService.js');
const { StatsService } = await import('../services/StatsService.js');
const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
const { listscores } = await import('../discord/commands/listscores.js');
const { renderCalloutAction } = await import('../discord/calloutActions.js');

const MINUTE = 60_000;
const BASE = Date.parse('2026-09-01T20:00:00.000Z');
const USER_A = '111111111111111111';
const USER_B = '222222222222222222';
const USER_C = '333333333333333333';
const GUILD = '1000000000000000052';
const GAME = 'Medieval Madness';
const ROTATION_GAME = 'Attack from Mars';

/** SQLite's own UTC shape - what the witness ingest stores in `created_at`. */
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

/** A `source='vpx'` score plus the game observation the witness filed for it. */
async function witnessedScore(opts: {
    roomId: string; tournamentId: string; gameId: string;
    username: string; userId: string; score: number; launchMs: number; exitMs: number;
}): Promise<number> {
    const db = await getDatabase();
    const res = await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            platform, engine, device, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'vpx', ?, ?, ?, 'vpxs', 'vpx', 'atgames', ?)`,
        GAME, opts.roomId, opts.gameId, opts.username, opts.userId, opts.score,
        opts.roomId, opts.tournamentId, opts.userId, sqliteTs(opts.exitMs),
    );
    const launch = Math.floor(opts.launchMs / 1000);
    const exit = Math.floor(opts.exitMs / 1000);
    await db.run(
        `INSERT INTO witness_observations
            (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via, kind)
         VALUES (?, ?, 'mm_109c', ?, ?, ?, 'live', 'game')`,
        `dev-${opts.userId}`, opts.userId, launch, exit, exit - launch,
    );
    return res.lastID as number;
}

interface Fixture {
    roomId: string;
    tournamentId: string;
    roundId: string;
    rotationId: string;
    rotationGameId: string;
    aFlagged: number;
    aVerified: number;
    bVerified: number;
    cFlagged: number;
}

async function makeFixture(): Promise<Fixture> {
    const db = await getDatabase();
    const roomId = await createTestRoom(`w52-${crypto.randomUUID().slice(0, 8)}`);
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, witness_flag_mode)
         VALUES (?, 'WWS Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 'prevent')`,
        tournamentId, roomId,
    );
    const rounds = await EventService.createOrUpdateEvent(tournamentId, {
        rounds: [{
            roundNo: 1,
            gameName: GAME,
            scheduledStartAt: new Date(BASE).toISOString(),
            scheduledEndAt: new Date(BASE + 30 * MINUTE).toISOString(),
        }],
        checkinRequired: false,
    });
    const roundId = rounds[0]!.id;
    await db.run(`UPDATE games SET status = 'ACTIVE', start_date = ? WHERE id = ?`, sqliteTs(BASE), roundId);

    // A: geared up (launched 5 min BEFORE the round) for 900, then a clean 500.
    const aFlagged = await witnessedScore({
        roomId, tournamentId, gameId: roundId, username: 'TomatoGrass', userId: USER_A,
        score: 900, launchMs: BASE - 5 * MINUTE, exitMs: BASE + 10 * MINUTE,
    });
    const aVerified = await witnessedScore({
        roomId, tournamentId, gameId: roundId, username: 'TomatoGrass', userId: USER_A,
        score: 500, launchMs: BASE + 16 * MINUTE, exitMs: BASE + 20 * MINUTE,
    });
    // B: one clean 700.
    const bVerified = await witnessedScore({
        roomId, tournamentId, gameId: roundId, username: 'Bee', userId: USER_B,
        score: 700, launchMs: BASE + 8 * MINUTE, exitMs: BASE + 12 * MINUTE,
    });
    // C: ONLY a geared-up 800 - under prevent, C is not on the round board at all.
    const cFlagged = await witnessedScore({
        roomId, tournamentId, gameId: roundId, username: 'Sea', userId: USER_C,
        score: 800, launchMs: BASE - 3 * MINUTE, exitMs: BASE + 14 * MINUTE,
    });

    // A rotation game in the same room, with an ordinary typed score.
    const rotationId = await createTestTournament(roomId, { name: 'Weekly' });
    const rotationGameId = await createTestGame(rotationId, { name: ROTATION_GAME, startDate: sqliteTs(BASE - 60 * MINUTE) });
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, iscored_username, discord_user_id, score, source,
            submitted_during_tournament_id, submitted_by_user_id, platform, engine, device, created_at
         ) VALUES (?, ?, 'Bee', ?, 4242, 'tournament', ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        ROTATION_GAME, roomId, USER_B, rotationId, USER_B, sqliteTs(BASE),
    );

    return { roomId, tournamentId, roundId, rotationId, rotationGameId, aFlagged, aVerified, bVerified, cFlagged };
}

async function roundBoard(f: Fixture) {
    const event = (await EventService.getEvent(f.tournamentId))!;
    const round = (await EventService.getRounds(f.tournamentId))[0]!;
    return (await EventResultService.getRoundBoardDetail(event, round)).board;
}

async function setFlagMode(f: Fixture, mode: 'prevent' | 'flag') {
    const db = await getDatabase();
    await db.run(`UPDATE tournaments SET witness_flag_mode = ? WHERE id = ?`, mode, f.tournamentId);
}

/** A `submissions` row only (no score_history twin), as the legacy upsert leaves one. */
async function submissionRow(gameId: string, username: string, userId: string, score: number) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        `${gameId}-${username.toLowerCase()}`, gameId, userId, username, score, new Date(BASE).toISOString(),
    );
}

describe('W52 - an event round ranks as its standings everywhere', () => {
    let f: Fixture;

    beforeEach(async () => {
        await setupTestDb();
        f = await makeFixture();
    });

    it('getForGame on an event round under prevent returns the round board order', async () => {
        const rankings = await LeaderboardService.getForGame(f.roundId);
        expect(rankings.map(r => r.history_id)).toEqual([f.bVerified, f.aVerified]);
        expect(rankings.map(r => r.score)).toEqual([700, 500]);
        expect(rankings.map(r => r.rank)).toEqual([1, 2]);

        const board = await roundBoard(f);
        expect(rankings.map(r => [r.history_id, r.iscored_username, r.score]))
            .toEqual(board.scores.map(s => [s.history_id, s.iscored_username, s.score]));
        // The verdict rides along (the web reads it; Discord ignores it).
        expect(rankings.every(r => r.witness?.status === 'verified')).toBe(true);
    });

    it('getForGameByProvenance and getForGameByPlatform on the round return the same order', async () => {
        const board = await roundBoard(f);
        const expected = board.scores.map(s => [s.history_id, s.score]);

        const byEngine = await LeaderboardService.getForGameByProvenance(f.roundId, { engine: 'vpx' });
        expect(byEngine.map(r => [r.history_id, r.score])).toEqual(expected);

        const byPlatform = await LeaderboardService.getForGameByPlatform(f.roundId, 'vpxs');
        expect(byPlatform.map(r => [r.history_id, r.score])).toEqual(expected);

        // A tab no row matches is empty, never a re-ranked raw board.
        expect(await LeaderboardService.getForGameByProvenance(f.roundId, { engine: 'fx' })).toEqual([]);
    });

    it('under flag every row stays, the flagged one first (still the round board)', async () => {
        await setFlagMode(f, 'flag');
        const rankings = await LeaderboardService.getForGame(f.roundId);
        const board = await roundBoard(f);
        expect(rankings.map(r => r.history_id)).toEqual(board.scores.map(s => s.history_id));
        expect(rankings[0]!.history_id).toBe(f.aFlagged);
    });

    it('a rotation game returns exactly the cached rows, with no witness field', async () => {
        const rankings = await LeaderboardService.getForGame(f.rotationGameId);
        const db = await getDatabase();
        const cached = await db.get<{ rankings: string }>(
            'SELECT rankings FROM leaderboard_cache WHERE game_id = ?', f.rotationGameId,
        );
        expect(cached).toBeTruthy();
        const rows = JSON.parse(cached!.rankings).rows as Array<{ rank: number; history_id: number; score: number; iscored_username: string }>;
        expect(rankings.map(r => [r.rank, r.history_id, r.score, r.iscored_username]))
            .toEqual(rows.map(r => [r.rank, r.history_id, r.score, r.iscored_username]));
        expect(rankings.every(r => !('witness' in r))).toBe(true);

        const byEngine = await LeaderboardService.getForGameByProvenance(f.rotationGameId, { engine: 'vpx' });
        expect(byEngine.map(r => r.score)).toEqual([4242]);
        expect(byEngine.every(r => !('witness' in r))).toBe(true);
    });

    it('the round read never writes or changes leaderboard_cache', async () => {
        const db = await getDatabase();
        const before = await db.all('SELECT game_id, rankings FROM leaderboard_cache ORDER BY game_id');
        await LeaderboardService.getForGame(f.roundId);
        await LeaderboardService.getForGameByProvenance(f.roundId, { engine: 'vpx' });
        expect(await db.all('SELECT game_id, rankings FROM leaderboard_cache ORDER BY game_id')).toEqual(before);
    });

    describe('Discord', () => {
        const savedEnv = process.env.DISCORD_GUILD_ID;
        beforeEach(() => { delete process.env.DISCORD_GUILD_ID; });
        afterEach(() => {
            if (savedEnv === undefined) delete process.env.DISCORD_GUILD_ID;
            else process.env.DISCORD_GUILD_ID = savedEnv;
        });

        it('/list-scores names the clean leader of the round, the prevented score nowhere', async () => {
            await GameRoomSettingsService.set(f.roomId, 'DISCORD_GUILD_ID', GUILD);
            const replies: unknown[] = [];
            const interaction = {
                user: { id: `w52-${crypto.randomUUID()}`, tag: 'w52#0000', displayName: 'W52' },
                guildId: GUILD,
                options: {
                    getString: () => null, getUser: () => null, getInteger: () => null,
                    getBoolean: () => null, getFocused: () => '',
                },
                deferReply: async () => {},
                editReply: async (payload: unknown) => { replies.push(payload); return payload; },
                reply: async (payload: unknown) => { replies.push(payload); return payload; },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any;
            await listscores.execute(interaction);

            const text = JSON.stringify(replies);
            expect(text).toContain(GAME);
            expect(text).toContain('**1.** **Bee**');
            expect(text).toContain('**2.** **TomatoGrass**');
            expect(text).not.toContain('900');
            expect(text).not.toContain('**Sea**');
        });

        it('the chat leaders action names the clean leader of the round', async () => {
            const out = await renderCalloutAction(
                'leaders',
                { roomIds: [f.roomId], legacyEnv: false },
                [{ id: f.roomId, name: 'W52 Room', slug: 'w52' }],
            );
            expect(out).toContain(`**${GAME}**: Bee`);
            expect(out).toContain('700');
            expect(out).not.toContain('900');
        });
    });

    describe('Stats', () => {
        it('getGameStats with the prevented ids leaves them out of avg / unique players / all-time high', async () => {
            const prevented = await EventResultService.preventedHistoryIds(f.roomId, GAME);
            expect(prevented.sort()).toEqual([f.aFlagged, f.cFlagged].sort());

            const stats = await StatsService.getGameStats(GAME, f.roomId, undefined, false, prevented);
            expect(stats!.allTimeHigh).toBe(700);
            expect(stats!.allTimeHighPlayer).toBe('Bee');
            expect(stats!.avgScore).toBe(600); // (500 + 700) / 2
            expect(stats!.uniquePlayers).toBe(2); // C's only score is prevented
        });

        it('getGameStats without the parameter is unchanged', async () => {
            const stats = await StatsService.getGameStats(GAME, f.roomId);
            expect(stats!.allTimeHigh).toBe(900);
            expect(stats!.allTimeHighPlayer).toBe('TomatoGrass');
            expect(stats!.avgScore).toBe(725); // (900 + 500 + 700 + 800) / 4
            expect(stats!.uniquePlayers).toBe(3);
        });

        it('recentResults names the round board winner of a finished round, the submissions top otherwise', async () => {
            const db = await getDatabase();
            await db.run(`UPDATE games SET status = 'COMPLETED', end_date = ? WHERE id = ?`,
                sqliteTs(BASE + 31 * MINUTE), f.roundId);
            // The legacy best-per-player rows: the geared-up 900 tops them.
            await submissionRow(f.roundId, 'TomatoGrass', USER_A, 900);
            await submissionRow(f.roundId, 'Sea', USER_C, 800);
            await submissionRow(f.roundId, 'Bee', USER_B, 700);

            const stats = await StatsService.getGameStats(GAME, f.roomId);
            expect(stats!.recentResults).toHaveLength(1);
            expect(stats!.recentResults[0]).toEqual({
                tournament_name: 'WWS Night',
                winner_name: 'Bee',
                winner_score: 700,
                end_date: sqliteTs(BASE + 31 * MINUTE),
            });

            // Under flag the round board's winner IS the 900.
            await setFlagMode(f, 'flag');
            const flagged = await StatsService.getGameStats(GAME, f.roomId);
            expect(flagged!.recentResults[0]).toMatchObject({ winner_name: 'TomatoGrass', winner_score: 900 });

            // A finished rotation game keeps its top `submissions` row.
            await db.run(`UPDATE games SET status = 'COMPLETED', end_date = ? WHERE id = ?`,
                sqliteTs(BASE), f.rotationGameId);
            await submissionRow(f.rotationGameId, 'Bee', USER_B, 4242);
            const rotation = await StatsService.getGameStats(ROTATION_GAME, f.roomId);
            expect(rotation!.recentResults).toEqual([{
                tournament_name: 'Weekly', winner_name: 'Bee', winner_score: 4242, end_date: sqliteTs(BASE),
            }]);
        });

        it('getGamePlayerRankings with the prevented ids drops them; without, it is unchanged', async () => {
            const prevented = await EventResultService.preventedHistoryIds(f.roomId, GAME);

            const without = await StatsService.getGamePlayerRankings(GAME, f.roomId);
            expect(without.map(r => [r.iscored_username, r.best_score, r.times_played]))
                .toEqual([['TomatoGrass', 900, 2], ['Sea', 800, 1], ['Bee', 700, 1]]);

            const withIds = await StatsService.getGamePlayerRankings(GAME, f.roomId, prevented);
            expect(withIds.map(r => [r.rank, r.iscored_username, r.best_score, r.times_played]))
                .toEqual([[1, 'Bee', 700, 1], [2, 'TomatoGrass', 500, 1]]);

            // No room scope (all rooms by name) applies the same exclusion.
            const unscoped = await StatsService.getGamePlayerRankings(GAME, undefined, prevented);
            expect(unscoped.map(r => r.iscored_username)).toEqual(['Bee', 'TomatoGrass']);
        });

        it('the game page routes apply it: Top Players and game stats', async () => {
            const app = await createTestApp();
            const players = await request(app).get(`/api/rooms/${f.roomId}/stats/game/${encodeURIComponent(GAME)}/players`);
            expect(players.status).toBe(200);
            expect(players.body.map((r: any) => r.iscored_username)).toEqual(['Bee', 'TomatoGrass']);
            expect(players.body[0].best_score).toBe(700);

            const stats = await request(app).get(`/api/rooms/${f.roomId}/stats/game/${encodeURIComponent(GAME)}`);
            expect(stats.body.allTimeHigh).toBe(700);
            expect(stats.body.uniquePlayers).toBe(2);

            // Under flag nothing is prevented: the 900 heads Top Players again.
            await setFlagMode(f, 'flag');
            const flagged = await request(app).get(`/api/rooms/${f.roomId}/stats/game/${encodeURIComponent(GAME)}/players`);
            expect(flagged.body[0]).toMatchObject({ iscored_username: 'TomatoGrass', best_score: 900 });
        });

        it('the per-game web read still carries the extras and the round order', async () => {
            const app = await createTestApp();
            const res = await request(app).get(`/api/rooms/${f.roomId}/leaderboard/${f.roundId}`);
            expect(res.body.rankings.map((r: any) => r.history_id)).toEqual([f.bVerified, f.aVerified]);
            expect(res.body.notCounted.map((r: any) => r.history_id).sort()).toEqual([f.aFlagged, f.cFlagged].sort());
            expect(res.body.witnessFlagMode).toBe('prevent');
        });
    });
});
