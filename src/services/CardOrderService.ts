import { getDatabase } from '../database/database.js';
import { logWarn } from '../utils/logger.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';

/**
 * v2.118.0 — the admin's manual scoreboard card order.
 *
 * Cards are ordered by tournament configuration
 * (`COALESCE(g.display_order, t.display_order, 9999)`, see
 * `LeaderboardService.getActiveLeaderboards`). An admin dragging a card on the
 * admin Leaderboard page stores an OVERRIDE of that order for the room, which
 * every surface (admin, public Scoreboard, kiosk) then renders.
 *
 * The override is deliberately SELF-INVALIDATING — ADR 0013's "the data tells
 * us when it is stale" rule. Nothing hooks rotation: `TournamentEngine`,
 * `TimeoutManager`, the auto-pick insert and the Discord commands are all
 * untouched. Instead the blob carries a FINGERPRINT of the state it was saved
 * against, and every read compares it to the state right now:
 *
 *   1. a tournament's `display_order` changed  → the admin edited the
 *      configured positions, which outranks a drag: discard the WHOLE override.
 *   2. a tournament's ACTIVE game set changed  → it rotated (promotion,
 *      deactivate, delete, auto-pick, timeout — every path, because this is
 *      derived from state rather than from hooks): drop THAT tournament's ids
 *      and let its cards fall back to their configured slots. Everyone else's
 *      manual order survives.
 *
 * The read path NEVER writes. A stale blob is simply ignored on each read and
 * replaced by the next drag; `clear` is the admin's explicit reset.
 *
 * NOT related to `TournamentEngine.reorderIScoredLineup` — the iScored lineup
 * follows its own rule and this override does not touch it. `games.display_order`
 * stays unwritten (it has no writer anywhere in the codebase).
 */

export const CARD_ORDER_SETTING_KEY = 'LEADERBOARD_CARD_ORDER';

/** Max ids stored/accepted — mirrors the Zod bound on the PUT body. */
export const CARD_ORDER_MAX_IDS = 200;

/** Per-tournament fingerprint. `activeGameIds` is always sorted so the
 *  comparison is order-insensitive. */
export interface CardOrderTournamentFingerprint {
    displayOrder: number;
    activeGameIds: string[];
}

/** The stored `LEADERBOARD_CARD_ORDER` blob. */
export interface StoredCardOrder {
    v: 1;
    savedAt: string;
    /** Every card id the admin saw, in the manual order. */
    order: string[];
    tournaments: Record<string, CardOrderTournamentFingerprint>;
    /** Pinned (tournament_id IS NULL) card ids present at save time. */
    pins: string[];
}

/** The room's card state right now, compared against a stored fingerprint. */
export interface CardOrderState {
    tournaments: Record<string, CardOrderTournamentFingerprint>;
    pinIds: string[];
}

/** Anything with an id — the leaderboard rows, or bare `{ id }` in tests. */
interface HasId { id: string }

function sameIdSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Apply a stored manual order to the default (configured) order. PURE — no DB,
 * no clock, no logging. See the class doc for the invalidation rules.
 *
 * @param defaultOrder cards in configured order (D)
 * @param override     the stored blob, or null
 * @param current      the room's state right now
 * @returns the cards to render, plus whether the override actually applied
 */
export function applyCardOrderOverride<T extends HasId>(
    defaultOrder: T[],
    override: StoredCardOrder | null,
    current: CardOrderState,
): { cards: T[]; applied: boolean } {
    const miss = { cards: defaultOrder, applied: false };
    if (!override || !Array.isArray(override.order) || override.order.length === 0) return miss;

    const storedTournaments = override.tournaments || {};

    // Rule 1 — whole-override discard. Only tournaments present in BOTH the
    // fingerprint and the current state participate: one deleted or deactivated
    // since the save simply stopped existing, which is not an admin edit of the
    // configured positions.
    for (const [tid, stored] of Object.entries(storedTournaments)) {
        const now = current.tournaments[tid];
        if (!now) continue;
        if (now.displayOrder !== stored.displayOrder) return miss;
    }

    // Rule 2 — per-tournament drop. A tournament whose ACTIVE game set moved
    // has rotated; its ids leave the manual list so its cards land back in
    // their configured slots. Pins are never dropped (an unpin just removes the
    // id from the board, which the "present in D" filter below handles).
    const dropped = new Set<string>();
    for (const [tid, stored] of Object.entries(storedTournaments)) {
        const now = current.tournaments[tid];
        if (!now) continue;
        if (!sameIdSet(stored.activeGameIds, now.activeGameIds)) {
            for (const id of stored.activeGameIds) dropped.add(id);
        }
    }

    // Rule 3 — slot-fill merge. L = the surviving manual ids that still have a
    // card; S = the positions those ids occupy in D, ascending. Refill S with L
    // in L's order; every other card keeps its configured position. That is
    // what makes a rotated card return to its tournament's slot while the
    // untouched cards keep the order the admin dragged them into.
    const indexById = new Map<string, number>();
    defaultOrder.forEach((card, i) => { if (!indexById.has(card.id)) indexById.set(card.id, i); });

    const seen = new Set<string>();
    const L: string[] = [];
    for (const id of override.order) {
        if (dropped.has(id) || seen.has(id) || !indexById.has(id)) continue;
        seen.add(id);
        L.push(id);
    }
    if (L.length === 0) return miss;

    const positions = L.map(id => indexById.get(id)!).sort((a, b) => a - b);
    const out = [...defaultOrder];
    for (let i = 0; i < L.length; i++) {
        const slot = positions[i]!;
        const card = defaultOrder[indexById.get(L[i]!)!]!;
        out[slot] = card;
    }
    return { cards: out, applied: true };
}

export class CardOrderService {
    /** Read + parse the stored blob. Malformed JSON degrades to "no override"
     *  with a WARN naming the room — never throws into a scoreboard read. */
    static async load(gameRoomId: string): Promise<StoredCardOrder | null> {
        const raw = await GameRoomSettingsService.get(gameRoomId, CARD_ORDER_SETTING_KEY);
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            if (!Array.isArray(parsed.order)) return null;
            return {
                v: 1,
                savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
                order: parsed.order.filter((id: unknown) => typeof id === 'string' && id.length > 0),
                tournaments: (parsed.tournaments && typeof parsed.tournaments === 'object') ? parsed.tournaments : {},
                pins: Array.isArray(parsed.pins) ? parsed.pins : [],
            };
        } catch {
            logWarn(`[CardOrder] Malformed ${CARD_ORDER_SETTING_KEY} for room ${gameRoomId} — ignoring`);
            return null;
        }
    }

    /**
     * The room's current card state.
     *
     * BOTH the save path and the read path go through this ONE function, which
     * is the whole point: if the two sides computed `activeGameIds` from
     * different queries the fingerprint would mismatch on the very next read
     * and the override would self-destruct immediately.
     */
    static async loadCurrentState(gameRoomId: string): Promise<CardOrderState> {
        const db = await getDatabase();
        // Same ACTIVE + room scoping as `LeaderboardService.getActiveLeaderboards`
        // (which room-filters on `t.game_room_id`), plus pinned rows — those
        // carry no tournament, so they scope on the denormalised
        // `games.game_room_id` (ADR 0005).
        const rows = await db.all(`
            SELECT g.id, g.tournament_id, COALESCE(t.display_order, 9999) as t_display_order
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.status = 'ACTIVE'
              AND (t.game_room_id = ? OR (g.tournament_id IS NULL AND g.game_room_id = ?))
            ORDER BY g.id ASC
        `, gameRoomId, gameRoomId) as Array<{ id: string; tournament_id: string | null; t_display_order: number }>;

        const tournaments: Record<string, CardOrderTournamentFingerprint> = {};
        const pinIds: string[] = [];
        for (const row of rows) {
            if (!row.tournament_id) { pinIds.push(row.id); continue; }
            const entry = tournaments[row.tournament_id]
                ?? (tournaments[row.tournament_id] = { displayOrder: row.t_display_order, activeGameIds: [] });
            entry.activeGameIds.push(row.id);
        }
        for (const t of Object.values(tournaments)) t.activeGameIds.sort();
        pinIds.sort();
        return { tournaments, pinIds };
    }

    /**
     * Apply the stored override to a page of cards. Called by
     * `LeaderboardService.getActiveLeaderboards` after its sort + dedupe.
     *
     * One settings read for a room with no manual order — the state query only
     * runs when a blob actually exists.
     */
    static async applyStored<T extends HasId>(gameRoomId: string, cards: T[]): Promise<T[]> {
        const override = await CardOrderService.load(gameRoomId);
        if (!override) return cards;
        const state = await CardOrderService.loadCurrentState(gameRoomId);
        return applyCardOrderOverride(cards, override, state).cards;
    }

    /** The card ids the admin can order — exactly the ids the board renders. */
    static async currentCardIds(gameRoomId: string): Promise<string[]> {
        const { LeaderboardService } = await import('./LeaderboardService.js');
        const boards = await LeaderboardService.getActiveLeaderboards(gameRoomId);
        return boards.map(b => b.gameId);
    }

    /**
     * Store a manual order. Validates the ids against the cards the board is
     * actually rendering; strays are reported rather than stored.
     */
    static async save(
        gameRoomId: string,
        orderedIds: string[],
    ): Promise<{ ok: true; savedAt: string } | { ok: false; invalid: string[] }> {
        const valid = new Set(await CardOrderService.currentCardIds(gameRoomId));
        const invalid = orderedIds.filter(id => !valid.has(id));
        if (invalid.length > 0) return { ok: false, invalid };

        const state = await CardOrderService.loadCurrentState(gameRoomId);
        const savedAt = new Date().toISOString();
        const blob: StoredCardOrder = {
            v: 1,
            savedAt,
            order: orderedIds.slice(0, CARD_ORDER_MAX_IDS),
            tournaments: state.tournaments,
            pins: state.pinIds.filter(id => valid.has(id)),
        };
        await GameRoomSettingsService.set(gameRoomId, CARD_ORDER_SETTING_KEY, JSON.stringify(blob));
        return { ok: true, savedAt };
    }

    /** Reset to the configured (tournament) order. */
    static async clear(gameRoomId: string): Promise<void> {
        await GameRoomSettingsService.delete(gameRoomId, CARD_ORDER_SETTING_KEY);
    }

    /**
     * Does a surviving override exist? Runs the SAME pure function the read
     * path runs, so the chip on the admin page cannot claim "Manual order"
     * for a blob that every read discards.
     */
    static async getStatus(gameRoomId: string): Promise<{ active: boolean; savedAt: string | null }> {
        const override = await CardOrderService.load(gameRoomId);
        if (!override) return { active: false, savedAt: null };
        const state = await CardOrderService.loadCurrentState(gameRoomId);
        const cards = (await CardOrderService.currentCardIds(gameRoomId)).map(id => ({ id }));
        const { applied } = applyCardOrderOverride(cards, override, state);
        return { active: applied, savedAt: override.savedAt || null };
    }
}
