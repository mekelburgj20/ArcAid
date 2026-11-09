import { getDatabase } from '../database/database.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import type { AtGamesPrivateTournamentSummary } from './AtGamesPrivateClient.js';

/**
 * How Arcaid knows a player is in an event's AtGames tournament (A40, v2.237.0).
 *
 *   - `'arcaid'`   — they joined through Arcaid's Join.
 *   - `'verified'` — Arcaid's Join found the tournament already in the
 *                    player's own AtGames list (joined in the app or website).
 *   - `'scores'`   — their AtGames score in this event was already pulled;
 *                    only a member's score reaches the tournament.
 *   - `'self'`     — the player said so ("Already joined in the AtGames app?").
 *                    The only one a player can take back.
 */
export type AtGamesJoinedVia = 'arcaid' | 'verified' | 'scores' | 'self';

type StoredVia = 'arcaid' | 'verified' | 'self';

/** Strongest first: a fact beats a player's say-so. */
const PRECEDENCE: AtGamesJoinedVia[] = ['arcaid', 'verified', 'scores', 'self'];

/**
 * Who is in an event's AtGames tournament, per player (A40).
 *
 * AtGames gives Arcaid no member list (FINDINGS-0b: the tournament detail
 * carries scores only), so this is what Arcaid has seen or been told. Rows are
 * keyed on the canonical user id and read through the full link graph, so a
 * player signed in with either linked identity sees the same answer.
 */
export class AtGamesJoinService {
    /**
     * Records that `userId` is in the event's AtGames tournament. A stronger
     * `via` replaces `'self'`; `'self'` never downgrades a join Arcaid saw.
     */
    static async record(tournamentId: string, userId: string, via: StoredVia): Promise<void> {
        const canonical = await IdentityLinkService.resolveCanonical(userId);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO atgames_event_joins (tournament_id, user_id, via) VALUES (?, ?, ?)
             ON CONFLICT(tournament_id, user_id) DO UPDATE SET via = excluded.via
              WHERE atgames_event_joins.via = 'self' AND excluded.via != 'self'`,
            tournamentId, canonical, via,
        );
    }

    /**
     * Takes back a player's own "I've joined". Only `'self'` rows go: a join
     * Arcaid saw is a fact, not a claim. Returns whether a row was removed.
     */
    static async clearSelf(tournamentId: string, userId: string): Promise<boolean> {
        const candidates = [...await IdentityLinkService.expandCandidates(userId)];
        const db = await getDatabase();
        const res = await db.run(
            `DELETE FROM atgames_event_joins
              WHERE tournament_id = ? AND via = 'self'
                AND user_id IN (${candidates.map(() => '?').join(', ')})`,
            tournamentId, ...candidates,
        );
        return (res.changes ?? 0) > 0;
    }

    /**
     * For each tournament the viewer is known to be in, how Arcaid knows.
     * Tournaments with no answer are absent. Two queries for any number of
     * tournaments: the stored joins, then the pulled AtGames scores.
     */
    static async joinedVia(tournamentIds: string[], viewerId: string | null | undefined): Promise<Map<string, AtGamesJoinedVia>> {
        const out = new Map<string, AtGamesJoinedVia>();
        const ids = [...new Set(tournamentIds.filter(Boolean))];
        if (!viewerId || ids.length === 0) return out;

        const candidates = [...await IdentityLinkService.expandCandidates(viewerId)];
        const idMarks = ids.map(() => '?').join(', ');
        const userMarks = candidates.map(() => '?').join(', ');
        const db = await getDatabase();

        const keep = (tournamentId: string, via: AtGamesJoinedVia) => {
            const have = out.get(tournamentId);
            if (!have || PRECEDENCE.indexOf(via) < PRECEDENCE.indexOf(have)) out.set(tournamentId, via);
        };

        const stored = await db.all<Array<{ tournament_id: string; via: string }>>(
            `SELECT tournament_id, via FROM atgames_event_joins
              WHERE tournament_id IN (${idMarks}) AND user_id IN (${userMarks})`,
            ...ids, ...candidates,
        );
        for (const row of stored) {
            if (row.via === 'arcaid' || row.via === 'verified' || row.via === 'self') keep(row.tournament_id, row.via);
        }

        // A pulled AtGames score proves membership. Linked rows carry the
        // canonical id; rows from before a link carry `atgames:<id>`, which the
        // candidate set includes once the player has linked.
        const scored = await db.all<Array<{ tournament_id: string }>>(
            `SELECT DISTINCT submitted_during_tournament_id AS tournament_id FROM score_history
              WHERE source = 'atgames' AND submitted_during_tournament_id IN (${idMarks})
                AND (discord_user_id IN (${userMarks}) OR submitted_by_user_id IN (${userMarks}))`,
            ...ids, ...candidates, ...candidates,
        );
        for (const row of scored) keep(row.tournament_id, 'scores');

        return out;
    }

    /**
     * Whether a player's own AtGames tournament list already holds this event's
     * tournament, by AtGames id or by invitation code.
     */
    static isMember(
        list: AtGamesPrivateTournamentSummary[],
        target: { atgamesId: string | null | undefined; code: string | null | undefined },
    ): boolean {
        const id = target.atgamesId?.trim() || null;
        const code = target.code?.trim().toLowerCase() || null;
        return list.some(t =>
            (id != null && String(t.id) === id)
            || (code != null && (t.invitationCode ?? '').trim().toLowerCase() === code));
    }
}
