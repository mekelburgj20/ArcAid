import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Season poll resolve (docs/season-format-plan.md §5.4).
 *
 *   - Merge: a web vote beats a Discord vote for the same (canonical) person;
 *     a Discord voter who disappears loses only their `discord` row.
 *   - Ties: `random` (seeded by poll id, stable), `first_nominated`, and
 *     `admin` (applies the fallback now, `tied = 1`, admin may swap).
 *   - Eligibility falls through to the next-ranked candidate; none eligible
 *     resolves with no result and queues nothing.
 *   - `queueGame` runs exactly once, however many times the close replays.
 */

const { post, get, patch } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn() }));

vi.mock('discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('discord.js')>();
    class REST {
        constructor(_opts?: unknown) {}
        setToken() { return this; }
        post = post;
        get = get;
        patch = patch;
    }
    return { ...actual, REST };
});

process.env.DISCORD_BOT_TOKEN = 'test-token';

const { setupTestDb } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { SeasonPollService } = await import('../services/SeasonPollService.js');
const { createSeason, addCatalogueGame, openPollDirect } = await import('./seasonHelpers.js');

const VOTER_A = '100000000000000001';
const VOTER_B = '100000000000000002';
const VOTER_C = '100000000000000003';
const CLOSES = '2026-10-16T01:00:00.000Z';
const AFTER_CLOSE = new Date('2026-10-16T01:01:00.000Z');

/** voters per Discord answer id */
let discordVoters: Record<number, string[]> = {};

beforeEach(async () => {
    await setupTestDb();
    SeasonPollService._resetMemoryForTests();
    post.mockReset().mockResolvedValue({});
    patch.mockReset().mockResolvedValue({});
    get.mockReset().mockImplementation(async (route: string) => {
        const answerId = Number(route.split('/').pop());
        return { users: (discordVoters[answerId] ?? []).map(id => ({ id })) };
    });
    discordVoters = {};
});

async function seasonWithPoll(names: string[], opts: Parameters<typeof createSeason>[0] = {}, catalogue: string[] = names) {
    const ctx = await createSeason(opts);
    for (const n of catalogue) await addCatalogueGame(n);
    const poll = await SeasonPollService.createDraft(ctx.season, { candidates: names.map(game_name => ({ game_name })) });
    await openPollDirect(poll.id, { closesAt: CLOSES });
    return { ...ctx, pollId: poll.id };
}

async function votesOf(pollId: string) {
    const db = await getDatabase();
    return db.all('SELECT user_id, position, source FROM season_poll_votes WHERE poll_id = ? ORDER BY user_id', pollId);
}

async function queuedNames(tournamentId: string) {
    const db = await getDatabase();
    const rows = await db.all(`SELECT name FROM games WHERE tournament_id = ? AND status = 'QUEUED'`, tournamentId);
    return rows.map((r: any) => r.name);
}

describe('tally merge', () => {
    it('web beats discord for the same person; discord removal deletes only discord rows', async () => {
        const { roomId, pollId } = await seasonWithPoll(['Attack from Mars', 'Medieval Madness']);
        const poll = (await SeasonPollService.getPoll(pollId))!;

        await SeasonPollService.vote(roomId, pollId, VOTER_A, 1);
        discordVoters = { 2: [VOTER_A, VOTER_B] };
        expect(await SeasonPollService.syncDiscordVotes(poll)).toBe(true);
        expect(await votesOf(pollId)).toEqual([
            { user_id: VOTER_A, position: 1, source: 'web' },
            { user_id: VOTER_B, position: 2, source: 'discord' },
        ]);

        // B removes their Discord vote; A disappears from Discord too.
        discordVoters = {};
        await SeasonPollService.syncDiscordVotes(poll);
        expect(await votesOf(pollId)).toEqual([{ user_id: VOTER_A, position: 1, source: 'web' }]);
    });

    it('maps Discord voters through resolveCanonical', async () => {
        const { pollId } = await seasonWithPoll(['Attack from Mars', 'Medieval Madness']);
        const db = await getDatabase();
        await db.run('INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)', VOTER_C, 'google:canon');
        discordVoters = { 1: [VOTER_C] };
        await SeasonPollService.syncDiscordVotes((await SeasonPollService.getPoll(pollId))!);
        expect(await votesOf(pollId)).toEqual([{ user_id: 'google:canon', position: 1, source: 'discord' }]);
    });

    it('a failed voter read changes nothing', async () => {
        const { roomId, pollId } = await seasonWithPoll(['Attack from Mars', 'Medieval Madness']);
        discordVoters = { 1: [VOTER_B] };
        await SeasonPollService.syncDiscordVotes((await SeasonPollService.getPoll(pollId))!);
        get.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
        await SeasonPollService.syncDiscordVotes((await SeasonPollService.getPoll(pollId))!);
        expect(await votesOf(pollId)).toEqual([{ user_id: VOTER_B, position: 1, source: 'discord' }]);
        void roomId;
    });

    it('refuses a vote on a poll that is not open', async () => {
        const ctx = await createSeason();
        await addCatalogueGame('Attack from Mars');
        const draft = await SeasonPollService.createDraft(ctx.season, { candidates: [{ game_name: 'Attack from Mars' }] });
        await expect(SeasonPollService.vote(ctx.roomId, draft.id, VOTER_A, 1)).rejects.toMatchObject({ code: 'POLL_NOT_OPEN' });
    });
});

describe('tie rules', () => {
    const candidates = [1, 2, 3].map(position => ({
        poll_id: 'p', position, game_name: `G${position}`, global_game_id: null, discord_answer_id: null,
    }));
    const tally = new Map([[1, 2], [2, 2], [3, 2]]);

    it('first_nominated picks the lowest position among the tied', () => {
        const r = SeasonPollService.rankCandidates('poll-x', candidates, tally, 'first_nominated', 'random');
        expect(r.order[0]!.position).toBe(1);
        expect(r.tied).toBe(true);
        expect(r.tiedPositions).toEqual([1, 2, 3]);
    });

    it('random is seeded by the poll id — a re-run picks the same one', () => {
        const a = SeasonPollService.rankCandidates('poll-seed-1', candidates, tally, 'random', 'random').order[0]!.position;
        for (let i = 0; i < 5; i++) {
            expect(SeasonPollService.rankCandidates('poll-seed-1', candidates, tally, 'random', 'random').order[0]!.position).toBe(a);
        }
        const picks = new Set(Array.from({ length: 30 }, (_, i) =>
            SeasonPollService.rankCandidates(`poll-${i}`, candidates, tally, 'random', 'random').order[0]!.position));
        expect(picks.size).toBeGreaterThan(1);
    });

    it('admin applies the fallback', () => {
        const r = SeasonPollService.rankCandidates('poll-x', candidates, tally, 'admin', 'first_nominated');
        expect(r.order[0]!.position).toBe(1);
    });

    it('no tie when one candidate leads', () => {
        const r = SeasonPollService.rankCandidates('poll-x', candidates, new Map([[2, 3], [1, 1]]), 'admin', 'random');
        expect(r.order.map(c => c.position)).toEqual([2, 1, 3]);
        expect(r.tied).toBe(false);
    });
});

describe('closeAndResolve', () => {
    it('queues the winner once, announces it, and a replayed close does nothing', async () => {
        const { roomId, pollId, tournamentId, season } = await seasonWithPoll(['Attack from Mars', 'Medieval Madness']);
        await SeasonPollService.vote(roomId, pollId, VOTER_A, 2);
        await SeasonPollService.vote(roomId, pollId, VOTER_B, 2);
        await SeasonPollService.vote(roomId, pollId, VOTER_C, 1);

        const poll = (await SeasonPollService.getPoll(pollId))!;
        expect(await SeasonPollService.closeAndResolve(season, poll, AFTER_CLOSE)).toBe(true);
        expect(await SeasonPollService.closeAndResolve(season, poll, AFTER_CLOSE)).toBe(false);

        expect(await queuedNames(tournamentId)).toEqual(['Medieval Madness']);
        const resolved = (await SeasonPollService.getPoll(pollId))!;
        expect(resolved).toMatchObject({ status: 'resolved', result_game_name: 'Medieval Madness', tied: 0 });
        expect(resolved.result_queued_game_id).toBeTruthy();

        // Discord expired at close, and one "Next up" embed naming the tournament.
        const routes = post.mock.calls.map(c => c[0]);
        expect(routes).toContain('/channels/900000000000000001/polls/msg-1/expire');
        const embeds = post.mock.calls.filter(c => c[1]?.body?.embeds).map(c => c[1].body.embeds[0]);
        expect(embeds).toHaveLength(1);
        expect(embeds[0].title).toBe(`Next up: Medieval Madness — ${season.name}`);
        expect(embeds[0].description).toContain('2 votes to 1');
        expect(embeds[0].description).toContain(season.name);
    });

    it('admin tie: applies the fallback, marks tied, posts the tie notice; choose swaps the queued row', async () => {
        const { roomId, pollId, tournamentId, season } = await seasonWithPoll(
            ['Attack from Mars', 'Medieval Madness'], { tieRule: 'admin', tieFallback: 'first_nominated' },
        );
        await SeasonPollService.vote(roomId, pollId, VOTER_A, 1);
        await SeasonPollService.vote(roomId, pollId, VOTER_B, 2);

        await SeasonPollService.closeAndResolve(season, (await SeasonPollService.getPoll(pollId))!, AFTER_CLOSE);
        let poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll).toMatchObject({ result_game_name: 'Attack from Mars', tied: 1 });
        const notice = post.mock.calls.map(c => c[1]?.body?.content).find(t => typeof t === 'string' && t.includes('tie between'));
        expect(notice).toContain('Fallback picked Attack from Mars');

        const firstQueued = poll.result_queued_game_id;
        poll = await SeasonPollService.choose(season, pollId, 2);
        expect(poll.result_game_name).toBe('Medieval Madness');
        expect(poll.result_queued_game_id).not.toBe(firstQueued);
        expect(await queuedNames(tournamentId)).toEqual(['Medieval Madness']);

        // Once the queued table has started, the swap is refused.
        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE id = ?`, poll.result_queued_game_id);
        await expect(SeasonPollService.choose(season, pollId, 1)).rejects.toMatchObject({ code: 'ALREADY_STARTED' });
    });

    it('choose only accepts a tied candidate', async () => {
        const { roomId, pollId, season } = await seasonWithPoll(
            ['A Table', 'B Table', 'C Table'], { tieRule: 'admin', tieFallback: 'first_nominated' },
        );
        await SeasonPollService.vote(roomId, pollId, VOTER_A, 1);
        await SeasonPollService.vote(roomId, pollId, VOTER_B, 2);
        await SeasonPollService.closeAndResolve(season, (await SeasonPollService.getPoll(pollId))!, AFTER_CLOSE);
        await expect(SeasonPollService.choose(season, pollId, 3)).rejects.toMatchObject({ code: 'CANDIDATE_NOT_TIED' });
    });

    it('random tie is not flagged for admin override', async () => {
        const { roomId, pollId, season } = await seasonWithPoll(['A Table', 'B Table'], { tieRule: 'random' });
        await SeasonPollService.vote(roomId, pollId, VOTER_A, 1);
        await SeasonPollService.vote(roomId, pollId, VOTER_B, 2);
        await SeasonPollService.closeAndResolve(season, (await SeasonPollService.getPoll(pollId))!, AFTER_CLOSE);
        const poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll.tied).toBe(0);
        const expected = SeasonPollService.seededPick(pollId, ['A Table', 'B Table']);
        expect(poll.result_game_name).toBe(expected);
    });

    it('falls through to the next-ranked eligible candidate and says so', async () => {
        const { roomId, pollId, tournamentId, season } = await seasonWithPoll(['Gone Table', 'Medieval Madness']);
        await SeasonPollService.vote(roomId, pollId, VOTER_A, 1);
        await SeasonPollService.vote(roomId, pollId, VOTER_B, 1);
        await SeasonPollService.vote(roomId, pollId, VOTER_C, 2);
        // The winner leaves the catalogue after the poll opened.
        const db = await getDatabase();
        await db.run(`UPDATE global_games SET status = 'rejected' WHERE name = 'Gone Table'`);

        await SeasonPollService.closeAndResolve(season, (await SeasonPollService.getPoll(pollId))!, AFTER_CLOSE);
        expect(await queuedNames(tournamentId)).toEqual(['Medieval Madness']);
        const embed = post.mock.calls.find(c => c[1]?.body?.embeds)![1].body.embeds[0];
        expect(embed.description).toContain('**Gone Table** is not eligible');
    });

    it('resolves with no result and queues nothing when no candidate is eligible', async () => {
        const { pollId, tournamentId, season } = await seasonWithPoll(['Only Table']);
        const db = await getDatabase();
        await db.run(`UPDATE global_games SET status = 'rejected'`);
        await SeasonPollService.closeAndResolve(season, (await SeasonPollService.getPoll(pollId))!, AFTER_CLOSE);
        const poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll.status).toBe('resolved');
        expect(poll.result_game_name).toBeNull();
        expect(await queuedNames(tournamentId)).toEqual([]);
        const warn = post.mock.calls.map(c => c[1]?.body?.content).find(t => typeof t === 'string' && t.includes('no table'));
        expect(warn).toBeTruthy();
    });

    it('a candidate that fails the platform rules is refused at save', async () => {
        const ctx = await createSeason({
            platformRules: { engines: { required: [], excluded: ['vpx'] }, devices: { required: [], excluded: [] } },
        });
        await addCatalogueGame('VPX Only', { platforms: ['vpx'] });
        // Excluded is a submission filter, not eligibility (ADR 0009) — required is the eligibility axis.
        const required = await createSeason({
            platformRules: { engines: { required: ['fx'], excluded: [] }, devices: { required: [], excluded: [] } },
        });
        await expect(SeasonPollService.createDraft(required.season, { candidates: [{ game_name: 'VPX Only' }] }))
            .rejects.toMatchObject({ code: 'CANDIDATE_INELIGIBLE' });
        await expect(SeasonPollService.createDraft(ctx.season, { candidates: [{ game_name: 'VPX Only' }] })).resolves.toBeTruthy();
    });
});
