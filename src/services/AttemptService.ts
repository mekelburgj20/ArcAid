import { getDatabase } from '../database/database.js';
import { resolveUserLabels } from './PlayerProfileResolver.js';

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

export type AttemptRowStatus = 'counted' | 'over_limit' | 'scored' | 'void' | 'unreported';

export type AttemptStartResult = {
    status: 'counted' | 'over_limit';
    attempt: number;
    of: number;
    remaining: number;
    late: boolean;
    /** True when this was a resend of a key already stored. */
    resent: boolean;
};

export type AttemptRefusalReason = 'late' | 'over_limit' | 'void' | 'reused' | 'unreported' | 'device' | 'exit_sample' | 'not_started';

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
};

/**
 * W38 (ADR 0033 §4) — has this play started counting? With "Start attempts"
 * required, a play counts only when the game began at or after the player's
 * press. `startedTs` undefined = never pressed.
 */
export function playIsStarted(startedTs: number | undefined, playStartTs: number): boolean {
    return startedTs != null && Math.floor(playStartTs) >= startedTs;
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
};

type AttemptRow = {
    id: number; tournament_id: string; game_id: string; game_room_id: string | null;
    canonical_user_id: string; device_id: string; attempt_key: string; attempt_no: number;
    status: AttemptRowStatus; started_ts: number; received_at: string; late: number;
    ended_ts: number | null; score: number | null; score_history_id: number | null;
    players: number | null; table_name: string | null; rom: string | null;
    voided_by: string | null; voided_at: string | null; note: string | null;
};

const VOIDABLE: ReadonlySet<AttemptRowStatus> = new Set(['counted', 'over_limit', 'unreported']);

export class AttemptVoidError extends Error {
    constructor(public code: 'NOT_FOUND' | 'NOT_VOIDABLE', public httpStatus: 404 | 409, message: string) {
        super(message);
        this.name = 'AttemptVoidError';
    }
}

/**
 * Pure: the " · …" suffix for the cabinet's "Sending to" line. The cabinet
 * draws that line on ONE row with no wrapping, so it stays short: a single
 * game reads "7 OF 10 ATTEMPTS LEFT"; several name each table. Upper case to
 * match the lobby suffix beside it (`EventLobbyService.cabinetLine`).
 */
export function attemptsLeftLine(items: Array<{ gameName: string; left: number; limit: number; notStarted?: boolean }>): string {
    if (items.length === 0) return '';
    if (items.length === 1) {
        const { left, limit, notStarted } = items[0]!;
        // W38 — a cabinet has no screen to press Start on; this is its cue to
        // press it on the phone before playing.
        if (notStarted) return ' · ATTEMPTS NOT STARTED';
        return left === 0 ? ' · NO ATTEMPTS LEFT' : ` · ${left} OF ${limit} ATTEMPTS LEFT`;
    }
    const parts = [...items]
        .sort((a, b) => a.gameName.localeCompare(b.gameName))
        .map(i => `${i.gameName.toUpperCase()} ${i.notStarted ? 'NOT STARTED' : `${i.left}/${i.limit}`}`);
    return ` · ATTEMPTS LEFT: ${parts.join(', ')}`;
}

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

    /**
     * Insert one attempt row with its number and status decided in the SAME
     * statement as the count. `INSERT OR IGNORE` on the (device, key) unique
     * index makes a resend a no-op; the caller reads the stored row back.
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
        await db.run(
            `INSERT OR IGNORE INTO attempts (
                tournament_id, game_id, game_room_id, canonical_user_id, device_id, attempt_key,
                attempt_no, status, started_ts, late, players, table_name, rom, ended_ts, score, note
             )
             SELECT ?, ?, ?, ?, ?, ?,
                    c.n + 1,
                    COALESCE(?, CASE WHEN c.n + 1 <= ? THEN ? ELSE 'over_limit' END),
                    ?, ?, ?, ?, ?, ?, ?, ?
               FROM (SELECT COUNT(*) AS n FROM attempts
                      WHERE game_id = ? AND canonical_user_id = ? AND status <> 'void') c`,
            row.tournamentId, row.gameId, row.gameRoomId, row.canonicalUserId, row.deviceId, row.key,
            row.forcedStatus, row.limit, row.withinStatus ?? 'counted',
            Math.floor(row.startedTs), row.late ? 1 : 0, row.players ?? null,
            row.tableName ?? null, row.rom ?? null, row.endedTs ?? null, row.score ?? null,
            row.note ? row.note.slice(0, 200) : null,
            row.gameId, row.canonicalUserId,
        );
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
            return refuse('unreported');
        }
        if (row.game_id !== input.gameId) return refuse('reused');
        switch (row.status) {
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
     * If the cabinet already reported this start over `/witness/attempt`
     * (same `cab:<started>` key), the score binds to that row.
     */
    static async recordStartAndBind(input: {
        tournamentId: string; gameId: string; gameRoomId: string | null;
        canonicalUserId: string; deviceId: string;
        limit: number; score: number; startedTs: number; endedTs: number;
        tableName?: string | null; rom?: string | null;
        restarts?: number | null;
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

    /** Public read: `{ [gameId]: { [canonicalUserId]: used } }`, void rows excluded. */
    static async usedByGame(tournamentId: string): Promise<Record<string, Record<string, number>>> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ game_id: string; canonical_user_id: string; used: number }>>(
            `SELECT game_id, canonical_user_id, COUNT(*) AS used
               FROM attempts
              WHERE tournament_id = ? AND status <> 'void'
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
     * One player's used count per game (`{ [gameId]: used }`), void rows
     * excluded — the same count `usedByGame` gives the game page's
     * "You have N attempts left" banner.
     */
    static async usedByPlayer(canonicalUserId: string, gameIds: string[]): Promise<Record<string, number>> {
        if (gameIds.length === 0) return {};
        const db = await getDatabase();
        const rows = await db.all<Array<{ game_id: string; used: number }>>(
            `SELECT game_id, COUNT(*) AS used
               FROM attempts
              WHERE canonical_user_id = ? AND status <> 'void'
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
        const db = await getDatabase();
        const { tournamentFinishedSql } = await import('../utils/openCard.js');
        const row = await db.get<{
            status: string; format: string | null; max_attempts: number | null; require_attempt_start: number | null;
            checkin_required: number | null; game_room_id: string | null; finished: number;
        }>(
            `SELECT g.status, t.format, t.max_attempts, t.require_attempt_start, t.checkin_required, t.game_room_id,
                    ${tournamentFinishedSql('t')} AS finished
               FROM games g JOIN tournaments t ON t.id = g.tournament_id
              WHERE g.id = ? AND t.id = ? AND t.game_room_id = ?`,
            input.gameId, input.tournamentId, input.roomId,
        );
        if (!row) return { ok: false, httpStatus: 404, code: 'NOT_FOUND', message: 'Game not found in this tournament' };
        if (!(row.max_attempts != null && row.max_attempts >= 1) || row.require_attempt_start !== 1) {
            return { ok: false, httpStatus: 409, code: 'NOT_REQUIRED', message: 'This tournament does not use Start attempts' };
        }
        if (row.finished === 1 || !['ACTIVE', 'SCHEDULED'].includes(row.status)) {
            return { ok: false, httpStatus: 409, code: 'NOT_OPEN', message: 'This table is closed' };
        }
        const { IdentityLinkService } = await import('./IdentityLinkService.js');
        const { entryAllowed } = await import('../utils/tournamentEntry.js');
        const canonical = await IdentityLinkService.resolveCanonical(input.userId);
        const [member, participant] = await Promise.all([
            db.get('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', input.roomId, canonical),
            db.get('SELECT 1 FROM tournament_participants WHERE tournament_id = ? AND user_id = ?', input.tournamentId, canonical),
        ]);
        const allowed = entryAllowed({
            format: row.format === 'event' ? 'event' : 'rotation',
            roomless: row.game_room_id == null,
            checkinRequired: row.checkin_required === 1,
            isMember: !!member,
            isParticipant: !!participant,
        });
        if (!allowed) {
            return {
                ok: false, httpStatus: 403, code: 'NOT_ENTERED',
                message: row.format === 'event' && row.checkin_required === 1
                    ? "You're not checked in for this event"
                    : 'Join this room first',
            };
        }
        const startedTs = await AttemptService.startAttempts({
            tournamentId: input.tournamentId, gameId: input.gameId, canonicalUserId: canonical,
            source: 'web', nowSec: input.nowSec,
        });
        return { ok: true, startedTs };
    }

    /**
     * The attempts suffix for a Witness device's "Sending to" line
     * (2026-10-25): what a cabinet player has left on the limited-attempts
     * games their next play would count on. Empty when there are none.
     */
    static async deviceLine(deviceId: string, canonicalUserId: string, nowTs: number = Math.floor(Date.now() / 1000)): Promise<string> {
        const { WitnessService } = await import('./WitnessService.js');
        const { VpxScoreIngestService } = await import('./VpxScoreIngestService.js');
        const db = await getDatabase();
        const device = await db.get<{ device_type: string | null }>(
            'SELECT device_type FROM witness_devices WHERE atgames_unique_id = ?', deviceId,
        );
        const games = await VpxScoreIngestService.openLimitedGames({
            canonicalUserId,
            target: await WitnessService.getDeviceTarget(deviceId),
            deviceType: device?.device_type === 'desktop' ? 'desktop' : 'atgames',
            nowTs,
        });
        const ids = games.map(g => g.gameId);
        const [used, starts] = await Promise.all([
            AttemptService.usedByPlayer(canonicalUserId, ids),
            AttemptService.startsFor(canonicalUserId, ids),
        ]);
        return attemptsLeftLine(games.map(g => ({
            gameName: g.gameName, limit: g.limit, left: Math.max(0, g.limit - (used[g.gameId] ?? 0)),
            // W38 — a table that needs Start attempts and has none reads NOT STARTED.
            notStarted: g.requireStart && starts[g.gameId] == null,
        })));
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
        const labels = await resolveUserLabels(rows.map(r => r.canonical_user_id));
        return rows.map(r => ({
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
        }));
    }

    /**
     * An admin gives the attempt back. Only a counted, over_limit or
     * unreported row; a `scored` row is refused — voiding never removes a
     * score (delete the score instead, which leaves the attempt used).
     */
    static async void(attemptId: number, adminUserId: string, tournamentId?: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get<AttemptRow>(
            `SELECT * FROM attempts WHERE id = ? ${tournamentId ? 'AND tournament_id = ?' : ''}`,
            ...(tournamentId ? [attemptId, tournamentId] : [attemptId]),
        );
        if (!row) throw new AttemptVoidError('NOT_FOUND', 404, 'Attempt not found.');
        if (!VOIDABLE.has(row.status)) {
            throw new AttemptVoidError(
                'NOT_VOIDABLE', 409,
                row.status === 'scored'
                    ? 'This attempt has a score. Voiding never removes a score — delete the score instead.'
                    : 'This attempt is already void.',
            );
        }
        await db.run(
            `UPDATE attempts SET status = 'void', voided_by = ?, voided_at = datetime('now') WHERE id = ?`,
            adminUserId, attemptId,
        );
    }
}
