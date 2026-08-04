import { getDatabase } from '../database/database.js';
import { PickAwardGate } from './PickAwardGate.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';

/**
 * PickAlertService — computes the "you owe the pick flow some attention" signal
 * that drives the Picks nav badge.
 *
 * Three conditions, in descending urgency:
 *   (a) `pending`    — the player holds a `[Pending Pick]` placeholder: they won
 *                      a slot and the clock is running. Always badges.
 *   (b) `emptyQueue` — a tournament where the player has pick standing but
 *                      nothing queued. Gated (see below) so it never nags
 *                      players who don't engage with picks, and suppressed
 *                      while the player's OWN pick is the currently ACTIVE
 *                      game (v2.77.0 — see the inline note at the call site).
 *   (c) `ineligible` — the player's HEAD-of-queue pick would be skipped at
 *                      activation (cooldown). Always badges — this is the
 *                      silent failure the feature exists to surface: pre-badge,
 *                      the row was deleted during maintenance with only a log
 *                      line, and the player found out by seeing someone else's
 *                      game go active.
 *
 * SCOPE CALL ON (b): "has pick standing" resolves to *has ever held a picker
 * row in this tournament* — `EXISTS(games WHERE tournament_id = ? AND
 * picker_discord_id = ?)`, any status. This works because the rotation path
 * activates a queued row IN PLACE (`UPDATE games SET status='ACTIVE'`,
 * TournamentEngine ~L1238), so `picker_discord_id` survives onto the ACTIVE and
 * later COMPLETED row — a player who ever queued or won keeps a permanent,
 * indexed-by-tournament trace. It is one cheap EXISTS per tournament, no
 * submissions scan, no winner recomputation.
 *
 * Known blind spot: the web open-slot pick path DELETEs the placeholder and
 * calls `activateGame`, which INSERTs a fresh row WITHOUT `picker_discord_id`.
 * A player whose only ever interaction was that exact path reads as "no
 * standing" and won't get (b) until they queue again. Deliberate: (b) is the
 * soft nudge, and under-nagging is the correct failure direction. (a) and (c)
 * are unaffected — both read live rows the player currently owns.
 */

export interface PickAlertTournamentRef {
    tournamentId: string;
    tournamentName: string;
}

export interface PickAlertIneligible extends PickAlertTournamentRef {
    gameId: string;
    gameName: string;
    /** Why it would be skipped. Only cooldown is checkable at activation today. */
    reason: 'cooldown';
}

export interface PickAlerts {
    /** (a) Count of unfulfilled `[Pending Pick]` placeholders held by this player. */
    pendingPickCount: number;
    /** (b) Pick-enabled tournaments where the player has standing but an empty queue. */
    emptyQueue: PickAlertTournamentRef[];
    /** (c) Tournaments whose head-of-queue pick is currently ineligible. */
    ineligible: PickAlertIneligible[];
    /** Badge number — total actionable items. */
    count: number;
    /** True when at least one (a) item exists — drives the urgent badge styling. */
    urgent: boolean;
}

const EMPTY: PickAlerts = { pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false };

export class PickAlertService {
    /**
     * Computes pick alerts for one player in one room.
     * Returns the empty result (no badge) for guests / unknown rooms rather
     * than throwing — this feeds a nav decoration, never a page.
     */
    static async getAlerts(roomId: string, discordId: string): Promise<PickAlerts> {
        if (!roomId || !discordId) return EMPTY;

        const db = await getDatabase();

        // Active tournaments in this room. Inactive ones can't rotate, so a
        // pick there is not actionable.
        const tournaments = await db.all(
            'SELECT id, name FROM tournaments WHERE game_room_id = ? AND is_active = 1',
            roomId,
        );
        if (!tournaments.length) return EMPTY;

        // Every QUEUED row this player owns across the room, in one pass —
        // placeholders and named picks alike. Same ordering contract the
        // rotation path consumes the queue with (`queue_order ASC, rowid ASC`,
        // NULL-first) so "head of queue" here means the same row that would
        // actually activate next.
        const queuedRows = await db.all(
            `SELECT g.id, g.name, g.tournament_id, g.queue_order
             FROM games g
             JOIN tournaments t ON g.tournament_id = t.id
             WHERE t.game_room_id = ? AND g.status = 'QUEUED' AND g.picker_discord_id = ?
             ORDER BY g.queue_order ASC, g.rowid ASC`,
            roomId, discordId,
        );

        const placeholdersByTournament = new Map<string, number>();
        const headByTournament = new Map<string, { id: string; name: string }>();
        for (const row of queuedRows) {
            if (row.name === '[Pending Pick]') {
                placeholdersByTournament.set(row.tournament_id, (placeholdersByTournament.get(row.tournament_id) ?? 0) + 1);
            } else if (!headByTournament.has(row.tournament_id)) {
                // First non-placeholder row wins — the query is already in
                // activation order.
                headByTournament.set(row.tournament_id, { id: row.id, name: row.name });
            }
        }

        const engine = TournamentEngine.getInstance();
        const alerts: PickAlerts = { pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false };

        for (const t of tournaments) {
            // Winner-picks off for this tournament — the whole pick flow is
            // inert here, so nothing is actionable.
            if (!(await PickAwardGate.isEnabled(roomId, t.id))) continue;

            // (a) pending placeholders
            const pending = placeholdersByTournament.get(t.id) ?? 0;
            alerts.pendingPickCount += pending;

            const head = headByTournament.get(t.id);

            if (head) {
                // (c) head-of-queue eligibility — the SAME check the activation
                // path runs (TournamentEngine.isGameEligible, called from both
                // the rotation and extra-slot-fill loops). Quiet so a nav probe
                // doesn't spam the log with one line per queued game per poll.
                const eligible = await engine.isGameEligible(t.id, head.name, undefined, { quiet: true });
                if (!eligible) {
                    alerts.ineligible.push({
                        tournamentId: t.id,
                        tournamentName: t.name,
                        gameId: head.id,
                        gameName: head.name,
                        reason: 'cooldown',
                    });
                }
            } else if (pending === 0) {
                // (b) nothing queued and no pending pick — nudge only if this
                // player has pick standing in THIS tournament (see class docs).
                //
                // Suppression (v2.77.0): their own pick is the game that is
                // LIVE right now. The nudge means "you could line up your next
                // pick" — nagging a player while the table they chose is the
                // active one is just wrong, and it was the field-reported bug:
                // the badge counted it, the Picks page rendered nothing to act
                // on, so the count was unclearable. Standing is deliberately
                // still the broad any-status EXISTS; this only carves out the
                // one state where the player is already the reason the
                // tournament is busy.
                const live = await db.get(
                    `SELECT 1 AS ok FROM games
                     WHERE tournament_id = ? AND status = 'ACTIVE' AND picker_discord_id = ?
                     LIMIT 1`,
                    t.id, discordId,
                );
                if (live) continue;

                const standing = await db.get(
                    'SELECT 1 AS ok FROM games WHERE tournament_id = ? AND picker_discord_id = ? LIMIT 1',
                    t.id, discordId,
                );
                if (standing) {
                    alerts.emptyQueue.push({ tournamentId: t.id, tournamentName: t.name });
                }
            }
        }

        alerts.count = alerts.pendingPickCount + alerts.emptyQueue.length + alerts.ineligible.length;
        alerts.urgent = alerts.pendingPickCount > 0;
        return alerts;
    }
}
