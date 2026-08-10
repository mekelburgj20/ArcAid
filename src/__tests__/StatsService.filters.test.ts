import { describe, it, expect } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { StatsService } from '../services/StatsService.js';

/**
 * v2.9x — tournament-type + time-window filters on the public Stats page
 * endpoints. Pins the boundary semantics documented on
 * `StatsService.StatsWindowFilters`: `[from, to)` — `from` inclusive, `to`
 * exclusive — compared against `g.end_date` (the game/round's completion
 * date), plus the type filter and how the two compose.
 */
describe('StatsService window/type filters', () => {
    describe('getEnhancedAllPlayerStats', () => {
        it('from is inclusive and to is exclusive on g.end_date', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId, { type: 'DG' });

            // Ends exactly at the window's lower bound — included.
            const gAtFrom = await createTestGame(tId, { status: 'COMPLETED', endDate: '2026-08-03T00:00:00.000Z' });
            await createTestSubmission(gAtFrom, { username: 'Alice', score: 100 });

            // Ends exactly at the window's upper bound — excluded (half-open).
            const gAtTo = await createTestGame(tId, { status: 'COMPLETED', endDate: '2026-08-10T00:00:00.000Z' });
            await createTestSubmission(gAtTo, { username: 'Alice', score: 200 });

            // Safely inside the window — included.
            const gInside = await createTestGame(tId, { status: 'COMPLETED', endDate: '2026-08-05T12:00:00.000Z' });
            await createTestSubmission(gInside, { username: 'Alice', score: 150 });

            // Safely outside the window — excluded.
            const gOutside = await createTestGame(tId, { status: 'COMPLETED', endDate: '2026-09-01T00:00:00.000Z' });
            await createTestSubmission(gOutside, { username: 'Alice', score: 300 });

            const stats = await StatsService.getEnhancedAllPlayerStats(roomId, {
                from: '2026-08-03T00:00:00.000Z',
                to: '2026-08-10T00:00:00.000Z',
            });
            const alice = stats.find((p: any) => p.iscored_username.toLowerCase() === 'alice');
            expect(alice).toBeDefined();
            expect(alice.games_played).toBe(2); // gAtFrom + gInside only
        });

        it('with no filters, behaves exactly as the unfiltered call (today\'s default)', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId, { type: 'DG' });
            const g = await createTestGame(tId, { status: 'COMPLETED', endDate: '2026-01-01T00:00:00.000Z' });
            await createTestSubmission(g, { username: 'Zoe', score: 42 });

            const unfiltered = await StatsService.getEnhancedAllPlayerStats(roomId);
            const explicitEmpty = await StatsService.getEnhancedAllPlayerStats(roomId, {});
            expect(explicitEmpty).toEqual(unfiltered);
            expect(unfiltered.find((p: any) => p.iscored_username.toLowerCase() === 'zoe')).toBeDefined();
        });

        it('filters by tournament type', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const dg = await createTestTournament(roomId, { type: 'DG' });
            const wg = await createTestTournament(roomId, { type: 'WG' });
            const gDg = await createTestGame(dg, { status: 'COMPLETED', endDate: new Date().toISOString() });
            const gWg = await createTestGame(wg, { status: 'COMPLETED', endDate: new Date().toISOString() });
            await createTestSubmission(gDg, { username: 'Bob', score: 500 });
            await createTestSubmission(gWg, { username: 'Bob', score: 600 });

            const dgOnly = await StatsService.getEnhancedAllPlayerStats(roomId, { type: 'DG' });
            const bobDg = dgOnly.find((p: any) => p.iscored_username.toLowerCase() === 'bob');
            expect(bobDg.games_played).toBe(1);

            const all = await StatsService.getEnhancedAllPlayerStats(roomId);
            const bobAll = all.find((p: any) => p.iscored_username.toLowerCase() === 'bob');
            expect(bobAll.games_played).toBe(2);
        });

        it('composes type AND window, not OR', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const dg = await createTestTournament(roomId, { type: 'DG' });
            const wg = await createTestTournament(roomId, { type: 'WG' });
            const gDgInWindow = await createTestGame(dg, { status: 'COMPLETED', endDate: '2026-08-05T00:00:00.000Z' });
            const gDgOutWindow = await createTestGame(dg, { status: 'COMPLETED', endDate: '2026-09-01T00:00:00.000Z' });
            const gWgInWindow = await createTestGame(wg, { status: 'COMPLETED', endDate: '2026-08-05T00:00:00.000Z' });
            await createTestSubmission(gDgInWindow, { username: 'Cara', score: 10 });
            await createTestSubmission(gDgOutWindow, { username: 'Cara', score: 10 });
            await createTestSubmission(gWgInWindow, { username: 'Cara', score: 10 });

            const filtered = await StatsService.getEnhancedAllPlayerStats(roomId, {
                type: 'DG',
                from: '2026-08-03T00:00:00.000Z',
                to: '2026-08-10T00:00:00.000Z',
            });
            const cara = filtered.find((p: any) => p.iscored_username.toLowerCase() === 'cara');
            expect(cara.games_played).toBe(1); // only gDgInWindow qualifies on BOTH axes
        });
    });

    describe('getGameActivityStats', () => {
        it('drops the community_scores branch entirely when a type filter is active', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const dg = await createTestTournament(roomId, { type: 'DG' });
            const gDg = await createTestGame(dg, { status: 'COMPLETED', endDate: new Date().toISOString(), name: 'Tourney Game' });
            await createTestSubmission(gDg, { username: 'Dave', score: 10 });

            const db = await getDatabase();
            await db.run(
                `INSERT INTO community_scores (game_name, game_room_id, iscored_username, score, created_at) VALUES (?, ?, ?, ?, ?)`,
                'Pinned Game', roomId, 'Dave', 999, new Date().toISOString(),
            );

            const noFilter = await StatsService.getGameActivityStats(roomId);
            expect(noFilter.some((g: any) => g.name === 'Pinned Game')).toBe(true);
            expect(noFilter.some((g: any) => g.name === 'Tourney Game')).toBe(true);

            // A type filter can't be evaluated against a pinned/community score
            // (no tournament to read a type from) — the whole branch is
            // dropped rather than silently ignoring the filter for it.
            const withType = await StatsService.getGameActivityStats(roomId, { type: 'DG' });
            expect(withType.some((g: any) => g.name === 'Pinned Game')).toBe(false);
            expect(withType.some((g: any) => g.name === 'Tourney Game')).toBe(true);
        });

        it('window filter is [from, to) on the tournament branch (g.end_date) and the community branch (cs.created_at)', async () => {
            await setupTestDb();
            const roomId = await createTestRoom();
            const dg = await createTestTournament(roomId, { type: 'DG' });
            const gIn = await createTestGame(dg, { status: 'COMPLETED', endDate: '2026-08-05T00:00:00.000Z', name: 'In-Window Game' });
            const gOut = await createTestGame(dg, { status: 'COMPLETED', endDate: '2026-09-01T00:00:00.000Z', name: 'Out-Window Game' });
            await createTestSubmission(gIn, { username: 'Eve', score: 1 });
            await createTestSubmission(gOut, { username: 'Eve', score: 1 });

            const db = await getDatabase();
            await db.run(
                `INSERT INTO community_scores (game_name, game_room_id, iscored_username, score, created_at) VALUES (?, ?, ?, ?, ?)`,
                'In-Window Pinned', roomId, 'Eve', 1, '2026-08-05T00:00:00.000Z',
            );
            await db.run(
                `INSERT INTO community_scores (game_name, game_room_id, iscored_username, score, created_at) VALUES (?, ?, ?, ?, ?)`,
                'Out-Window Pinned', roomId, 'Eve', 1, '2026-09-01T00:00:00.000Z',
            );

            const filtered = await StatsService.getGameActivityStats(roomId, {
                from: '2026-08-03T00:00:00.000Z',
                to: '2026-08-10T00:00:00.000Z',
            });
            const names = filtered.map((g: any) => g.name);
            expect(names).toContain('In-Window Game');
            expect(names).toContain('In-Window Pinned');
            expect(names).not.toContain('Out-Window Game');
            expect(names).not.toContain('Out-Window Pinned');
        });
    });
});
