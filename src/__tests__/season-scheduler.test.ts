import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Season poll clock (docs/season-format-plan.md §5.2).
 *
 *   - Times derive from the NEXT rotation (cadence) minus the season offsets,
 *     and persist so the admin page shows real times.
 *   - Explicit times must close before the rotation they feed, ≥ 1 h long.
 *   - A paused season is skipped entirely; polls stop at the bound.
 *   - The one-day reminder is idempotent (its empty draft is the guard).
 *   - A Discord post that keeps failing leaves the poll a draft, then cancels.
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
const { SeasonScheduler } = await import('../engine/SeasonScheduler.js');
const { createSeason, addCatalogueGame, refreshSeason, SEASON_CHANNEL } = await import('./seasonHelpers.js');

// Friday 00:00 America/New_York (EDT) = 04:00Z.
const WED_NOON = new Date('2026-10-14T12:00:00.000Z');
const NEXT_ROTATION = '2026-10-16T04:00:00.000Z';
const DERIVED_OPEN = '2026-10-12T04:00:00.000Z';   // rotation − 96 h (Monday)
const DERIVED_CLOSE = '2026-10-16T01:00:00.000Z';  // rotation − 3 h (Thursday 9 PM ET)

let messageCounter = 0;

beforeEach(async () => {
    await setupTestDb();
    SeasonPollService._resetMemoryForTests();
    messageCounter = 0;
    post.mockReset().mockImplementation(async (_route: string, opts?: { body?: any }) => {
        if (opts?.body?.poll) {
            return { id: `msg-${++messageCounter}`, poll: { answers: opts.body.poll.answers.map((_: unknown, i: number) => ({ answer_id: i + 1 })) } };
        }
        return {};
    });
    get.mockReset().mockResolvedValue({ users: [] });
    patch.mockReset().mockResolvedValue({});
});

async function seasonWithDraft(opts: Parameters<typeof createSeason>[0] = {}) {
    const ctx = await createSeason(opts);
    await addCatalogueGame('Attack from Mars');
    await addCatalogueGame('Medieval Madness');
    const draft = await SeasonPollService.createDraft(ctx.season, {
        candidates: [{ game_name: 'Attack from Mars' }, { game_name: 'Medieval Madness' }],
    });
    return { ...ctx, pollId: draft.id };
}

const pollPosts = () => post.mock.calls.filter(c => c[1]?.body?.poll);
const textPosts = () => post.mock.calls.map(c => c[1]?.body?.content).filter((t): t is string => typeof t === 'string' && !t.startsWith('**'));

describe('deriveTimes', () => {
    it('derives from the next rotation minus the offsets', async () => {
        const { season } = await createSeason();
        expect(SeasonPollService.deriveTimes(season, WED_NOON)).toEqual({
            opensAt: DERIVED_OPEN, closesAt: DERIVED_CLOSE, rotationAt: NEXT_ROTATION,
        });
    });

    it('moves to the following rotation when less than an hour of poll would remain', async () => {
        const { season } = await createSeason();
        const t = SeasonPollService.deriveTimes(season, new Date('2026-10-16T00:30:00.000Z'));
        expect(t).toEqual({
            opensAt: '2026-10-19T04:00:00.000Z',
            closesAt: '2026-10-23T01:00:00.000Z',
            rotationAt: '2026-10-23T04:00:00.000Z',
        });
    });
});

describe('explicit times validation', () => {
    it('refuses a close at/after the rotation, naming it', async () => {
        const { season } = await createSeason();
        await expect(SeasonPollService.validateTimes(season, '2026-10-14T00:00:00Z', '2026-10-16T05:00:00Z', WED_NOON))
            .rejects.toMatchObject({ code: 'POLL_CLOSE_AFTER_ROTATION', message: expect.stringContaining(NEXT_ROTATION) });
    });

    it('refuses a poll shorter than an hour and a reversed window', async () => {
        const { season } = await createSeason();
        await expect(SeasonPollService.validateTimes(season, '2026-10-15T00:00:00Z', '2026-10-15T00:30:00Z', WED_NOON))
            .rejects.toMatchObject({ code: 'POLL_TOO_SHORT' });
        await expect(SeasonPollService.validateTimes(season, '2026-10-15T02:00:00Z', '2026-10-15T00:30:00Z', WED_NOON))
            .rejects.toMatchObject({ code: 'POLL_TIMES_ORDER' });
    });

    it('accepts a valid pair and requires both or neither', async () => {
        const { season } = await createSeason();
        await expect(SeasonPollService.validateTimes(season, '2026-10-14T13:00:00Z', '2026-10-15T20:00:00Z', WED_NOON)).resolves.toBeUndefined();
        await expect(SeasonPollService.createDraft(season, { opens_at: '2026-10-14T13:00:00Z' }, WED_NOON))
            .rejects.toMatchObject({ code: 'POLL_TIMES_PAIR' });
    });

    it('an open poll can only close earlier', async () => {
        const { season, pollId } = await seasonWithDraft();
        await SeasonScheduler.getInstance().tick(WED_NOON);
        await expect(SeasonPollService.updatePoll(season, pollId, { closes_at: '2026-10-16T02:00:00Z' }, WED_NOON))
            .rejects.toMatchObject({ code: 'POLL_CLOSE_LATER' });
        await expect(SeasonPollService.updatePoll(season, pollId, { candidates: [] }, WED_NOON))
            .rejects.toMatchObject({ code: 'POLL_LOCKED' });
        const moved = await SeasonPollService.updatePoll(season, pollId, { closes_at: '2026-10-15T20:00:00Z' }, WED_NOON);
        expect(moved.closes_at).toBe('2026-10-15T20:00:00.000Z');
    });
});

describe('SeasonScheduler.tick', () => {
    it('persists derived times and posts the poll once it is due', async () => {
        const { pollId } = await seasonWithDraft();
        await SeasonScheduler.getInstance().tick(WED_NOON);

        const poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll).toMatchObject({
            status: 'open', opens_at: DERIVED_OPEN, closes_at: DERIVED_CLOSE,
            discord_channel_id: SEASON_CHANNEL, discord_message_id: 'msg-1',
        });
        expect(pollPosts()).toHaveLength(1);
        const body = pollPosts()[0]![1].body;
        expect(body.poll.duration).toBe(37); // ceil(Thu 01:00Z − Wed 12:00Z)
        expect(body.poll.answers.map((a: any) => a.poll_media.text)).toEqual(['Attack from Mars', 'Medieval Madness']);
        expect(body.content).toContain('Combined: no votes yet');

        const db = await getDatabase();
        const answers = await db.all('SELECT position, discord_answer_id FROM season_poll_candidates WHERE poll_id = ? ORDER BY position', pollId);
        expect(answers).toEqual([{ position: 1, discord_answer_id: 1 }, { position: 2, discord_answer_id: 2 }]);

        // Re-tick: nothing new is posted.
        await SeasonScheduler.getInstance().tick(new Date(WED_NOON.getTime() + 60_000));
        expect(pollPosts()).toHaveLength(1);
    });

    it('does not post before the derived open time', async () => {
        const { pollId } = await seasonWithDraft();
        await SeasonScheduler.getInstance().tick(new Date('2026-10-10T12:00:00.000Z'));
        const poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll.status).toBe('draft');
        expect(poll.opens_at).toBe(DERIVED_OPEN);
        expect(pollPosts()).toHaveLength(0);
    });

    it('edits the tally line only when the merged tally changes', async () => {
        const { pollId, roomId } = await seasonWithDraft();
        await SeasonScheduler.getInstance().tick(WED_NOON);
        await SeasonPollService.vote(roomId, pollId, '100000000000000001', 2);
        await SeasonScheduler.getInstance().tick(new Date(WED_NOON.getTime() + 60_000));
        expect(patch).toHaveBeenCalledTimes(1);
        expect(patch.mock.calls[0]![1].body.content).toContain('Combined: Medieval Madness 1');
        await SeasonScheduler.getInstance().tick(new Date(WED_NOON.getTime() + 120_000));
        expect(patch).toHaveBeenCalledTimes(1);
    });

    it('closes and resolves at closes_at, then holds the next poll until that table goes live', async () => {
        const { pollId, roomId, tournamentId, season } = await seasonWithDraft();
        await SeasonScheduler.getInstance().tick(WED_NOON);
        await SeasonPollService.vote(roomId, pollId, '100000000000000001', 1);
        const next = await SeasonPollService.createDraft(season, { candidates: [{ game_name: 'Medieval Madness' }] });

        await SeasonScheduler.getInstance().tick(new Date('2026-10-16T01:00:30.000Z'));
        expect((await SeasonPollService.getPoll(pollId))!.status).toBe('resolved');
        // Next draft is not derived/posted while week N's table is still QUEUED.
        expect((await SeasonPollService.getPoll(next.id))!.opens_at).toBeNull();

        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE tournament_id = ? AND status = 'QUEUED'`, tournamentId);
        await SeasonScheduler.getInstance().tick(new Date('2026-10-16T04:01:00.000Z'));
        const derived = (await SeasonPollService.getPoll(next.id))!;
        expect(derived.opens_at).toBe('2026-10-19T04:00:00.000Z');
        expect(derived.closes_at).toBe('2026-10-23T01:00:00.000Z');
        expect(derived.status).toBe('draft');
    });

    it('skips a paused season entirely', async () => {
        const { pollId, season } = await seasonWithDraft();
        await SeasonPollService.setPaused(season, true, WED_NOON);
        await SeasonScheduler.getInstance().tick(WED_NOON);
        const poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll.status).toBe('draft');
        expect(poll.opens_at).toBeNull();
        expect(post).not.toHaveBeenCalled();

        await SeasonPollService.setPaused(await refreshSeason(season.id), false, WED_NOON);
        await SeasonScheduler.getInstance().tick(WED_NOON);
        expect((await SeasonPollService.getPoll(pollId))!.status).toBe('open');
    });

    it('resume clears stale unposted times so they re-derive', async () => {
        const { pollId, season } = await seasonWithDraft();
        const db = await getDatabase();
        await db.run('UPDATE season_polls SET opens_at = ?, closes_at = ? WHERE id = ?', '2026-10-05T04:00:00Z', '2026-10-09T01:00:00Z', pollId);
        await SeasonPollService.setPaused(season, true, WED_NOON);
        await SeasonPollService.setPaused(await refreshSeason(season.id), false, WED_NOON);
        const poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll.opens_at).toBeNull();
        expect(poll.closes_at).toBeNull();
    });

    it('stops posting at the bound', async () => {
        const { pollId, season, tournamentId } = await seasonWithDraft({ tableCount: 1 });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO season_polls (id, tournament_id, slot_no, status, result_game_name) VALUES ('done-1', ?, 99, 'resolved', 'Old Table')`,
            tournamentId,
        );
        await SeasonScheduler.getInstance().tick(WED_NOON);
        expect((await SeasonPollService.getPoll(pollId))!.status).toBe('draft');
        expect(post).not.toHaveBeenCalled();
        const list = await SeasonPollService.adminList(season);
        expect(list.bound_reached).toBe(true);
        expect(list.polls.find(p => p.id === pollId)!.beyond_bound).toBe(true);
    });

    it('sends ONE reminder a day before a derived open with no draft prepared', async () => {
        const { tournamentId } = await createSeason();
        const db = await getDatabase();

        await SeasonScheduler.getInstance().tick(new Date('2026-10-10T12:00:00.000Z')); // > 24h before Monday
        expect(await db.all('SELECT id FROM season_polls WHERE tournament_id = ?', tournamentId)).toHaveLength(0);

        const sunday = new Date('2026-10-11T05:00:00.000Z');
        await SeasonScheduler.getInstance().tick(sunday);
        await SeasonScheduler.getInstance().tick(new Date(sunday.getTime() + 60_000));
        const drafts = await db.all('SELECT * FROM season_polls WHERE tournament_id = ?', tournamentId);
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ status: 'draft', opens_at: DERIVED_OPEN, closes_at: DERIVED_CLOSE });
        const reminders = post.mock.calls.map(c => c[1]?.body?.content).filter((t: unknown) => typeof t === 'string' && t.includes('no candidates prepared'));
        expect(reminders).toHaveLength(1);

        // The empty draft is never posted when it comes due.
        await SeasonScheduler.getInstance().tick(WED_NOON);
        expect(pollPosts()).toHaveLength(0);
    });

    it('a failing post leaves a draft, and the third failure cancels it with an explanation', async () => {
        const { pollId } = await seasonWithDraft();
        post.mockImplementation(async (_route: string, opts?: { body?: any }) => {
            if (opts?.body?.poll) throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
            return {};
        });
        await SeasonScheduler.getInstance().tick(WED_NOON);
        let poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll).toMatchObject({ status: 'draft', posted_at: null });

        await SeasonScheduler.getInstance().tick(new Date(WED_NOON.getTime() + 60_000));
        await SeasonScheduler.getInstance().tick(new Date(WED_NOON.getTime() + 120_000));
        poll = (await SeasonPollService.getPoll(pollId))!;
        expect(poll.status).toBe('cancelled');
        expect(textPosts().some(t => t.includes('Send Polls'))).toBe(true);
    });
});
