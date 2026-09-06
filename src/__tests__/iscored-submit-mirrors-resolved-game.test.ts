import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

/**
 * v2.155.2 — `syncScoreToIScored` reads `iscored_id` from the SAME game the
 * score was actually written to (item 4 of the ambiguous-active-games
 * follow-up), instead of its own unordered by-name `LIMIT 1`. A room with two
 * ACTIVE games sharing a name in different tournaments — each pointing at a
 * DIFFERENT iScored board — could otherwise mirror a score onto the WRONG
 * board.
 *
 * Follows the exact `IScoredApiClient` mocking pattern from
 * `iscored-submit-lock-logging.test.ts` (module-level `vi.mock`, hoisted, so
 * `database.js`'s singleton is loaded once and never reset mid-file).
 */

const submittedTo: Array<{ iscoredId: string; username: string; score: number }> = [];

vi.mock('../engine/IScoredApiClient.js', () => ({
    IScoredApiClient: class {
        constructor(_opts: unknown) { /* no network in tests */ }
        static parseGameroomName(url: string) { return url.split('/').pop() || null; }
        async submitScore(iscoredId: string, username: string, score: number) {
            submittedTo.push({ iscoredId, username, score });
        }
    },
}));

const { setupTestDb, createTestRoom, createTestTournament } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { syncScoreToIScored } = await import('../services/IScoredSubmitSync.js');

async function seedAmbiguousIScoredFixture(slug: string) {
    const db = await getDatabase();
    const roomId = await createTestRoom(slug, slug);
    for (const [key, value] of [
        ['ISCORED_ENABLED', 'true'], ['ISCORED_USERNAME', 'acct'], ['ISCORED_PASSWORD', 'pw'],
        ['ISCORED_PUBLIC_URL', 'https://example.invalid/acct'],
    ]) {
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
            roomId, key, value,
        );
    }
    const gameName = 'Black Rose';
    const tournamentA = await createTestTournament(roomId, { name: 'Weekly Grind - VR' });
    const tournamentB = await createTestTournament(roomId, { name: 'Daily Grind' });
    const gameA = crypto.randomUUID();
    const gameB = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, iscored_id, status, game_room_id, created_at)
         VALUES (?, ?, ?, 'ISCORED-A', 'ACTIVE', ?, datetime('now'))`,
        gameA, tournamentA, gameName, roomId,
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, iscored_id, status, game_room_id, created_at)
         VALUES (?, ?, ?, 'ISCORED-B', 'ACTIVE', ?, datetime('now'))`,
        gameB, tournamentB, gameName, roomId,
    );
    return { roomId, gameName, gameA, gameB };
}

describe('syncScoreToIScored — mirrors onto the SAME game as gameId', () => {
    beforeEach(async () => {
        await setupTestDb();
        submittedTo.length = 0;
        delete process.env.ISCORED_API_ENABLED;
    });

    it('reads iscored_id from the game gameId points at (B), not the name-only default', async () => {
        const fx = await seedAmbiguousIScoredFixture('iscored-mirror-b');

        await syncScoreToIScored({
            roomId: fx.roomId, gameName: fx.gameName, username: 'Tester', score: 500, gameId: fx.gameB,
        });

        expect(submittedTo).toEqual([{ iscoredId: 'ISCORED-B', username: 'Tester', score: 500 }]);
    });

    it('reads iscored_id from the game gameId points at (A) when that is the target instead', async () => {
        const fx = await seedAmbiguousIScoredFixture('iscored-mirror-a');

        await syncScoreToIScored({
            roomId: fx.roomId, gameName: fx.gameName, username: 'Tester', score: 700, gameId: fx.gameA,
        });

        expect(submittedTo).toEqual([{ iscoredId: 'ISCORED-A', username: 'Tester', score: 700 }]);
    });

    it('falls back to the name lookup when no gameId is given (back-compat for callers that never resolved one)', async () => {
        const fx = await seedAmbiguousIScoredFixture('iscored-mirror-none');

        await syncScoreToIScored({
            roomId: fx.roomId, gameName: fx.gameName, username: 'Tester', score: 900,
        });

        // Either board is a defensible pick with NO gameId hint (that is
        // exactly the ambiguity this whole effort exists to remove upstream)
        // — this pins that the call still succeeds and picks ONE of them,
        // not that it fails or double-submits.
        expect(submittedTo.length).toBe(1);
        expect(['ISCORED-A', 'ISCORED-B']).toContain(submittedTo[0]!.iscoredId);
    });
});
