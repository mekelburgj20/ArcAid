import { EmbedBuilder } from 'discord.js';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { sendChannelEmbed } from '../utils/discord.js';
import { emitLeaderboardUpdated } from '../api/websocket.js';
import { applyLibraryDefaults } from '../utils/gameLibraryDefaults.js';
import { eventEndGraceSec } from '../services/EventSubmissionGate.js';
import { EventService, type EventRoundRow, type EventTournamentRow } from '../services/EventService.js';

/**
 * Live Event clock (v2.135.0, ADR 0017).
 *
 * A per-minute tick, registered beside the picker-timeout checker in
 * `Scheduler.start()`. It is the ONLY thing that moves an event forward:
 * check-in opens, rounds flip ACTIVE, rounds close, the event freezes.
 *
 * ## Why it is safe to run at-least-once
 *
 * The tick is stateless — it reads the schedule from the DB every time — so
 * `Scheduler.reload()` (stop + start, fired whenever a tournament is saved)
 * costs nothing but a re-registration. More importantly a container restart
 * mid-tick must not double-announce or double-flip, so:
 *
 *   - every status flip is a guarded `UPDATE … WHERE status = <expected>` and
 *     acts only when `changes === 1`;
 *   - every announcement is guarded on an idempotency stamp
 *     (`checkin_announced_at`, `event_finished_at`) written in the same step.
 *
 * ## Why events carry no cron
 *
 * An event's `cadence` is `{"timezone": tz}` with no `cron`, which
 * `Scheduler.scheduleTournament` skips outright. That keeps `runMaintenance`,
 * `processSlotMaintenance` and `TimeoutManager` away from event rounds — they
 * would rotate, complete and re-pick the rounds out from under the schedule.
 */

/** Discord embed colour for event announcements — distinct from the four rotation colours. */
const EVENT_COLOR = 0xFF4D6D;

const MEDALS = ['🥇', '🥈', '🥉'];

interface DueRoundRow extends EventRoundRow {
    tournament_name: string;
    tournament_type: string;
    discord_channel_id: string | null;
    end_grace_sec: number | null;
}

export class EventScheduler {
    private static instance: EventScheduler;
    /** Reentrancy guard: a slow tick (iScored board creation) must not overlap the next minute's. */
    private running = false;

    public static getInstance(): EventScheduler {
        if (!EventScheduler.instance) EventScheduler.instance = new EventScheduler();
        return EventScheduler.instance;
    }

    /**
     * One sweep. Each step is independently try/caught so a failure in one
     * (a Discord outage, an iScored timeout) cannot stall the others — a round
     * that fails to get an iScored board still opens on Arcaid.
     *
     * `now` is injectable so tests can drive the clock.
     */
    public async tick(now: Date = new Date()): Promise<void> {
        if (this.running) {
            logWarn('EventScheduler: previous tick still running, skipping this minute.');
            return;
        }
        this.running = true;
        try {
            for (const step of [
                () => this.openCheckIns(now),
                () => this.startDueRounds(now),
                () => this.endDueRounds(now),
                () => this.finishCompletedEvents(now),
            ]) {
                try { await step(); } catch (error) { logError('EventScheduler step failed:', error); }
            }
        } finally {
            this.running = false;
        }
    }

    // --- Step 1: check-in opens -------------------------------------------

    private async openCheckIns(now: Date): Promise<void> {
        const db = await getDatabase();
        const nowIso = now.toISOString();
        const due = await db.all<Array<EventTournamentRow & { room_slug: string | null }>>(
            `SELECT t.*, r.slug AS room_slug
               FROM tournaments t
               LEFT JOIN game_rooms r ON r.id = t.game_room_id
              WHERE t.format = 'event' AND t.is_active = 1
                AND t.checkin_announced_at IS NULL
                AND t.event_finished_at IS NULL
                AND (t.checkin_opens_at IS NULL OR t.checkin_opens_at <= ?)`,
            nowIso,
        );

        for (const event of due) {
            // Stamp FIRST and act only if we won the race — a second process
            // (or a restart replaying this minute) then finds 0 changes and
            // announces nothing.
            const res = await db.run(
                `UPDATE tournaments SET checkin_announced_at = ?
                  WHERE id = ? AND checkin_announced_at IS NULL`,
                nowIso, event.id,
            ) as { changes?: number };
            if (!res.changes) continue;

            const rounds = await EventService.getRounds(event.id);
            const first = rounds[0];
            logInfo(`Event check-in open: '${event.name}' (${event.id}), ${rounds.length} round(s).`);

            await this.announce(event, new EmbedBuilder()
                .setTitle(`Check-in open: ${event.name}`)
                .setDescription(
                    event.checkin_required === 1
                        ? `Check in before round 1 starts${first ? ` <t:${Math.floor(Date.parse(first.scheduled_start_at) / 1000)}:R>` : ''} — only checked-in players can post a score.`
                        : `${event.name} is open. ${rounds.length} round${rounds.length === 1 ? '' : 's'} to play.`,
                )
                .setColor(EVENT_COLOR)
                .setFooter({ text: `${rounds.length} round${rounds.length === 1 ? '' : 's'}` })
                .setTimestamp());

            await this.feed(event, 'event_checkin_open', '📋', `Check-in open: ${event.name}`,
                event.checkin_required === 1 ? 'Check in before round 1 starts.' : undefined);
        }
    }

    // --- Step 2: rounds start ---------------------------------------------

    private async startDueRounds(now: Date): Promise<void> {
        const db = await getDatabase();
        const nowIso = now.toISOString();
        const due = await db.all<DueRoundRow[]>(
            `SELECT g.id, g.tournament_id, g.game_room_id, g.name, g.status, g.round_no,
                    g.scheduled_start_at, g.scheduled_end_at, g.start_date, g.end_date, g.iscored_id,
                    t.name AS tournament_name, t.type AS tournament_type,
                    t.discord_channel_id, t.end_grace_sec
               FROM games g
               JOIN tournaments t ON t.id = g.tournament_id
              WHERE t.format = 'event' AND t.is_active = 1
                AND g.status = 'SCHEDULED' AND g.round_no IS NOT NULL
                AND g.scheduled_start_at <= ?
                AND g.scheduled_end_at > ?`,
            nowIso, nowIso,
        );

        for (const round of due) {
            // THE FLIP COMES FIRST, the iScored board second.
            //
            // The advertised window is the product promise; the iScored mirror
            // is a convenience. A Playwright login against a misconfigured
            // account costs ~40s (two attempts with backoff), and doing it
            // before the flip would hold the round shut for that whole time —
            // and, because `tick()` is reentrancy-guarded, push the NEXT minute's
            // work behind it too. Opening on time and attaching the board a few
            // seconds later is strictly better: the only exposure is a score
            // submitted inside that gap, whose iScored sync no-ops.
            //
            // `start_date` is the SCHEDULED time, never the tick time, so the
            // elapsed-since-start figure every score is judged by matches what
            // players were told.
            const res = await db.run(
                `UPDATE games SET status = 'ACTIVE', start_date = ?
                  WHERE id = ? AND status = 'SCHEDULED'`,
                round.scheduled_start_at, round.id,
            ) as { changes?: number };
            if (!res.changes) continue;

            try {
                const iscoredId = await this.createIScoredBoard(round);
                if (iscoredId) {
                    await db.run(
                        'UPDATE games SET iscored_id = COALESCE(iscored_id, ?) WHERE id = ?',
                        iscoredId, round.id,
                    );
                }
            } catch (error) {
                logError(`EventScheduler: iScored board creation failed for round ${round.round_no} of '${round.tournament_name}' — the round is open without one:`, error);
            }

            await applyLibraryDefaults(db, round.game_room_id, round.id, round.name);

            const { LeaderboardService } = await import('../services/LeaderboardService.js');
            await LeaderboardService.invalidate(round.id);
            if (round.game_room_id) emitLeaderboardUpdated(round.game_room_id, { gameId: round.id });

            logInfo(`Event round ${round.round_no} live: '${round.name}' for '${round.tournament_name}'.`);

            const endsAt = Math.floor(Date.parse(round.scheduled_end_at) / 1000);
            await this.announce(round, new EmbedBuilder()
                .setTitle(`Round ${round.round_no} is LIVE: ${round.name}`)
                .setDescription(`Scores count until <t:${endsAt}:t> (<t:${endsAt}:R>). Get them in.`)
                .setColor(EVENT_COLOR)
                .setFooter({ text: round.tournament_name })
                .setTimestamp());

            await this.feed(round, 'event_round_start', '🔴',
                `Round ${round.round_no} live: ${round.name}`, round.tournament_name, round.name);
        }
    }

    /**
     * Mirror the round onto iScored when the room has it enabled. Copied from
     * the admin activate route so an event round appears on the board exactly
     * as a rotation game does — tagged with the tournament type, unlocked and
     * visible.
     */
    private async createIScoredBoard(round: DueRoundRow): Promise<string | null> {
        if (!round.game_room_id) return null;
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        if ((await GameRoomSettingsService.get(round.game_room_id, 'ISCORED_ENABLED')) === 'false') return null;

        const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(round.game_room_id);
        if (!creds) return null;

        const { IScoredSessionRegistry } = await import('./IScoredSessionRegistry.js');
        return IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
            const id = await client.createGame(round.name, undefined);
            await client.setGameTags(id, round.tournament_type);
            await client.setGameStatus(id, { locked: false, hidden: false });
            return id;
        });
    }

    // --- Step 3: rounds end ------------------------------------------------

    private async endDueRounds(now: Date): Promise<void> {
        const db = await getDatabase();
        const active = await db.all<DueRoundRow[]>(
            `SELECT g.id, g.tournament_id, g.game_room_id, g.name, g.status, g.round_no,
                    g.scheduled_start_at, g.scheduled_end_at, g.start_date, g.end_date, g.iscored_id,
                    t.name AS tournament_name, t.type AS tournament_type,
                    t.discord_channel_id, t.end_grace_sec
               FROM games g
               JOIN tournaments t ON t.id = g.tournament_id
              WHERE t.format = 'event' AND t.is_active = 1
                AND g.status IN ('ACTIVE', 'SCHEDULED') AND g.round_no IS NOT NULL`,
        );

        for (const round of active) {
            // The SAME grace the gate honours, via the SAME helper — a round
            // that closed while the gate was still accepting scores would drop
            // them on the floor.
            const closesAt = Date.parse(round.scheduled_end_at) + eventEndGraceSec(round) * 1000;
            if (now.getTime() < closesAt) continue;

            if (round.status === 'SCHEDULED') {
                // The round's ENTIRE window elapsed without a tick — the app was
                // down for longer than the round lasted. It never opened, so
                // there is nothing to deactivate (and `deactivateGame` would
                // throw on a non-ACTIVE row); mark it done so the event can
                // still reach its final state. Without this the event is stuck
                // forever: `finishCompletedEvents` waits for no SCHEDULED or
                // ACTIVE rounds to remain.
                const skipped = await db.run(
                    `UPDATE games SET status = 'COMPLETED', start_date = ?, end_date = ?
                      WHERE id = ? AND status = 'SCHEDULED'`,
                    round.scheduled_start_at, round.scheduled_end_at, round.id,
                ) as { changes?: number };
                if (skipped.changes) {
                    logWarn(`EventScheduler: round ${round.round_no} of '${round.tournament_name}' was never opened — its whole window passed while the scheduler was not running. Marking it COMPLETED.`);
                }
                continue;
            }

            const { TournamentEngine } = await import('./TournamentEngine.js');
            try {
                await TournamentEngine.getInstance().deactivateGame(round.id);
            } catch (error) {
                // deactivateGame throws when the row is no longer ACTIVE — i.e.
                // another tick or an admin "end now" already closed it. Anything
                // else is a real failure worth surfacing.
                logWarn(`EventScheduler: could not close round ${round.round_no} of '${round.tournament_name}':`, error);
                continue;
            }

            const { LeaderboardService } = await import('../services/LeaderboardService.js');
            await LeaderboardService.invalidate(round.id);
            if (round.game_room_id) emitLeaderboardUpdated(round.game_room_id, { gameId: round.id });

            logInfo(`Event round ${round.round_no} closed: '${round.name}' for '${round.tournament_name}'.`);
            await this.announceRoundResults(round);
        }
    }

    private async announceRoundResults(round: DueRoundRow): Promise<void> {
        const event = await EventService.getEvent(round.tournament_id);
        if (!event) return;
        const rounds = await EventService.getRounds(round.tournament_id);
        const row = rounds.find(r => r.id === round.id);
        if (!row) return;

        const { EventResultService } = await import('../services/EventResultService.js');
        const board = await EventResultService.getRoundBoard(event, row);
        const top = board.scores.slice(0, 3);

        const lines = top.length
            ? top.map((s, i) => {
                const elapsed = s.elapsed_sec != null
                    ? ` · +${String(Math.floor(s.elapsed_sec / 60)).padStart(2, '0')}:${String(s.elapsed_sec % 60).padStart(2, '0')}`
                    : '';
                const name = s.display_name || s.iscored_username;
                return `${MEDALS[i] ?? ''} **${name}** — ${s.score.toLocaleString()}${elapsed}${s.flagged ? ' ⚠️' : ''}`;
            }).join('\n')
            : '_No scores were posted this round._';

        await this.announce(round, new EmbedBuilder()
            .setTitle(`Round ${round.round_no} results: ${round.name}`)
            .setDescription(lines)
            .setColor(EVENT_COLOR)
            .setFooter({ text: round.tournament_name })
            .setTimestamp());

        await this.feed(round, 'event_round_end', '🏁',
            `Round ${round.round_no} finished: ${round.name}`,
            top[0] ? `${top[0].display_name || top[0].iscored_username} took it with ${top[0].score.toLocaleString()}.` : undefined,
            round.name);
    }

    // --- Step 4: the event finishes ---------------------------------------

    private async finishCompletedEvents(now: Date): Promise<void> {
        const db = await getDatabase();
        const nowIso = now.toISOString();
        const candidates = await db.all<EventTournamentRow[]>(
            `SELECT t.* FROM tournaments t
              WHERE t.format = 'event' AND t.is_active = 1 AND t.event_finished_at IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM games g
                     WHERE g.tournament_id = t.id AND g.round_no IS NOT NULL
                       AND g.status IN ('SCHEDULED', 'ACTIVE')
                )
                AND EXISTS (SELECT 1 FROM games g WHERE g.tournament_id = t.id AND g.round_no IS NOT NULL)`,
        );

        for (const event of candidates) {
            const { EventResultService } = await import('../services/EventResultService.js');
            // Computed ONCE: the frozen blob is the display-stripped view of the
            // same standings the announcement reads names from.
            const standings = await EventResultService.computeStandings(event.id);
            if (!standings) continue;
            const result = EventResultService.freeze(standings, nowIso);

            // is_active = 0 gives the event the same "completed tournament"
            // semantics MergeService and the alias-link freeze gate already
            // understand: its scores stop being re-attributed by later identity
            // links, so a frozen result stays frozen.
            const res = await db.run(
                `UPDATE tournaments SET event_result = ?, event_finished_at = ?, is_active = 0
                  WHERE id = ? AND event_finished_at IS NULL`,
                JSON.stringify(result), nowIso, event.id,
            ) as { changes?: number };
            if (!res.changes) continue;

            logInfo(`Event finished: '${event.name}' (${event.id}), ${result.standings.length} ranked player(s).`);

            // Names come from the LIVE standings, never from the frozen blob —
            // that blob holds identity keys only, by design.
            const winner = standings.standings[0];
            const podium = standings.standings.slice(0, 3);

            await this.announce(event, new EmbedBuilder()
                .setTitle(`${event.name} — final standings`)
                .setDescription(podium.length
                    ? podium.map((p, i) => `${MEDALS[i] ?? ''} **${p.display_name || p.iscored_username}** — ${Math.round(p.total).toLocaleString()}`).join('\n')
                    : '_No scores were posted._')
                .setColor(EVENT_COLOR)
                .setFooter({ text: `Aggregate: ${result.aggregateMethod}` })
                .setTimestamp());

            await this.feed(event, 'event_finished', '🏆', `${event.name} is done`,
                winner ? `${winner.display_name || winner.iscored_username} wins.` : undefined);

            if (winner) await EventScheduler.notifyWinner(event, winner.discord_user_id);
        }
    }

    private static async notifyWinner(event: EventTournamentRow, userId: string): Promise<void> {
        try {
            const { NotificationService } = await import('../services/NotificationService.js');
            await NotificationService.notify({
                userId,
                type: 'tournamentWin',
                message: `You won **${event.name}**! Final standings are up.`,
                roomId: event.game_room_id,
                tournamentId: event.id,
            });
        } catch (error) {
            logWarn('EventScheduler: winner notification failed:', error);
        }
    }

    // --- shared helpers ----------------------------------------------------

    private async announce(
        target: { tournament_id?: string; discord_channel_id?: string | null; game_room_id: string | null },
        embed: EmbedBuilder,
    ): Promise<void> {
        try {
            let channelId = target.discord_channel_id ?? null;
            if (!channelId && target.game_room_id) {
                const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
                channelId = await GameRoomSettingsService.get(target.game_room_id, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID');
            }
            if (!channelId) return;
            await sendChannelEmbed(channelId, embed);
        } catch (error) {
            logWarn('EventScheduler: Discord announcement failed:', error);
        }
    }

    private async feed(
        target: { id?: string; tournament_id?: string; game_room_id: string | null },
        type: string, icon: string, title: string, subtitle?: string, gameName?: string,
    ): Promise<void> {
        if (!target.game_room_id) return;
        try {
            const { LobbyFeedService } = await import('../services/LobbyFeedService.js');
            await LobbyFeedService.emit({
                gameRoomId: target.game_room_id,
                type, icon, title, subtitle, gameName,
                tournamentId: target.tournament_id ?? target.id,
            });
        } catch (error) {
            logWarn('EventScheduler: lobby feed emit failed:', error);
        }
    }
}
