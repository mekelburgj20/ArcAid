import { LeaderboardService } from './LeaderboardService.js';
import { GameArtService } from './GameArtService.js';

/** One table a listed room is playing now (`GET /api/rooms` → `activeTables`). */
export interface RoomActiveTable {
    /** The `games` row id the room's scoreboard card links to. */
    gameId: string;
    /** The table name as the card shows it (`display_name`, else the game name). */
    name: string;
    /** `GameArtService`'s art for the table (the art a card falls back to), or null. */
    imageUrl: string | null;
    /** The board's #1 as the board renders it (`display_name ?? iscored_username`), or null with no score yet. */
    leaderName: string | null;
    /** The board's #1 score, or null with no score yet. */
    topScore: number | null;
}

/** How many tables the room list carries per room. */
export const ROOM_ACTIVE_TABLES_MAX = 3;

/**
 * G35b (v2.278.0) — what each listed room is playing, for the landing page's
 * room cards ("What's on", owner 2026-11-26).
 *
 * The rules, each read from the room board rather than restated:
 * - **Which tables:** the board's live cards, `LeaderboardService.getLiveCards`
 *   (the board's own card read, narrowed to the open cards), in the board's
 *   order. Event rounds are left OUT: their board is the round board
 *   (`getEventRoundOverlays`), whose witness join costs queries per round and
 *   per player, too much for an unauthenticated list every visitor loads.
 * - **Order:** the board with the newest score first
 *   (`LeaderboardService.getLastScoreTimes`, the board's own window), boards
 *   with no score yet last, ties in the board's order; at most
 *   `ROOM_ACTIVE_TABLES_MAX`.
 * - **The #1:** `LeaderboardService.getRunSummaries` — the board's own ranked
 *   rows (cache, recalculate on a miss), one hydrate for every room, so the
 *   name resolves at READ through `resolveProfiles` and the label is the
 *   board's `display_name ?? iscored_username`, never a raw id.
 * - **Art:** `GameArtService` (the ONE art rule), one query.
 *
 * The CALLER withholds the field for `approval` rooms (pass only the rooms the
 * list may describe). Cost for the whole list: the board's card reads per room
 * (two or three queries plus the card-order settings read), then one
 * last-score query, the run-summary batch (a handful of queries, plus one
 * recalculate per board whose cache was just invalidated) and one art query,
 * however many rooms there are.
 */
export class RoomActiveTablesService {
    static async forRooms(roomIds: string[]): Promise<Map<string, RoomActiveTable[]>> {
        const out = new Map<string, RoomActiveTable[]>();
        const ids = [...new Set(roomIds)];
        if (ids.length === 0) return out;

        const liveByRoom = await Promise.all(ids.map(id => LeaderboardService.getLiveCards(id)));
        const candidates = liveByRoom.map(cards => cards.filter(card => !card.isEventRound));
        const lastScoreAt = await LeaderboardService.getLastScoreTimes(
            candidates.flatMap(cards => cards.map(card => card.gameId)),
        );

        const picked = candidates.map(cards => cards
            .map((card, boardIndex) => ({ card, boardIndex, last: lastScoreAt.get(card.gameId) ?? null }))
            .sort((a, b) => {
                if (a.last !== null && b.last !== null && a.last !== b.last) return b.last - a.last;
                if ((a.last === null) !== (b.last === null)) return a.last === null ? 1 : -1;
                return a.boardIndex - b.boardIndex;
            })
            .slice(0, ROOM_ACTIVE_TABLES_MAX)
            .map(entry => entry.card));

        const pickedCards = picked.flat();
        const [summaries, art] = await Promise.all([
            LeaderboardService.getRunSummaries(pickedCards.map(card => card.gameId)),
            GameArtService.artForNames(pickedCards.map(card => card.gameName)),
        ]);

        ids.forEach((roomId, i) => {
            out.set(roomId, picked[i]!.map(card => {
                const leader = summaries.get(card.gameId)?.winner ?? null;
                return {
                    gameId: card.gameId,
                    name: card.displayName || card.gameName,
                    imageUrl: art.get(GameArtService.key(card.gameName)) ?? null,
                    leaderName: leader ? (leader.display_name || leader.iscored_username || null) : null,
                    topScore: leader ? leader.score : null,
                };
            }));
        });
        return out;
    }
}
