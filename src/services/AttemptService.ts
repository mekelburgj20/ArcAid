import { getDatabase } from '../database/database.js';
import { resolveUserLabels } from './PlayerProfileResolver.js';
import { logInfo } from '../utils/logger.js';
import { ActivityLogService } from './ActivityLogService.js';
import { normalizePracticeGames } from '../utils/practiceGames.js';

/**
 * Limited attempts (v2.167.0, ADR 0029): N game STARTS per player per `games`
 * row of a tournament, counted over the wire by the Castcade companion.
 *
 * - `recordStart` is what `GET /api/witness/attempt` lands on: the companion
 *   reports a game start the moment it happens, with an opaque `key` that the
 *   later score call repeats as `attempt=<key>`.
 * - `bindScore` is what the score ingest asks before it writes a score to a
 *   limited board: the score must belong to a counted, on-time attempt.
 * - `recordStartAndBind` is the CABINET's path (owner ruling 2026-10-22): a
 *   cabinet has no live start call, so each game report IS the attempt,
 *   counted at report time, plus one row per ball-one restart before it.
 *   Cabinet 1.0.4 also reports unscorable games (zero score, under 20 s)
 *   through `recordStart`, on the same `cab:<started>` key.
 *
 * The count and the insert are ONE `INSERT … SELECT` statement, which SQLite
 * runs atomically — two simultaneous starts cannot both read "4 used" and
 * both become attempt 5 of 5. (A `BEGIN … COMMIT` here would collide with any
 * other transaction open on the shared connection; the single statement gives
 * the same guarantee without that hazard.)
 *
 * No FKs on `attempts` (same doctrine as `witness_evidence`): the trail
 * outlives the game and tournament it describes.
 */

/** A start reported more than this many seconds after it happened is LATE: it counts, and its score will not. */
export const ATTEMPT_LATE_SEC = 120;

/**
 * W126 — `practice` joined the set: a game that STARTED while the player's
 * pause was open on the table (`attempt_pauses`). It used no slot (it is not
 * in `USED_STATUS_SQL`), never reaches the tournament board, and counts only
 * against the tournament's practice allowance (`tournaments.practice_games`).
 */
export type AttemptRowStatus = 'counted' | 'over_limit' | 'scored' | 'void' | 'unreported' | 'practice';

/**
 * W126 — where a practice game stands against the tournament's allowance.
 * `of` is `tournaments.practice_games` (0 = unlimited, then `remaining` is
 * null); `n` is the 1-based number of this practice game on the table.
 */
export type PracticeCount = { n: number; of: number; remaining: number | null };

export type AttemptStartResult =
    | {
        status: 'counted' | 'over_limit';
        attempt: number;
        of: number;
        remaining: number;
        late: boolean;
        /** True when this was a resend of a key already stored. */
        resent: boolean;
    }
    /** W126 — the start fell inside the player's pause: recorded, no slot used. */
    | { status: 'practice'; practice: PracticeCount; late: boolean; resent: boolean };

/**
 * W126 — one player's practice state on one table (the card, the game page,
 * the device line). `limit` null = the tournament does not offer practice;
 * 0 = unlimited (`left` is then null). `paused` is true only while an open
 * pause can still produce a practice game — an open pause whose allowance is
 * used up reads as not paused, which is what the next play will be.
 */
export type PracticeState = {
    offered: boolean;
    limit: number | null;
    used: number;
    left: number | null;
    paused: boolean;
    pausedTs: number | null;
};

/**
 * W56 / W82 — one row of the room's limited-attempts list for the viewer
 * (`GET /rooms/:roomId/attempt-starts/me`). W56 listed only start-required
 * tables (the "Start attempts" press); W82 lists every open limited-attempts
 * table the viewer is in, with their own counts, so the card can say
 * "N attempts left". `started`/`startedTs` mean something only when
 * `requireStart` is true — consumers gate the press on `requireStart`.
 */
export type RoomAttemptStart = {
    gameId: string;
    gameName: string;
    tournamentId: string;
    tournamentName: string | null;
    roundNo: number | null;
    started: boolean;
    startedTs: number | null;
    /** The tournament's `max_attempts`. */
    limit: number;
    /** This player's USED attempts on the table (`usedByPlayer`: counted/scored/unreported; W85 — an over_limit row used nothing). */
    used: number;
    /** `max(0, limit − used)`. */
    left: number;
    /** Does the tournament make players press Start attempts first? */
    requireStart: boolean;
    /** W126 — the viewer's practice state on this table (`offered: false` when the tournament has no practice allowance). */
    practice: PracticeState;
};

export type AttemptRefusalReason = 'late' | 'over_limit' | 'void' | 'reused' | 'unreported' | 'device' | 'exit_sample' | 'not_started' | 'practice';

/** What the player is told, per machine reason. The trail keeps the machine reason. */
export const ATTEMPT_REFUSAL_TEXT: Record<AttemptRefusalReason, string> = {
    late: 'this game start was reported late (offline?) — the attempt is used and this score does not count',
    over_limit: 'no attempts left on this table — this score does not count',
    void: 'this attempt was voided by an admin — this score does not count',
    reused: 'this attempt already has a different score — this score does not count',
    unreported: 'no game start was reported for this score — import this table in Castcade so live mode can count attempts',
    device: 'this tournament limits attempts per table; scores come from Arcaid Witness only',
    exit_sample: 'this table reports one score per sitting on the cabinet, so attempts cannot be counted on it',
    not_started: 'you have not pressed Start attempts for this table on Arcaid yet — this play used no attempt',
    // W126 — must not open with the `not_started` words: the Castcade
    // companion recognises that reason by its opening words.
    practice: 'practice mode is on for this table — this play used no attempt and does not count for the tournament',
};

/**
 * W38 (ADR 0033 §4) — has this play started counting? With "Start attempts"
 * required, a play counts only when the game began at or after the player's
 * press. `startedTs` undefined = never pressed.
 */
export function playIsStarted(startedTs: number | undefined, playStartTs: number): boolean {
    return startedTs != null && Math.floor(playStartTs) >= startedTs;
}

/**
 * W126 (ADR 0043) — did this play START inside one of the player's pauses on
 * the table? `[pausedTs, resumedTs)`, an open pause having no end. The rule
 * every surface states: a pause only looks forward, so a game that began
 * before the press stays an attempt whatever happens to the pause afterwards,
 * and a game that began inside it stays practice after a resume. The SQL in
 * `insertAtomic` is this same test (plus the allowance); keep the two equal.
 */
export function playIsPractice(
    pauses: ReadonlyArray<{ pausedTs: number; resumedTs: number | null }>, playStartTs: number,
): boolean {
    const t = Math.floor(playStartTs);
    return pauses.some(p => p.pausedTs <= t && (p.resumedTs == null || t < p.resumedTs));
}

/** W126 — the count for one practice game against the allowance. */
function practiceCount(n: number, cap: number | null): PracticeCount {
    const of = cap ?? 0;
    return { n, of, remaining: of > 0 ? Math.max(0, of - n) : null };
}

export type AttemptBindResult =
    | { ok: true; attemptId: number; attempt: { n: number; of: number; remaining: number } }
    | { ok: false; reason: AttemptRefusalReason; text: string };

export type AttemptAdminRow = {
    id: number;
    gameId: string;
    gameName: string | null;
    userId: string;
    playerLabel: string;
    attemptNo: number;
    status: AttemptRowStatus;
    late: boolean;
    startedTs: number;
    receivedAt: string;
    endedTs: number | null;
    score: number | null;
    scoreHistoryId: number | null;
    tableName: string | null;
    voidedAt: string | null;
    voidable: boolean;
    /**
     * W68 — an `over_limit` row the host can count now: it carries the play
     * (score + end time) and the player has room under the limit. False on
     * every other row.
     */
    reinstatable: boolean;
    /** W68 — why an `over_limit` row cannot be reinstated (for the button's title); null otherwise. */
    reinstateBlockedReason: string | null;
    /** W68 — the player's USED attempts on this table (counted/scored/unreported), what the room check counts; W85 — an over_limit row such as this one is not among them. */
    used: number;
};

type AttemptRow = {
    id: number; tournament_id: string; game_id: string; game_room_id: string | null;
    canonical_user_id: string; device_id: string; attempt_key: string; attempt_no: number;
    status: AttemptRowStatus; started_ts: number; received_at: string; late: number;
    ended_ts: number | null; score: number | null; score_history_id: number | null;
    players: number | null; table_name: string | null; rom: string | null;
    voided_by: string | null; voided_at: string | null; note: string | null;
};

/**
 * W68 (v2.203.0) — `scored` joined the set: a host may give back an attempt
 * that already has a score (the per-ball fragments of W67). Voiding never
 * touches the score by itself; the route deletes it only when asked.
 * W126 — `practice` too: voiding one gives a practice game back.
 */
const VOIDABLE: ReadonlySet<AttemptRowStatus> = new Set(['counted', 'over_limit', 'unreported', 'scored', 'practice']);

/**
 * W85 (v2.217.1) — the rows that USED a slot: `counted`, `scored`,
 * `unreported`. An `over_limit` row is a refused start kept for audit and
 * Reinstate (W68); it used nothing, so it is never "used": it does not fill
 * the room for the next start, does not eat the slot a void gives back, and
 * does not block a reinstate. Counting it did all three (TG, Congo, "15 of 5",
 * 2026-11-01). Every used count in this file reads through this predicate.
 */
const USED_STATUS_SQL = `status IN ('counted', 'scored', 'unreported')`;

export class AttemptVoidError extends Error {
    constructor(public code: 'NOT_FOUND' | 'NOT_VOIDABLE', public httpStatus: 404 | 409, message: string) {
        super(message);
        this.name = 'AttemptVoidError';
    }
}

export type AttemptReinstateCode = 'NOT_FOUND' | 'NOT_REINSTATABLE' | 'NO_ROOM' | 'MISSING_PLAY' | 'SUPPRESSED' | 'DUPLICATE';

export class AttemptReinstateError extends Error {
    constructor(public code: AttemptReinstateCode, public httpStatus: 404 | 409, message: string) {
        super(message);
        this.name = 'AttemptReinstateError';
    }
}

/** What `void` did: the row's status before, and the score it was bound to (a scored row). */
export type AttemptVoidResult = { previousStatus: AttemptRowStatus; scoreHistoryId: number | null };

/** W68 — what a reinstate wrote. */
export type AttemptReinstateResult = {
    attemptNo: number;
    of: number;
    scoreHistoryId: number;
    gameId: string;
    gameRoomId: string | null;
};

/** W68 — the reinstate check the list and the action share: null = allowed, else why not. */
function reinstateBlock(row: Pick<AttemptRow, 'status' | 'score' | 'ended_ts'>, usedByOthers: number, limit: number | null): string | null {
    if (row.status !== 'over_limit') return 'Only an attempt that went over the limit can be reinstated.';
    if (limit == null) return 'This tournament no longer limits attempts.';
    if (row.score == null || row.ended_ts == null) {
        return 'No score was recorded with this attempt, so there is no play to put on the board.';
    }
    if (usedByOthers >= limit) {
        return `No room: ${usedByOthers} of ${limit} attempts are already used on this table by this player. Void one first.`;
    }
    return null;
}

/**
 * Pure: the " · …" suffix for the cabinet's "Sending to" line. The cabinet
 * draws that line on ONE row with no wrapping, so it stays short: a single
 * game reads "7 OF 10 ATTEMPTS LEFT"; several name each table. Upper case to
 * match the lobby suffix beside it (`EventLobbyService.cabinetLine`).
 */
export function attemptsLeftLine(items: Array<{
    gameName: string; left: number; limit: number; notStarted?: boolean;
    /** W126 — the player's pause is open on this table: the next play is practice. */
    practice?: boolean;
    /** W126 — practice games left (null = unlimited). */
    practiceLeft?: number | null;
}>): string {
    if (items.length === 0) return '';
    if (items.length === 1) {
        const { left, limit, notStarted, practice, practiceLeft } = items[0]!;
        // W38 — a cabinet has no screen to press Start on; this is its cue to
        // press it on the phone before playing.
        if (notStarted) return ' · ATTEMPTS NOT STARTED';
        // W126 — the loudest state on the line: a player who forgot to resume
        // would otherwise play their real games as practice.
        if (practice) return practiceLeft != null ? ` · PRACTICE MODE, ${practiceLeft} LEFT` : ' · PRACTICE MODE';
        return left === 0 ? ' · NO ATTEMPTS LEFT' : ` · ${left} OF ${limit} ATTEMPTS LEFT`;
    }
    const parts = [...items]
        .sort((a, b) => a.gameName.localeCompare(b.gameName))
        .map(i => `${i.gameName.toUpperCase()} ${i.notStarted ? 'NOT STARTED' : i.practice ? 'PRACTICE' : `${i.left}/${i.limit}`}`);
    return ` · ATTEMPTS LEFT: ${parts.join(', ')}`;
}

/** W81 — one limited-attempts game a device's next play would count on, and what the player has left there. */
export type DeviceAttemptsLeft = {
    gameId: string; gameName: string; tournamentId: string;
    limit: number; used: number; left: number;
    /** W38 — the table needs Start attempts and the player has not pressed it. */
    notStarted: boolean;
    /** W126 — the player's pause is open here: the next play is practice and uses no attempt. */
    practice: boolean;
    /** W126 — practice games left (null = unlimited, or practice is not on). */
    practiceLeft: number | null;
};

function cleanKey(key: string | null | undefined): string {
    return (key ?? '').trim().slice(0, 200);
}

export class AttemptService {
    /** The tournament's limit, or null (unlimited / no such tournament). */
    static async limitFor(tournamentId: string | null | undefined): Promise<number | null> {
        if (!tournamentId) return null;
        const db = await getDatabase();
        const row = await db.get<{ max_attempts: number | null }>(
            'SELECT max_attempts FROM tournaments WHERE id = ?', tournamentId,
        );
        const n = row?.max_attempts;
        return typeof n === 'number' && n >= 1 ? n : null;
    }

    /** W126 — the tournament's practice allowance: null = not offered, 0 = unlimited, else games per player per table. */
    static async practiceGamesFor(tournamentId: string | null | undefined): Promise<number | null> {
        if (!tournamentId) return null;
        const db = await getDatabase();
        const row = await db.get<{ practice_games: number | null }>(
            'SELECT practice_games FROM tournaments WHERE id = ?', tournamentId,
        );
        return normalizePracticeGames(row?.practice_games);
    }

    /**
     * Insert one attempt row with its number and status decided in the SAME
     * statement as the count. `INSERT OR IGNORE` on the (device, key) unique
     * index makes a resend a no-op; the caller reads the stored row back.
     *
     * W85: the count is the player's USED rows (`USED_STATUS_SQL`), never the
     * over_limit ones — so after a void the next start is counted again. A row
     * within the limit is numbered used + 1; one past it `MAX(limit, used) +
     * k` (ADR 0029 "attempt = of + k"), so the host list reads 6 of 5, 7 of 5.
     * A forced status (`unreported`) is a used row and numbers as one.
     *
     * W126 (ADR 0043): the same statement decides PRACTICE first. The start is
     * practice when it falls inside one of the player's pauses on the table
     * (`playIsPractice`, tested at the play's own start) AND the tournament offers
     * practice AND the allowance is not used up (0 = unlimited). A practice
     * row uses no slot, is numbered in its own sequence (practice 1, 2, 3)
     * and beats a forced status — an unreported start inside a pause is
     * practice, not a used attempt. Deciding it here, with the count, is what
     * makes the allowance exact: two simultaneous starts cannot both be the
     * last practice game, and the start after the last one is an attempt.
     */
    private static async insertAtomic(row: {
        tournamentId: string; gameId: string; gameRoomId: string | null;
        canonicalUserId: string; deviceId: string; key: string;
        limit: number; forcedStatus: AttemptRowStatus | null;
        /** The status a row WITHIN the limit gets (default `counted`; a cabinet report is `scored` at once). */
        withinStatus?: 'counted' | 'scored';
        startedTs: number; late: boolean; players?: number | null;
        tableName?: string | null; rom?: string | null;
        endedTs?: number | null; score?: number | null;
        note?: string | null;
    }): Promise<void> {
        const db = await getDatabase();
        // W126 — the pause is tested at the play's OWN start (`startedTs`, the
        // device's clock), on a live start call as on an after-the-fact
        // report, exactly like `playIsStarted`. Deliberately not the moment
        // the call ARRIVED: a start call held back for a minute (network
        // unplugged) until the player saw the game going badly and pressed
        // Pause would then be filed as practice. With the play's own time a
        // game that began before the press is an attempt whenever its call
        // arrives.
        const practiceTs = Math.floor(row.startedTs);
        await db.run(
            `INSERT OR IGNORE INTO attempts (
                tournament_id, game_id, game_room_id, canonical_user_id, device_id, attempt_key,
                attempt_no, status, started_ts, late, players, table_name, rom, ended_ts, score, note
             )
             SELECT ?, ?, ?, ?, ?, ?,
                    CASE WHEN c.is_practice = 1 THEN c.practice + 1
                         WHEN ? IS NOT NULL OR c.used + 1 <= ? THEN c.used + 1
                         ELSE MAX(?, c.used) + c.over + 1 END,
                    CASE WHEN c.is_practice = 1 THEN 'practice'
                         ELSE COALESCE(?, CASE WHEN c.used + 1 <= ? THEN ? ELSE 'over_limit' END) END,
                    ?, ?, ?, ?, ?, ?, ?, ?
               FROM (SELECT a.used, a.over, a.practice,
                            CASE WHEN p.cap IS NOT NULL AND p.paused = 1 AND (p.cap = 0 OR a.practice < p.cap)
                                 THEN 1 ELSE 0 END AS is_practice
                       FROM (SELECT COALESCE(SUM(CASE WHEN ${USED_STATUS_SQL} THEN 1 ELSE 0 END), 0) AS used,
                                    COALESCE(SUM(CASE WHEN status = 'over_limit' THEN 1 ELSE 0 END), 0) AS over,
                                    COALESCE(SUM(CASE WHEN status = 'practice' THEN 1 ELSE 0 END), 0) AS practice
                               FROM attempts
                              WHERE game_id = ? AND canonical_user_id = ?) a,
                            (SELECT (SELECT practice_games FROM tournaments WHERE id = ?) AS cap,
                                    EXISTS (SELECT 1 FROM attempt_pauses ap
                                             WHERE ap.game_id = ? AND ap.canonical_user_id = ?
                                               AND ap.paused_ts <= ?
                                               AND (ap.resumed_ts IS NULL OR ? < ap.resumed_ts)) AS paused) p
                    ) c`,
            row.tournamentId, row.gameId, row.gameRoomId, row.canonicalUserId, row.deviceId, row.key,
            row.forcedStatus, row.limit, row.limit,
            row.forcedStatus, row.limit, row.withinStatus ?? 'counted',
            Math.floor(row.startedTs), row.late ? 1 : 0, row.players ?? null,
            row.tableName ?? null, row.rom ?? null, row.endedTs ?? null, row.score ?? null,
            row.note ? row.note.slice(0, 200) : null,
            row.gameId, row.canonicalUserId,
            row.tournamentId, row.gameId, row.canonicalUserId, practiceTs, practiceTs,
        );
        await AttemptService.closePauseAtCap({
            tournamentId: row.tournamentId, gameId: row.gameId, gameRoomId: row.gameRoomId,
            canonicalUserId: row.canonicalUserId, tableName: row.tableName ?? null,
            // After the start that used the last practice game, so that start stays inside the pause.
            atTs: Math.max(Math.floor(Date.now() / 1000), practiceTs + 1),
        });
    }

    /**
     * W126 — the pause ends itself when the last practice game has STARTED
     * (owner ruling 2026-11-24): the state the player sees afterwards is
     * "attempts counting", which is what their next game will be. The rule
     * does not depend on this row closing (`insertAtomic` tests the allowance
     * itself); this keeps what the page shows equal to what the rule does.
     * One conditional UPDATE, acted on only when it changed a row.
     */
    private static async closePauseAtCap(row: {
        tournamentId: string; gameId: string; gameRoomId: string | null;
        canonicalUserId: string; tableName: string | null; atTs: number;
    }): Promise<void> {
        const db = await getDatabase();
        const closed = await db.run(
            `UPDATE attempt_pauses
                SET resumed_ts = MAX(?, paused_ts), ended_by = 'cap'
              WHERE game_id = ? AND canonical_user_id = ? AND resumed_ts IS NULL
                AND COALESCE((SELECT practice_games FROM tournaments WHERE id = ?), 0) > 0
                AND (SELECT COUNT(*) FROM attempts a
                      WHERE a.game_id = attempt_pauses.game_id
                        AND a.canonical_user_id = attempt_pauses.canonical_user_id
                        AND a.status = 'practice')
                    >= (SELECT practice_games FROM tournaments WHERE id = ?)`,
            row.atTs, row.gameId, row.canonicalUserId, row.tournamentId, row.tournamentId,
        );
        if (closed.changes !== 1) return;
        void ActivityLogService.record({
            roomId: row.gameRoomId ?? undefined, category: 'score', eventType: 'attempts_resumed',
            userId: row.canonicalUserId, tournamentId: row.tournamentId, gameId: row.gameId,
            tableName: row.tableName, source: 'vpx',
            summary: `Practice games used up on ${row.tableName || 'a table'}; attempts are counting again`,
            details: { endedBy: 'cap' },
        });
    }

    /** One game START: (device, key) per GAME (v2.175.0, W37 — a play may count in several tournaments). */
    private static async byKey(deviceId: string, key: string, gameId: string): Promise<AttemptRow | undefined> {
        const db = await getDatabase();
        return db.get<AttemptRow>(
            'SELECT * FROM attempts WHERE device_id = ? AND attempt_key = ? AND game_id = ?', deviceId, key, gameId,
        );
    }

    /**
     * A game START (the `/witness/attempt` call). Counted while the player has
     * a slot left, `over_limit` (still recorded, numbered past the limit)
     * after. Late (> ATTEMPT_LATE_SEC between `started` and now) is recorded
     * and answered — the start still uses the slot; its score will be refused.
     * Idempotent on (device, key): a resend returns the stored answer.
     *
     * A CABINET also calls this (cabinet 1.0.4) for games it detected but
     * cannot score — abandoned at zero points (`no_score`) or shorter than
     * 20 s (`short_game`). Its reports are after the fact by design, so
     * `cabinet` never sets `late`; `note` keeps its reason and `endedTs`
     * the end. Its key is `cab:<started>`, the SAME key a cabinet score report
     * for that start uses (`recordStartAndBind`), so the two land on one row.
     */
    static async recordStart(input: {
        tournamentId: string; gameId: string; gameRoomId: string | null;
        canonicalUserId: string; deviceId: string; key: string;
        limit: number; startedTs: number; players?: number | null;
        tableName?: string | null; rom?: string | null;
        nowSec?: number;
        cabinet?: boolean;
        endedTs?: number | null;
        note?: string | null;
    }): Promise<AttemptStartResult | null> {
        const key = cleanKey(input.key);
        if (!key || !input.deviceId) return null;
        const existing = await AttemptService.byKey(input.deviceId, key, input.gameId);
        const now = input.nowSec ?? Math.floor(Date.now() / 1000);
        if (!existing) {
            await AttemptService.insertAtomic({
                ...input, key, forcedStatus: null,
                late: !input.cabinet && now - Math.floor(input.startedTs) > ATTEMPT_LATE_SEC,
                endedTs: input.endedTs != null && Number.isFinite(input.endedTs) ? Math.floor(input.endedTs) : null,
            });
        }
        const row = (existing ?? await AttemptService.byKey(input.deviceId, key, input.gameId))!;
        if (row.status === 'practice') {
            return {
                status: 'practice',
                practice: practiceCount(row.attempt_no, await AttemptService.practiceGamesFor(input.tournamentId)),
                late: row.late === 1,
                resent: !!existing,
            };
        }
        const of = input.limit;
        const counted = row.status === 'counted' || row.status === 'scored';
        return {
            status: counted ? 'counted' : 'over_limit',
            attempt: row.attempt_no,
            of,
            remaining: Math.max(0, of - row.attempt_no),
            late: row.late === 1,
            resent: !!existing,
        };
    }

    /**
     * May this score land on the limited board? ADR 0029's table:
     *   counted, on time → yes (the caller marks it scored once it is written)
     *   counted, late → no (`late`) · over_limit → no · void → no
     *   scored, same score → yes (the ordinary duplicate path dedups it)
     *   scored, different score → no (`reused`)
     *   no row → an `unreported` row is created now (it counts, late = 1) → no
     * A key that belongs to a different game is `reused`.
     */
    static async bindScore(input: {
        tournamentId: string; gameId: string; gameRoomId: string | null;
        canonicalUserId: string; deviceId: string; attemptKey: string | null | undefined;
        limit: number; score: number; startedTs: number; endedTs: number;
        tableName?: string | null; rom?: string | null;
        /**
         * W38 (ADR 0033 §3) — when the game's window opened (a round's
         * scheduled start, a rotation game's activation). A play that STARTED
         * before it cannot have a start row (the start call matched no open
         * game), yet it ENDED inside the window, and "every play that ends
         * inside the window counts once you are in": it is counted now.
         */
        windowStartTs?: number | null;
    }): Promise<AttemptBindResult> {
        const refuse = (reason: AttemptRefusalReason): AttemptBindResult =>
            ({ ok: false, reason, text: ATTEMPT_REFUSAL_TEXT[reason] });
        let key = cleanKey(input.attemptKey);
        let row = key ? await AttemptService.byKey(input.deviceId, key, input.gameId) : undefined;
        if (!row && key && input.windowStartTs != null && Math.floor(input.startedTs) < input.windowStartTs) {
            // Started before the window, ended inside it: the companion did
            // report the start (it carries a key) but the start call had no
            // open game to count it on. Count it now, in order, like any start.
            await AttemptService.insertAtomic({
                tournamentId: input.tournamentId, gameId: input.gameId, gameRoomId: input.gameRoomId,
                canonicalUserId: input.canonicalUserId, deviceId: input.deviceId, key,
                limit: input.limit, forcedStatus: null,
                startedTs: input.startedTs, late: false,
                tableName: input.tableName ?? null, rom: input.rom ?? null,
                note: 'started before the window',
            });
            row = await AttemptService.byKey(input.deviceId, key, input.gameId);
        }
        if (!row) {
            // No start was ever reported for this score. Record one now — it
            // counts against the player (the game was played) — and refuse.
            // A key-less score gets a key derived from the play so a resend
            // of the same score cannot count twice.
            if (!key) key = `unreported:${Math.floor(input.startedTs)}:${Math.floor(input.endedTs)}:${Math.floor(input.score)}`;
            await AttemptService.insertAtomic({
                tournamentId: input.tournamentId, gameId: input.gameId, gameRoomId: input.gameRoomId,
                canonicalUserId: input.canonicalUserId, deviceId: input.deviceId, key,
                limit: input.limit, forcedStatus: 'unreported',
                startedTs: input.startedTs, late: true,
                tableName: input.tableName ?? null, rom: input.rom ?? null,
                endedTs: input.endedTs, score: input.score,
            });
            // W126 — a start inside the player's pause was filed as practice
            // instead (it used no slot); say so rather than "unreported".
            const filed = await AttemptService.byKey(input.deviceId, key, input.gameId);
            return refuse(filed?.status === 'practice' ? 'practice' : 'unreported');
        }
        if (row.game_id !== input.gameId) return refuse('reused');
        switch (row.status) {
            case 'practice': {
                // W126 — decided at the START and never revisited: resuming
                // while the game runs does not turn it into an attempt. The
                // score is kept on the row (W126.2 would need it), written once.
                const db = await getDatabase();
                await db.run(
                    `UPDATE attempts SET score = ?, ended_ts = ? WHERE id = ? AND status = 'practice' AND score IS NULL`,
                    Math.floor(input.score), Math.floor(input.endedTs), row.id,
                );
                return refuse('practice');
            }
            case 'counted':
                if (row.late === 1) return refuse('late');
                return {
                    ok: true, attemptId: row.id,
                    attempt: { n: row.attempt_no, of: input.limit, remaining: Math.max(0, input.limit - row.attempt_no) },
                };
            case 'scored':
                if (row.score !== Math.floor(input.score)) return refuse('reused');
                return {
                    ok: true, attemptId: row.id,
                    attempt: { n: row.attempt_no, of: input.limit, remaining: Math.max(0, input.limit - row.attempt_no) },
                };
            case 'over_limit': return refuse('over_limit');
            case 'void': return refuse('void');
            case 'unreported': return refuse('unreported');
            default: return refuse('reused');
        }
    }

    /**
     * A CABINET game report (owner ruling 2026-10-22, ADR 0029). The cabinet
     * Witness has no live start call — each completed game it reports IS the
     * attempt, counted at report time. Keyed on `(device, 'cab:' + startedTs)`
     * so a replayed record (the cabinet re-sends up to 7 days of score files)
     * returns the same row and never uses a second attempt. Never `late`:
     * cabinet reports are after the fact by design. The count and the bind
     * are the one atomic insert: within the limit the row is `scored` at
     * once, past it `over_limit` and the score is refused.
     *
     * v1 numbering: the attempt number is the count of the player's existing
     * non-void rows on the game + 1, i.e. REPORT order. A cabinet that reports
     * games out of start order numbers them out of order; accepted for v1.
     *
     * `restarts` (the report's `restarts=N`): ball-one restarts the launcher
     * recorded BEFORE this game in the same sitting — each one an abandoned
     * game start. They are recorded first, as N rows keyed
     * `cab:<started>:r<i>` (note `restart`), each counted or over_limit by
     * the running count; the keys make a replay a no-op. Then the game itself.
     *
     * `note` (W64): stamped on the SCORED `cab:<started>` row only — the ingest
     * passes `restart` when the report is a game the player abandoned by a
     * hold-Start restart (`reason=restart`, cabinet 1.0.8+), so the attempt
     * trail reads the same as the `:r<i>` rows.
     *
     * If the cabinet already reported this start over `/witness/attempt`
     * (same `cab:<started>` key), the score binds to that row.
     */
    static async recordStartAndBind(input: {
        tournamentId: string; gameId: string; gameRoomId: string | null;
        canonicalUserId: string; deviceId: string;
        limit: number; score: number; startedTs: number; endedTs: number;
        tableName?: string | null; rom?: string | null;
        restarts?: number | null;
        note?: string | null;
    }): Promise<AttemptBindResult> {
        const refuse = (reason: AttemptRefusalReason): AttemptBindResult =>
            ({ ok: false, reason, text: ATTEMPT_REFUSAL_TEXT[reason] });
        const key = `cab:${Math.floor(input.startedTs)}`;
        const restarts = Math.min(50, Math.max(0, Math.floor(Number(input.restarts) || 0)));
        for (let i = 1; i <= restarts; i++) {
            await AttemptService.insertAtomic({
                tournamentId: input.tournamentId, gameId: input.gameId, gameRoomId: input.gameRoomId,
                canonicalUserId: input.canonicalUserId, deviceId: input.deviceId, key: `${key}:r${i}`,
                limit: input.limit, forcedStatus: null,
                startedTs: input.startedTs, late: false,
                tableName: input.tableName ?? null, rom: input.rom ?? null,
                note: 'restart',
            });
        }
        let row = await AttemptService.byKey(input.deviceId, key, input.gameId);
        if (!row) {
            await AttemptService.insertAtomic({
                tournamentId: input.tournamentId, gameId: input.gameId, gameRoomId: input.gameRoomId,
                canonicalUserId: input.canonicalUserId, deviceId: input.deviceId, key,
                limit: input.limit, forcedStatus: null, withinStatus: 'scored',
                startedTs: input.startedTs, late: false,
                tableName: input.tableName ?? null, rom: input.rom ?? null,
                endedTs: input.endedTs, score: Math.floor(input.score),
                note: input.note ?? null,
            });
            row = await AttemptService.byKey(input.deviceId, key, input.gameId);
            if (!row) return refuse('reused');
        }
        if (row.game_id !== input.gameId) return refuse('reused');
        switch (row.status) {
            case 'scored':
            case 'counted':
                if (row.score != null && row.score !== Math.floor(input.score)) return refuse('reused');
                return {
                    ok: true, attemptId: row.id,
                    attempt: { n: row.attempt_no, of: input.limit, remaining: Math.max(0, input.limit - row.attempt_no) },
                };
            case 'over_limit': return refuse('over_limit');
            case 'void': return refuse('void');
            // W126 — the game started inside the player's pause. The row keeps
            // its score (a start the cabinet reported first, over
            // `/witness/attempt`, has none yet), written once.
            case 'practice': {
                const db = await getDatabase();
                await db.run(
                    `UPDATE attempts SET score = ?, ended_ts = ? WHERE id = ? AND status = 'practice' AND score IS NULL`,
                    Math.floor(input.score), Math.floor(input.endedTs), row.id,
                );
                return refuse('practice');
            }
            default: return refuse('reused');
        }
    }

    /**
     * The score landed: the attempt is spent on it. A cabinet row is already
     * `scored` (bound at report time) and only gains its `score_history_id`.
     */
    static async markScored(attemptId: number, scored: { scoreHistoryId: number; score: number; endedTs: number }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE attempts SET status = 'scored', score_history_id = ?, score = ?, ended_ts = ?
              WHERE id = ? AND (status = 'counted' OR (status = 'scored' AND score_history_id IS NULL))`,
            scored.scoreHistoryId, Math.floor(scored.score), Math.floor(scored.endedTs), attemptId,
        );
    }

    /** Public read: `{ [gameId]: { [canonicalUserId]: used } }` — USED rows only (W85: void and over_limit excluded). */
    static async usedByGame(tournamentId: string): Promise<Record<string, Record<string, number>>> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ game_id: string; canonical_user_id: string; used: number }>>(
            `SELECT game_id, canonical_user_id, COUNT(*) AS used
               FROM attempts
              WHERE tournament_id = ? AND ${USED_STATUS_SQL}
              GROUP BY game_id, canonical_user_id`,
            tournamentId,
        );
        const out: Record<string, Record<string, number>> = {};
        for (const r of rows) {
            (out[r.game_id] ??= {})[r.canonical_user_id] = r.used;
        }
        return out;
    }

    /**
     * One player's used count per game (`{ [gameId]: used }`) — USED rows
     * only (W85: void and over_limit excluded) — the same count `usedByGame`
     * gives the game page's "You have N attempts left" banner.
     */
    static async usedByPlayer(canonicalUserId: string, gameIds: string[]): Promise<Record<string, number>> {
        if (gameIds.length === 0) return {};
        const db = await getDatabase();
        const rows = await db.all<Array<{ game_id: string; used: number }>>(
            `SELECT game_id, COUNT(*) AS used
               FROM attempts
              WHERE canonical_user_id = ? AND ${USED_STATUS_SQL}
                AND game_id IN (${gameIds.map(() => '?').join(', ')})
              GROUP BY game_id`,
            canonicalUserId, ...gameIds,
        );
        return Object.fromEntries(rows.map(r => [r.game_id, r.used]));
    }

    /** W38 — does this tournament make players press Start attempts first? */
    static async requiresStart(tournamentId: string | null | undefined): Promise<boolean> {
        if (!tournamentId) return false;
        const db = await getDatabase();
        const row = await db.get<{ require_attempt_start: number | null }>(
            'SELECT require_attempt_start FROM tournaments WHERE id = ?', tournamentId,
        );
        return row?.require_attempt_start === 1;
    }

    /** W38 — `{ [gameId]: started_ts }` for one player: when they pressed Start attempts per table. */
    static async startsFor(canonicalUserId: string, gameIds: string[]): Promise<Record<string, number>> {
        if (gameIds.length === 0) return {};
        const db = await getDatabase();
        const rows = await db.all<Array<{ game_id: string; started_ts: number }>>(
            `SELECT game_id, started_ts FROM attempt_starts
              WHERE canonical_user_id = ? AND game_id IN (${gameIds.map(() => '?').join(', ')})`,
            canonicalUserId, ...gameIds,
        );
        return Object.fromEntries(rows.map(r => [r.game_id, r.started_ts]));
    }

    /**
     * W126 — one player's practice state per table. `games` carries each
     * table's allowance (`tournaments.practice_games`); a table whose
     * tournament does not offer practice reads `offered: false` and costs no
     * query. Two batched reads for the rest: the practice games used
     * (`attempts.status = 'practice'`) and the OPEN pause per table.
     */
    static async practiceStateFor(
        canonicalUserId: string, games: ReadonlyArray<{ gameId: string; practiceGames: number | null }>,
    ): Promise<Record<string, PracticeState>> {
        const out: Record<string, PracticeState> = {};
        const offered = games.filter(g => normalizePracticeGames(g.practiceGames) != null);
        for (const g of games) {
            out[g.gameId] = { offered: false, limit: null, used: 0, left: null, paused: false, pausedTs: null };
        }
        if (offered.length === 0) return out;
        const db = await getDatabase();
        const ids = offered.map(g => g.gameId);
        const marks = ids.map(() => '?').join(', ');
        const [usedRows, openRows] = await Promise.all([
            db.all<Array<{ game_id: string; used: number }>>(
                `SELECT game_id, COUNT(*) AS used FROM attempts
                  WHERE canonical_user_id = ? AND status = 'practice' AND game_id IN (${marks})
                  GROUP BY game_id`,
                canonicalUserId, ...ids,
            ),
            db.all<Array<{ game_id: string; paused_ts: number }>>(
                `SELECT game_id, paused_ts FROM attempt_pauses
                  WHERE canonical_user_id = ? AND resumed_ts IS NULL AND game_id IN (${marks})`,
                canonicalUserId, ...ids,
            ),
        ]);
        const used = new Map(usedRows.map(r => [r.game_id, r.used]));
        const open = new Map(openRows.map(r => [r.game_id, r.paused_ts]));
        for (const g of offered) {
            const limit = normalizePracticeGames(g.practiceGames)!;
            const n = used.get(g.gameId) ?? 0;
            const hasRoom = limit === 0 || n < limit;
            const pausedTs = open.get(g.gameId) ?? null;
            out[g.gameId] = {
                offered: true, limit, used: n,
                left: limit === 0 ? null : Math.max(0, limit - n),
                // An open pause with nothing left produces attempts, not practice: say so.
                paused: pausedTs != null && hasRoom,
                pausedTs: pausedTs != null && hasRoom ? pausedTs : null,
            };
        }
        return out;
    }

    /** W126 — the game row the player presses on, with what the Start / Pause checks read. */
    private static async playerGameRow(input: { roomId: string; tournamentId: string; gameId: string }) {
        const db = await getDatabase();
        const { tournamentFinishedSql } = await import('../utils/openCard.js');
        return db.get<{
            name: string; status: string; format: string | null; max_attempts: number | null; require_attempt_start: number | null;
            checkin_required: number | null; game_room_id: string | null; finished: number; entry_mode: string | null;
            practice_games: number | null;
        }>(
            `SELECT g.name, g.status, t.format, t.max_attempts, t.require_attempt_start, t.checkin_required, t.game_room_id, t.entry_mode,
                    t.practice_games,
                    ${tournamentFinishedSql('t')} AS finished
               FROM games g JOIN tournaments t ON t.id = g.tournament_id
              WHERE g.id = ? AND t.id = ? AND t.game_room_id = ?`,
            input.gameId, input.tournamentId, input.roomId,
        );
    }

    /**
     * W126 — is this player ALLOWED IN (`entryAllowed`, the one entry rule a
     * device play is held to)? Shared by the Start attempts and Pause presses
     * so the two cannot disagree about who is in a tournament.
     */
    private static async playerEntry(
        row: { format: string | null; checkin_required: number | null; game_room_id: string | null; entry_mode: string | null },
        input: { roomId: string; tournamentId: string; userId: string },
    ): Promise<{ canonical: string; allowed: boolean; refusal: string }> {
        const db = await getDatabase();
        const { IdentityLinkService } = await import('./IdentityLinkService.js');
        const { entryAllowed, normalizeEntryMode } = await import('../utils/tournamentEntry.js');
        const canonical = await IdentityLinkService.resolveCanonical(input.userId);
        const [member, participant, roster] = await Promise.all([
            db.get('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', input.roomId, canonical),
            db.get('SELECT 1 FROM tournament_participants WHERE tournament_id = ? AND user_id = ?', input.tournamentId, canonical),
            db.get('SELECT 1 FROM tournament_roster WHERE tournament_id = ? AND user_id = ?', input.tournamentId, canonical),
        ]);
        const entryMode = normalizeEntryMode(row.entry_mode);
        const allowed = entryAllowed({
            format: row.format === 'event' ? 'event' : 'rotation',
            roomless: row.game_room_id == null,
            checkinRequired: row.checkin_required === 1,
            isMember: !!member,
            isParticipant: !!participant,
            entryMode,
            onRoster: !!roster,
        });
        return {
            canonical, allowed,
            refusal: entryMode === 'invited' && !roster
                ? 'This tournament is invite-only and you are not on its roster'
                : row.format === 'event' && row.checkin_required === 1
                ? "You're not checked in for this event"
                : 'Join this room first',
        };
    }

    /**
     * W126 (ADR 0043) — the player presses "Pause attempts" on one table.
     * From this instant (the SERVER's clock; never backdated) the games they
     * START on it are practice: no attempt used, off the tournament board, on
     * to the Global Scoreboard. A game already running stays an attempt.
     *
     * Refused when the tournament does not limit attempts or does not offer
     * practice (`NOT_OFFERED`), the table is closed (`NOT_OPEN`), the player
     * is not in (`NOT_ENTERED`, the device's own entry rule), Start attempts
     * is required and not pressed (`NOT_STARTED`: nothing counts yet, so there
     * is nothing to pause), no attempts are left (`NO_ATTEMPTS_LEFT`: plays
     * past the limit stay reinstatable only as over-limit rows), or the
     * allowance is used up (`NO_PRACTICE_LEFT`). Idempotent: a second press
     * keeps the open pause and its time (the partial unique index).
     */
    static async pauseForPlayer(input: {
        roomId: string; tournamentId: string; gameId: string; userId: string; nowSec?: number;
    }): Promise<
        | { ok: true; practice: PracticeState }
        | {
            ok: false; httpStatus: 403 | 404 | 409;
            code: 'NOT_FOUND' | 'NOT_OFFERED' | 'NOT_OPEN' | 'NOT_ENTERED' | 'NOT_STARTED' | 'NO_ATTEMPTS_LEFT' | 'NO_PRACTICE_LEFT';
            message: string;
        }
    > {
        const row = await AttemptService.playerGameRow(input);
        if (!row) return { ok: false, httpStatus: 404, code: 'NOT_FOUND', message: 'Game not found in this tournament' };
        const limit = row.max_attempts != null && row.max_attempts >= 1 ? row.max_attempts : null;
        const cap = normalizePracticeGames(row.practice_games);
        if (limit == null || cap == null) {
            return { ok: false, httpStatus: 409, code: 'NOT_OFFERED', message: 'This tournament does not offer practice games' };
        }
        if (row.finished === 1 || !['ACTIVE', 'SCHEDULED'].includes(row.status)) {
            return { ok: false, httpStatus: 409, code: 'NOT_OPEN', message: 'This table is closed' };
        }
        const entry = await AttemptService.playerEntry(row, input);
        if (!entry.allowed) return { ok: false, httpStatus: 403, code: 'NOT_ENTERED', message: entry.refusal };
        const canonical = entry.canonical;
        if (row.require_attempt_start === 1 && (await AttemptService.startsFor(canonical, [input.gameId]))[input.gameId] == null) {
            return {
                ok: false, httpStatus: 409, code: 'NOT_STARTED',
                message: 'Press Start attempts first. Until you do, your plays here use no attempt anyway',
            };
        }
        const used = (await AttemptService.usedByPlayer(canonical, [input.gameId]))[input.gameId] ?? 0;
        if (used >= limit) {
            return { ok: false, httpStatus: 409, code: 'NO_ATTEMPTS_LEFT', message: 'You have no attempts left on this table' };
        }
        const before = (await AttemptService.practiceStateFor(canonical, [{ gameId: input.gameId, practiceGames: cap }]))[input.gameId]!;
        if (before.left === 0) {
            return { ok: false, httpStatus: 409, code: 'NO_PRACTICE_LEFT', message: 'You have used all your practice games on this table' };
        }
        const db = await getDatabase();
        const now = input.nowSec ?? Math.floor(Date.now() / 1000);
        const inserted = await db.run(
            `INSERT OR IGNORE INTO attempt_pauses (game_id, canonical_user_id, tournament_id, paused_ts, source)
             VALUES (?, ?, ?, ?, 'web')`,
            input.gameId, canonical, input.tournamentId, now,
        );
        if (inserted.changes === 1) {
            void ActivityLogService.record({
                roomId: input.roomId, category: 'score', eventType: 'attempts_paused',
                userId: canonical, tournamentId: input.tournamentId, gameId: input.gameId, gameName: row.name,
                summary: `Attempts paused on ${row.name} to practice` +
                    (before.left != null ? ` (${before.left} practice ${before.left === 1 ? 'game' : 'games'} left)` : ''),
                details: { practiceGames: cap, practiceUsed: before.used },
            });
        }
        const practice = (await AttemptService.practiceStateFor(canonical, [{ gameId: input.gameId, practiceGames: cap }]))[input.gameId]!;
        return { ok: true, practice };
    }

    /**
     * W126 — the player presses "Resume attempts": the open pause on this
     * table ends now (the SERVER's clock), and games they START from here
     * count again. A practice game still running stays practice. Never
     * refused for a table that has closed or a setting the host changed —
     * resuming is always the safe direction; a press with no open pause
     * changes nothing.
     */
    static async resumeForPlayer(input: {
        roomId: string; tournamentId: string; gameId: string; userId: string; nowSec?: number;
    }): Promise<
        | { ok: true; resumed: boolean; practice: PracticeState }
        | { ok: false; httpStatus: 404; code: 'NOT_FOUND'; message: string }
    > {
        const row = await AttemptService.playerGameRow(input);
        if (!row) return { ok: false, httpStatus: 404, code: 'NOT_FOUND', message: 'Game not found in this tournament' };
        const { IdentityLinkService } = await import('./IdentityLinkService.js');
        const canonical = await IdentityLinkService.resolveCanonical(input.userId);
        const db = await getDatabase();
        const now = input.nowSec ?? Math.floor(Date.now() / 1000);
        const closed = await db.run(
            `UPDATE attempt_pauses SET resumed_ts = MAX(?, paused_ts), ended_by = 'player'
              WHERE game_id = ? AND canonical_user_id = ? AND resumed_ts IS NULL`,
            now, input.gameId, canonical,
        );
        if (closed.changes === 1) {
            void ActivityLogService.record({
                roomId: input.roomId, category: 'score', eventType: 'attempts_resumed',
                userId: canonical, tournamentId: input.tournamentId, gameId: input.gameId, gameName: row.name,
                summary: `Attempts resumed on ${row.name}; plays count again`,
                details: { endedBy: 'player' },
            });
        }
        const practice = (await AttemptService.practiceStateFor(
            canonical, [{ gameId: input.gameId, practiceGames: row.practice_games }],
        ))[input.gameId]!;
        return { ok: true, resumed: closed.changes === 1, practice };
    }

    /**
     * W126 — who is in practice mode right now in one tournament (the
     * runner's Attempts panel), names resolved, never a raw id. An open pause
     * whose allowance is used up is left out, as on the player's own page.
     */
    static async pausedNow(tournamentId: string): Promise<Array<{
        gameId: string; gameName: string | null; userId: string; playerLabel: string;
        pausedTs: number; practiceUsed: number; practiceLeft: number | null;
    }>> {
        const cap = await AttemptService.practiceGamesFor(tournamentId);
        if (cap == null) return [];
        const db = await getDatabase();
        const rows = await db.all<Array<{
            game_id: string; game_name: string | null; canonical_user_id: string; paused_ts: number; used: number;
        }>>(
            `SELECT p.game_id, g.name AS game_name, p.canonical_user_id, p.paused_ts,
                    (SELECT COUNT(*) FROM attempts a
                      WHERE a.game_id = p.game_id AND a.canonical_user_id = p.canonical_user_id
                        AND a.status = 'practice') AS used
               FROM attempt_pauses p
               LEFT JOIN games g ON g.id = p.game_id
              WHERE p.tournament_id = ? AND p.resumed_ts IS NULL
              ORDER BY p.paused_ts DESC
              LIMIT 500`,
            tournamentId,
        );
        const live = rows.filter(r => cap === 0 || r.used < cap);
        const labels = await resolveUserLabels(live.map(r => r.canonical_user_id));
        return live.map(r => ({
            gameId: r.game_id, gameName: r.game_name, userId: r.canonical_user_id,
            playerLabel: labels[r.canonical_user_id] ?? 'Unknown player',
            pausedTs: r.paused_ts, practiceUsed: r.used,
            practiceLeft: cap === 0 ? null : Math.max(0, cap - r.used),
        }));
    }

    /**
     * W56 / W82 — the room's limited-attempts list for one player: every OPEN
     * game in this room whose tournament limits attempts, that the player is
     * allowed in, with their own used/left counts (W82, the card's
     * "N attempts left") and — where the tournament requires the press —
     * whether they have pressed Start attempts (W56). The game set is
     * `VpxScoreIngestService.roomLimitedGames` (the same candidates + entry
     * rule a device play is matched against), so a card can never offer a
     * button the press itself would refuse as not entered. A table that does
     * not require the press reads `requireStart: false`, `started: false`.
     */
    static async roomStartsFor(input: { roomId: string; userId: string }): Promise<RoomAttemptStart[]> {
        const { IdentityLinkService } = await import('./IdentityLinkService.js');
        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const canonical = await IdentityLinkService.resolveCanonical(input.userId);
        const games = await VpxScoreIngestService.roomLimitedGames({ canonicalUserId: canonical, roomId: input.roomId });
        const ids = games.map(g => g.gameId);
        const [used, starts, practice] = await Promise.all([
            AttemptService.usedByPlayer(canonical, ids),
            AttemptService.startsFor(canonical, games.filter(g => g.requireStart).map(g => g.gameId)),
            AttemptService.practiceStateFor(canonical, games),
        ]);
        return games.map(g => ({
            gameId: g.gameId, gameName: g.gameName,
            tournamentId: g.tournamentId, tournamentName: g.tournamentName,
            roundNo: g.roundNo,
            started: starts[g.gameId] != null,
            startedTs: starts[g.gameId] ?? null,
            limit: g.limit,
            used: used[g.gameId] ?? 0,
            left: Math.max(0, g.limit - (used[g.gameId] ?? 0)),
            requireStart: g.requireStart,
            practice: practice[g.gameId]!,
        }));
    }

    /**
     * W38 (ADR 0033 §4) — the player presses Start attempts for one table.
     * Idempotent: a second press keeps the FIRST time (a later press would let
     * a player re-date their start past games they want forgotten). Returns
     * the stored start. Authorization (entered, game open, setting on) is the
     * caller's job.
     */
    static async startAttempts(input: {
        tournamentId: string; gameId: string; canonicalUserId: string;
        source: 'web' | 'device'; nowSec?: number;
    }): Promise<number> {
        const db = await getDatabase();
        const now = input.nowSec ?? Math.floor(Date.now() / 1000);
        await db.run(
            `INSERT OR IGNORE INTO attempt_starts (game_id, canonical_user_id, tournament_id, started_ts, source)
             VALUES (?, ?, ?, ?, ?)`,
            input.gameId, input.canonicalUserId, input.tournamentId, now, input.source,
        );
        const row = await db.get<{ started_ts: number }>(
            'SELECT started_ts FROM attempt_starts WHERE game_id = ? AND canonical_user_id = ?',
            input.gameId, input.canonicalUserId,
        );
        return row!.started_ts;
    }

    /**
     * W38 — the web "Start attempts" button, with every check the device path
     * would make: the tournament limits attempts AND requires the press, the
     * game is one of its open (ACTIVE) or upcoming (SCHEDULED round) tables and
     * the tournament has not finished, and the player is ALLOWED IN by the one
     * entry rule (`entryAllowed` — room member, or checked-in participant when
     * the event requires check-in). Pressing early is harmless: plays outside
     * the window never count anyway.
     */
    static async startForPlayer(input: {
        roomId: string; tournamentId: string; gameId: string; userId: string; nowSec?: number;
    }): Promise<
        | { ok: true; startedTs: number }
        | { ok: false; httpStatus: 403 | 404 | 409; code: 'NOT_FOUND' | 'NOT_REQUIRED' | 'NOT_OPEN' | 'NOT_ENTERED'; message: string }
    > {
        const row = await AttemptService.playerGameRow(input);
        if (!row) return { ok: false, httpStatus: 404, code: 'NOT_FOUND', message: 'Game not found in this tournament' };
        if (!(row.max_attempts != null && row.max_attempts >= 1) || row.require_attempt_start !== 1) {
            return { ok: false, httpStatus: 409, code: 'NOT_REQUIRED', message: 'This tournament does not use Start attempts' };
        }
        if (row.finished === 1 || !['ACTIVE', 'SCHEDULED'].includes(row.status)) {
            return { ok: false, httpStatus: 409, code: 'NOT_OPEN', message: 'This table is closed' };
        }
        const entry = await AttemptService.playerEntry(row, input);
        if (!entry.allowed) return { ok: false, httpStatus: 403, code: 'NOT_ENTERED', message: entry.refusal };
        const startedTs = await AttemptService.startAttempts({
            tournamentId: input.tournamentId, gameId: input.gameId, canonicalUserId: entry.canonical,
            source: 'web', nowSec: input.nowSec,
        });
        return { ok: true, startedTs };
    }

    /**
     * The attempts suffix for a Witness device's "Sending to" line
     * (2026-10-25): what a cabinet player has left on the limited-attempts
     * games their next play would count on. Empty when there are none.
     */
    static async deviceLine(deviceId: string, canonicalUserId: string, nowTs: number = Math.floor(Date.now() / 1000), playDevice?: import('./VpxScoreIngestService.js').PlayDevice | null): Promise<string> {
        return attemptsLeftLine(await AttemptService.deviceAttemptsLeft({ deviceId, canonicalUserId, nowTs, playDevice }));
    }

    /**
     * W81 — the attempts behind `deviceLine`, structured: one entry per
     * limited-attempts game the device's next play would count on
     * (`VpxScoreIngestService.openLimitedGames`, the same candidate / routing /
     * entry / window / exclusion filters `match` uses), with the player's
     * used count (`usedByPlayer`, void excluded) and what is left. The cabinet
     * line and the runner's Witness page both read this, so they cannot name
     * different games or different counts.
     */
    static async deviceAttemptsLeft(input: {
        deviceId: string; canonicalUserId: string; nowTs: number;
        playDevice?: import('./VpxScoreIngestService.js').PlayDevice | null;
        /** Known by the caller already (skips a lookup); else read from `witness_devices`. */
        deviceType?: 'atgames' | 'desktop' | null;
    }): Promise<DeviceAttemptsLeft[]> {
        const { WitnessService } = await import('./WitnessService.js');
        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        let deviceType = input.deviceType ?? null;
        if (!deviceType) {
            const db = await getDatabase();
            const device = await db.get<{ device_type: string | null }>(
                'SELECT device_type FROM witness_devices WHERE atgames_unique_id = ?', input.deviceId,
            );
            deviceType = device?.device_type === 'desktop' ? 'desktop' : 'atgames';
        }
        const games = await VpxScoreIngestService.openLimitedGames({
            canonicalUserId: input.canonicalUserId,
            target: await WitnessService.getDeviceTarget(input.deviceId),
            deviceType,
            playDevice: input.playDevice,
            nowTs: input.nowTs,
        });
        const ids = games.map(g => g.gameId);
        const [used, starts, practice] = await Promise.all([
            AttemptService.usedByPlayer(input.canonicalUserId, ids),
            AttemptService.startsFor(input.canonicalUserId, ids),
            AttemptService.practiceStateFor(input.canonicalUserId, games),
        ]);
        return games.map(g => ({
            gameId: g.gameId, gameName: g.gameName, tournamentId: g.tournamentId, limit: g.limit,
            used: used[g.gameId] ?? 0,
            left: Math.max(0, g.limit - (used[g.gameId] ?? 0)),
            // W38 — a table that needs Start attempts and has none reads NOT STARTED.
            notStarted: g.requireStart && starts[g.gameId] == null,
            // W126 — the pause is open: the next play here is practice.
            practice: practice[g.gameId]!.paused,
            practiceLeft: practice[g.gameId]!.paused ? practice[g.gameId]!.left : null,
        }));
    }

    /** The runner's list, newest first, names resolved (never a raw id). */
    static async listForAdmin(tournamentId: string, gameId?: string | null): Promise<AttemptAdminRow[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<AttemptRow & { game_name: string | null }>>(
            `SELECT a.*, g.name AS game_name
               FROM attempts a
               LEFT JOIN games g ON g.id = a.game_id
              WHERE a.tournament_id = ?
                ${gameId ? 'AND a.game_id = ?' : ''}
              ORDER BY a.received_at DESC, a.id DESC
              LIMIT 1000`,
            ...(gameId ? [tournamentId, gameId] : [tournamentId]),
        );
        const [labels, used, limit] = await Promise.all([
            resolveUserLabels(rows.map(r => r.canonical_user_id)),
            AttemptService.usedByGame(tournamentId),
            AttemptService.limitFor(tournamentId),
        ]);
        return rows.map(r => {
            const usedHere = used[r.game_id]?.[r.canonical_user_id] ?? 0;
            // The room check counts the player's USED rows; this over_limit row is not one of them (W85).
            const block = r.status === 'over_limit' ? reinstateBlock(r, usedHere, limit) : null;
            return {
                id: r.id,
                gameId: r.game_id,
                gameName: r.game_name,
                userId: r.canonical_user_id,
                playerLabel: labels[r.canonical_user_id] ?? 'Unknown player',
                attemptNo: r.attempt_no,
                status: r.status,
                late: r.late === 1,
                startedTs: r.started_ts,
                receivedAt: r.received_at,
                endedTs: r.ended_ts,
                score: r.score,
                scoreHistoryId: r.score_history_id,
                tableName: r.table_name,
                voidedAt: r.voided_at,
                voidable: VOIDABLE.has(r.status),
                reinstatable: r.status === 'over_limit' && block == null,
                reinstateBlockedReason: block,
                used: usedHere,
            };
        });
    }

    /**
     * An admin gives the attempt back: any non-void row (counted, over_limit,
     * unreported, and since W68 a `scored` one). A void is final — `bindScore`
     * and the cabinet report path refuse a replay of a void key.
     *
     * Voiding never removes a score by itself: a scored row's score stays on
     * the board (it was a real play) unless the caller deletes it too — the
     * route does that through the ordinary per-row delete when the host ticks
     * "Also delete its score". The returned `scoreHistoryId` is what to delete.
     */
    static async void(attemptId: number, adminUserId: string, tournamentId?: string): Promise<AttemptVoidResult> {
        const db = await getDatabase();
        const row = await db.get<AttemptRow>(
            `SELECT * FROM attempts WHERE id = ? ${tournamentId ? 'AND tournament_id = ?' : ''}`,
            ...(tournamentId ? [attemptId, tournamentId] : [attemptId]),
        );
        if (!row) throw new AttemptVoidError('NOT_FOUND', 404, 'Attempt not found.');
        if (!VOIDABLE.has(row.status)) {
            throw new AttemptVoidError('NOT_VOIDABLE', 409, 'This attempt is already void.');
        }
        const res = await db.run(
            `UPDATE attempts SET status = 'void', voided_by = ?, voided_at = datetime('now') WHERE id = ? AND status <> 'void'`,
            adminUserId, attemptId,
        );
        if (res.changes !== 1) throw new AttemptVoidError('NOT_VOIDABLE', 409, 'This attempt is already void.');
        // G14 (ADR 0037) - the void is an activity row in the tournament's room.
        void ActivityLogService.record({
            category: 'score', eventType: 'attempt_voided',
            userId: row.canonical_user_id, actorUserId: adminUserId, deviceId: row.device_id,
            tournamentId: row.tournament_id, gameId: row.game_id, tableName: row.table_name,
            source: 'vpx', score: row.score,
            summary: row.status === 'practice'
                ? `Practice game ${row.attempt_no} on ${row.table_name || 'a table'} voided (the practice game is given back)`
                : `Attempt ${row.attempt_no} on ${row.table_name || 'a table'} voided (was ${row.status})`,
            details: { attemptId: row.id, previousStatus: row.status },
            dedupeKey: `att-void:${row.id}`,
        });
        return { previousStatus: row.status, scoreHistoryId: row.score_history_id };
    }

    /**
     * W68 (v2.203.0) — a host REINSTATES an `over_limit` attempt once room
     * exists (owner ask 2026-10-30: per-ball fragments ate a player's attempts,
     * the host voided them, and the real game that was over the limit should
     * now count). The play itself is on the row (a cabinet report stores its
     * score and end time); its trail row and Global copy already exist.
     *
     *   1. Only an `over_limit` row, in a tournament that still limits
     *      attempts, that carries its score and end time (a DESKTOP start that
     *      went over the limit never stored its score, so there is no play to
     *      land — refused, never invented).
     *   2. Room: the player's OTHER non-void rows on this table must be fewer
     *      than the limit; the row becomes attempt (that count + 1) — the same
     *      numbering the insert uses. Count and flip are ONE `UPDATE`, atomic
     *      like `insertAtomic`, so two reinstates cannot both take the last slot.
     *   3. The play lands through `VpxScoreIngestService.landReinstated` (the
     *      ingest's own board write; suppression honoured; no second Global
     *      row), and the attempt is bound to the new row like `markScored`.
     *      A suppressed or duplicate play writes nothing and the flip is undone.
     */
    static async reinstateAttempt(attemptId: number, tournamentId: string, adminUserId: string): Promise<AttemptReinstateResult> {
        const db = await getDatabase();
        const row = await db.get<AttemptRow>(
            'SELECT * FROM attempts WHERE id = ? AND tournament_id = ?', attemptId, tournamentId,
        );
        if (!row) throw new AttemptReinstateError('NOT_FOUND', 404, 'Attempt not found.');
        if (row.status !== 'over_limit') {
            throw new AttemptReinstateError('NOT_REINSTATABLE', 409, 'Only an attempt that went over the limit can be reinstated.');
        }
        const limit = await AttemptService.limitFor(tournamentId);
        const others = (await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM attempts
              WHERE game_id = ? AND canonical_user_id = ? AND ${USED_STATUS_SQL} AND id <> ?`,
            row.game_id, row.canonical_user_id, row.id,
        ))!.n;
        const block = reinstateBlock(row, others, limit);
        if (block) {
            const code: AttemptReinstateCode = limit == null ? 'NOT_REINSTATABLE'
                : row.score == null || row.ended_ts == null ? 'MISSING_PLAY' : 'NO_ROOM';
            throw new AttemptReinstateError(code, 409, block);
        }

        const game = await db.get<{ id: string; name: string; game_room_id: string | null }>(
            `SELECT g.id, g.name, COALESCE(g.game_room_id, t.game_room_id) AS game_room_id
               FROM games g LEFT JOIN tournaments t ON t.id = g.tournament_id
              WHERE g.id = ? AND g.tournament_id = ?`,
            row.game_id, tournamentId,
        );
        if (!game) throw new AttemptReinstateError('MISSING_PLAY', 409, 'The table this attempt was on no longer exists in this tournament.');

        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const score = row.score!;
        const endedTs = row.ended_ts!;
        const playedAt = VpxScoreIngestService.playedAtOf(endedTs);

        // The over-limit play's trail row (written by the ingest's refusal) and
        // the Global copy it points at: the device kind for provenance, the
        // headset fact a desktop sent (`global_scores.device`).
        const trail = await db.get<{ id: number; global_score_id: string | null }>(
            `SELECT id, global_score_id FROM witness_evidence
              WHERE device_id = ? AND canonical_user_id = ? AND game_id = ? AND tournament_id = ?
                AND outcome = 'attempt_refused' AND score = ? AND played_at = ?
              ORDER BY id DESC LIMIT 1`,
            row.device_id, row.canonical_user_id, row.game_id, tournamentId, score, playedAt,
        );
        const device = await db.get<{ device_type: string | null }>(
            'SELECT device_type FROM witness_devices WHERE atgames_unique_id = ?', row.device_id,
        );
        const globalDevice = trail?.global_score_id
            ? (await db.get<{ device: string | null }>('SELECT device FROM global_scores WHERE id = ?', trail.global_score_id))?.device ?? null
            : null;
        const deviceType = device
            ? (device.device_type === 'desktop' ? 'desktop' : 'atgames')
            : globalDevice === 'atgames' ? 'atgames'
            : globalDevice === 'pc' || globalDevice === 'vr_headset' ? 'desktop'
            : null;
        if (!deviceType) {
            throw new AttemptReinstateError('MISSING_PLAY', 409, 'Cannot tell which machine this play came from (the device is no longer paired).');
        }
        const provenance = VpxScoreIngestService.provenanceFor(
            deviceType, deviceType === 'desktop' && globalDevice === 'vr_headset' ? 'vr_headset' : 'pc',
        );

        // Checked before the flip so the common refusal changes nothing; the
        // landing checks again for a race.
        if (await VpxScoreIngestService.isReinstateSuppressed(row.canonical_user_id, game.name, row.table_name, row.rom, score, playedAt)) {
            throw new AttemptReinstateError('SUPPRESSED', 409, 'This play was deleted, so it cannot be put back on the board.');
        }

        const flipped = await db.run(
            `UPDATE attempts
                SET status = 'scored',
                    attempt_no = (SELECT COUNT(*) FROM attempts o
                                   WHERE o.game_id = attempts.game_id AND o.canonical_user_id = attempts.canonical_user_id
                                     AND o.status IN ('counted', 'scored', 'unreported') AND o.id <> attempts.id) + 1
              WHERE id = ? AND status = 'over_limit'
                AND (SELECT COUNT(*) FROM attempts o
                      WHERE o.game_id = attempts.game_id AND o.canonical_user_id = attempts.canonical_user_id
                        AND o.status IN ('counted', 'scored', 'unreported') AND o.id <> attempts.id) < ?`,
            row.id, limit,
        );
        if (flipped.changes !== 1) {
            throw new AttemptReinstateError('NO_ROOM', 409, 'The attempt changed while it was being reinstated — reload and try again.');
        }
        const undo = () => db.run(
            `UPDATE attempts SET status = 'over_limit', attempt_no = ? WHERE id = ? AND status = 'scored' AND score_history_id IS NULL`,
            row.attempt_no, row.id,
        );

        let landed: Awaited<ReturnType<typeof VpxScoreIngestService.landReinstated>>;
        try {
            landed = await VpxScoreIngestService.landReinstated({
                canonicalUserId: row.canonical_user_id,
                game: { id: game.id, name: game.name, gameRoomId: game.game_room_id, tournamentId },
                score, endedTs, tableName: row.table_name, rom: row.rom,
                provenance, trailId: trail?.id ?? null, deviceId: row.device_id,
            });
        } catch (err) {
            await undo();
            throw err;
        }
        if (landed.status !== 'ingested') {
            await undo();
            throw landed.status === 'suppressed'
                ? new AttemptReinstateError('SUPPRESSED', 409, 'This play was deleted, so it cannot be put back on the board.')
                : new AttemptReinstateError('DUPLICATE', 409, 'This player already has this exact score on this table, so nothing new would land.');
        }

        await AttemptService.markScored(row.id, { scoreHistoryId: landed.scoreHistoryId, score, endedTs });
        const after = (await db.get<{ attempt_no: number }>('SELECT attempt_no FROM attempts WHERE id = ?', row.id))!;
        void ActivityLogService.record({
            roomId: game.game_room_id, category: 'score', eventType: 'attempt_reinstated',
            userId: row.canonical_user_id, actorUserId: adminUserId, deviceId: row.device_id,
            tournamentId, gameId: game.id, gameName: game.name, tableName: row.table_name,
            source: 'vpx', score,
            summary: `Over-limit attempt on ${game.name} reinstated; score ${score.toLocaleString('en-US')} landed as attempt ${after.attempt_no}`,
            details: { attemptId: row.id, scoreHistoryId: landed.scoreHistoryId },
        });

        if (game.game_room_id) {
            try {
                const { emitLeaderboardUpdated } = await import('../api/websocket.js');
                emitLeaderboardUpdated(game.game_room_id, { gameId: game.id });
            } catch { /* socket optional */ }
        }
        logInfo(
            `Attempt #${row.id} reinstated by ${adminUserId}: ${row.canonical_user_id} ${score} on "${game.name}" ` +
            `is attempt ${after.attempt_no} of ${limit} (score_history#${landed.scoreHistoryId})`,
        );
        return {
            attemptNo: after.attempt_no, of: limit!, scoreHistoryId: landed.scoreHistoryId,
            gameId: game.id, gameRoomId: game.game_room_id,
        };
    }
}
