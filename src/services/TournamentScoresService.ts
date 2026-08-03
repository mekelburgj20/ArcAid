import { getDatabase } from '../database/database.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import { resolveProfiles } from './PlayerProfileResolver.js';

/**
 * Per-tournament score boards — every score submitted DURING one tournament,
 * grouped into one board per game that was featured in it.
 *
 * ## Why `submitted_during_tournament_id` and nothing else
 *
 * `score_history.game_id` decays to NULL: the dominant web submit path
 * (`CommunityScoreService`) never supplies one, and every unpin / delete /
 * cleanup path NULLs it deliberately so the score outlives its `games` row
 * (ADR 0005). A `JOIN games ON sh.game_id = g.id` therefore matches ~nothing in
 * production — the exact mistake that shipped `getPersonalBests` empty for
 * every player in v2.74.0. `submitted_during_tournament_id` is the durable
 * per-tournament key, stamped at submit time and never rewritten.
 *
 * Boards are consequently keyed on `LOWER(game_name)`, not on a `games` row.
 * The tournament's `games` rows are still read, but only to DECORATE a board
 * with slot dates / status / "featured N×" — a board whose slot has since been
 * deleted still renders, with null dates.
 *
 * ## Winner semantics
 *
 * A board's winner is its own rank-1 row, i.e. the best score submitted inside
 * the tournament window. This can differ from the winner shown on
 * `GET /:roomId/history`, which ranks `submissions` (best-EVER per player per
 * game, including scores set outside the window). Self-consistency with what
 * this page displays beats agreement with a different query's definition — a
 * board that crowned someone who appears nowhere in its own list would be a
 * bug report waiting to happen.
 *
 * ## One asymmetry worth knowing
 *
 * The identity PARTITION folds aliases through `user_mappings` unconditionally
 * (`COALESCE(submitted_by_user_id, um.discord_user_id, 'iscored:' || …)`), while
 * DISPLAY resolution (`resolveProfiles`) only consults `user_mappings` for rows
 * whose raw id is an `iscored:*` synthetic. That guard is deliberate and
 * load-bearing on the display side — a COMMUNITY/ANON row must not borrow a real
 * user's name just because the typed name collides with someone's alias (the
 * v2.0.0 F.20 regression). Collapsing such a row is harmless by comparison: two
 * names mapped to one Discord user ARE one player.
 */

export interface TournamentScoreRow {
    /** Competition rank within the board: ties share a rank, next rank skips (1,2,2,4). */
    rank: number;
    /** `COALESCE(submitted_by_user_id, user_mappings.discord_user_id, raw)`. */
    discord_user_id: string;
    /** Stable identifier — used for keys and `/players/:name` routing. */
    iscored_username: string;
    /** Render as `display_name ?? iscored_username` (see `playerName()` on the FE). */
    display_name: string | null;
    avatar_hash: string | null;
    avatar_url: string | null;
    score: number;
    created_at: string | null;
    platform: string | null;
    engine: string;
    device: string;
    photo_url: string | null;
}

export interface TournamentScoreBoard {
    /** `LOWER(game_name)` — the grouping key, stable across casing drift. */
    game_key: string;
    /** Display casing for the game. */
    game_name: string;
    /** How many `games` slots this tournament ran for this game (0 = slot deleted). */
    slot_count: number;
    /** Dates/status of the MOST RECENT slot; all null when `slot_count === 0`. */
    start_date: string | null;
    end_date: string | null;
    status: string | null;
    /** The board's rank-1 row (tournament-window winner), or null when empty. */
    winner: TournamentScoreRow | null;
    scores: TournamentScoreRow[];
}

export interface TournamentScoresResult {
    tournament: {
        id: string;
        name: string;
        type: string;
        is_active: boolean;
        /** MIN(games.start_date) over the tournament's slots. */
        first_start: string | null;
        /** MAX(games.end_date) — `tournaments` has no end_date column. */
        last_end: string | null;
    };
    boards: TournamentScoreBoard[];
}

interface SlotRow {
    name: string;
    status: string | null;
    start_date: string | null;
    end_date: string | null;
}

export class TournamentScoresService {
    /**
     * @returns `null` when the tournament doesn't exist OR belongs to another
     * room — the caller turns both into a 404 so this endpoint can't be used to
     * probe tournament ids across rooms.
     */
    static async getTournamentScores(
        roomId: string,
        tournamentId: string,
    ): Promise<TournamentScoresResult | null> {
        const db = await getDatabase();

        const tournament = await db.get<{
            id: string; name: string; type: string; is_active: number; game_room_id: string | null;
        }>(
            `SELECT id, name, type, is_active, game_room_id FROM tournaments WHERE id = ?`,
            tournamentId,
        );
        if (!tournament || tournament.game_room_id !== roomId) return null;

        // Slot metadata. Read separately from the scores so a deleted slot can
        // never suppress a board (and an empty slot can never invent one).
        const slots = await db.all<SlotRow[]>(
            `SELECT name, status, start_date, end_date FROM games WHERE tournament_id = ?`,
            tournamentId,
        );
        const slotsByKey = new Map<string, SlotRow[]>();
        for (const slot of slots) {
            const key = (slot.name || '').toLowerCase();
            let list = slotsByKey.get(key);
            if (!list) { list = []; slotsByKey.set(key, list); }
            list.push(slot);
        }

        let firstStart: string | null = null;
        let lastEnd: string | null = null;
        for (const slot of slots) {
            if (slot.start_date && (firstStart === null || slot.start_date < firstStart)) firstStart = slot.start_date;
            if (slot.end_date && (lastEnd === null || slot.end_date > lastEnd)) lastEnd = slot.end_date;
        }

        // Best-per-player rows, ranked per board, in ONE windowed query.
        //
        // Inner window collapses a player's multiple submissions to their best
        // (the canonical partition, identical to LeaderboardService.recalculate /
        // RoomScoresService: a Discord user's several iScored aliases fold into
        // one row via user_mappings; pure-anon rows still partition per-name).
        // Outer window then orders those bests into board positions.
        const rows = await db.all<Array<{
            game_key: string;
            game_name: string;
            iscored_username: string | null;
            discord_user_id: string | null;
            submitted_by_user_id: string | null;
            score: number;
            created_at: string | null;
            platform: string | null;
            engine: string | null;
            device: string | null;
            photo_url: string | null;
            position: number;
        }>>(
            `SELECT
                best.game_key,
                best.game_name,
                best.iscored_username,
                best.discord_user_id,
                best.submitted_by_user_id,
                best.score,
                best.created_at,
                best.platform,
                best.engine,
                best.device,
                best.photo_url,
                ROW_NUMBER() OVER (
                    PARTITION BY best.game_key ORDER BY best.score DESC, best.created_at ASC
                ) AS position
            FROM (
                SELECT
                    LOWER(sh.game_name) AS game_key,
                    sh.game_name,
                    sh.iscored_username,
                    sh.discord_user_id,
                    sh.submitted_by_user_id,
                    sh.score,
                    sh.created_at,
                    sh.platform,
                    sh.engine,
                    sh.device,
                    sh.photo_url,
                    ROW_NUMBER() OVER (
                        PARTITION BY LOWER(sh.game_name),
                                     COALESCE(sh.submitted_by_user_id, um.discord_user_id,
                                              'iscored:' || LOWER(sh.iscored_username))
                        ORDER BY sh.score DESC, sh.created_at ASC
                    ) AS rn
                FROM score_history sh
                LEFT JOIN user_mappings um
                       ON um.iscored_username = sh.iscored_username COLLATE NOCASE
                WHERE sh.submitted_during_tournament_id = ?
                  AND sh.orphaned_at IS NULL
            ) best
            WHERE best.rn = 1
            ORDER BY best.game_key, position`,
            tournamentId,
        );

        // Display resolution happens once for the whole page (two batched
        // queries) rather than per board — see PlayerProfileResolver.
        const profiles = await resolveProfiles(rows as Array<{
            submitted_by_user_id?: string | null;
            discord_user_id?: string | null;
            iscored_username?: string | null;
        }>);

        const boardsByKey = new Map<string, TournamentScoreBoard>();
        rows.forEach((row, i) => {
            const profile = profiles[i]!;
            let board = boardsByKey.get(row.game_key);
            if (!board) {
                const slotList = slotsByKey.get(row.game_key) ?? [];
                const newest = pickNewestSlot(slotList);
                board = {
                    game_key: row.game_key,
                    game_name: row.game_name,
                    slot_count: slotList.length,
                    start_date: newest?.start_date ?? null,
                    end_date: newest?.end_date ?? null,
                    status: newest?.status ?? null,
                    winner: null,
                    scores: [],
                };
                boardsByKey.set(row.game_key, board);
            }

            const prev = board.scores[board.scores.length - 1];
            board.scores.push({
                // Competition rank — equal scores share a position.
                rank: prev && prev.score === row.score ? prev.rank : board.scores.length + 1,
                discord_user_id: profile.discord_user_id,
                iscored_username: row.iscored_username || 'Unknown',
                display_name: profile.display_name,
                avatar_hash: profile.avatar_hash,
                avatar_url: profile.avatar_url,
                score: row.score,
                created_at: row.created_at ?? null,
                platform: row.platform || null,
                engine: row.engine || UNKNOWN,
                device: row.device || UNKNOWN,
                photo_url: row.photo_url || null,
            });
        });

        const boards = [...boardsByKey.values()];
        for (const board of boards) board.winner = board.scores[0] ?? null;

        // Most recently completed slot first. Boards whose slot was deleted (or
        // hasn't ended) have no end_date and sort to the back, ordered by their
        // own newest score so they're still in a sensible sequence.
        boards.sort((a, b) => {
            if (a.end_date && b.end_date) return a.end_date < b.end_date ? 1 : a.end_date > b.end_date ? -1 : 0;
            if (a.end_date) return -1;
            if (b.end_date) return 1;
            const aLast = newestScoreAt(a);
            const bLast = newestScoreAt(b);
            return aLast < bLast ? 1 : aLast > bLast ? -1 : 0;
        });

        return {
            tournament: {
                id: tournament.id,
                name: tournament.name,
                type: tournament.type,
                is_active: !!tournament.is_active,
                first_start: firstStart,
                last_end: lastEnd,
            },
            boards,
        };
    }
}

/** Latest slot: prefer the one that ended last, else the one that started last. */
function pickNewestSlot(slots: SlotRow[]): SlotRow | null {
    if (slots.length === 0) return null;
    return [...slots].sort((a, b) => {
        const aKey = a.end_date || a.start_date || '';
        const bKey = b.end_date || b.start_date || '';
        return aKey < bKey ? 1 : aKey > bKey ? -1 : 0;
    })[0]!;
}

function newestScoreAt(board: TournamentScoreBoard): string {
    let newest = '';
    for (const s of board.scores) if (s.created_at && s.created_at > newest) newest = s.created_at;
    return newest;
}
