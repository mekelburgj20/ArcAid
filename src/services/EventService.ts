import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { applyLibraryDefaults } from '../utils/gameLibraryDefaults.js';
import { logInfo } from '../utils/logger.js';
import type { EventAggregateMethod } from '../types/index.js';

/**
 * Live Event format — write side (v2.135.0, ADR 0017).
 *
 * An "event" tournament is time-boxed: N rounds, each its own `games` row
 * pre-created with `status='SCHEDULED'`, each with a wall-clock window. The
 * per-minute `EventScheduler` flips them ACTIVE and COMPLETED; the
 * `EventSubmissionGate` refuses scores outside their windows; `EventResultService`
 * reads the standings back out.
 *
 * Events register NO cron. Their `cadence` is `{"timezone": tz}` only, which
 * `Scheduler.scheduleTournament` already treats as "no cadence configured" and
 * skips — so `runMaintenance` / `processSlotMaintenance` / `TimeoutManager`
 * never touch an event. That is load-bearing: those paths would rotate the
 * rounds out from under the schedule.
 */

export type EventConfigErrorCode =
    | 'NO_ROUNDS'
    | 'TOO_MANY_ROUNDS'
    | 'DUPLICATE_ROUND_NO'
    | 'INVALID_ROUND_WINDOW'
    | 'ROUNDS_OVERLAP'
    | 'CHECKIN_AFTER_START'
    | 'ROUND_LOCKED'
    | 'GAME_NAME_IN_ROTATION';

export class EventConfigError extends Error {
    constructor(public code: EventConfigErrorCode, message: string) {
        super(message);
        this.name = 'EventConfigError';
    }
}

/** Hard ceiling on rounds per event — a sanity bound, not a product limit. */
export const MAX_EVENT_ROUNDS = 12;

export interface EventRoundInput {
    roundNo: number;
    gameName: string;
    /** ISO UTC. */
    scheduledStartAt: string;
    scheduledEndAt: string;
}

export interface EventConfigInput {
    rounds: EventRoundInput[];
    /** NULL/undefined = check-in is open from creation. */
    checkinOpensAt?: string | null;
    checkinRequired?: boolean;
    aggregateMethod?: EventAggregateMethod;
    minElapsedSec?: number | null;
    endGraceSec?: number;
}

export interface EventRoundRow {
    id: string;
    tournament_id: string;
    game_room_id: string | null;
    name: string;
    status: string;
    round_no: number;
    scheduled_start_at: string;
    scheduled_end_at: string;
    start_date: string | null;
    end_date: string | null;
    iscored_id: string | null;
}

export interface EventTournamentRow {
    id: string;
    name: string;
    type: string;
    game_room_id: string | null;
    format: string;
    is_active: number;
    start_date: string | null;
    end_date: string | null;
    checkin_opens_at: string | null;
    checkin_required: number;
    aggregate_method: EventAggregateMethod;
    min_elapsed_sec: number | null;
    end_grace_sec: number | null;
    checkin_announced_at: string | null;
    event_finished_at: string | null;
    event_result: string | null;
    discord_channel_id: string | null;
}

export type EventState =
    | 'upcoming'        // before check-in opens
    | 'checkin'         // check-in open, round 1 not started
    | 'live'            // inside a round window
    | 'between_rounds'  // a round has ended, another is still to come
    | 'finished'
    | 'cancelled';

export interface ParticipantRow {
    tournament_id: string;
    user_id: string;
    checked_in_at: string;
    source: 'checkin' | 'qualifier' | 'admin';
    added_by: string | null;
}

export class EventService {
    /** The event tournament row, or null when `id` is a rotation tournament / missing. */
    static async getEvent(tournamentId: string): Promise<EventTournamentRow | null> {
        const db = await getDatabase();
        const row = await db.get<EventTournamentRow>(
            `SELECT * FROM tournaments WHERE id = ? AND format = 'event'`,
            tournamentId,
        );
        return row ?? null;
    }

    /** Rounds in schedule order. Empty for a rotation tournament. */
    static async getRounds(tournamentId: string): Promise<EventRoundRow[]> {
        const db = await getDatabase();
        return db.all<EventRoundRow[]>(
            `SELECT id, tournament_id, game_room_id, name, status, round_no,
                    scheduled_start_at, scheduled_end_at, start_date, end_date, iscored_id
               FROM games
              WHERE tournament_id = ? AND round_no IS NOT NULL
              ORDER BY round_no ASC`,
            tournamentId,
        );
    }

    /**
     * Create or replace an event's configuration + rounds.
     *
     * Editing rules, in the order they are enforced:
     *   - a round that has already STARTED (ACTIVE) or ENDED (COMPLETED) is
     *     immutable — `ROUND_LOCKED`. Rewriting the window of a live round
     *     would retroactively invalidate scores the gate has already accepted.
     *   - a round removed from the input is deleted ONLY while SCHEDULED.
     *   - `tournaments.start_date/end_date` are kept as MIN/MAX of the rounds.
     *
     * Rounds are upserted by `(tournament_id, round_no)`, so an admin editing
     * an upcoming round keeps its `games.id` — and therefore its scores.
     */
    static async createOrUpdateEvent(tournamentId: string, config: EventConfigInput): Promise<EventRoundRow[]> {
        const db = await getDatabase();
        const tournament = await db.get<{ id: string; game_room_id: string | null; name: string }>(
            'SELECT id, game_room_id, name FROM tournaments WHERE id = ?', tournamentId,
        );
        if (!tournament) throw new EventConfigError('NO_ROUNDS', `Tournament ${tournamentId} not found`);

        const rounds = EventService.validateRounds(config);
        await EventService.assertNoRotationNameClash(tournament.game_room_id, tournamentId, rounds);

        const existing = await EventService.getRounds(tournamentId);
        const byRoundNo = new Map(existing.map(r => [r.round_no, r]));
        const keptRoundNos = new Set(rounds.map(r => r.roundNo));

        // Locked-round guard runs BEFORE any write so a rejected save changes
        // nothing at all.
        for (const input of rounds) {
            const prior = byRoundNo.get(input.roundNo);
            if (!prior || prior.status === 'SCHEDULED') continue;
            const changed = prior.name.toLowerCase() !== input.gameName.toLowerCase()
                || prior.scheduled_start_at !== input.scheduledStartAt
                || prior.scheduled_end_at !== input.scheduledEndAt;
            if (changed) {
                throw new EventConfigError('ROUND_LOCKED',
                    `Round ${input.roundNo} has already ${prior.status === 'ACTIVE' ? 'started' : 'finished'} and can no longer be changed.`);
            }
        }
        for (const prior of existing) {
            if (keptRoundNos.has(prior.round_no)) continue;
            if (prior.status !== 'SCHEDULED') {
                throw new EventConfigError('ROUND_LOCKED',
                    `Round ${prior.round_no} has already ${prior.status === 'ACTIVE' ? 'started' : 'finished'} and can no longer be removed.`);
            }
        }

        await db.exec('BEGIN TRANSACTION');
        try {
            for (const prior of existing) {
                if (!keptRoundNos.has(prior.round_no)) {
                    await db.run('DELETE FROM games WHERE id = ? AND status = ?', prior.id, 'SCHEDULED');
                }
            }

            for (const input of rounds) {
                const prior = byRoundNo.get(input.roundNo);
                if (prior) {
                    if (prior.status === 'SCHEDULED') {
                        await db.run(
                            `UPDATE games SET name = ?, scheduled_start_at = ?, scheduled_end_at = ?, game_room_id = ?
                              WHERE id = ? AND status = 'SCHEDULED'`,
                            input.gameName, input.scheduledStartAt, input.scheduledEndAt,
                            tournament.game_room_id, prior.id,
                        );
                        if (prior.name.toLowerCase() !== input.gameName.toLowerCase()) {
                            await applyLibraryDefaults(db, tournament.game_room_id, prior.id, input.gameName);
                        }
                    }
                    continue;
                }
                const gameId = uuidv4();
                await db.run(
                    `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
                     VALUES (?, ?, ?, 'SCHEDULED', ?, ?, ?, ?)`,
                    gameId, tournamentId, input.gameName, tournament.game_room_id,
                    input.roundNo, input.scheduledStartAt, input.scheduledEndAt,
                );
                await applyLibraryDefaults(db, tournament.game_room_id, gameId, input.gameName);
            }

            await db.run(
                `UPDATE tournaments
                    SET format = 'event',
                        start_date = ?, end_date = ?,
                        checkin_opens_at = ?, checkin_required = ?,
                        aggregate_method = ?, min_elapsed_sec = ?, end_grace_sec = COALESCE(?, end_grace_sec)
                  WHERE id = ?`,
                rounds[0]!.scheduledStartAt,
                rounds[rounds.length - 1]!.scheduledEndAt,
                config.checkinOpensAt ?? null,
                config.checkinRequired === false ? 0 : 1,
                config.aggregateMethod ?? 'best',
                config.minElapsedSec ?? null,
                config.endGraceSec ?? null,
                tournamentId,
            );
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }

        logInfo(`Event '${tournament.name}' (${tournamentId}) saved with ${rounds.length} round(s).`);
        return EventService.getRounds(tournamentId);
    }

    /**
     * Shape + ordering validation. Returns the rounds sorted by `roundNo`,
     * which is also guaranteed to be chronological order.
     */
    private static validateRounds(config: EventConfigInput): EventRoundInput[] {
        const rounds = [...(config.rounds ?? [])].sort((a, b) => a.roundNo - b.roundNo);
        if (rounds.length === 0) throw new EventConfigError('NO_ROUNDS', 'An event needs at least one round.');
        if (rounds.length > MAX_EVENT_ROUNDS) {
            throw new EventConfigError('TOO_MANY_ROUNDS', `An event can have at most ${MAX_EVENT_ROUNDS} rounds.`);
        }

        const seen = new Set<number>();
        for (const r of rounds) {
            if (seen.has(r.roundNo)) throw new EventConfigError('DUPLICATE_ROUND_NO', `Round ${r.roundNo} is listed twice.`);
            seen.add(r.roundNo);
            const start = Date.parse(r.scheduledStartAt);
            const end = Date.parse(r.scheduledEndAt);
            if (!r.gameName?.trim() || Number.isNaN(start) || Number.isNaN(end) || end <= start) {
                throw new EventConfigError('INVALID_ROUND_WINDOW',
                    `Round ${r.roundNo} needs a game and an end time after its start time.`);
            }
        }

        // Rounds must not overlap AND must run in round-number order — a
        // "Round 2" scheduled before Round 1 would make the standings' per-round
        // columns read backwards and break the "check-in closes at round 1
        // start" rule.
        for (let i = 1; i < rounds.length; i++) {
            if (Date.parse(rounds[i]!.scheduledStartAt) < Date.parse(rounds[i - 1]!.scheduledEndAt)) {
                throw new EventConfigError('ROUNDS_OVERLAP',
                    `Round ${rounds[i]!.roundNo} starts before round ${rounds[i - 1]!.roundNo} ends.`);
            }
        }

        if (config.checkinOpensAt) {
            const opens = Date.parse(config.checkinOpensAt);
            if (Number.isNaN(opens) || opens >= Date.parse(rounds[0]!.scheduledStartAt)) {
                throw new EventConfigError('CHECKIN_AFTER_START',
                    'Check-in must open before round 1 starts (it closes when round 1 starts).');
            }
        }
        return rounds;
    }

    /**
     * A round's game name must not collide with a game that a ROTATION
     * tournament in the same room currently has ACTIVE.
     *
     * Both the submission gate and `ScoreHistoryService.log`'s tournament
     * auto-resolve key on `(room, LOWER(game name))`; with the same name live in
     * both formats there is no way to tell which competition a score belongs to.
     * Caught at save time, where the admin can just rename or reschedule.
     */
    private static async assertNoRotationNameClash(
        gameRoomId: string | null, tournamentId: string, rounds: EventRoundInput[],
    ): Promise<void> {
        if (!gameRoomId) return;
        const db = await getDatabase();
        for (const r of rounds) {
            const clash = await db.get<{ tname: string }>(
                `SELECT t.name AS tname
                   FROM games g JOIN tournaments t ON t.id = g.tournament_id
                  WHERE t.game_room_id = ? AND t.id != ? AND COALESCE(t.format, 'rotation') = 'rotation'
                    AND g.status = 'ACTIVE' AND LOWER(g.name) = LOWER(?)
                  LIMIT 1`,
                gameRoomId, tournamentId, r.gameName,
            );
            if (clash) {
                throw new EventConfigError('GAME_NAME_IN_ROTATION',
                    `"${r.gameName}" is currently active in "${clash.tname}". Scores could not be attributed to the right competition — finish or rename that game first, or pick a different table for round ${r.roundNo}.`);
            }
        }
    }

    /**
     * Where the event is right now. Derived from the SCHEDULE (not from the
     * rounds' statuses) so the answer is honest even when the per-minute tick
     * is a few seconds behind the clock.
     */
    static async getState(tournamentId: string, now: Date = new Date()): Promise<EventState | null> {
        const event = await EventService.getEvent(tournamentId);
        if (!event) return null;
        const rounds = await EventService.getRounds(tournamentId);
        return EventService.deriveState(event, rounds, now);
    }

    static deriveState(event: EventTournamentRow, rounds: EventRoundRow[], now: Date): EventState {
        if (event.event_finished_at) return 'finished';
        if (event.is_active === 0) return 'cancelled';
        if (rounds.length === 0) return 'upcoming';

        const t = now.getTime();
        if (event.checkin_opens_at && t < Date.parse(event.checkin_opens_at)) return 'upcoming';

        const first = rounds[0]!;
        if (t < Date.parse(first.scheduled_start_at)) return 'checkin';

        for (const r of rounds) {
            if (t >= Date.parse(r.scheduled_start_at) && t < Date.parse(r.scheduled_end_at)) return 'live';
        }
        const last = rounds[rounds.length - 1]!;
        if (t >= Date.parse(last.scheduled_end_at)) return 'finished';
        return 'between_rounds';
    }

    // --- Participants (the check-in roster) -------------------------------

    /**
     * Every participant lookup and write goes through the CANONICAL identity.
     * A player who checks in on the web with Google and submits from Discord is
     * one person; without this they would be two rows and the second submit
     * would be refused as not-checked-in.
     */
    static async canonicalId(userId: string): Promise<string> {
        return IdentityLinkService.resolveCanonical(userId);
    }

    static async listParticipants(tournamentId: string): Promise<ParticipantRow[]> {
        const db = await getDatabase();
        return db.all<ParticipantRow[]>(
            `SELECT tournament_id, user_id, checked_in_at, source, added_by
               FROM tournament_participants WHERE tournament_id = ? ORDER BY checked_in_at ASC`,
            tournamentId,
        );
    }

    static async isParticipant(tournamentId: string, userId: string): Promise<ParticipantRow | null> {
        const db = await getDatabase();
        const canonical = await EventService.canonicalId(userId);
        const row = await db.get<ParticipantRow>(
            `SELECT tournament_id, user_id, checked_in_at, source, added_by
               FROM tournament_participants WHERE tournament_id = ? AND user_id = ?`,
            tournamentId, canonical,
        );
        return row ?? null;
    }

    /**
     * Idempotent: checking in twice keeps the FIRST `checked_in_at`, because
     * that timestamp is what the late-check-in guard compares against round 1's
     * start. An `admin` add upgrades an existing row's source (the admin path
     * deliberately bypasses the late guard — that IS the straggler mechanism).
     */
    static async checkIn(
        tournamentId: string, userId: string,
        source: ParticipantRow['source'] = 'checkin', addedBy?: string | null,
    ): Promise<ParticipantRow> {
        const db = await getDatabase();
        const canonical = await EventService.canonicalId(userId);
        await db.run(
            `INSERT INTO tournament_participants (tournament_id, user_id, checked_in_at, source, added_by)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(tournament_id, user_id) DO UPDATE SET
                source = CASE WHEN excluded.source = 'admin' THEN 'admin' ELSE tournament_participants.source END,
                added_by = COALESCE(excluded.added_by, tournament_participants.added_by)`,
            tournamentId, canonical, new Date().toISOString(), source, addedBy ?? null,
        );
        const row = await EventService.isParticipant(tournamentId, canonical);
        if (!row) throw new Error(`Check-in write for ${canonical} on ${tournamentId} did not persist`);
        return row;
    }

    static async withdraw(tournamentId: string, userId: string): Promise<boolean> {
        const db = await getDatabase();
        const canonical = await EventService.canonicalId(userId);
        const res = await db.run(
            'DELETE FROM tournament_participants WHERE tournament_id = ? AND user_id = ?',
            tournamentId, canonical,
        ) as { changes?: number };
        if (res.changes) logInfo(`Participant ${canonical} withdrew from event ${tournamentId}.`);
        return !!res.changes;
    }

    static async participantCount(tournamentId: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM tournament_participants WHERE tournament_id = ?', tournamentId,
        );
        return row?.n ?? 0;
    }
}
