import { getDatabase } from '../database/database.js';
import { logError, logWarn } from '../utils/logger.js';
import { nextRotationIso } from '../utils/cronUtils.js';
import { SeasonPollService, type SeasonPollRow, type SeasonTournamentRow } from '../services/SeasonPollService.js';

/**
 * Pick-by-poll clock (docs/season-format-plan.md §5, §13; ADR 0026). The name
 * is historical: since v2.162.0 it drives every POLL-PICKED rotation
 * tournament (`poll_picks = 1`), Season or not.
 *
 * A per-minute tick registered beside `EventScheduler` in `Scheduler`. For
 * every active, poll-picked tournament (a Season additionally unpaused and
 * unfinished) it: mirrors Discord votes into
 * open polls, closes + resolves polls whose `closes_at` has passed, derives
 * and posts the next draft, and sends the one-day reminder when no draft is
 * prepared.
 *
 * Stateless and at-least-once safe like `EventScheduler`: it reads the queue
 * from the DB each minute, and every flip (`draft → open`, `open → resolved`)
 * is a guarded `UPDATE … WHERE status = <expected>` acted on only when
 * `changes === 1`.
 *
 * One poll per rotation: a new draft is only derived/posted when no poll is
 * open AND no resolved poll's table is still waiting in the queue — so a week
 * never gets two polls, and the next week's derivation uses the rotation AFTER
 * the queued table goes live.
 */
export class SeasonScheduler {
    private static instance: SeasonScheduler;
    /** Reentrancy guard: a slow tick (Discord) must not overlap the next minute's. */
    private running = false;

    public static getInstance(): SeasonScheduler {
        if (!SeasonScheduler.instance) SeasonScheduler.instance = new SeasonScheduler();
        return SeasonScheduler.instance;
    }

    /** One sweep. `now` is injectable so tests can drive the clock. */
    public async tick(now: Date = new Date()): Promise<void> {
        if (this.running) {
            logWarn('SeasonScheduler: previous tick still running, skipping this minute.');
            return;
        }
        this.running = true;
        try {
            const db = await getDatabase();
            const seasons = await db.all<SeasonTournamentRow[]>(
                `SELECT t.*, r.slug AS room_slug FROM tournaments t
                   LEFT JOIN game_rooms r ON r.id = t.game_room_id
                  WHERE t.poll_picks = 1
                    AND t.is_active = 1
                    AND t.season_paused_at IS NULL
                    AND t.season_finished_at IS NULL`,
            );
            for (const season of seasons) {
                try {
                    await this.processSeason(season, now);
                } catch (error) {
                    logError(`SeasonScheduler: season '${season.name}' (${season.id}) failed`, error);
                }
            }
        } finally {
            this.running = false;
        }
    }

    private async processSeason(t: SeasonTournamentRow, now: Date): Promise<void> {
        const db = await getDatabase();
        const nowMs = now.getTime();

        // 1. Open polls: close + resolve the due ones, mirror the rest.
        const open = await db.all<SeasonPollRow[]>(
            `SELECT * FROM season_polls WHERE tournament_id = ? AND status = 'open' ORDER BY slot_no`, t.id,
        );
        for (const poll of open) {
            try {
                if (poll.closes_at && Date.parse(poll.closes_at) <= nowMs) {
                    await SeasonPollService.closeAndResolve(t, poll, now);
                } else {
                    await SeasonPollService.refreshOpenPoll(t, poll);
                }
            } catch (error) {
                logError(`SeasonScheduler: poll ${poll.id} failed`, error);
            }
        }

        // 2. The bound: a poll-picked SEASON stops polling once its tables are
        //    all chosen. A poll-only rotation has no bound.
        if (t.season_table_count != null
            && await SeasonPollService.countResolvedWithResult(t.id) >= t.season_table_count) return;

        // 3. One poll per rotation (see class doc).
        const stillOpen = await db.get(
            `SELECT 1 FROM season_polls WHERE tournament_id = ? AND status = 'open' LIMIT 1`, t.id,
        );
        if (stillOpen) return;
        const waiting = await db.get(
            `SELECT 1 FROM season_polls p JOIN games g ON g.id = p.result_queued_game_id
              WHERE p.tournament_id = ? AND p.status = 'resolved' AND g.status = 'QUEUED' LIMIT 1`,
            t.id,
        );
        if (waiting) return;
        // A poll that tied under "Admin decides" HOLDS with nothing queued
        // (ADR 0026). It still owns its rotation: no next poll is derived until
        // that rotation has passed, chosen or not — after that the hold is the
        // rotation's own ("No Table Queued") and the queue moves on.
        const held = await db.all<Array<{ closes_at: string | null }>>(
            `SELECT closes_at FROM season_polls
              WHERE tournament_id = ? AND status = 'resolved' AND tied = 1 AND result_queued_game_id IS NULL`,
            t.id,
        );
        for (const h of held) {
            const rotation = h.closes_at ? nextRotationIso(t.cadence, new Date(h.closes_at)) : null;
            if (rotation && nowMs < Date.parse(rotation)) return;
        }

        // 4. The lowest-slot draft: derive its times if needed, post when due.
        const draft = await db.get<SeasonPollRow>(
            `SELECT * FROM season_polls WHERE tournament_id = ? AND status = 'draft' ORDER BY slot_no LIMIT 1`, t.id,
        );
        if (!draft) {
            // 5. No draft prepared: the one-day reminder (creates the empty draft).
            await SeasonPollService.maybeRemind(t, now);
            return;
        }

        let poll = draft;
        const stale = !poll.opens_at || !poll.closes_at || Date.parse(poll.closes_at) <= nowMs;
        if (stale && !poll.posted_at) {
            const times = SeasonPollService.deriveTimes(t, now);
            if (!times) return; // no cron — nothing to derive from
            await db.run(
                `UPDATE season_polls SET opens_at = ?, closes_at = ? WHERE id = ? AND status = 'draft'`,
                times.opensAt, times.closesAt, poll.id,
            );
            poll = { ...poll, opens_at: times.opensAt, closes_at: times.closesAt };
        }
        if (poll.opens_at && Date.parse(poll.opens_at) <= nowMs) {
            await SeasonPollService.postDraft(t, poll, now);
        }
    }
}
