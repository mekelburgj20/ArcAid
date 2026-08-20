import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';

/**
 * INCIDENT (prod, 2026-08-20 03:00 UTC, tournament WG-VPXS).
 *
 * `runMaintenanceWork` loaded the queued rows ONCE at the top of the run and
 * fed a mutable copy to both the per-slot loop and the extra-slot fill loop.
 * Since the pick-delegation arc (2026-08-17) the per-slot cascade consumes
 * queued rows through FRESH reads (`nextEligibleQueuedFor`) and flips the
 * chosen row to ACTIVE — so the run-start snapshot goes stale the moment a
 * slot activates something.
 *
 * The extra-slot loop then re-encountered the just-activated game ("Bad
 * Cats"), `isGameEligible` returned false (its own brand-new ACTIVE row counts
 * as "played within the lookback"), and the cooldown branch issued
 * `DELETE FROM games WHERE id = ?` against a live ACTIVE game with an open
 * iScored board. Only the `leaderboard_cache.game_id -> games.id` NO-ACTION FK
 * stopped it; the thrown SQLITE_CONSTRAINT aborted the run mid-way (the second
 * slot was never filled, `maintenance_runs.outcome='error'`).
 *
 * These tests use the real `runMaintenance` path with `ISCORED_ENABLED=false`
 * so `getIScoredCredsForRoom` short-circuits instead of launching Playwright —
 * the same idiom as `pick-award-gate.test.ts`.
 */

let roomCounter = 0;

async function setupTournament(opts: { maxActive?: number; winnerPicks?: number } = {}) {
    const db = await getDatabase();
    const roomId = await createTestRoom(`stale-queue-${++roomCounter}`, 'Stale Queue Room');
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tournamentId = await createTestTournament(roomId, { name: 'WG-VPXS' });
    await db.run(
        'UPDATE tournaments SET max_active_games = ?, winner_picks = ? WHERE id = ?',
        opts.maxActive ?? 2, opts.winnerPicks ?? 1, tournamentId,
    );
    PickAwardGate.invalidate();
    return { roomId, tournamentId };
}

/** Top score attributed to a real player id, so the cascade resolves a winner. */
async function seedWinningScore(gameId: string, playerId: string, username = 'Winner') {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        `${gameId}-${username.toLowerCase()}`, gameId, playerId, playerId, username, 99999,
        new Date().toISOString(),
    );
}

/** The FK that turned a destructive DELETE into an aborted run. */
async function seedLeaderboardCache(gameId: string) {
    const db = await getDatabase();
    await db.run(
        'INSERT INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, ?, ?)',
        gameId, JSON.stringify({ v: 1, rows: [] }), new Date().toISOString(),
    );
}

/** A COMPLETED run of `name` inside the lookback window makes it ineligible. */
async function seedRecentlyPlayed(tournamentId: string, name: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, start_date, end_date)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?)`,
        crypto.randomUUID(), tournamentId, name,
        new Date().toISOString(), new Date().toISOString(),
    );
}

async function gameRow(id: string) {
    const db = await getDatabase();
    return db.get('SELECT id, name, status, queue_order FROM games WHERE id = ?', id);
}

describe('Maintenance — stale queued-row snapshot (prod incident 2026-08-20)', () => {
    beforeEach(async () => {
        await setupTestDb();
        PickAwardGate.invalidate();
    });

    it('REGRESSION: the extra-slot loop does not delete the game the cascade just activated', async () => {
        const db = await getDatabase();
        const { tournamentId } = await setupTournament({ maxActive: 2 });
        const engine = TournamentEngine.getInstance();

        const activeId = await createTestGame(tournamentId, { name: 'Blackbelt 2018', status: 'ACTIVE' });
        await seedWinningScore(activeId, 'WINNER_1');
        const queued = await engine.queueGame(tournamentId, 'Bad Cats', undefined, undefined, 'WINNER_1');
        // A cached leaderboard for the row is what the NO-ACTION FK hangs off —
        // in prod it was written by the activation's own recalc.
        await seedLeaderboardCache(queued.id);

        // Pre-fix this rejected with SQLITE_CONSTRAINT out of the extra-slot loop.
        await expect(engine.runMaintenance(tournamentId)).resolves.toBeUndefined();

        const row = await gameRow(queued.id);
        expect(row).toBeDefined();
        expect(row.status).toBe('ACTIVE');
        // Part 5: an ACTIVE row is in nobody's queue any more.
        expect(row.queue_order).toBeNull();

        const run = await db.get(
            'SELECT outcome FROM maintenance_runs WHERE tournament_id = ? ORDER BY id DESC LIMIT 1',
            tournamentId,
        );
        expect(run?.outcome).not.toBe('error');
    });

    it('a queued twin of a now-ACTIVE game is LEFT QUEUED, not deleted (guard order)', async () => {
        const { tournamentId } = await setupTournament({ maxActive: 2 });
        const engine = TournamentEngine.getInstance();

        const activeId = await createTestGame(tournamentId, { name: 'Blackbelt 2018', status: 'ACTIVE' });
        await seedWinningScore(activeId, 'WINNER_1');
        // The winner's own pick — the cascade activates this one.
        await engine.queueGame(tournamentId, 'Bad Cats', undefined, undefined, 'WINNER_1');
        // Another player queued the same title. Once the winner's copy is ACTIVE
        // this row is a twin: the v2.103.0 guard says leave it queued. While the
        // cooldown check ran first it was deleted instead — the ACTIVE twin
        // trivially fails cooldown — making that guard dead code.
        const twin = await engine.queueGame(tournamentId, 'Bad Cats', undefined, undefined, 'OTHER_PLAYER');

        await engine.runMaintenance(tournamentId);

        const row = await gameRow(twin.id);
        expect(row).toBeDefined();
        expect(row.status).toBe('QUEUED');
    });

    it('a genuinely ineligible queued row is still removed, even with a cached leaderboard', async () => {
        const db = await getDatabase();
        // No ACTIVE games: the run goes straight to the extra-slot fill loop.
        const { tournamentId } = await setupTournament({ maxActive: 1 });
        const engine = TournamentEngine.getInstance();

        const stale = await engine.queueGame(tournamentId, 'Recently Played', undefined, undefined, 'PLAYER_A');
        await seedRecentlyPlayed(tournamentId, 'Recently Played');
        await seedLeaderboardCache(stale.id);

        // The cache row must not make the removal throw (part 3).
        await expect(engine.runMaintenance(tournamentId)).resolves.toBeUndefined();

        expect(await gameRow(stale.id)).toBeUndefined();
        expect(await db.get('SELECT game_id FROM leaderboard_cache WHERE game_id = ?', stale.id)).toBeUndefined();
    });

});

describe('nextEligibleQueuedFor — defensive removal (2026-08-20)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('drops an ineligible queued row that has a cached leaderboard, without throwing', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom(`neq-${++roomCounter}`, 'NEQ Room');
        const tournamentId = await createTestTournament(roomId, { name: 'NEQ' });
        const engine = TournamentEngine.getInstance();

        const stale = await engine.queueGame(tournamentId, 'Recently Played', undefined, undefined, 'PLAYER_A');
        const fresh = await engine.queueGame(tournamentId, 'Fresh Pick', undefined, undefined, 'PLAYER_A');
        await seedRecentlyPlayed(tournamentId, 'Recently Played');
        await seedLeaderboardCache(stale.id);

        const next = await engine.nextEligibleQueuedFor(tournamentId, 'PLAYER_A');

        expect(next?.id).toBe(fresh.id);
        expect(await gameRow(stale.id)).toBeUndefined();
        expect(await db.get('SELECT game_id FROM leaderboard_cache WHERE game_id = ?', stale.id)).toBeUndefined();
    });
});
