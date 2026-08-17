import { getDatabase } from '../database/database.js';

/**
 * PickDispositionService — the "if I win the next rotation, what happens to my
 * pick" preference (ROADMAP "Next-win disposition + dynasty option +
 * rotation-readiness nudge", locked 2026-08-09; extended 2026-08-17).
 *
 * `use-my-queue` (the default) is deliberately NOT a stored value — it's the
 * ABSENCE of a `picker_dispositions` row.
 *
 * LIFETIME IS SPLIT BY TYPE (owner ruling 2026-08-17 — see
 * tmp/pick-delegation-contract.md §5 Q2):
 *   - `nominate` is ONE-SHOT. Handing your pick to a named person is a decision
 *     about one round, so `consume()` deletes it when it fires.
 *   - `forfeit` and `auto` are STANDING. They are stances about how the player
 *     wants to play, so they survive firing and persist until the player
 *     changes or clears them.
 * Pre-2026-08-17 every type was one-shot; that is why `consume()` still exists
 * as a distinct call from `get()` rather than collapsing into it.
 *
 * `auto` ("roll the dice") hands the pick straight to the auto-picker. It is
 * NOT the same as the absence of a row — absence means "use my queue, and give
 * me a pick window if it's empty".
 */

export type PickDispositionType = 'nominate' | 'forfeit' | 'auto';

export interface PickDispositionRow {
    id: number;
    tournament_id: string;
    discord_user_id: string;
    disposition: PickDispositionType;
    nominee_discord_id: string | null;
    created_at: string;
    updated_at: string;
}

/** Thrown by `set()` when a player tries to nominate themselves. */
export class SelfNominationError extends Error {
    code = 'SELF_NOMINATION';
    constructor() {
        super('You cannot nominate yourself.');
    }
}

export class PickDispositionService {
    /** Current disposition for a player in a tournament, or null (= use-my-queue). */
    static async get(tournamentId: string, discordUserId: string): Promise<PickDispositionRow | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT * FROM picker_dispositions WHERE tournament_id = ? AND discord_user_id = ?',
            tournamentId, discordUserId,
        );
        return (row as PickDispositionRow | undefined) ?? null;
    }

    /**
     * Upsert a player's disposition. Rejects self-nomination outright.
     * Guild-membership validity for a nominee is a best-effort check the
     * CALLER performs (degrades to allowing the set on uncertainty — see
     * ROADMAP) since it requires a live Discord client / guild lookup this
     * service has no business owning.
     */
    static async set(
        tournamentId: string,
        discordUserId: string,
        disposition: PickDispositionType,
        nomineeDiscordId?: string | null,
    ): Promise<PickDispositionRow> {
        if (disposition === 'nominate') {
            if (!nomineeDiscordId) {
                throw new Error('A nominee is required for a nominate disposition.');
            }
            if (nomineeDiscordId === discordUserId) {
                throw new SelfNominationError();
            }
        }

        const db = await getDatabase();
        const now = new Date().toISOString();
        const nominee = disposition === 'nominate' ? (nomineeDiscordId ?? null) : null;
        await db.run(
            `INSERT INTO picker_dispositions (tournament_id, discord_user_id, disposition, nominee_discord_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(tournament_id, discord_user_id) DO UPDATE SET
                disposition = excluded.disposition,
                nominee_discord_id = excluded.nominee_discord_id,
                updated_at = excluded.updated_at`,
            tournamentId, discordUserId, disposition, nominee, now, now,
        );
        return (await this.get(tournamentId, discordUserId))!;
    }

    /** Clears back to 'use-my-queue' (deletes the row, if any). */
    static async clear(tournamentId: string, discordUserId: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'DELETE FROM picker_dispositions WHERE tournament_id = ? AND discord_user_id = ?',
            tournamentId, discordUserId,
        );
    }

    /**
     * Fire a player's disposition: read the row (if any) and delete it in the
     * same call ONLY when it is one-shot (`nominate`). `forfeit` and `auto` are
     * standing preferences — they are returned and left in place, so the next
     * win applies them again.
     *
     * Called ONLY for the player who actually WON the slot. Walking a chain
     * (a nominee's disposition, or a runner-up reached by forfeit) must use
     * `get()` — otherwise one person winning would burn several other people's
     * settings. See tmp/pick-delegation-contract.md §4.6.
     */
    static async consume(tournamentId: string, discordUserId: string): Promise<PickDispositionRow | null> {
        const row = await this.get(tournamentId, discordUserId);
        if (!row) return null;
        if (row.disposition === 'nominate') {
            const db = await getDatabase();
            await db.run(
                'DELETE FROM picker_dispositions WHERE tournament_id = ? AND discord_user_id = ?',
                tournamentId, discordUserId,
            );
        }
        return row;
    }

    /** Whether a player has EITHER a queued (non-placeholder) game or a stored
     *  disposition in this tournament — the rotation-readiness nudge's "is this
     *  player already set for the next rotation" predicate. */
    static async hasQueueOrDisposition(tournamentId: string, discordUserId: string): Promise<boolean> {
        const db = await getDatabase();
        const queued = await db.get(
            `SELECT 1 AS ok FROM games
             WHERE tournament_id = ? AND status = 'QUEUED' AND picker_discord_id = ? AND name != '[Pending Pick]'
             LIMIT 1`,
            tournamentId, discordUserId,
        );
        if (queued) return true;
        const disposition = await this.get(tournamentId, discordUserId);
        return !!disposition;
    }
}
