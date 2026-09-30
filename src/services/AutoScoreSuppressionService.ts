import { getDatabase } from '../database/database.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { logInfo } from '../utils/logger.js';

/**
 * Play-scoped tombstones for AUTO-POSTED scores (ADR 0024).
 *
 * ## What an auto-posted score is
 *
 * A score nobody typed: `source = 'vpx'` (the Arcaid Witness read it off the
 * VPX launcher's own records on a paired cabinet) or `source = 'atgames'` (a
 * host's "Pull scores" read it from an AtGames private tournament). Both
 * sources REPLAY: the cabinet re-sends up to seven days of its score files
 * whenever it restarts or is re-paired, and a host may press "Pull scores" as
 * often as they like. Deleting such a row without a tombstone is therefore not
 * a delete at all — the next replay puts it straight back.
 *
 * ## Why this is not `deleted_score_suppressions`
 *
 * That table (ADR 0011) is the iScored tombstone: keyed on (game ROW, player)
 * with a MAX-score threshold, because iScored can only ever re-send a player's
 * best. Neither property fits here. These scores are never pushed to iScored,
 * the `games` row they landed on rotates away while the cabinet keeps its
 * files, and a threshold would swallow every unrelated LOWER score the same
 * player posts later. What identifies a replayed play is the play itself:
 * whose it was, which table, what score, and when it ended.
 *
 * ## The match key
 *
 * `(source, owner_key, game_key, score, played_at)` —
 *   - `owner_key` is the row's `submitted_by_user_id` when set, else its raw
 *     `discord_user_id` (e.g. an unlinked `atgames:<id>`), which is exactly
 *     what the ingest paths write as the player on a replay.
 *   - `game_key` is `normalizeGameName`, so the device's heterogeneous table
 *     names and the room's name for the game meet in one form.
 *   - `played_at` is the play's OWN timestamp in SQLite UTC shape (the
 *     launcher's game end / AtGames' submit time — `score_history.created_at`
 *     already holds exactly that for these sources). NULL means "time
 *     unknown": a Global Scoreboard row only carries its ingest time, so its
 *     tombstone matches on player + game + score alone.
 *
 * The suppression is PLAY-scoped, not room-scoped: a deleted play must not
 * come back on a different board either (the Global leftover path once the
 * table has rotated off the card).
 *
 * `isSuppressed` is the ONE predicate. Every ingest check and every dry run
 * calls it — never re-implement the match anywhere else.
 */

export type AutoScoreSource = 'vpx' | 'atgames';

/** Only these sources replay; every other source is untouched by this table. */
export function isAutoScoreSource(source: string | null | undefined): source is AutoScoreSource {
    return source === 'vpx' || source === 'atgames';
}

/**
 * Normalise a stored/supplied time to SQLite's UTC shape at second
 * resolution (`YYYY-MM-DD HH:MM:SS`). Accepts that shape itself (optionally
 * with fractional seconds) or an ISO string. Returns null when absent or
 * unparseable, which callers treat as "time unknown".
 */
export function toPlayedAt(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    const sqliteShape = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(trimmed);
    if (sqliteShape) return `${sqliteShape[1]} ${sqliteShape[2]}`;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export class AutoScoreSuppressionService {
    /** Write a tombstone. Idempotent — a repeat delete of the same play is a no-op. */
    static async record(input: {
        source: AutoScoreSource;
        ownerKey: string;
        gameName: string;
        score: number;
        playedAt: string | null;
        gameRoomId?: string | null;
        deletedBy?: string | null;
    }): Promise<void> {
        const gameKey = normalizeGameName(input.gameName || '');
        if (!input.ownerKey || !gameKey) return;
        const db = await getDatabase();
        const playedAt = toPlayedAt(input.playedAt);
        await db.run(
            `INSERT INTO auto_score_suppressions
                (source, owner_key, game_key, score, played_at, game_room_id, deleted_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
            input.source, input.ownerKey, gameKey, input.score, playedAt,
            input.gameRoomId ?? null, input.deletedBy ?? null,
        );
        logInfo(
            `Auto-score suppression recorded: ${input.source} ${input.ownerKey} ${input.score} on "${gameKey}" ` +
            `(played ${playedAt ?? 'time unknown'})`,
        );
    }

    /**
     * Is this play one somebody deleted? True when a tombstone exists with the
     * same source, owner and score, a `game_key` equal to the normalised form
     * of ANY supplied name, and a `played_at` that is either NULL (time
     * unknown) or equal to the supplied time.
     */
    static async isSuppressed(input: {
        source: string | null | undefined;
        ownerKey: string | null | undefined;
        gameNames: string[];
        score: number;
        playedAt: string | null | undefined;
    }): Promise<boolean> {
        if (!isAutoScoreSource(input.source) || !input.ownerKey) return false;
        const keys = [...new Set(input.gameNames.map(n => normalizeGameName(n || '')).filter(Boolean))];
        if (keys.length === 0) return false;
        const playedAt = toPlayedAt(input.playedAt ?? null);
        const db = await getDatabase();
        const hit = await db.get(
            `SELECT 1 FROM auto_score_suppressions
              WHERE source = ? AND owner_key = ? AND score = ?
                AND game_key IN (${keys.map(() => '?').join(',')})
                AND (played_at IS NULL OR played_at = ?)
              LIMIT 1`,
            input.source, input.ownerKey, input.score, ...keys, playedAt,
        );
        return !!hit;
    }

    /**
     * Remove the tombstone for exactly this play (the restore path). Matches
     * `played_at` exactly — restoring a time-unknown Global row lifts only the
     * time-unknown tombstone its delete wrote, never a timed one a room delete
     * wrote for the same play.
     */
    static async clear(input: {
        source: AutoScoreSource;
        ownerKey: string;
        gameName: string;
        score: number;
        playedAt: string | null;
    }): Promise<number> {
        const gameKey = normalizeGameName(input.gameName || '');
        if (!input.ownerKey || !gameKey) return 0;
        const db = await getDatabase();
        const res = await db.run(
            `DELETE FROM auto_score_suppressions
              WHERE source = ? AND owner_key = ? AND game_key = ? AND score = ?
                AND COALESCE(played_at, '') = COALESCE(?, '')`,
            input.source, input.ownerKey, gameKey, input.score, toPlayedAt(input.playedAt),
        );
        return res.changes ?? 0;
    }
}
