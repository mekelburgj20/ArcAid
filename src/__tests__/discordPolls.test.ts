import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Season poll Discord adapter (docs/season-format-plan.md §5.3). Pins the REST
 * bodies against a mocked `REST` — never hits Discord.
 */

const { post, get, patch } = vi.hoisted(() => ({
    post: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
}));

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

const {
    postPoll, fetchAnswerVoters, expirePoll, editMessageContent, pollDurationHours, MAX_POLL_DURATION_H,
} = await import('../utils/discordPolls.js');

beforeEach(() => {
    post.mockReset();
    get.mockReset();
    patch.mockReset();
    process.env.DISCORD_BOT_TOKEN = 'test-token';
});

describe('pollDurationHours', () => {
    it('rounds up to whole hours', () => {
        expect(pollDurationHours('2026-10-16T01:00:00Z', '2026-10-12T04:00:00Z')).toBe(93);
        expect(pollDurationHours('2026-10-12T05:00:01Z', '2026-10-12T04:00:00Z')).toBe(2);
    });
    it('is at least 1 and capped at 768', () => {
        expect(pollDurationHours('2026-10-12T04:10:00Z', '2026-10-12T04:00:00Z')).toBe(1);
        expect(pollDurationHours('2027-10-12T04:00:00Z', '2026-10-12T04:00:00Z')).toBe(MAX_POLL_DURATION_H);
    });
});

describe('postPoll', () => {
    it('posts a single-choice poll with content, answers and duration', async () => {
        post.mockResolvedValue({ id: 'msg-1', poll: { answers: [{ answer_id: 1 }, { answer_id: 2 }] } });
        const res = await postPoll({
            channelId: 'C1',
            content: '**Week 5 table poll** — vote here',
            question: 'Week 5 table',
            answers: ['Attack from Mars', 'Medieval Madness'],
            durationHours: 93,
        });

        expect(res).toEqual({ ok: true, value: { messageId: 'msg-1', answerIds: [1, 2] } });
        expect(post).toHaveBeenCalledTimes(1);
        const [route, opts] = post.mock.calls[0]!;
        expect(route).toBe('/channels/C1/messages');
        expect(opts.body.content).toBe('**Week 5 table poll** — vote here');
        expect(opts.body.poll).toEqual({
            question: { text: 'Week 5 table' },
            answers: [{ poll_media: { text: 'Attack from Mars' } }, { poll_media: { text: 'Medieval Madness' } }],
            duration: 93,
            allow_multiselect: false,
            layout_type: 1,
        });
    });

    it('caps the duration at 768 h and the answer text at 55 chars', async () => {
        post.mockResolvedValue({ id: 'msg-2', poll: { answers: [{ answer_id: 1 }] } });
        await postPoll({ channelId: 'C1', content: 'x', question: 'q', answers: ['A'.repeat(80)], durationHours: 5000 });
        const body = post.mock.calls[0]![1].body;
        expect(body.poll.duration).toBe(768);
        expect(body.poll.answers[0].poll_media.text).toHaveLength(55);
    });

    it('returns a typed failure instead of throwing on a REST error', async () => {
        post.mockRejectedValue(Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 }));
        const res = await postPoll({ channelId: 'C1', content: 'x', question: 'q', answers: ['A'], durationHours: 2 });
        expect(res).toEqual({ ok: false, status: 403, code: 50013, message: 'Missing Permissions' });
    });

    it('returns a typed failure when the bot token is missing', async () => {
        delete process.env.DISCORD_BOT_TOKEN;
        const res = await postPoll({ channelId: 'C1', content: 'x', question: 'q', answers: ['A'], durationHours: 2 });
        expect(res.ok).toBe(false);
        expect(post).not.toHaveBeenCalled();
    });
});

describe('fetchAnswerVoters', () => {
    it('paginates on `after` with limit=100 until a short page', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}` }));
        const page2 = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}` }));
        get.mockResolvedValueOnce({ users: page1 }).mockResolvedValueOnce({ users: page2 });

        const res = await fetchAnswerVoters('C1', 'msg-1', 3);
        expect(res.ok).toBe(true);
        expect(res.ok && res.value).toHaveLength(105);

        expect(get).toHaveBeenCalledTimes(2);
        expect(get.mock.calls[0]![0]).toBe('/channels/C1/polls/msg-1/answers/3');
        const q1 = get.mock.calls[0]![1].query as URLSearchParams;
        expect(q1.get('limit')).toBe('100');
        expect(q1.get('after')).toBeNull();
        const q2 = get.mock.calls[1]![1].query as URLSearchParams;
        expect(q2.get('after')).toBe('u99');
    });

    it('returns a typed failure on a REST error', async () => {
        get.mockRejectedValue(Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 }));
        const res = await fetchAnswerVoters('C1', 'msg-1', 1);
        expect(res).toEqual({ ok: false, status: 404, code: 10008, message: 'Unknown Message' });
    });
});

describe('expirePoll / editMessageContent', () => {
    it('expires via the poll expire route', async () => {
        post.mockResolvedValue({});
        const res = await expirePoll('C1', 'msg-1');
        expect(res.ok).toBe(true);
        expect(post.mock.calls[0]![0]).toBe('/channels/C1/polls/msg-1/expire');
    });

    it('edits only the content line', async () => {
        patch.mockResolvedValue({});
        const res = await editMessageContent('C1', 'msg-1', 'Combined: A 7');
        expect(res.ok).toBe(true);
        expect(patch.mock.calls[0]![0]).toBe('/channels/C1/messages/msg-1');
        expect(patch.mock.calls[0]![1].body.content).toBe('Combined: A 7');
    });

    it('never throws on failure', async () => {
        patch.mockRejectedValue(new Error('boom'));
        const res = await editMessageContent('C1', 'msg-1', 'x');
        expect(res.ok).toBe(false);
    });
});
