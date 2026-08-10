import { getDatabase } from '../database/database.js';

/**
 * PickDispositionService — the tri-state "if I win the next rotation, what
 * happens to my pick" preference (ROADMAP "Next-win disposition + dynasty
 * option + rotation-readiness nudge", locked 2026-08-09).
 *
 * `use-my-queue` (the default) is deliberately NOT a stored value — it's the
 * ABSENCE of a `picker_dispositions` row. `nominate`/`forfeit` rows are
 * consumed (read + deleted) exactly once, at the winner-designation
 * chokepoint in `TournamentEngine.resolveNextPicker` — so the preference is
 * strictly one-shot: it applies to the very next rotation this player wins,
 * then the row is gone and the following win reverts to 'use-my-queue'
 * unless the player sets a new disposition.
 */

export type PickDispositionType = 'nominate' | 'forfeit';

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
     * One-shot consume: read the row (if any) and delete it in the same call,
     * so a second rotation win reverts to 'use-my-queue' unless the player
     * sets a fresh disposition. Called ONLY from the winner-designation
     * chokepoint — never from a read path (use `get()` there).
     */
    static async consume(tournamentId: string, discordUserId: string): Promise<PickDispositionRow | null> {
        const row = await this.get(tournamentId, discordUserId);
        if (!row) return null;
        const db = await getDatabase();
        await db.run(
            'DELETE FROM picker_dispositions WHERE tournament_id = ? AND discord_user_id = ?',
            tournamentId, discordUserId,
        );
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
