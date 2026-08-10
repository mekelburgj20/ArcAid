import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { StatsService } from '../services/StatsService.js';
import { listwinners } from '../discord/commands/listwinners.js';

/**
 * Drift-audit fix #3 — four raw `submissions` reads were missing the
 * `orphaned_at IS NULL` filter a ban cascade relies on (`ScoreReportService.
 * ban` sets `orphaned_at` on a banned identity's rows instead of deleting
 * them — see ban-content-cascade.test.ts). Without the filter, a banned
 * player's scores kept surfacing in `/list-winners`, `/my-stats`
 * (`StatsService.getPlayerStats`/`getPlayerStatsByUsername`), and a game's
 * "recent results" (`StatsService.getGameStats`).
 */

async function seedSubmission(gameId: string, opts: {
    username: string;
    discordUserId: string;
    score: number;
    orphaned?: boolean;
}) {
    const db = await getDatabase();
    const id = `${gameId}-${opts.username.toLowerCase()}`;
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, orphaned_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
        id, gameId, opts.discordUserId, opts.username, opts.score,
        opts.orphaned ? new Date().toISOString() : null,
    );
    return id;
}

function makeSimpleInteraction() {
    const replies: unknown[] = [];
    const interaction = {
        deferReply: async () => {},
        editReply: async (payload: unknown) => { replies.push(payload); return payload; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, replies };
}

describe('ban-cascade leaks — orphaned_at IS NULL (drift-audit fix #3)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('(a) /list-winners excludes an orphaned (banned) top score and shows the next legit one', async () => {
        const roomId = await createTestRoom('leak-listwinners');
        const tId = await createTestTournament(roomId, { name: 'Leak Winners Tournament' });
        const gameId = await createTestGame(tId, {
            name: 'Leak Winners Game', status: 'COMPLETED', endDate: new Date().toISOString(),
        });
        await seedSubmission(gameId, { username: 'BannedWinner', discordUserId: 'banned-1', score: 9000, orphaned: true });
        await seedSubmission(gameId, { username: 'LegitPlayer', discordUserId: 'legit-1', score: 5000 });

        const { interaction, replies } = makeSimpleInteraction();
        await listwinners.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).toContain('LegitPlayer');
        expect(text).not.toContain('BannedWinner');
    });

    it('(a) /list-winners shows nothing for a game whose only score is orphaned', async () => {
        const roomId = await createTestRoom('leak-listwinners-only');
        const tId = await createTestTournament(roomId, { name: 'Leak Winners Only Tournament' });
        const gameId = await createTestGame(tId, {
            name: 'Leak Winners Only Game', status: 'COMPLETED', endDate: new Date().toISOString(),
        });
        await seedSubmission(gameId, { username: 'OnlyBanned', discordUserId: 'banned-2', score: 9000, orphaned: true });

        const { interaction, replies } = makeSimpleInteraction();
        await listwinners.execute(interaction);

        const text = JSON.stringify(replies[replies.length - 1]);
        expect(text).not.toContain('OnlyBanned');
    });

    it('(b) StatsService.getPlayerStats excludes orphaned rows from totals, best score, and recent scores', async () => {
        const roomId = await createTestRoom('leak-getplayerstats');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Stats Game', status: 'COMPLETED' });
        await seedSubmission(gameId, { username: 'Alias1', discordUserId: 'stats-user-1', score: 9999, orphaned: true });
        await seedSubmission(gameId, { username: 'stats-user-1', discordUserId: 'stats-user-1', score: 1234 });

        const stats = await StatsService.getPlayerStats('stats-user-1', roomId);
        expect(stats.bestScore).toBe(1234);
        expect(stats.totalGamesPlayed).toBe(1);
        expect(stats.recentScores.some((r: { score: number }) => r.score === 9999)).toBe(false);
    });

    it('(c) StatsService.getPlayerStatsByUsername excludes orphaned rows', async () => {
        const roomId = await createTestRoom('leak-getplayerstatsbyname');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Stats By Name Game', status: 'COMPLETED' });
        await seedSubmission(gameId, { username: 'NamedPlayer', discordUserId: 'named-1', score: 9999, orphaned: true });

        const stats = await StatsService.getPlayerStatsByUsername('NamedPlayer', roomId);
        expect(stats.totalGamesPlayed).toBe(0);
        expect(stats.bestScore).toBe(0);
        expect(stats.recentScores.length).toBe(0);
    });

    it('(d) StatsService.getGameStats recentResults excludes an orphaned winner (was inconsistent with the stats/highHolder queries just above it)', async () => {
        const roomId = await createTestRoom('leak-getgamestats');
        const tId = await createTestTournament(roomId, { name: 'Leak Game Stats Tournament' });
        const gameId = await createTestGame(tId, {
            name: 'Leak Game Stats Game', status: 'COMPLETED', endDate: new Date().toISOString(),
        });
        await seedSubmission(gameId, { username: 'BannedTopScorer', discordUserId: 'banned-3', score: 9999, orphaned: true });
        await seedSubmission(gameId, { username: 'LegitRunnerUp', discordUserId: 'legit-3', score: 4000 });

        const gameStats = await StatsService.getGameStats('Leak Game Stats Game', roomId);
        expect(gameStats).toBeTruthy();
        const winnerNames = gameStats!.recentResults.map((r: { winner_name: string | null }) => r.winner_name);
        expect(winnerNames).not.toContain('BannedTopScorer');
        expect(winnerNames).toContain('LegitRunnerUp');
    });
});
