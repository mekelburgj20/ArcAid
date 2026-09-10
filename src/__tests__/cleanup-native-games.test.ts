import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { IScoredSessionRegistry } from '../engine/IScoredSessionRegistry.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import type { IScoredClient } from '../engine/IScoredClient.js';

// Regression lock for the RTX_Pinball Daily Grind incident (2026-09-09, v2.155.6):
// cleanup selected only COMPLETED games WITH an iscored_id. A room that has iScored
// switched off creates every game without one, so those games were invisible to
// cleanup forever and piled up on the board as locked cards. Every completed game
// must be considered; the ones that were never on iScored archive locally.

async function addCompletedGame(
    tournamentId: string,
    roomId: string,
    name: string,
    iscoredId: string | null,
    endedAt: string,
    roundNo: number | null = null,
): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, iscored_id, start_date, end_date, game_room_id, round_no)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?)`,
        id, tournamentId, name, iscoredId,
        new Date(Date.parse(endedAt) - 24 * 3600 * 1000).toISOString(), endedAt, roomId, roundNo,
    );
    return id;
}

const statusOf = async (id: string): Promise<string | undefined> => {
    const db = await getDatabase();
    const row = await db.get<{ status: string }>('SELECT status FROM games WHERE id = ?', id);
    return row?.status;
};

/** Fake Playwright client shaped like the kill-switch test's, for the session-registry cases. */
function makeFakeClient() {
    const deleteGame = vi.fn(async () => true);
    const client = {
        connect: async () => {},
        disconnect: async () => {},
        deleteGame,
        setGameStatus: vi.fn(async () => {}),
        getGamesOnIScored: vi.fn(async () => [] as unknown[]),
    } as unknown as IScoredClient;
    return { client, deleteGame };
}

afterEach(async () => {
    const reg = IScoredSessionRegistry.getInstance();
    reg.setClientFactoryForTests(null);
    await reg.shutdown();
});

describe('runCleanup — games that were never on iScored (no iscored_id)', () => {
    it('archives them when the room has no iScored at all (the RTX Daily Grind case)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-native', 'Cleanup Native');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const g1 = await addCompletedGame(tId, roomId, 'Star God 2019', null, '2026-09-02T03:00:00.000Z');
        const g2 = await addCompletedGame(tId, roomId, 'Big Shot', null, '2026-09-03T03:00:00.000Z');
        const g3 = await addCompletedGame(tId, roomId, 'House of Diamonds 2017', null, '2026-09-10T03:00:00.000Z');

        // sharedClient null + sharedCreds null → the room resolves to no iScored.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, null, null);

        expect(await statusOf(g1)).toBe('ARCHIVED');
        expect(await statusOf(g2)).toBe('ARCHIVED');
        expect(await statusOf(g3)).toBe('ARCHIVED');
    });

    it('never hands a missing id to deleteGame; rows WITH an id still go through the delete path', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-mixed', 'Cleanup Mixed');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const local = await addCompletedGame(tId, roomId, 'Never On iScored', null, '2026-09-03T03:00:00.000Z');
        const remote = await addCompletedGame(tId, roomId, 'Still On iScored', 'ISC_REMOTE', '2026-09-02T03:00:00.000Z');

        // The remote delete does NOT confirm → that row must stay COMPLETED to retry,
        // exactly as before. The local-only row has nothing to retry and archives now.
        const deleteGame = vi.fn(async () => false);
        const client = { deleteGame } as unknown as IScoredClient;
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, client, null);

        expect(deleteGame).toHaveBeenCalledTimes(1);
        expect(deleteGame).toHaveBeenCalledWith('ISC_REMOTE', 'Still On iScored');
        expect(await statusOf(local)).toBe('ARCHIVED');
        expect(await statusOf(remote)).toBe('COMPLETED');
    });

    it('a retain count is applied across both kinds, newest first', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-retain', 'Cleanup Retain');
        const tId = await createTestTournament(roomId, { name: 'Weekly Grind' });
        const oldest = await addCompletedGame(tId, roomId, 'Oldest (remote)', 'ISC_OLD', '2026-09-01T03:00:00.000Z');
        const middle = await addCompletedGame(tId, roomId, 'Middle (local)', null, '2026-09-02T03:00:00.000Z');
        const newest = await addCompletedGame(tId, roomId, 'Newest (local)', null, '2026-09-03T03:00:00.000Z');

        const deleteGame = vi.fn(async () => true);
        const client = { deleteGame } as unknown as IScoredClient;
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'retain', count: 1 }, client, null);

        expect(await statusOf(newest)).toBe('COMPLETED'); // retained: the single most recent
        expect(await statusOf(middle)).toBe('ARCHIVED');
        expect(await statusOf(oldest)).toBe('ARCHIVED');
        expect(deleteGame).toHaveBeenCalledTimes(1);
        expect(deleteGame).toHaveBeenCalledWith('ISC_OLD', 'Oldest (remote)');
    });

    it('with nothing past the retain count it changes nothing and calls nothing', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-noop', 'Cleanup Noop');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const a = await addCompletedGame(tId, roomId, 'A', null, '2026-09-02T03:00:00.000Z');
        const b = await addCompletedGame(tId, roomId, 'B', 'ISC_B', '2026-09-03T03:00:00.000Z');

        const deleteGame = vi.fn(async () => true);
        const client = { deleteGame } as unknown as IScoredClient;
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'retain', count: 5 }, client, null);

        expect(deleteGame).not.toHaveBeenCalled();
        expect(await statusOf(a)).toBe('COMPLETED');
        expect(await statusOf(b)).toBe('COMPLETED');
    });

    it('a Live Event ROUND (round_no set) is never a cleanup candidate', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-event', 'Cleanup Event');
        const tId = await createTestTournament(roomId, { name: 'Friday Night Event' });
        const round1 = await addCompletedGame(tId, roomId, 'Round 1 Table', null, '2026-09-05T02:00:00.000Z', 1);
        const rotation = await addCompletedGame(tId, roomId, 'Rotation Table', null, '2026-09-05T02:00:00.000Z');

        // The default `retain 0` rule is what Discord /run-cleanup hands an event.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'retain', count: 0 }, null, null);

        expect(await statusOf(round1)).toBe('COMPLETED'); // the event clock owns rounds
        expect(await statusOf(rotation)).toBe('ARCHIVED');
    });

    it('a native-only pass opens no iScored session even when the room has creds', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cleanup-nosession', 'Cleanup No Session');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'true');
        await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'testacct');
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'testpw');
        await GameRoomSettingsService.set(roomId, 'ISCORED_PUBLIC_URL', 'https://iscored.info/testacct');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const local = await addCompletedGame(tId, roomId, 'Never On iScored', null, '2026-09-03T03:00:00.000Z');

        const fake = makeFakeClient();
        const factory = vi.fn(() => fake.client);
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(factory);

        // The standalone shape (runScheduledCleanup / Discord): no shared client,
        // creds left for runCleanup to resolve. Nothing remote → no login at all.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' });
        expect(factory).not.toHaveBeenCalled();
        expect(fake.deleteGame).not.toHaveBeenCalled();
        expect(await statusOf(local)).toBe('ARCHIVED');

        // Positive control: a row that IS on iScored still opens the session.
        const remote = await addCompletedGame(tId, roomId, 'On iScored', 'ISC_R', '2026-09-04T03:00:00.000Z');
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' });
        expect(factory).toHaveBeenCalledTimes(1);
        expect(fake.deleteGame).toHaveBeenCalledWith('ISC_R', 'On iScored');
        expect(await statusOf(remote)).toBe('ARCHIVED');
    });

    it('archiving clears EVERY reference to a purged photo, not just score_history', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('cleanup-photos', 'Cleanup Photos');
        const tId = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gameId = await addCompletedGame(tId, roomId, 'Photo Table', null, '2026-09-03T03:00:00.000Z');
        const url = '/api/score-photos/cleanup-photos/purged.jpg';
        const keepUrl = '/api/score-photos/cleanup-photos/kept.jpg';

        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, score, photo_url, source)
             VALUES ('Photo Table', ?, ?, 'alice', 1000, ?, 'tournament')`, roomId, gameId, url);
        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, score, photo_url)
             VALUES ('Photo Table', ?, 'alice', 1000, ?)`, roomId, url);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp)
             VALUES (?, ?, 'u-alice', 'alice', 1000, ?, ?)`, crypto.randomUUID(), gameId, url, new Date().toISOString());
        await db.run(`INSERT INTO global_games (id, name) VALUES ('gg-photo', 'Photo Table')`);
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, score, photo_url, origin_type, origin_game_room_id, origin_game_id)
             VALUES ('gs-purged', 'gg-photo', 'u-alice', 1000, ?, 'room', ?, ?)`, url, roomId, gameId);
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, score, photo_url, origin_type, origin_game_room_id, origin_game_id)
             VALUES ('gs-kept', 'gg-photo', 'u-bob', 900, ?, 'room', ?, ?)`, keepUrl, roomId, gameId);

        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'immediate' }, null, null);
        expect(await statusOf(gameId)).toBe('ARCHIVED');

        const nulls = async (table: string): Promise<number> =>
            (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE photo_url = ?`, url))!.n;
        expect(await nulls('score_history')).toBe(0);
        expect(await nulls('community_scores')).toBe(0);
        expect(await nulls('submissions')).toBe(0);
        expect(await nulls('global_scores')).toBe(0);
        // Only the purged file's references go; a different photo of the same game survives.
        const kept = await db.get<{ photo_url: string | null }>(`SELECT photo_url FROM global_scores WHERE id = 'gs-kept'`);
        expect(kept?.photo_url).toBe(keepUrl);
    });

    it('the back-to-back-winner block still sees a previous slot that cleanup ARCHIVED', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('cleanup-dynasty', 'Cleanup Dynasty');
        const tId = await createTestTournament(roomId, { name: 'Weekly Grind' });
        await db.run('UPDATE tournaments SET allow_dynasty = 0 WHERE id = ?', tId);
        const prev = await addCompletedGame(tId, roomId, 'Last Week', null, '2026-09-03T03:00:00.000Z');
        const current = await addCompletedGame(tId, roomId, 'This Week', null, '2026-09-10T03:00:00.000Z');
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
             VALUES (?, ?, 'COMMUNITY', 'u-alice', 'alice', 5000, ?)`,
            `${prev}-alice`, prev, new Date().toISOString());

        // The maintenance pass that completes a slot archives the previous one
        // straight away under `immediate` / `retain` — so by the time the winner
        // is resolved, last week's row is ARCHIVED, not COMPLETED.
        await TournamentEngine.getInstance().runCleanup(tId, { mode: 'retain', count: 1 }, null, null);
        expect(await statusOf(prev)).toBe('ARCHIVED');
        expect(await statusOf(current)).toBe('COMPLETED');

        const engine = TournamentEngine.getInstance() as unknown as {
            isDynastyBlocked: (db: unknown, t: unknown, g: { id: string }, winnerId: string | null) => Promise<boolean>;
        };
        const tournamentRow = await db.get('SELECT * FROM tournaments WHERE id = ?', tId);
        expect(await engine.isDynastyBlocked(db, tournamentRow, { id: current }, 'u-alice')).toBe(true);
        expect(await engine.isDynastyBlocked(db, tournamentRow, { id: current }, 'u-bob')).toBe(false);
    });
});
