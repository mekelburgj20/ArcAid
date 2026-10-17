import { REST, Routes } from 'discord.js';
import { logWarn } from './logger.js';

/**
 * Discord poll I/O for the Season poll queue (docs/season-format-plan.md §5.3).
 *
 * REST only, exactly like `sendChannelMessage` in `./discord.ts`: token from
 * env, `Routes.*`, no gateway intent. A gateway `GuildMessagePolls` intent
 * would make the vote mirror instant; the per-minute REST read is the backstop
 * that always works and is enough for v1.
 *
 * Every call returns a typed result rather than throwing — a Discord outage
 * or a missing permission must surface to `SeasonScheduler` as data (so it
 * can retry, count failures, or leave a poll as a draft), never as a raw
 * REST error escaping into a tick. Failures are logged here, once, with the
 * channel named and nothing secret.
 */

/** Discord caps a poll at 32 days. */
export const MAX_POLL_DURATION_H = 768;
/** Discord caps a poll answer's text at 55 characters. */
export const MAX_ANSWER_TEXT = 55;
/** Discord caps a poll question at 300 characters. */
export const MAX_QUESTION_TEXT = 300;
/** Discord's page size cap for poll answer voters. */
const VOTERS_PAGE_LIMIT = 100;

export type DiscordFailure = {
    ok: false;
    /** HTTP status, when Discord answered; null for "no token" / network. */
    status: number | null;
    /** Discord's JSON error code, when present (50013 = Missing Permissions). */
    code: number | null;
    message: string;
};
export type DiscordResult<T> = { ok: true; value: T } | DiscordFailure;

function restClient(): REST | null {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return null;
    return new REST({ version: '10' }).setToken(token);
}

const NO_TOKEN: DiscordFailure = { ok: false, status: null, code: null, message: 'DISCORD_BOT_TOKEN is not set' };

function toFailure(err: unknown, what: string, channelId: string): DiscordFailure {
    const e = err as { status?: unknown; code?: unknown; message?: unknown };
    const status = typeof e?.status === 'number' ? e.status : null;
    const code = typeof e?.code === 'number' ? e.code : null;
    const message = typeof e?.message === 'string' ? e.message : String(err);
    logWarn(`Discord poll: ${what} failed in channel ${channelId} (status ${status ?? 'n/a'}, code ${code ?? 'n/a'}): ${message}`);
    return { ok: false, status, code, message };
}

/**
 * Discord poll duration in whole hours: `ceil((closesAt − postedAt) / 1 h)`,
 * at least 1 (Discord's minimum) and capped at 768 h (Discord's maximum).
 */
export function pollDurationHours(closesAt: Date | string, postedAt: Date | string): number {
    const ms = new Date(closesAt).getTime() - new Date(postedAt).getTime();
    const hours = Math.ceil(ms / 3_600_000);
    if (!Number.isFinite(hours)) return 1;
    return Math.min(MAX_POLL_DURATION_H, Math.max(1, hours));
}

export interface PostPollInput {
    channelId: string;
    /** Message content above the poll — carries the combined tally + web link. */
    content: string;
    question: string;
    answers: string[];
    durationHours: number;
}

export interface PostedPoll {
    messageId: string;
    /** Discord's answer id per input answer, index-aligned with `answers`. */
    answerIds: number[];
}

/** `POST /channels/:id/messages` with a single-choice poll. */
export async function postPoll(input: PostPollInput): Promise<DiscordResult<PostedPoll>> {
    const rest = restClient();
    if (!rest) return NO_TOKEN;
    const body = {
        content: input.content,
        poll: {
            question: { text: input.question.slice(0, MAX_QUESTION_TEXT) },
            answers: input.answers.map(text => ({ poll_media: { text: text.slice(0, MAX_ANSWER_TEXT) } })),
            duration: Math.min(MAX_POLL_DURATION_H, Math.max(1, Math.ceil(input.durationHours))),
            allow_multiselect: false,
            layout_type: 1,
        },
        allowed_mentions: { parse: [] as string[] },
    };
    try {
        const res = await rest.post(Routes.channelMessages(input.channelId), { body }) as {
            id?: string;
            poll?: { answers?: Array<{ answer_id?: number }> };
        };
        if (!res?.id) {
            return toFailure(new Error('Discord returned no message id'), 'post poll', input.channelId);
        }
        // Discord numbers answers 1..N in the order sent; fall back to that
        // when the response omits them so the mapping never goes missing.
        const returned = res.poll?.answers ?? [];
        const answerIds = input.answers.map((_, i) => returned[i]?.answer_id ?? i + 1);
        return { ok: true, value: { messageId: res.id, answerIds } };
    } catch (err) {
        return toFailure(err, 'post poll', input.channelId);
    }
}

/**
 * Every voter (user id) for one answer, paginating on `after` with
 * `limit=100` until a short page.
 */
export async function fetchAnswerVoters(
    channelId: string,
    messageId: string,
    answerId: number,
): Promise<DiscordResult<string[]>> {
    const rest = restClient();
    if (!rest) return NO_TOKEN;
    const voters: string[] = [];
    let after: string | undefined;
    try {
        // Bounded: 1000 pages = 100k voters, far past any room.
        for (let page = 0; page < 1000; page++) {
            const query = new URLSearchParams({ limit: String(VOTERS_PAGE_LIMIT) });
            if (after) query.set('after', after);
            const res = await rest.get(Routes.pollAnswerVoters(channelId, messageId, answerId), { query }) as {
                users?: Array<{ id: string }>;
            };
            const users = res?.users ?? [];
            for (const u of users) voters.push(u.id);
            if (users.length < VOTERS_PAGE_LIMIT) break;
            after = users[users.length - 1]!.id;
        }
        return { ok: true, value: voters };
    } catch (err) {
        return toFailure(err, `read voters for answer ${answerId}`, channelId);
    }
}

/** `POST /channels/:id/polls/:messageId/expire` — end the poll now. */
export async function expirePoll(channelId: string, messageId: string): Promise<DiscordResult<void>> {
    const rest = restClient();
    if (!rest) return NO_TOKEN;
    try {
        await rest.post(Routes.expirePoll(channelId, messageId));
        return { ok: true, value: undefined };
    } catch (err) {
        return toFailure(err, 'expire poll', channelId);
    }
}

/** `PATCH /channels/:id/messages/:messageId` — replace the content line. */
export async function editMessageContent(
    channelId: string,
    messageId: string,
    content: string,
): Promise<DiscordResult<void>> {
    const rest = restClient();
    if (!rest) return NO_TOKEN;
    try {
        await rest.patch(Routes.channelMessage(channelId, messageId), {
            body: { content, allowed_mentions: { parse: [] as string[] } },
        });
        return { ok: true, value: undefined };
    } catch (err) {
        return toFailure(err, 'edit poll message', channelId);
    }
}
