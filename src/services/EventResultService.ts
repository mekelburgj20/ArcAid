import { getDatabase } from '../database/database.js';
import { resolveProfiles } from './PlayerProfileResolver.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { EventService, type EventRoundRow, type EventTournamentRow } from './EventService.js';
import { eventEndGraceSec } from './EventSubmissionGate.js';
import { WitnessVerifyService, type WitnessVerdict } from './WitnessVerifyService.js';
import type { EventAggregateMethod } from '../types/index.js';

/**
 * Live Event boards + standings (v2.135.0, ADR 0017) — read side.
 *
 * ## Why rows are found by `submitted_during_tournament_id` first
 *
 * Same reason `TournamentScoresService` does it: `score_history.game_id` decays
 * to NULL (the dominant web submit path never supplied one pre-v2.135.0, and
 * every unpin/delete/cleanup path NULLs it deliberately per ADR 0005). The
 * tournament stamp is the durable key.
 *
 * But an event has SEVERAL rounds under ONE tournament id, and two rounds may
 * feature the SAME game — so the tournament stamp alone cannot separate them.
 * That is why the event submit path stamps `game_id` explicitly (the gate hands
 * the resolved round to `ScoreHistoryService.log`). Rows that predate that, or
 * that arrive from the iScored sync poller, fall back to
 * `(game name, created_at inside the round window)`.
 *
 * ## Identity
 *
 * The partition is copied verbatim from `TournamentScoresService` /
 * `LeaderboardService.recalculate` — a Discord user's several iScored aliases
 * fold into one row via `user_mappings`; pure-anon rows still partition per
 * name. Display names and avatars are attached at READ time by
 * `resolveProfiles`, never stored — the same doctrine that keeps
 * `leaderboard_cache` identity-stable, and it applies to the frozen
 * `event_result` blob too.
 */

export interface EventScoreRow {
    rank: number;
    /** Stable partition key for this player across rounds. */
    identity_key: string;
    discord_user_id: string;
    iscored_username: string;
    display_name: string | null;
    avatar_hash: string | null;
    avatar_url: string | null;
    score: number;
    created_at: string | null;
    platform: string | null;
    engine: string | null;
    device: string | null;
    photo_url: string | null;
    /** Seconds between the round's scheduled start and this submission. */
    elapsed_sec: number | null;
    /**
     * `elapsed_sec < min_elapsed_sec`. A HOST-FACING HINT, never an automatic
     * rejection: Arcaid cannot see play time from outside the cabinet, so a
     * fast submission is suspicious, not proven. See ADR 0017's trust model.
     */
    flagged: boolean;
    /** False = this score is on the board but its player never checked in. */
    participant: boolean;
    /**
     * v2.145.0 (P8, ADR 0020) — the Arcaid Witness verdict for this score, or
     * `null` when none applies (anything not AtGames-sourced). A HOST-FACING
     * BADGE like `flagged`: it never rejects a score or changes a rank, and
     * `unwitnessed` is neutral — most players have no paired cabinet.
     */
    witness: WitnessVerdict | null;
}

export interface EventRoundBoard {
    roundNo: number;
    gameId: string;
    gameName: string;
    status: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    startedAt: string | null;
    endedAt: string | null;
    scores: EventScoreRow[];
}

export interface EventStandingRow {
    rank: number;
    identity_key: string;
    discord_user_id: string;
    iscored_username: string;
    display_name: string | null;
    avatar_hash: string | null;
    avatar_url: string | null;
    /** Per-round best, indexed by round number; null = did not score that round. */
    roundScores: Array<number | null>;
    /** The aggregate under the event's `aggregate_method`. */
    total: number;
    roundsPlayed: number;
    /** Any round score flagged as implausibly fast. */
    flagged: boolean;
    /**
     * Any counted round score whose witness verdict is `flagged` — the table
     * was launched before that round opened. A boolean, so it is identity-stable
     * and freezes into `event_result` without violating that blob's doctrine.
     * Absent on results frozen before v2.145.0; readers treat missing as false.
     */
    witnessFlagged: boolean;
}

export interface EventStandings {
    aggregateMethod: EventAggregateMethod;
    checkinRequired: boolean;
    roundNumbers: number[];
    standings: EventStandingRow[];
    /**
     * Only populated for `average`: players who missed at least one round.
     * Averaging over a partial set would rank a one-round sniper above someone
     * who played every round, so they are listed separately instead.
     */
    incomplete: EventStandingRow[];
}

/**
 * The frozen `tournaments.event_result` payload. Identity-stable rows only.
 *
 * `witnessFlagged` (v2.145.0) freezes fine — it is a boolean fact about what
 * happened, not a rendering of who somebody is. Blobs frozen BEFORE v2.145.0
 * carry no such key, so every reader must treat it as missing-tolerant (false).
 */
export interface FrozenEventResult {
    v: 1;
    finishedAt: string;
    aggregateMethod: EventAggregateMethod;
    checkinRequired: boolean;
    roundNumbers: number[];
    standings: Array<Omit<EventStandingRow, 'display_name' | 'avatar_hash' | 'avatar_url'>>;
    incomplete: Array<Omit<EventStandingRow, 'display_name' | 'avatar_hash' | 'avatar_url'>>;
}

interface RawScoreRow {
    identity_key: string;
    discord_user_id: string | null;
    submitted_by_user_id: string | null;
    iscored_username: string | null;
    score: number;
    created_at: string | null;
    platform: string | null;
    engine: string | null;
    device: string | null;
    photo_url: string | null;
    elapsed_sec: number | null;
    /** Needed by the witness verify-join: only `'atgames'` rows get a verdict. */
    source: string | null;
    /** `created_at` as epoch seconds — the witness join key (exit ≈ created). */
    created_epoch: number | null;
}

/**
 * `COALESCE(submitted_by_user_id, user_mappings.discord_user_id, 'iscored:'||LOWER(name))`
 * — the canonical identity partition. Kept as one constant so the round board
 * and the standings can never drift apart on who counts as the same player.
 */
const IDENTITY_KEY_SQL =
    `COALESCE(sh.submitted_by_user_id, um.discord_user_id, 'iscored:' || LOWER(sh.iscored_username))`;

export class EventResultService {
    /**
     * Best-per-player rows for ONE round, ranked.
     *
     * @param participants canonical ids from `tournament_participants`; pass the
     *   already-loaded set so a multi-round standings computation resolves the
     *   roster once instead of per round.
     */
    static async getRoundBoard(
        event: EventTournamentRow,
        round: EventRoundRow,
        participants?: Set<string>,
    ): Promise<EventRoundBoard> {
        const db = await getDatabase();
        const roster = participants ?? await EventResultService.loadParticipantSet(event.id);
        const graceSec = eventEndGraceSec(event);

        // The window fallback is deliberately generous by the same grace the
        // gate allows, so a score the gate ACCEPTED at end+30s can never be
        // invisible on the board that accepted it.
        const rows = await db.all<RawScoreRow[]>(
            `SELECT identity_key, discord_user_id, submitted_by_user_id, iscored_username,
                    score, created_at, platform, engine, device, photo_url, elapsed_sec,
                    source, created_epoch
               FROM (
                    SELECT ${IDENTITY_KEY_SQL} AS identity_key,
                           sh.discord_user_id,
                           sh.submitted_by_user_id,
                           sh.iscored_username,
                           sh.score,
                           sh.created_at,
                           sh.platform,
                           sh.engine,
                           sh.device,
                           sh.photo_url,
                           sh.source,
                           CAST(strftime('%s', sh.created_at) AS INTEGER) AS created_epoch,
                           CAST(strftime('%s', sh.created_at) AS INTEGER)
                             - CAST(strftime('%s', ?) AS INTEGER) AS elapsed_sec,
                           ROW_NUMBER() OVER (
                               PARTITION BY ${IDENTITY_KEY_SQL}
                               ORDER BY sh.score DESC, sh.created_at ASC
                           ) AS rn
                      FROM score_history sh
                      LEFT JOIN user_mappings um
                             ON um.iscored_username = sh.iscored_username COLLATE NOCASE
                     WHERE sh.submitted_during_tournament_id = ?
                       AND sh.orphaned_at IS NULL
                       AND (
                            sh.game_id = ?
                            OR (sh.game_id IS NULL
                                AND LOWER(sh.game_name) = LOWER(?)
                                AND CAST(strftime('%s', sh.created_at) AS INTEGER)
                                      >= CAST(strftime('%s', ?) AS INTEGER)
                                AND CAST(strftime('%s', sh.created_at) AS INTEGER)
                                      <= CAST(strftime('%s', ?) AS INTEGER) + ?)
                       )
               )
              WHERE rn = 1
              ORDER BY score DESC, created_at ASC`,
            round.scheduled_start_at,
            event.id,
            round.id,
            round.name,
            round.scheduled_start_at,
            round.scheduled_end_at,
            graceSec,
        );

        const profiles = await resolveProfiles(rows as Array<{
            submitted_by_user_id?: string | null;
            discord_user_id?: string | null;
            iscored_username?: string | null;
        }>);

        // The witness verify-join, batched for the whole board (v2.145.0, P8).
        // `scheduled_start_at` is stored ISO, so the epoch conversion is done in
        // JS here while the SQL above does the same conversion with strftime —
        // both land on the same UTC second.
        const roundStartEpoch = Math.floor(Date.parse(round.scheduled_start_at) / 1000);
        const witnessVerdicts = await WitnessVerifyService.verdictsForRound({
            roundStartEpoch,
            rows: rows.map(row => ({
                identityKey: row.identity_key,
                createdEpoch: row.created_epoch,
                source: row.source,
            })),
        });

        const minElapsed = event.min_elapsed_sec;
        const scores: EventScoreRow[] = rows.map((row, i) => {
            const profile = profiles[i]!;
            return {
                rank: i + 1,
                identity_key: row.identity_key,
                discord_user_id: profile.discord_user_id,
                iscored_username: row.iscored_username ?? '',
                display_name: profile.display_name ?? null,
                avatar_hash: profile.avatar_hash ?? null,
                avatar_url: profile.avatar_url ?? null,
                score: row.score,
                created_at: row.created_at,
                platform: row.platform,
                engine: row.engine,
                device: row.device,
                photo_url: row.photo_url,
                elapsed_sec: row.elapsed_sec,
                flagged: minElapsed != null && row.elapsed_sec != null && row.elapsed_sec < minElapsed,
                // When check-in isn't required, EVERYONE is a participant —
                // otherwise a handful of voluntary check-ins would grey out the
                // rest of an open event's board.
                participant: event.checkin_required !== 1 || roster.has(row.identity_key),
                witness: witnessVerdicts[i] ?? null,
            };
        });

        return {
            roundNo: round.round_no,
            gameId: round.id,
            gameName: round.name,
            status: round.status,
            scheduledStartAt: round.scheduled_start_at,
            scheduledEndAt: round.scheduled_end_at,
            startedAt: round.start_date,
            endedAt: round.end_date,
            scores,
        };
    }

    /**
     * The roster as a set of identity keys that a `score_history` partition key
     * can be tested against directly.
     *
     * `tournament_participants.user_id` is always a CANONICAL id, while a score
     * row's partition key can be a raw provider id or an `iscored:<name>`
     * synthetic. Both sides are expanded through `IdentityLinkService` so a
     * Google check-in matches a Discord submit.
     */
    static async loadParticipantSet(tournamentId: string): Promise<Set<string>> {
        const participants = await EventService.listParticipants(tournamentId);
        const keys = new Set<string>();
        for (const p of participants) {
            keys.add(p.user_id);
            for (const linked of await IdentityLinkService.expandCandidates(p.user_id)) keys.add(linked);
        }
        return keys;
    }

    /** All round boards, in round order. */
    static async getBoards(tournamentId: string): Promise<EventRoundBoard[] | null> {
        const event = await EventService.getEvent(tournamentId);
        if (!event) return null;
        const rounds = await EventService.getRounds(tournamentId);
        const roster = await EventResultService.loadParticipantSet(tournamentId);
        const boards: EventRoundBoard[] = [];
        for (const round of rounds) {
            boards.push(await EventResultService.getRoundBoard(event, round, roster));
        }
        return boards;
    }

    /**
     * Aggregate the round boards into standings.
     *
     * - `best`    — the player's single best round score.
     * - `sum`     — Σ of their round bests; a missed round contributes 0.
     * - `average` — mean over rounds, but ONLY for players who scored in EVERY
     *   round. Everyone else is moved to `incomplete`, because averaging a
     *   partial set would put a one-round sniper above a player who competed
     *   all night.
     *
     * Tie-break: higher single-round best, then the earlier timestamp (whoever
     * got there first keeps the higher place).
     */
    static async computeStandings(tournamentId: string): Promise<EventStandings | null> {
        const event = await EventService.getEvent(tournamentId);
        if (!event) return null;
        const boards = await EventResultService.getBoards(tournamentId);
        if (!boards) return null;

        const checkinRequired = event.checkin_required === 1;
        const roundNumbers = boards.map(b => b.roundNo);
        const indexOfRound = new Map(roundNumbers.map((n, i) => [n, i]));

        interface Acc {
            row: EventScoreRow;
            roundScores: Array<number | null>;
            bestSingle: number;
            earliest: string;
            flagged: boolean;
            witnessFlagged: boolean;
        }
        const byPlayer = new Map<string, Acc>();

        for (const board of boards) {
            const idx = indexOfRound.get(board.roundNo)!;
            for (const score of board.scores) {
                // A non-participant's score stays visible on the ROUND board
                // (greyed out on the FE) but never enters the standings — that
                // is the whole point of requiring check-in.
                if (checkinRequired && !score.participant) continue;
                let acc = byPlayer.get(score.identity_key);
                if (!acc) {
                    acc = {
                        row: score,
                        roundScores: roundNumbers.map(() => null),
                        bestSingle: score.score,
                        earliest: score.created_at ?? '',
                        flagged: false,
                        witnessFlagged: false,
                    };
                    byPlayer.set(score.identity_key, acc);
                }
                acc.roundScores[idx] = score.score;
                if (score.score > acc.bestSingle) acc.bestSingle = score.score;
                if (score.created_at && (!acc.earliest || score.created_at < acc.earliest)) {
                    acc.earliest = score.created_at;
                }
                if (score.flagged) acc.flagged = true;
                // Only `flagged` propagates: `unwitnessed` is the neutral
                // default and must never accumulate into a mark against a
                // player who simply has no paired cabinet.
                if (score.witness?.status === 'flagged') acc.witnessFlagged = true;
            }
        }

        const method = (event.aggregate_method ?? 'best') as EventAggregateMethod;
        const complete: EventStandingRow[] = [];
        const incomplete: EventStandingRow[] = [];

        for (const acc of byPlayer.values()) {
            const played = acc.roundScores.filter((s): s is number => s != null);
            const isComplete = played.length === roundNumbers.length;
            const total = method === 'sum'
                ? played.reduce((a, b) => a + b, 0)
                : method === 'average'
                    ? (played.length ? played.reduce((a, b) => a + b, 0) / played.length : 0)
                    : acc.bestSingle;

            const entry: EventStandingRow = {
                rank: 0,
                identity_key: acc.row.identity_key,
                discord_user_id: acc.row.discord_user_id,
                iscored_username: acc.row.iscored_username,
                display_name: acc.row.display_name,
                avatar_hash: acc.row.avatar_hash,
                avatar_url: acc.row.avatar_url,
                roundScores: acc.roundScores,
                total,
                roundsPlayed: played.length,
                flagged: acc.flagged,
                witnessFlagged: acc.witnessFlagged,
            };
            // Only `average` is distorted by a partial set — `best` and `sum`
            // rank partial players perfectly sensibly against full ones.
            if (method === 'average' && !isComplete) incomplete.push(entry);
            else complete.push(entry);
        }

        const rank = (list: EventStandingRow[]) => {
            list.sort((a, b) => {
                if (b.total !== a.total) return b.total - a.total;
                const aBest = Math.max(0, ...a.roundScores.filter((s): s is number => s != null));
                const bBest = Math.max(0, ...b.roundScores.filter((s): s is number => s != null));
                if (bBest !== aBest) return bBest - aBest;
                return a.iscored_username.localeCompare(b.iscored_username);
            });
            list.forEach((entry, i) => { entry.rank = i + 1; });
            return list;
        };

        return {
            aggregateMethod: method,
            checkinRequired,
            roundNumbers,
            standings: rank(complete),
            incomplete: rank(incomplete),
        };
    }

    /**
     * Freeze the final standings into `tournaments.event_result`.
     *
     * Display fields are STRIPPED before storing — a name or an avatar baked in
     * here would go stale the moment the player renames, exactly the bug that
     * read-time profile resolution exists to prevent (v2.74.0, S24.1). The
     * frozen blob keeps identity keys only; `GET /events/:id` re-attaches
     * profiles on the way out.
     */
    static async compute(tournamentId: string, finishedAt: string): Promise<FrozenEventResult | null> {
        const standings = await EventResultService.computeStandings(tournamentId);
        if (!standings) return null;
        return EventResultService.freeze(standings, finishedAt);
    }

    /**
     * Re-freeze a FINISHED event's result from today's data (v2.148.0, ADR 0021).
     *
     * The host action behind it is "Re-run verification": witness reports,
     * check-ins and identity links keep arriving AFTER an event ends — a
     * cabinet that was offline all night uploads in the morning, a player links
     * their AtGames account the next day — and the frozen blob is a snapshot of
     * what was known at the buzzer. Recomputing costs nothing and can only make
     * the record more accurate.
     *
     * It deliberately reuses `computeStandings` + `freeze` — the SAME pair
     * `EventScheduler.finishCompletedEvents` uses — and does nothing else. In
     * particular it does NOT touch `event_finished_at` (the event finished when
     * it finished; the frozen timestamp is preserved verbatim), does not touch
     * `is_active` (which the alias-link freeze gate reads), and ANNOUNCES
     * NOTHING: a re-verification is bookkeeping, and a second podium post to
     * Discord hours later would read as a second event.
     *
     * Returns `null` when the tournament is not a finished event.
     */
    static async recomputeFrozenResult(tournamentId: string): Promise<{
        finishedAt: string;
        standings: number;
        incomplete: number;
        witnessFlagged: number;
    } | null> {
        const db = await getDatabase();
        const row = await db.get<{ format: string | null; event_finished_at: string | null }>(
            'SELECT format, event_finished_at FROM tournaments WHERE id = ?', tournamentId,
        );
        if (!row || row.format !== 'event' || !row.event_finished_at) return null;

        const standings = await EventResultService.computeStandings(tournamentId);
        if (!standings) return null;
        const result = EventResultService.freeze(standings, row.event_finished_at);

        // Guarded on the stamp still being present, so a concurrent reopen
        // (`EventService.createOrUpdateEvent` clears it when a future round is
        // added back) can never be overwritten by a result computed for the
        // finished version of the same event.
        await db.run(
            `UPDATE tournaments SET event_result = ?
              WHERE id = ? AND event_finished_at IS NOT NULL`,
            JSON.stringify(result), tournamentId,
        );

        const flagged = [...result.standings, ...result.incomplete].filter(s => s.witnessFlagged).length;
        return {
            finishedAt: row.event_finished_at,
            standings: result.standings.length,
            incomplete: result.incomplete.length,
            witnessFlagged: flagged,
        };
    }

    /** Pure display-strip of an already-computed standings set. */
    static freeze(standings: EventStandings, finishedAt: string): FrozenEventResult {
        const strip = (rows: EventStandingRow[]) => rows.map(({
            display_name: _dn, avatar_hash: _ah, avatar_url: _au, ...rest
        }) => rest);
        return {
            v: 1,
            finishedAt,
            aggregateMethod: standings.aggregateMethod,
            checkinRequired: standings.checkinRequired,
            roundNumbers: standings.roundNumbers,
            standings: strip(standings.standings),
            incomplete: strip(standings.incomplete),
        };
    }
}
