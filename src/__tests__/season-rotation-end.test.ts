import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Season rotation hooks in TournamentEngine (docs/season-format-plan.md §6).
 *
 *   - Pause: maintenance skips with `season paused`, recorded in
 *     maintenance_runs; the current table stays ACTIVE.
 *   - Season end: at the bound (counting the table just completed) nothing
 *     more activates; `season_finished_at` is stamped once and the final top 3
 *     are announced once, with pings. Later runs skip with `season finished`.
 *   - The count is derived from game rows and ignores event rounds.
 */

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('discord.js')>();
    class REST {
        constructor(_opts?: unknown) {}
        setToken() { return this; }
        post = post;
        get = vi.fn(async () => ({ users: [] }));
        patch = vi.fn(async () => ({}));
    }
    return { ...actual, REST };
});

process.env.DISCORD_BOT_TOKEN = 'test-token';

const { setupTestDb, createTestGame, createTestSubmission } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { TournamentEngine } = await import('../engine/TournamentEngine.js');
const { PickAwardGate } = await import('../services/PickAwardGate.js');
const { SeasonPollService } = await import('../services/SeasonPollService.js');
const { createSeason } = await import('./seasonHelpers.js');

const ALICE = '200000000000000001';
const BOB = '200000000000000002';

beforeEach(async () => {
    await setupTestDb();
    PickAwardGate.invalidate();
    post.mockReset().mockResolvedValue({});
});

const standingsEmbeds = () => post.mock.calls
    .map(c => c[1]?.body)
    .filter(b => b?.embeds?.[0]?.title?.startsWith('Season Final Standings'));

async function lastRun(tournamentId: string) {
    const db = await getDatabase();
    return db.get('SELECT outcome, summary FROM maintenance_runs WHERE tournament_id = ? ORDER BY rowid DESC LIMIT 1', tournamentId);
}

async function statusOf(gameId: string) {
    const db = await getDatabase();
    return (await db.get('SELECT status FROM games WHERE id = ?', gameId))?.status;
}

describe('season end', () => {
    it('stamps once, announces the top 3 once with pings, activates nothing after the bound', async () => {
        const { tournamentId, season } = await createSeason({ tableCount: 2, pointsTop: 50 });
        const week1 = await createTestGame(tournamentId, { name: 'Week One', status: 'ARCHIVED' });
        await createTestSubmission(week1, { username: 'Alice', discordUserId: ALICE, score: 900 });
        await createTestSubmission(week1, { username: 'Bob', discordUserId: BOB, score: 800 });
        const week2 = await createTestGame(tournamentId, { name: 'Week Two', status: 'ACTIVE' });
        await createTestSubmission(week2, { username: 'Bob', discordUserId: BOB, score: 999 });
        await createTestSubmission(week2, { username: 'Alice', discordUserId: ALICE, score: 100 });
        const leftover = await TournamentEngine.getInstance().queueGame(tournamentId, 'Never Played');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        // Default cleanup (retain 0) archives the completed table straight away.
        expect(['COMPLETED', 'ARCHIVED']).toContain(await statusOf(week2));
        expect(await statusOf(leftover.id)).toBe('QUEUED');
        const db = await getDatabase();
        const t = await db.get('SELECT season_finished_at, is_active FROM tournaments WHERE id = ?', tournamentId);
        expect(t.season_finished_at).toBeTruthy();
        expect(t.is_active).toBe(1);

        const embeds = standingsEmbeds();
        expect(embeds).toHaveLength(1);
        const body = embeds[0]!;
        expect(body.embeds[0].title).toBe(`Season Final Standings — ${season.name}`);
        // Alice 50+49 = 99, Bob 49+50 = 99 — both appear, both pinged.
        expect(body.embeds[0].description).toContain('**99** pts');
        expect(body.allowed_mentions.users.sort()).toEqual([ALICE, BOB].sort());
        expect((await lastRun(tournamentId))).toMatchObject({ outcome: 'success', summary: expect.stringContaining('season finished') });

        // The cron keeps firing and keeps skipping; no second announcement.
        await TournamentEngine.getInstance().runMaintenance(tournamentId);
        expect(standingsEmbeds()).toHaveLength(1);
        expect(await lastRun(tournamentId)).toMatchObject({ outcome: 'skipped', summary: 'season finished' });
        expect(await statusOf(leftover.id)).toBe('QUEUED');
    });

    it('before the bound, the poll-queued table activates through the existing path', async () => {
        const { tournamentId } = await createSeason({ tableCount: 12 });
        const active = await createTestGame(tournamentId, { name: 'Week One', status: 'ACTIVE' });
        const next = await TournamentEngine.getInstance().queueGame(tournamentId, 'Week Two Table');

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        expect(['COMPLETED', 'ARCHIVED']).toContain(await statusOf(active));
        expect(await statusOf(next.id)).toBe('ACTIVE');
        const db = await getDatabase();
        expect((await db.get('SELECT season_finished_at FROM tournaments WHERE id = ?', tournamentId)).season_finished_at).toBeNull();
        expect(standingsEmbeds()).toHaveLength(0);
    });
});

describe('pause', () => {
    it('skips maintenance with a `season paused` run row and leaves the table open', async () => {
        const { tournamentId, season } = await createSeason();
        const active = await createTestGame(tournamentId, { name: 'Live Table', status: 'ACTIVE' });
        const queued = await TournamentEngine.getInstance().queueGame(tournamentId, 'Next Table');
        await SeasonPollService.setPaused(season, true);

        await TournamentEngine.getInstance().runMaintenance(tournamentId);

        expect(await lastRun(tournamentId)).toEqual({ outcome: 'skipped', summary: 'season paused' });
        expect(await statusOf(active)).toBe('ACTIVE');
        expect(await statusOf(queued.id)).toBe('QUEUED');
    });
});

describe('derived table count', () => {
    it('counts COMPLETED + ARCHIVED rotation games and ignores event rounds', async () => {
        const { tournamentId } = await createSeason();
        const db = await getDatabase();
        await createTestGame(tournamentId, { name: 'A', status: 'COMPLETED' });
        await createTestGame(tournamentId, { name: 'B', status: 'ARCHIVED' });
        await createTestGame(tournamentId, { name: 'C', status: 'ACTIVE' });
        const round = await createTestGame(tournamentId, { name: 'Round', status: 'COMPLETED' });
        await db.run('UPDATE games SET round_no = 1 WHERE id = ?', round);
        expect(await SeasonPollService.countTablesDone(tournamentId)).toBe(2);
    });

    it('un-counts a week when its game row is deleted', async () => {
        const { tournamentId } = await createSeason();
        const db = await getDatabase();
        const wrong = await createTestGame(tournamentId, { name: 'Wrong', status: 'COMPLETED' });
        expect(await SeasonPollService.countTablesDone(tournamentId)).toBe(1);
        await db.run('DELETE FROM games WHERE id = ?', wrong);
        expect(await SeasonPollService.countTablesDone(tournamentId)).toBe(0);
    });
});
