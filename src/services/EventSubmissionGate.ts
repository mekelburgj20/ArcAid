import { getDatabase } from '../database/database.js';
import { EventService } from './EventService.js';

/**
 * Live Event submission gate (v2.135.0, ADR 0017) — THE one enforcement point.
 *
 * Every score path that can land on an event round calls
 * `checkEventSubmission` BEFORE it writes anything (before the photo is saved,
 * before `CommunityScoreService.submitScore`): the three web routes
 * (`/submit-score`, `/freeplay-score`, `/community-scores`) and the Discord
 * `/submit-score` command. Adding a fourth submit path means adding a fifth
 * call here — a submit path that skips the gate silently makes every window in
 * the room advisory.
 *
 * **`ScoreSyncPoller` is deliberately NOT gated.** An iScored-synced score has
 * no play time and no submitter identity Arcaid can trust, so refusing it would
 * lose real scores from rooms that bridge to an iScored board. Instead, synced
 * rows land on the round and `EventResultService` filters them out of the
 * standings when the event requires check-in and the name maps to nobody.
 *
 * ## Precedence: an event round never shadows a live rotation game
 *
 * Both formats key on `(room, LOWER(game name))`. A round SCHEDULED for
 * tomorrow on a table that a rotation tournament has ACTIVE *today* must not
 * make today's submissions fail with "the round hasn't started". So:
 *
 *   1. an ACTIVE event round always wins — the event is live, that is the
 *      competition this score belongs to;
 *   2. otherwise a SCHEDULED round gates only when NO rotation game of that
 *      name is ACTIVE in the room;
 *   3. otherwise the rotation path runs completely untouched.
 *
 * `EventService.assertNoRotationNameClash` refuses the collision at save time,
 * but a rotation can activate the name *after* the event was saved, so the
 * precedence rule is the runtime backstop.
 */

/**
 * Late-submit grace after a round's scheduled end.
 *
 * AtGames cabinets are exit-to-submit — a score only uploads when the player
 * fully exits the table — so a host running "exit at the buzzer, then submit"
 * rules needs 120-180s, while a pure phone-submit frenzy keeps the 60s default.
 * ONE value per event, resolved through this helper by BOTH the gate and
 * `EventScheduler`'s round-end step, so the window a score is accepted in and
 * the moment the round closes can never disagree.
 */
export const DEFAULT_EVENT_END_GRACE_SEC = 60;

export function eventEndGraceSec(t: { end_grace_sec?: number | null }): number {
    const value = t?.end_grace_sec;
    return typeof value === 'number' && value >= 0 ? value : DEFAULT_EVENT_END_GRACE_SEC;
}

export type EventGateDenial =
    | 'EVENT_NOT_STARTED'
    | 'EVENT_ROUND_ENDED'
    | 'EVENT_NOT_CHECKED_IN'
    | 'EVENT_CHECKIN_LATE';

export interface EventGateMatch {
    tournamentId: string;
    tournamentName: string;
    gameId: string;
    gameName: string;
    roundNo: number;
    scheduledStartAt: string;
    scheduledEndAt: string;
}

export interface EventGateResult {
    ok: boolean;
    /**
     * Set on an ACCEPTED event submission. The caller MUST thread
     * `tournamentId` + `gameId` through to `ScoreHistoryService.log` so the row
     * is stamped with the round it belongs to — two rounds of the same game are
     * otherwise indistinguishable.
     */
    event?: EventGateMatch;
    code?: EventGateDenial;
    message?: string;
}

interface RoundCandidate {
    game_id: string;
    game_name: string;
    status: string;
    round_no: number;
    scheduled_start_at: string;
    scheduled_end_at: string;
    tournament_id: string;
    tournament_name: string;
    checkin_required: number;
    end_grace_sec: number | null;
}

const PASS: EventGateResult = { ok: true };

/**
 * @returns `{ok:true}` with no `event` when this game is not an event round —
 *   the rotation path then runs exactly as it did before this feature existed.
 */
export async function checkEventSubmission(params: {
    roomId: string;
    gameName: string;
    userId: string;
    now?: Date;
}): Promise<EventGateResult> {
    const { roomId, gameName, userId } = params;
    if (!roomId || !gameName) return PASS;

    const db = await getDatabase();
    const now = params.now ?? new Date();

    // ACTIVE first: a live round outranks a scheduled one on the same table.
    const candidates = await db.all<RoundCandidate[]>(
        `SELECT g.id AS game_id, g.name AS game_name, g.status, g.round_no,
                g.scheduled_start_at, g.scheduled_end_at,
                t.id AS tournament_id, t.name AS tournament_name,
                t.checkin_required, t.end_grace_sec
           FROM games g
           JOIN tournaments t ON t.id = g.tournament_id
          WHERE t.game_room_id = ?
            AND t.format = 'event'
            AND g.round_no IS NOT NULL
            AND g.status IN ('ACTIVE', 'SCHEDULED')
            AND LOWER(g.name) = LOWER(?)
          ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
                   g.scheduled_start_at ASC`,
        roomId, gameName,
    );
    if (candidates.length === 0) return PASS;

    let round = candidates[0]!;
    if (round.status !== 'ACTIVE') {
        // Precedence rule 2 — a not-yet-open round yields to a rotation game of
        // the same name that is live right now.
        const rotationActive = await db.get<{ id: string }>(
            `SELECT g.id FROM games g JOIN tournaments t ON t.id = g.tournament_id
              WHERE t.game_room_id = ? AND COALESCE(t.format, 'rotation') = 'rotation'
                AND g.status = 'ACTIVE' AND LOWER(g.name) = LOWER(?)
              LIMIT 1`,
            roomId, gameName,
        );
        if (rotationActive) return PASS;
        round = candidates[0]!;
    }

    const nowMs = now.getTime();
    const startMs = Date.parse(round.scheduled_start_at);
    const endMs = Date.parse(round.scheduled_end_at);
    const graceMs = eventEndGraceSec(round) * 1000;

    if (nowMs < startMs) {
        const minutes = Math.max(1, Math.ceil((startMs - nowMs) / 60000));
        return {
            ok: false,
            code: 'EVENT_NOT_STARTED',
            message: `Round ${round.round_no} of "${round.tournament_name}" hasn't started yet — it opens in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        };
    }

    if (nowMs > endMs + graceMs) {
        return {
            ok: false,
            code: 'EVENT_ROUND_ENDED',
            message: `Round ${round.round_no} of "${round.tournament_name}" is closed. Scores after the buzzer don't count.`,
        };
    }

    if (round.checkin_required === 1) {
        const participant = await EventService.isParticipant(round.tournament_id, userId);
        if (!participant) {
            return {
                ok: false,
                code: 'EVENT_NOT_CHECKED_IN',
                message: `You're not checked in for "${round.tournament_name}". Check-in closed when round 1 started — ask an admin to add you.`,
            };
        }
        // Defense in depth: check-in is supposed to be impossible once round 1
        // starts, so a `checkin`-sourced row stamped after that means the
        // check-in route let one through. An `admin` row is exempt — adding a
        // straggler mid-event IS the sanctioned override.
        if (participant.source === 'checkin') {
            const firstRound = await db.get<{ scheduled_start_at: string }>(
                `SELECT scheduled_start_at FROM games
                  WHERE tournament_id = ? AND round_no IS NOT NULL
                  ORDER BY round_no ASC LIMIT 1`,
                round.tournament_id,
            );
            if (firstRound && Date.parse(participant.checked_in_at) > Date.parse(firstRound.scheduled_start_at)) {
                return {
                    ok: false,
                    code: 'EVENT_CHECKIN_LATE',
                    message: `Your check-in for "${round.tournament_name}" landed after round 1 started, so it doesn't count. Ask an admin to add you.`,
                };
            }
        }
    }

    return {
        ok: true,
        event: {
            tournamentId: round.tournament_id,
            tournamentName: round.tournament_name,
            gameId: round.game_id,
            gameName: round.game_name,
            roundNo: round.round_no,
            scheduledStartAt: round.scheduled_start_at,
            scheduledEndAt: round.scheduled_end_at,
        },
    };
}
