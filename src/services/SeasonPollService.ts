import crypto from 'crypto';
import { EmbedBuilder } from 'discord.js';
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { nextRotationIso } from '../utils/cronUtils.js';
import {
    resolveAnnouncementChannelId, isDiscordEnabledForRoom, sendChannelEmbed, sendChannelMessage, getTournamentColor,
} from '../utils/discord.js';
import {
    postPoll, fetchAnswerVoters, expirePoll, editMessageContent, pollDurationHours,
} from '../utils/discordPolls.js';
import { parsePlatformsList, parseTournamentRules, passesplatformRules, hasAnyPlatformRules } from '../utils/platformRules.js';
import { catalogueTypesForTournamentMode } from '../utils/tournamentMode.js';
import { roomUrl } from '../utils/publicLinks.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { RoomGameTagsService } from './RoomGameTagsService.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { resolveProfiles } from './PlayerProfileResolver.js';
import { getIO } from '../api/websocket.js';

/**
 * Pick-by-poll queue (docs/season-format-plan.md §5, §13; ADR 0025 + 0026).
 *
 * The names (`SeasonPollService`, `season_polls`, `season:poll`) are
 * historical: since v2.162.0 the poll is a ROTATION METHOD gated on
 * `tournaments.poll_picks`, independent of whether the tournament is a Season.
 * A Season adds the bound (polls stop at `season_table_count`) and the pause.
 *
 * Arcaid owns the poll: Discord is one vote source, the web is the other, and
 * the merged tally in `season_poll_votes` decides. This service owns CRUD,
 * timing derivation, the Discord mirror, tally, resolve and tie handling;
 * `SeasonScheduler.tick()` drives it once a minute.
 *
 * Every state flip is `UPDATE … WHERE status = <expected>` acted on only when
 * `changes === 1`, so a tick replayed after a restart cannot queue a table
 * twice or post a second poll.
 */

export const MAX_POLL_CANDIDATES = 10;
const HOUR_MS = 3_600_000;
const REMINDER_LEAD_MS = 24 * HOUR_MS;
const MAX_POST_FAILURES = 3;
const SEASON_COLOR = 0x00BFFF;

export type SeasonPollStatus = 'draft' | 'open' | 'resolved' | 'cancelled';
export type SeasonTieRule = 'admin' | 'random' | 'first_nominated';

export interface SeasonTournamentRow {
    id: string;
    name: string;
    type: string;
    mode: string;
    cadence: string;
    platform_rules: string | null;
    game_room_id: string | null;
    discord_channel_id: string | null;
    is_active: number;
    format: string;
    /** NULL = not a Season (a poll-only rotation tournament). */
    season_table_count: number | null;
    season_ranking_group_id: string | null;
    /** 1 = Pick by poll is on (ADR 0026) — the gate for the whole poll queue. */
    poll_picks: number;
    poll_opens_before_h: number;
    poll_closes_before_h: number;
    poll_tie_rule: SeasonTieRule;
    /** Season-only (a poll-only tournament has no pause). */
    season_paused_at: string | null;
    season_finished_at: string | null;
    room_slug?: string | null;
}

export interface SeasonPollRow {
    id: string;
    tournament_id: string;
    slot_no: number;
    status: SeasonPollStatus;
    question: string | null;
    opens_at: string | null;
    closes_at: string | null;
    discord_channel_id: string | null;
    discord_message_id: string | null;
    posted_at: string | null;
    tie_rule: SeasonTieRule | null;
    result_game_name: string | null;
    result_queued_game_id: string | null;
    tied: number;
    resolved_at: string | null;
    created_at: string;
}

export interface SeasonPollCandidateRow {
    poll_id: string;
    position: number;
    game_name: string;
    global_game_id: string | null;
    discord_answer_id: number | null;
}

export interface CandidateInput {
    game_name: string;
    global_game_id?: string | null;
}

export interface PollDraftInput {
    candidates?: CandidateInput[];
    question?: string | null;
    opens_at?: string | null;
    closes_at?: string | null;
    discord_channel_id?: string | null;
    tie_rule?: SeasonTieRule | null;
}

/** A refused season-poll operation. `status` is the HTTP status a route should answer. */
export class SeasonPollError extends Error {
    constructor(public code: string, message: string, public status = 400) {
        super(message);
        this.name = 'SeasonPollError';
    }
}

/** In-memory per-process state. Losing it on restart costs one redundant edit / one extra retry. */
const postFailures = new Map<string, number>();
const lastTallySig = new Map<string, string>();
const warnedEmptyDraft = new Set<string>();

function nowIso(now: Date): string { return now.toISOString(); }

export class SeasonPollService {
    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /**
     * The tournament if it is a Season OR poll-picked (optionally in
     * `roomId`), else null. Callers that need one or the other check
     * `isSeason` / `poll_picks` themselves.
     */
    static async getSeasonTournament(tournamentId: string, roomId?: string): Promise<SeasonTournamentRow | null> {
        const db = await getDatabase();
        const row = await db.get<SeasonTournamentRow>(
            `SELECT t.*, r.slug AS room_slug FROM tournaments t
               LEFT JOIN game_rooms r ON r.id = t.game_room_id
              WHERE t.id = ? AND (t.poll_picks = 1 OR t.season_table_count IS NOT NULL)`,
            tournamentId,
        );
        if (!row) return null;
        if (roomId !== undefined && row.game_room_id !== roomId) return null;
        return row;
    }

    /**
     * Tables a season has played: COMPLETED or ARCHIVED rotation games (event
     * rounds excluded). Derived, never stored — the game rows are the record,
     * so a `deleteGameCompletely` ("wrong table") correctly un-counts a week.
     */
    static async countTablesDone(tournamentId: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM games
              WHERE tournament_id = ? AND status IN ('COMPLETED','ARCHIVED') AND round_no IS NULL`,
            tournamentId,
        );
        return row?.n ?? 0;
    }

    /**
     * Resolved polls that actually queued a table — the bound polls stop at
     * (plan §5.2). A poll that resolved with no eligible winner queued nothing
     * and does not use up a week.
     */
    static async countResolvedWithResult(tournamentId: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM season_polls
              WHERE tournament_id = ? AND status = 'resolved' AND result_game_name IS NOT NULL`,
            tournamentId,
        );
        return row?.n ?? 0;
    }

    static async getPoll(pollId: string): Promise<SeasonPollRow | null> {
        const db = await getDatabase();
        return (await db.get<SeasonPollRow>('SELECT * FROM season_polls WHERE id = ?', pollId)) ?? null;
    }

    static async getCandidates(pollId: string): Promise<SeasonPollCandidateRow[]> {
        const db = await getDatabase();
        return db.all<SeasonPollCandidateRow[]>(
            'SELECT * FROM season_poll_candidates WHERE poll_id = ? ORDER BY position ASC', pollId,
        );
    }

    /** Count per candidate position over the merged votes. */
    static async tally(pollId: string): Promise<Map<number, number>> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ position: number; n: number }>>(
            'SELECT position, COUNT(*) AS n FROM season_poll_votes WHERE poll_id = ? GROUP BY position', pollId,
        );
        return new Map(rows.map(r => [r.position, r.n]));
    }

    static defaultQuestion(tournamentName: string, slotNo: number): string {
        return `${tournamentName} — week ${slotNo} table`;
    }

    // ------------------------------------------------------------------
    // Timing (plan §5.2)
    // ------------------------------------------------------------------

    /**
     * Derive a poll window from the NEXT rotation after `now` minus the
     * season offsets. If that rotation leaves less than an hour of poll
     * (close already past, or nearly), the following rotation is used — this
     * is also what re-derives a draft whose times went stale during a pause.
     */
    static deriveTimes(t: Pick<SeasonTournamentRow, 'cadence' | 'poll_opens_before_h' | 'poll_closes_before_h'>, now: Date):
        { opensAt: string; closesAt: string; rotationAt: string } | null {
        let from = now;
        for (let i = 0; i < 4; i++) {
            const rotationIso = nextRotationIso(t.cadence, from);
            if (!rotationIso) return null;
            const rotationMs = Date.parse(rotationIso);
            const opensMs = rotationMs - t.poll_opens_before_h * HOUR_MS;
            const closesMs = rotationMs - t.poll_closes_before_h * HOUR_MS;
            if (closesMs - Math.max(now.getTime(), opensMs) >= HOUR_MS) {
                return { opensAt: new Date(opensMs).toISOString(), closesAt: new Date(closesMs).toISOString(), rotationAt: rotationIso };
            }
            from = new Date(rotationMs);
        }
        return null;
    }

    /**
     * Explicit per-poll times (plan §5.2): `opens_at < closes_at`,
     * `closes_at − opens_at ≥ 1 h`, and `closes_at` before the rotation the
     * poll feeds (the next rotation after the later of now and opens_at).
     * Refuses with the rotation time named.
     */
    static async validateTimes(t: SeasonTournamentRow, opensAt: string, closesAt: string, now: Date): Promise<void> {
        const opensMs = Date.parse(opensAt);
        const closesMs = Date.parse(closesAt);
        if (Number.isNaN(opensMs) || Number.isNaN(closesMs)) {
            throw new SeasonPollError('POLL_TIMES_INVALID', 'opens_at and closes_at must be ISO-8601 date-times.');
        }
        if (opensMs >= closesMs) {
            throw new SeasonPollError('POLL_TIMES_ORDER', 'The poll must open before it closes.');
        }
        if (closesMs - opensMs < HOUR_MS) {
            throw new SeasonPollError('POLL_TOO_SHORT', 'A poll must run for at least 1 hour (Discord minimum).');
        }
        if (closesMs <= now.getTime()) {
            throw new SeasonPollError('POLL_CLOSE_PAST', 'The poll close time is already in the past.');
        }
        const rotationIso = nextRotationIso(t.cadence, new Date(Math.max(now.getTime(), opensMs)));
        if (rotationIso && closesMs >= Date.parse(rotationIso)) {
            throw new SeasonPollError('POLL_CLOSE_AFTER_ROTATION',
                `The poll must close before the table it picks starts: the next rotation is ${rotationIso}.`);
        }
    }

    // ------------------------------------------------------------------
    // Eligibility + candidates (plan §5.4, §5.5)
    // ------------------------------------------------------------------

    /**
     * Same check as admin activate-game: an APPROVED catalogue game whose
     * platforms (catalogue ∪ room tags) pass the tournament's platform rules.
     */
    static async checkEligible(t: SeasonTournamentRow, gameName: string): Promise<{ ok: boolean; globalGameId: string | null }> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ id: string; platforms: string | null; features: string | null }>>(
            `SELECT id, platforms, features FROM global_games WHERE LOWER(name) = LOWER(?) AND status = 'approved'`,
            gameName,
        );
        if (rows.length === 0) return { ok: false, globalGameId: null };
        const rules = parseTournamentRules(t);
        if (!hasAnyPlatformRules(rules)) return { ok: true, globalGameId: rows[0]!.id };
        const roomTags = t.game_room_id ? await RoomGameTagsService.getTagsForGameName(t.game_room_id, gameName) : [];
        for (const row of rows) {
            const platforms = Array.from(new Set([...parsePlatformsList(row.platforms || '[]'), ...roomTags]));
            if (passesplatformRules(platforms, rules, parsePlatformsList(row.features || '[]'))) {
                return { ok: true, globalGameId: row.id };
            }
        }
        return { ok: false, globalGameId: rows[0]!.id };
    }

    /**
     * Candidate picker (plan §5.5): approved catalogue games of the
     * tournament's mode that pass its platform rules, with `played_before`
     * over this room's games rows of ANY status.
     */
    static async listCandidates(t: SeasonTournamentRow, opts: { q?: string; unplayed?: boolean; limit?: number }): Promise<Array<{
        global_game_id: string; name: string; manufacturer: string | null; year: number | null; played_before: boolean;
    }>> {
        const db = await getDatabase();
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        const types = catalogueTypesForTournamentMode(t.mode);
        const params: unknown[] = [];
        let where = `status = 'approved'`;
        if (types.length > 0) {
            where += ` AND type IN (${types.map(() => '?').join(',')})`;
            params.push(...types);
        }
        if (opts.q && opts.q.trim()) {
            where += ` AND LOWER(name) LIKE ?`;
            params.push(`%${opts.q.trim().toLowerCase()}%`);
        }
        const rows = await db.all<Array<{ id: string; name: string; manufacturer: string | null; year: number | null; platforms: string | null; features: string | null }>>(
            `SELECT id, name, manufacturer, year, platforms, features FROM global_games WHERE ${where} ORDER BY name COLLATE NOCASE`,
            ...params,
        );

        const played = new Set<string>();
        if (t.game_room_id) {
            const playedRows = await db.all<Array<{ n: string }>>(
                `SELECT DISTINCT LOWER(g.name) AS n FROM games g
                   LEFT JOIN tournaments tt ON tt.id = g.tournament_id
                  WHERE COALESCE(g.game_room_id, tt.game_room_id) = ?`,
                t.game_room_id,
            );
            for (const r of playedRows) played.add(r.n);
        }

        const rules = parseTournamentRules(t);
        const checkRules = hasAnyPlatformRules(rules);
        const tagMap = checkRules && t.game_room_id
            ? await RoomGameTagsService.getTagMapByGameNameForRoom(t.game_room_id)
            : new Map<string, string[]>();

        const out: Array<{ global_game_id: string; name: string; manufacturer: string | null; year: number | null; played_before: boolean }> = [];
        for (const row of rows) {
            if (checkRules) {
                const tags = tagMap.get(row.name.toLowerCase()) ?? tagMap.get(row.name) ?? [];
                const platforms = Array.from(new Set([...parsePlatformsList(row.platforms || '[]'), ...tags]));
                if (!passesplatformRules(platforms, rules, parsePlatformsList(row.features || '[]'))) continue;
            }
            const playedBefore = played.has(row.name.toLowerCase());
            if (opts.unplayed && playedBefore) continue;
            out.push({ global_game_id: row.id, name: row.name, manufacturer: row.manufacturer, year: row.year, played_before: playedBefore });
            if (out.length >= limit) break;
        }
        return out;
    }

    // ------------------------------------------------------------------
    // CRUD (admin)
    // ------------------------------------------------------------------

    private static async normaliseCandidates(t: SeasonTournamentRow, candidates: CandidateInput[]): Promise<Array<{ game_name: string; global_game_id: string | null }>> {
        if (candidates.length > MAX_POLL_CANDIDATES) {
            throw new SeasonPollError('TOO_MANY_CANDIDATES', `A poll can have at most ${MAX_POLL_CANDIDATES} candidates (Discord's cap).`);
        }
        const seen = new Set<string>();
        const out: Array<{ game_name: string; global_game_id: string | null }> = [];
        for (const c of candidates) {
            const name = (c.game_name ?? '').trim();
            if (!name) throw new SeasonPollError('CANDIDATE_INVALID', 'Every candidate needs a game name.');
            const key = name.toLowerCase();
            if (seen.has(key)) throw new SeasonPollError('CANDIDATE_DUPLICATE', `"${name}" is listed twice.`);
            seen.add(key);
            const elig = await this.checkEligible(t, name);
            if (!elig.ok) {
                throw new SeasonPollError('CANDIDATE_INELIGIBLE',
                    `"${name}" is not an approved catalogue game that meets this tournament's platform rules.`);
            }
            out.push({ game_name: name, global_game_id: c.global_game_id ?? elig.globalGameId });
        }
        return out;
    }

    private static async writeCandidates(pollId: string, candidates: Array<{ game_name: string; global_game_id: string | null }>): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM season_poll_candidates WHERE poll_id = ?', pollId);
        let position = 1;
        for (const c of candidates) {
            await db.run(
                'INSERT INTO season_poll_candidates (poll_id, position, game_name, global_game_id) VALUES (?, ?, ?, ?)',
                pollId, position++, c.game_name, c.global_game_id,
            );
        }
    }

    private static async nextSlotNo(tournamentId: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ m: number | null }>('SELECT MAX(slot_no) AS m FROM season_polls WHERE tournament_id = ?', tournamentId);
        return (row?.m ?? 0) + 1;
    }

    static async createDraft(t: SeasonTournamentRow, input: PollDraftInput, now: Date = new Date()): Promise<SeasonPollRow> {
        if (!t.poll_picks) {
            throw new SeasonPollError('POLL_PICKS_OFF', 'Pick by poll is off for this tournament — turn it on in the tournament settings first.', 409);
        }
        const candidates = await this.normaliseCandidates(t, input.candidates ?? []);
        const hasOpen = input.opens_at != null;
        const hasClose = input.closes_at != null;
        if (hasOpen !== hasClose) {
            throw new SeasonPollError('POLL_TIMES_PAIR', 'Set both opens_at and closes_at, or neither (derived from the season defaults).');
        }
        if (hasOpen) await this.validateTimes(t, input.opens_at!, input.closes_at!, now);

        const db = await getDatabase();
        const id = crypto.randomUUID();
        const slotNo = await this.nextSlotNo(t.id);
        await db.run(
            `INSERT INTO season_polls (id, tournament_id, slot_no, status, question, opens_at, closes_at, discord_channel_id, tie_rule)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
            id, t.id, slotNo, input.question?.trim() || null,
            hasOpen ? new Date(input.opens_at!).toISOString() : null,
            hasClose ? new Date(input.closes_at!).toISOString() : null,
            input.discord_channel_id || null, input.tie_rule ?? null,
        );
        await this.writeCandidates(id, candidates);
        return (await this.getPoll(id))!;
    }

    /**
     * Edit a poll. A DRAFT accepts everything. An OPEN poll accepts only
     * `closes_at`, and only EARLIER (Discord cannot extend a poll, and its
     * answers cannot be edited) — anything else is a 409.
     */
    static async updatePoll(t: SeasonTournamentRow, pollId: string, input: PollDraftInput, now: Date = new Date()): Promise<SeasonPollRow> {
        const poll = await this.requirePoll(t, pollId);
        const db = await getDatabase();

        if (poll.status === 'open') {
            const touchesOther = input.candidates !== undefined || input.question !== undefined
                || input.opens_at !== undefined || input.discord_channel_id !== undefined || input.tie_rule !== undefined;
            if (touchesOther) {
                throw new SeasonPollError('POLL_LOCKED', 'This poll is open: only its close time can be moved, and only earlier. Use "Cancel and repost" to change anything else.', 409);
            }
            if (input.closes_at == null) return poll;
            const closesMs = Date.parse(input.closes_at);
            if (Number.isNaN(closesMs)) throw new SeasonPollError('POLL_TIMES_INVALID', 'closes_at must be an ISO-8601 date-time.');
            if (poll.closes_at && closesMs >= Date.parse(poll.closes_at)) {
                throw new SeasonPollError('POLL_CLOSE_LATER', 'An open poll can only close earlier — Discord cannot extend a poll.', 409);
            }
            if (closesMs <= now.getTime()) {
                throw new SeasonPollError('POLL_CLOSE_PAST', 'That close time is already past — use "Close now".');
            }
            await db.run(`UPDATE season_polls SET closes_at = ? WHERE id = ? AND status = 'open'`, new Date(closesMs).toISOString(), pollId);
            return (await this.getPoll(pollId))!;
        }
        if (poll.status !== 'draft') {
            throw new SeasonPollError('POLL_NOT_EDITABLE', `A ${poll.status} poll cannot be edited.`, 409);
        }

        const opensAt = input.opens_at !== undefined ? input.opens_at : poll.opens_at;
        const closesAt = input.closes_at !== undefined ? input.closes_at : poll.closes_at;
        if ((opensAt == null) !== (closesAt == null)) {
            throw new SeasonPollError('POLL_TIMES_PAIR', 'Set both opens_at and closes_at, or neither (derived from the season defaults).');
        }
        if (opensAt != null && (input.opens_at !== undefined || input.closes_at !== undefined)) {
            await this.validateTimes(t, opensAt, closesAt!, now);
        }
        if (input.candidates !== undefined) {
            const candidates = await this.normaliseCandidates(t, input.candidates);
            await this.writeCandidates(pollId, candidates);
        }
        await db.run(
            `UPDATE season_polls SET question = ?, opens_at = ?, closes_at = ?, discord_channel_id = ?, tie_rule = ?
              WHERE id = ? AND status = 'draft'`,
            input.question !== undefined ? (input.question?.trim() || null) : poll.question,
            opensAt != null ? new Date(opensAt).toISOString() : null,
            closesAt != null ? new Date(closesAt).toISOString() : null,
            input.discord_channel_id !== undefined ? (input.discord_channel_id || null) : poll.discord_channel_id,
            input.tie_rule !== undefined ? (input.tie_rule ?? null) : poll.tie_rule,
            pollId,
        );
        warnedEmptyDraft.delete(pollId);
        return (await this.getPoll(pollId))!;
    }

    private static async requirePoll(t: SeasonTournamentRow, pollId: string): Promise<SeasonPollRow> {
        const poll = await this.getPoll(pollId);
        if (!poll || poll.tournament_id !== t.id) throw new SeasonPollError('POLL_NOT_FOUND', 'Poll not found.', 404);
        return poll;
    }

    /** Cancel a draft or open poll. An open Discord poll is expired too. */
    static async cancelPoll(t: SeasonTournamentRow, pollId: string): Promise<SeasonPollRow> {
        const poll = await this.requirePoll(t, pollId);
        if (poll.status !== 'draft' && poll.status !== 'open') {
            throw new SeasonPollError('POLL_NOT_CANCELLABLE', `A ${poll.status} poll cannot be cancelled.`, 409);
        }
        const db = await getDatabase();
        const res = await db.run(`UPDATE season_polls SET status = 'cancelled' WHERE id = ? AND status = ?`, pollId, poll.status);
        if (!res.changes) throw new SeasonPollError('POLL_CHANGED', 'The poll changed state — reload and try again.', 409);
        if (poll.status === 'open' && poll.discord_channel_id && poll.discord_message_id) {
            await expirePoll(poll.discord_channel_id, poll.discord_message_id);
        }
        this.emit(t, pollId);
        return (await this.getPoll(pollId))!;
    }

    /**
     * Cancel + clone as a new draft. The clone takes the cancelled poll's
     * slot (so "week N" keeps its number) and the cancelled row moves to the
     * end of the queue. Times are left NULL so the next tick re-derives them.
     */
    static async repostPoll(t: SeasonTournamentRow, pollId: string): Promise<SeasonPollRow> {
        const poll = await this.requirePoll(t, pollId);
        if (poll.status !== 'draft' && poll.status !== 'open' && poll.status !== 'cancelled') {
            throw new SeasonPollError('POLL_NOT_REPOSTABLE', `A ${poll.status} poll cannot be reposted.`, 409);
        }
        if (poll.status !== 'cancelled') await this.cancelPoll(t, pollId);
        const db = await getDatabase();
        const originalSlot = poll.slot_no;
        const endSlot = await this.nextSlotNo(t.id);
        await db.run('UPDATE season_polls SET slot_no = ? WHERE id = ?', endSlot, pollId);
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO season_polls (id, tournament_id, slot_no, status, question, discord_channel_id, tie_rule)
             VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
            id, t.id, originalSlot, poll.question, poll.discord_channel_id, poll.tie_rule,
        );
        const candidates = await this.getCandidates(pollId);
        await this.writeCandidates(id, candidates.map(c => ({ game_name: c.game_name, global_game_id: c.global_game_id })));
        return (await this.getPoll(id))!;
    }

    /** Move a DRAFT to `slotNo`, swapping with whatever draft holds it. */
    static async reorderPoll(t: SeasonTournamentRow, pollId: string, slotNo: number): Promise<SeasonPollRow> {
        const poll = await this.requirePoll(t, pollId);
        if (poll.status !== 'draft') throw new SeasonPollError('POLL_NOT_DRAFT', 'Only draft polls can be reordered.', 409);
        if (!Number.isInteger(slotNo) || slotNo < 1) throw new SeasonPollError('SLOT_INVALID', 'slot_no must be a positive integer.');
        if (slotNo === poll.slot_no) return poll;
        const db = await getDatabase();
        const occupant = await db.get<SeasonPollRow>('SELECT * FROM season_polls WHERE tournament_id = ? AND slot_no = ?', t.id, slotNo);
        if (occupant && occupant.status !== 'draft') {
            throw new SeasonPollError('SLOT_TAKEN', `Slot ${slotNo} belongs to a ${occupant.status} poll.`, 409);
        }
        await db.exec('BEGIN');
        try {
            if (occupant) await db.run('UPDATE season_polls SET slot_no = ? WHERE id = ?', -1, occupant.id);
            await db.run('UPDATE season_polls SET slot_no = ? WHERE id = ?', slotNo, pollId);
            if (occupant) await db.run('UPDATE season_polls SET slot_no = ? WHERE id = ?', poll.slot_no, occupant.id);
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
        return (await this.getPoll(pollId))!;
    }

    /** Admin "Close now": expire on Discord and resolve immediately. */
    static async closeNow(t: SeasonTournamentRow, pollId: string, now: Date = new Date()): Promise<SeasonPollRow> {
        const poll = await this.requirePoll(t, pollId);
        if (poll.status !== 'open') throw new SeasonPollError('POLL_NOT_OPEN', 'Only an open poll can be closed.', 409);
        const db = await getDatabase();
        await db.run(`UPDATE season_polls SET closes_at = ? WHERE id = ? AND status = 'open'`, nowIso(now), pollId);
        await this.closeAndResolve(t, (await this.getPoll(pollId))!, now);
        return (await this.getPoll(pollId))!;
    }

    // ------------------------------------------------------------------
    // Votes (plan §5.4)
    // ------------------------------------------------------------------

    /** Load a poll that belongs to a season / poll-picked tournament in `roomId`. */
    static async getPollInRoom(roomId: string, pollId: string): Promise<{ poll: SeasonPollRow; t: SeasonTournamentRow } | null> {
        const poll = await this.getPoll(pollId);
        if (!poll) return null;
        const t = await this.getSeasonTournament(poll.tournament_id, roomId);
        if (!t) return null;
        return { poll, t };
    }

    /** Web vote: upsert `(poll, canonical user, position, 'web')`. A web vote beats a Discord one. */
    static async vote(roomId: string, pollId: string, userId: string, position: number): Promise<{ my_vote: number }> {
        const found = await this.getPollInRoom(roomId, pollId);
        if (!found) throw new SeasonPollError('POLL_NOT_FOUND', 'Poll not found.', 404);
        if (found.poll.status !== 'open') throw new SeasonPollError('POLL_NOT_OPEN', 'This poll is not open for voting.', 409);
        const candidates = await this.getCandidates(pollId);
        if (!candidates.some(c => c.position === position)) {
            throw new SeasonPollError('CANDIDATE_INVALID', 'No such candidate on this poll.');
        }
        const canonical = await IdentityLinkService.resolveCanonical(userId);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO season_poll_votes (poll_id, user_id, position, source, voted_at)
             VALUES (?, ?, ?, 'web', datetime('now'))
             ON CONFLICT(poll_id, user_id) DO UPDATE SET position = excluded.position, source = 'web', voted_at = excluded.voted_at`,
            pollId, canonical, position,
        );
        this.emit(found.t, pollId);
        return { my_vote: position };
    }

    /** Withdraw the viewer's vote (either source). */
    static async withdrawVote(roomId: string, pollId: string, userId: string): Promise<void> {
        const found = await this.getPollInRoom(roomId, pollId);
        if (!found) throw new SeasonPollError('POLL_NOT_FOUND', 'Poll not found.', 404);
        if (found.poll.status !== 'open') throw new SeasonPollError('POLL_NOT_OPEN', 'This poll is not open for voting.', 409);
        const canonical = await IdentityLinkService.resolveCanonical(userId);
        const db = await getDatabase();
        await db.run('DELETE FROM season_poll_votes WHERE poll_id = ? AND user_id = ?', pollId, canonical);
        this.emit(found.t, pollId);
    }

    /**
     * Mirror the Discord poll into `season_poll_votes`. Each voter maps
     * through `resolveCanonical`; a `discord` row is written only where the
     * same person has no `web` row; a `discord` row whose voter is gone is
     * deleted. Removals are applied only when EVERY answer read succeeded, so
     * a partial read can never wipe votes.
     */
    static async syncDiscordVotes(poll: SeasonPollRow): Promise<boolean> {
        if (!poll.discord_channel_id || !poll.discord_message_id) return false;
        const candidates = await this.getCandidates(poll.id);
        const seen = new Map<string, number>();
        for (const c of candidates) {
            if (c.discord_answer_id == null) continue;
            const res = await fetchAnswerVoters(poll.discord_channel_id, poll.discord_message_id, c.discord_answer_id);
            if (!res.ok) return false;
            for (const voterId of res.value) {
                const canonical = await IdentityLinkService.resolveCanonical(voterId);
                seen.set(canonical, c.position);
            }
        }
        const db = await getDatabase();
        const existing = await db.all<Array<{ user_id: string; position: number; source: string }>>(
            'SELECT user_id, position, source FROM season_poll_votes WHERE poll_id = ?', poll.id,
        );
        const byUser = new Map(existing.map(r => [r.user_id, r]));
        for (const [userId, position] of seen) {
            const row = byUser.get(userId);
            if (row?.source === 'web') continue;
            if (row && row.position === position) continue;
            await db.run(
                `INSERT INTO season_poll_votes (poll_id, user_id, position, source, voted_at)
                 VALUES (?, ?, ?, 'discord', datetime('now'))
                 ON CONFLICT(poll_id, user_id) DO UPDATE SET position = excluded.position, source = 'discord', voted_at = excluded.voted_at
                 WHERE season_poll_votes.source = 'discord'`,
                poll.id, userId, position,
            );
        }
        for (const row of existing) {
            if (row.source === 'discord' && !seen.has(row.user_id)) {
                await db.run(
                    `DELETE FROM season_poll_votes WHERE poll_id = ? AND user_id = ? AND source = 'discord'`,
                    poll.id, row.user_id,
                );
            }
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Resolve + ties (plan §5.4)
    // ------------------------------------------------------------------

    /** Stable "random" pick among `tied`, seeded by the poll id — a re-run picks the same one. */
    static seededPick<T>(pollId: string, tied: T[]): T {
        const digest = crypto.createHash('sha256').update(pollId).digest();
        return tied[digest.readUInt32BE(0) % tied.length]!;
    }

    /**
     * Ordered outcome: `[winner, ...rest]` in the order eligibility is tried,
     * plus whether the top was a tie and which positions tied.
     *
     * Under `admin` a tie has NO winner (ADR 0026: "admin decides" holds, there
     * is no fallback) — `order` is then by position among the tied, and the
     * caller must not queue `order[0]`.
     */
    static rankCandidates(
        pollId: string,
        candidates: SeasonPollCandidateRow[],
        tally: Map<number, number>,
        rule: SeasonTieRule,
    ): { order: SeasonPollCandidateRow[]; tied: boolean; tiedPositions: number[] } {
        if (candidates.length === 0) return { order: [], tied: false, tiedPositions: [] };
        const votes = (c: SeasonPollCandidateRow) => tally.get(c.position) ?? 0;
        const max = Math.max(...candidates.map(votes));
        const top = candidates.filter(c => votes(c) === max).sort((a, b) => a.position - b.position);
        const tied = top.length > 1;
        let winner = top[0]!;
        if (tied && rule === 'random') winner = this.seededPick(pollId, top);
        const rest = candidates
            .filter(c => c.position !== winner.position)
            .sort((a, b) => (votes(b) - votes(a)) || (a.position - b.position));
        return { order: [winner, ...rest], tied, tiedPositions: tied ? top.map(c => c.position) : [] };
    }

    /**
     * Close an open poll and resolve it. Final Discord read, expire, then the
     * guarded `open → resolved` flip; only the process that wins the flip
     * resolves, so `queueGame` runs exactly once.
     */
    static async closeAndResolve(t: SeasonTournamentRow, poll: SeasonPollRow, now: Date): Promise<boolean> {
        if (poll.discord_channel_id && poll.discord_message_id) {
            await this.syncDiscordVotes(poll);
            await expirePoll(poll.discord_channel_id, poll.discord_message_id);
        }
        const db = await getDatabase();
        const res = await db.run(
            `UPDATE season_polls SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'`,
            nowIso(now), poll.id,
        );
        if (res.changes !== 1) return false;
        try {
            await this.resolveWinner(t, poll, now);
        } catch (err) {
            // The poll stays `resolved` with no result — visible on the admin
            // page, and the rotation holds (empty queue, both pick flags off).
            logError(`Season poll ${poll.id}: resolve failed`, err);
        }
        lastTallySig.delete(poll.id);
        this.emit(t, poll.id);
        return true;
    }

    private static async resolveWinner(t: SeasonTournamentRow, poll: SeasonPollRow, now: Date): Promise<void> {
        const db = await getDatabase();
        const candidates = await this.getCandidates(poll.id);
        const tally = await this.tally(poll.id);
        const rule = (poll.tie_rule ?? t.poll_tie_rule) as SeasonTieRule;
        const { order, tied, tiedPositions } = this.rankCandidates(poll.id, candidates, tally, rule);
        const week = poll.slot_no;
        const channelId = await resolveAnnouncementChannelId(t.game_room_id, t.discord_channel_id);

        // "Admin decides" HOLDS (ADR 0026): queue nothing, mark the poll tied
        // with no result, tell the channel. The rotation's existing empty-queue
        // behaviour ("No Table Queued", wait for admin) is the admin alert.
        if (tied && rule === 'admin') {
            await db.run(
                `UPDATE season_polls SET tied = 1, result_game_name = NULL, result_queued_game_id = NULL WHERE id = ?`,
                poll.id,
            );
            const names = candidates.filter(c => tiedPositions.includes(c.position)).map(c => c.game_name);
            logInfo(`Season poll '${t.name}' week ${week} (${poll.id}) tied between ${names.join(', ')} — holding for an admin to choose.`);
            if (channelId) {
                const adminUrl = t.room_slug ? `${roomUrl(t.room_slug)}/admin/tournaments` : '';
                await sendChannelMessage(channelId,
                    `**${t.name}** — the week ${week} vote tied between ${names.join(' and ')}. An admin must choose the table on the admin page${adminUrl ? ` (${adminUrl})` : ''}; no table starts until then.`);
            }
            return;
        }

        const skipped: string[] = [];
        let chosen: SeasonPollCandidateRow | null = null;
        for (const c of order) {
            const elig = await this.checkEligible(t, c.game_name);
            if (elig.ok) { chosen = c; break; }
            skipped.push(c.game_name);
        }

        if (!chosen) {
            logWarn(`Season '${t.name}' week ${week} poll (${poll.id}) resolved with NO eligible table — rotation will hold until an admin queues one.`);
            if (channelId) {
                await sendChannelMessage(channelId,
                    `⚠️ **${t.name}** — no table from the week ${week} poll is eligible to play${skipped.length ? ` (${skipped.join(', ')})` : ''}. The rotation will hold until an admin queues one.`);
            }
            return;
        }

        const { TournamentEngine } = await import('../engine/TournamentEngine.js');
        const game = await TournamentEngine.getInstance().queueGame(t.id, chosen.game_name);
        await db.run(
            `UPDATE season_polls SET result_game_name = ?, result_queued_game_id = ?, tied = 0 WHERE id = ?`,
            chosen.game_name, game.id, poll.id,
        );
        logInfo(`Season '${t.name}' week ${week} poll resolved: ${chosen.game_name} queued (${game.id})${tied ? ` after a tie (${rule})` : ''}.`);

        if (!channelId) return;
        const votes = (c: SeasonPollCandidateRow) => tally.get(c.position) ?? 0;
        const runnerUp = order.find(c => c.position !== chosen!.position);
        const score = runnerUp ? `${votes(chosen)} vote${votes(chosen) === 1 ? '' : 's'} to ${votes(runnerUp)}` : `${votes(chosen)} vote${votes(chosen) === 1 ? '' : 's'}`;
        const rotationIso = nextRotationIso(t.cadence, now);
        const starts = rotationIso ? ` Starts <t:${Math.floor(Date.parse(rotationIso) / 1000)}:F>.` : '';
        let desc = `**Next up: ${chosen.game_name}** (won the week ${week} poll for **${t.name}**, ${score}).${starts}`;
        if (skipped.length) {
            desc += `\n${skipped.map(n => `**${n}**`).join(', ')} ${skipped.length === 1 ? 'is' : 'are'} not eligible for this tournament, so the next-ranked table goes in.`;
        }
        await sendChannelEmbed(channelId, new EmbedBuilder()
            .setTitle(`Next up: ${chosen.game_name} — ${t.name}`)
            .setDescription(desc)
            .setColor(getTournamentColor(t.type) || SEASON_COLOR)
            .setFooter({ text: t.name })
            .setTimestamp(now));
    }

    /**
     * Admin tie decision (ADR 0026): a poll that tied under "admin decides"
     * holds with nothing queued until an admin picks one of the TIED
     * candidates here. Choosing again while the chosen row is still QUEUED
     * swaps it — the engine removes the queued row, `queueGame` adds the new one.
     */
    static async choose(t: SeasonTournamentRow, pollId: string, position: number, now: Date = new Date()): Promise<SeasonPollRow> {
        const poll = await this.requirePoll(t, pollId);
        if (poll.status !== 'resolved' || !poll.tied) {
            throw new SeasonPollError('POLL_NOT_TIED', 'Only a poll that tied under "Admin decides" can be chosen.', 409);
        }
        const candidates = await this.getCandidates(pollId);
        const tally = await this.tally(pollId);
        const rule = (poll.tie_rule ?? t.poll_tie_rule) as SeasonTieRule;
        const { tiedPositions } = this.rankCandidates(pollId, candidates, tally, rule);
        const pick = candidates.find(c => c.position === position);
        if (!pick || !tiedPositions.includes(position)) {
            throw new SeasonPollError('CANDIDATE_NOT_TIED', 'Choose one of the tied candidates.');
        }
        if (pick.game_name === poll.result_game_name) return poll;
        const elig = await this.checkEligible(t, pick.game_name);
        if (!elig.ok) throw new SeasonPollError('CANDIDATE_INELIGIBLE', `"${pick.game_name}" is not eligible for this tournament.`);

        const { TournamentEngine } = await import('../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();
        if (poll.result_queued_game_id) {
            const removed = await engine.removeQueuedGame(poll.result_queued_game_id);
            if (!removed) {
                throw new SeasonPollError('ALREADY_STARTED', 'The queued table has already started — it can no longer be swapped.', 409);
            }
        }
        const game = await engine.queueGame(t.id, pick.game_name);
        const db = await getDatabase();
        await db.run(
            'UPDATE season_polls SET result_game_name = ?, result_queued_game_id = ? WHERE id = ?',
            pick.game_name, game.id, pollId,
        );
        logInfo(`Season '${t.name}' week ${poll.slot_no}: admin chose ${pick.game_name} over ${poll.result_game_name ?? '(none)'}.`);
        const channelId = await resolveAnnouncementChannelId(t.game_room_id, t.discord_channel_id);
        if (channelId) {
            const rotationIso = nextRotationIso(t.cadence, now);
            const starts = rotationIso ? ` Starts <t:${Math.floor(Date.parse(rotationIso) / 1000)}:F>.` : '';
            await sendChannelEmbed(channelId, new EmbedBuilder()
                .setTitle(`Next up: ${pick.game_name} — ${t.name}`)
                .setDescription(`**Next up: ${pick.game_name}** — admins broke the week ${poll.slot_no} tie for **${t.name}**.${starts}`)
                .setColor(getTournamentColor(t.type) || SEASON_COLOR)
                .setFooter({ text: t.name })
                .setTimestamp(now));
        }
        this.emit(t, pollId);
        return (await this.getPoll(pollId))!;
    }

    // ------------------------------------------------------------------
    // Discord posting + tally line (plan §5.3)
    // ------------------------------------------------------------------

    static async pollChannelFor(t: SeasonTournamentRow, poll: SeasonPollRow): Promise<string | null> {
        if (!(await isDiscordEnabledForRoom(t.game_room_id))) return null;
        if (poll.discord_channel_id) return poll.discord_channel_id;
        return resolveAnnouncementChannelId(t.game_room_id, t.discord_channel_id);
    }

    static buildContent(t: SeasonTournamentRow, poll: SeasonPollRow, candidates: SeasonPollCandidateRow[], tally: Map<number, number>): string {
        const question = poll.question || this.defaultQuestion(t.name, poll.slot_no);
        const link = t.room_slug ? ` — vote here or at ${roomUrl(t.room_slug)}` : ' — vote here';
        const counted = candidates
            .map(c => ({ name: c.game_name, n: tally.get(c.position) ?? 0 }))
            .filter(c => c.n > 0)
            .sort((a, b) => b.n - a.n);
        const combined = counted.length
            ? counted.map(c => `${c.name} ${c.n}`).join(' · ')
            : 'no votes yet';
        return `**${question}**${link} · Combined: ${combined}`;
    }

    /**
     * Post a draft. Claims the row first (`draft → open`), then posts; a
     * Discord failure reverts it to a draft with `posted_at` NULL so the next
     * tick retries, and the third failure cancels it with an explanation.
     * Returns true when the poll is now open.
     */
    static async postDraft(t: SeasonTournamentRow, poll: SeasonPollRow, now: Date): Promise<boolean> {
        const db = await getDatabase();
        const candidates = await this.getCandidates(poll.id);
        if (candidates.length === 0) {
            if (!warnedEmptyDraft.has(poll.id)) {
                warnedEmptyDraft.add(poll.id);
                logWarn(`Season '${t.name}' week ${poll.slot_no} poll (${poll.id}) is due to open but has no candidates — not posting.`);
            }
            return false;
        }
        const claim = await db.run(
            `UPDATE season_polls SET status = 'open', posted_at = ? WHERE id = ? AND status = 'draft' AND posted_at IS NULL`,
            nowIso(now), poll.id,
        );
        if (claim.changes !== 1) return false;

        const channelId = await this.pollChannelFor(t, poll);
        if (channelId) {
            const question = poll.question || this.defaultQuestion(t.name, poll.slot_no);
            const tally = await this.tally(poll.id);
            const result = await postPoll({
                channelId,
                content: this.buildContent(t, poll, candidates, tally),
                question,
                answers: candidates.map(c => c.game_name),
                durationHours: pollDurationHours(poll.closes_at ?? now, now),
            });
            if (!result.ok) {
                const failures = (postFailures.get(poll.id) ?? 0) + 1;
                postFailures.set(poll.id, failures);
                if (failures >= MAX_POST_FAILURES) {
                    await db.run(`UPDATE season_polls SET status = 'cancelled', posted_at = NULL WHERE id = ? AND status = 'open'`, poll.id);
                    postFailures.delete(poll.id);
                    logWarn(`Season '${t.name}' week ${poll.slot_no} poll cancelled after ${failures} failed posts to channel ${channelId}.`);
                    await sendChannelMessage(channelId,
                        `⚠️ **${t.name}** — the week ${poll.slot_no} poll could not be posted here after ${failures} tries (${result.status === 403 ? 'the bot needs **Send Messages** and **Send Polls** in this channel' : result.message}). It has been cancelled; an admin can repost it.`);
                } else {
                    await db.run(`UPDATE season_polls SET status = 'draft', posted_at = NULL WHERE id = ? AND status = 'open'`, poll.id);
                    logWarn(`Season '${t.name}' week ${poll.slot_no} poll: post to channel ${channelId} failed (${failures}/${MAX_POST_FAILURES}); will retry next minute.`);
                }
                return false;
            }
            postFailures.delete(poll.id);
            await db.run(
                'UPDATE season_polls SET discord_channel_id = ?, discord_message_id = ? WHERE id = ?',
                channelId, result.value.messageId, poll.id,
            );
            for (let i = 0; i < candidates.length; i++) {
                await db.run(
                    'UPDATE season_poll_candidates SET discord_answer_id = ? WHERE poll_id = ? AND position = ?',
                    result.value.answerIds[i] ?? null, poll.id, candidates[i]!.position,
                );
            }
            lastTallySig.set(poll.id, this.tallySig(tally));
        }
        logInfo(`Season '${t.name}' week ${poll.slot_no} poll opened${channelId ? ` in channel ${channelId}` : ' (web only)'}.`);
        this.emit(t, poll.id);
        return true;
    }

    private static tallySig(tally: Map<number, number>): string {
        return JSON.stringify([...tally.entries()].sort((a, b) => a[0] - b[0]));
    }

    /**
     * One tick for an open, not-yet-due poll: mirror Discord votes; when the
     * merged tally changed, rewrite the content line and emit `season:poll`.
     */
    static async refreshOpenPoll(t: SeasonTournamentRow, poll: SeasonPollRow): Promise<void> {
        await this.syncDiscordVotes(poll);
        const tally = await this.tally(poll.id);
        const sig = this.tallySig(tally);
        if (lastTallySig.get(poll.id) === sig) return;
        lastTallySig.set(poll.id, sig);
        if (poll.discord_channel_id && poll.discord_message_id) {
            const candidates = await this.getCandidates(poll.id);
            await editMessageContent(poll.discord_channel_id, poll.discord_message_id, this.buildContent(t, poll, candidates, tally));
        }
        this.emit(t, poll.id);
    }

    /**
     * Reminder (plan §5.2 last bullet): one day before a derived opens_at with
     * no draft prepared, create an EMPTY draft (that row is the idempotency
     * guard) and post one channel message.
     */
    static async maybeRemind(t: SeasonTournamentRow, now: Date): Promise<boolean> {
        const times = this.deriveTimes(t, now);
        if (!times) return false;
        if (now.getTime() < Date.parse(times.opensAt) - REMINDER_LEAD_MS) return false;
        const db = await getDatabase();
        const slotNo = await this.nextSlotNo(t.id);
        const id = crypto.randomUUID();
        try {
            await db.run(
                `INSERT INTO season_polls (id, tournament_id, slot_no, status, opens_at, closes_at) VALUES (?, ?, ?, 'draft', ?, ?)`,
                id, t.id, slotNo, times.opensAt, times.closesAt,
            );
        } catch {
            return false; // a concurrent tick took the slot — it sends the reminder
        }
        const channelId = await resolveAnnouncementChannelId(t.game_room_id, t.discord_channel_id);
        logInfo(`Season '${t.name}': no candidates prepared for the week ${slotNo} poll — reminder sent.`);
        if (channelId) {
            const adminUrl = t.room_slug ? ` ${roomUrl(t.room_slug)}/admin/tournaments` : '';
            await sendChannelMessage(channelId,
                `**${t.name}** — no candidates prepared for the week ${slotNo} poll — it opens <t:${Math.floor(Date.parse(times.opensAt) / 1000)}:R>.${adminUrl}`);
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Pause / resume (plan §6)
    // ------------------------------------------------------------------

    static async setPaused(t: SeasonTournamentRow, paused: boolean, now: Date = new Date()): Promise<void> {
        const db = await getDatabase();
        if (paused) {
            await db.run('UPDATE tournaments SET season_paused_at = ? WHERE id = ? AND season_paused_at IS NULL', nowIso(now), t.id);
            return;
        }
        await db.run('UPDATE tournaments SET season_paused_at = NULL WHERE id = ?', t.id);
        // Drafts whose times went stale during the pause re-derive from the
        // next rotation on the next tick.
        await db.run(
            `UPDATE season_polls SET opens_at = NULL, closes_at = NULL
              WHERE tournament_id = ? AND status = 'draft' AND posted_at IS NULL AND closes_at IS NOT NULL AND closes_at <= ?`,
            t.id, nowIso(now),
        );
    }

    // ------------------------------------------------------------------
    // Views (plan §7)
    // ------------------------------------------------------------------

    private static async discordUrl(t: SeasonTournamentRow, poll: SeasonPollRow): Promise<string | null> {
        if (!poll.discord_channel_id || !poll.discord_message_id || !t.game_room_id) return null;
        const guildId = await GameRoomSettingsService.get(t.game_room_id, 'DISCORD_GUILD_ID');
        if (!guildId) return null;
        return `https://discord.com/channels/${guildId}/${poll.discord_channel_id}/${poll.discord_message_id}`;
    }

    /** True when the tournament is a Season (has a bound). */
    static isSeason(t: Pick<SeasonTournamentRow, 'season_table_count'>): boolean {
        return t.season_table_count != null;
    }

    /**
     * The `season` sub-object on the public tournaments list — built for a
     * Season OR a poll-picked tournament. `table_count`/`tables_done` are null
     * for a poll-only tournament (no bound).
     */
    static async listSummary(t: SeasonTournamentRow): Promise<{
        poll_picks: boolean; tables_done: number | null; table_count: number | null;
        paused: boolean; finished: boolean; open_poll_id: string | null;
    }> {
        const db = await getDatabase();
        const open = await db.get<{ id: string }>(
            `SELECT id FROM season_polls WHERE tournament_id = ? AND status = 'open' ORDER BY slot_no LIMIT 1`, t.id,
        );
        const season = this.isSeason(t);
        return {
            poll_picks: !!t.poll_picks,
            tables_done: season ? await this.countTablesDone(t.id) : null,
            table_count: season ? t.season_table_count : null,
            paused: !!t.season_paused_at,
            finished: !!t.season_finished_at,
            open_poll_id: open?.id ?? null,
        };
    }

    /** Public season summary (`GET /tournaments/:id/season`). */
    static async publicSummary(t: SeasonTournamentRow, viewerId: string | null, now: Date = new Date()) {
        const db = await getDatabase();
        const open = await db.get<SeasonPollRow>(
            `SELECT * FROM season_polls WHERE tournament_id = ? AND status = 'open' ORDER BY slot_no LIMIT 1`, t.id,
        );
        let openPoll: any = null;
        if (open) {
            const candidates = await this.getCandidates(open.id);
            const tally = await this.tally(open.id);
            let myVote: number | null = null;
            if (viewerId) {
                const canonical = await IdentityLinkService.resolveCanonical(viewerId);
                const row = await db.get<{ position: number }>(
                    'SELECT position FROM season_poll_votes WHERE poll_id = ? AND user_id = ?', open.id, canonical,
                );
                myVote = row?.position ?? null;
            }
            openPoll = {
                id: open.id,
                slot_no: open.slot_no,
                question: open.question || this.defaultQuestion(t.name, open.slot_no),
                opens_at: open.opens_at,
                closes_at: open.closes_at,
                posted_at: open.posted_at,
                discord_url: await this.discordUrl(t, open),
                candidates: candidates.map(c => ({
                    position: c.position,
                    game_name: c.game_name,
                    global_game_id: c.global_game_id,
                    votes: tally.get(c.position) ?? 0,
                })),
                total_votes: [...tally.values()].reduce((a, b) => a + b, 0),
                my_vote: myVote,
            };
        }
        const nextDraft = await db.get<SeasonPollRow>(
            `SELECT * FROM season_polls WHERE tournament_id = ? AND status = 'draft' ORDER BY slot_no LIMIT 1`, t.id,
        );
        const derived = t.poll_picks ? this.deriveTimes(t, now) : null;
        return {
            tournament_id: t.id,
            name: t.name,
            config: {
                poll_picks: !!t.poll_picks,
                table_count: t.season_table_count,
                poll_opens_before_h: t.poll_opens_before_h,
                poll_closes_before_h: t.poll_closes_before_h,
                tie_rule: t.poll_tie_rule,
                ranking_group_id: t.season_ranking_group_id,
            },
            progress: this.isSeason(t)
                ? { tables_done: await this.countTablesDone(t.id), table_count: t.season_table_count }
                : null,
            paused: !!t.season_paused_at,
            paused_at: t.season_paused_at,
            finished: !!t.season_finished_at,
            finished_at: t.season_finished_at,
            next_rotation_at: nextRotationIso(t.cadence, now),
            next_poll_opens_at: open ? null : (nextDraft?.opens_at ?? derived?.opensAt ?? null),
            open_poll: openPoll,
        };
    }

    /** Admin poll queue (`GET /tournaments/:id/season/polls`). */
    static async adminList(t: SeasonTournamentRow) {
        const db = await getDatabase();
        const polls = await db.all<SeasonPollRow[]>(
            'SELECT * FROM season_polls WHERE tournament_id = ? ORDER BY slot_no ASC', t.id,
        );
        const resolvedCount = await this.countResolvedWithResult(t.id);
        const openCount = polls.filter(p => p.status === 'open').length;
        let draftIndex = 0;
        const out = [];
        for (const poll of polls) {
            const candidates = await this.getCandidates(poll.id);
            const tally = await this.tally(poll.id);
            const voteRows = await db.all<Array<{ user_id: string; position: number; source: string; voted_at: string }>>(
                'SELECT user_id, position, source, voted_at FROM season_poll_votes WHERE poll_id = ? ORDER BY voted_at ASC', poll.id,
            );
            const profiles = await resolveProfiles(voteRows.map(v => ({ submitted_by_user_id: v.user_id, discord_user_id: v.user_id })));
            const rule = (poll.tie_rule ?? t.poll_tie_rule) as SeasonTieRule;
            const ranked = this.rankCandidates(poll.id, candidates, tally, rule);
            const queued = poll.result_queued_game_id
                ? await db.get<{ status: string }>('SELECT status FROM games WHERE id = ?', poll.result_queued_game_id)
                : null;
            // The bound applies only to a poll-picked SEASON (ADR 0026).
            const beyondBound = t.season_table_count != null && poll.status === 'draft'
                && (resolvedCount + openCount + draftIndex++) >= t.season_table_count;
            // "Admin decides" held this poll: choosable until a chosen table starts.
            const canChoose = !!poll.tied && (!poll.result_queued_game_id || queued?.status === 'QUEUED');
            out.push({
                id: poll.id,
                slot_no: poll.slot_no,
                status: poll.status,
                question: poll.question || this.defaultQuestion(t.name, poll.slot_no),
                question_custom: poll.question,
                opens_at: poll.opens_at,
                closes_at: poll.closes_at,
                posted_at: poll.posted_at,
                discord_channel_id: poll.discord_channel_id,
                discord_message_id: poll.discord_message_id,
                discord_url: await this.discordUrl(t, poll),
                tie_rule: poll.tie_rule,
                effective_tie_rule: rule,
                result_game_name: poll.result_game_name,
                result_queued_game_id: poll.result_queued_game_id,
                result_queued_status: queued?.status ?? null,
                tied: !!poll.tied,
                tied_positions: poll.tied ? ranked.tiedPositions : [],
                can_choose: canChoose,
                resolved_at: poll.resolved_at,
                created_at: poll.created_at,
                beyond_bound: beyondBound,
                candidates: candidates.map(c => ({
                    position: c.position,
                    game_name: c.game_name,
                    global_game_id: c.global_game_id,
                    discord_answer_id: c.discord_answer_id,
                    votes: tally.get(c.position) ?? 0,
                })),
                total_votes: voteRows.length,
                voters: voteRows.map((v, i) => ({
                    user_id: v.user_id,
                    display_name: profiles[i]?.display_name ?? null,
                    position: v.position,
                    source: v.source,
                    voted_at: v.voted_at,
                })),
            });
        }
        const season = this.isSeason(t);
        return {
            tournament_id: t.id,
            poll_picks: !!t.poll_picks,
            table_count: t.season_table_count,
            tables_done: season ? await this.countTablesDone(t.id) : null,
            resolved_count: resolvedCount,
            bound_reached: !!t.poll_picks && season && resolvedCount >= t.season_table_count!,
            paused: !!t.season_paused_at,
            finished: !!t.season_finished_at,
            polls: out,
        };
    }

    /** `season:poll` to `room:<id>` on every tally/state change. */
    static emit(t: SeasonTournamentRow, pollId: string): void {
        if (!t.game_room_id) return;
        try {
            getIO()?.to(`room:${t.game_room_id}`).emit('season:poll', { tournamentId: t.id, pollId });
        } catch { /* socket optional */ }
    }

    /** Test-only: forget the in-memory per-process state. */
    static _resetMemoryForTests(): void {
        postFailures.clear();
        lastTallySig.clear();
        warnedEmptyDraft.clear();
    }
}
