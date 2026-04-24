import cron from 'node-cron';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { Tournament, CadenceConfig, CleanupRule } from '../types/index.js';
import { TournamentEngine } from './TournamentEngine.js';
import { TimeoutManager } from './TimeoutManager.js';
import { RoomEventService } from '../services/RoomEventService.js';
import { VpsImportService } from '../services/VpsImportService.js';
import { getNextRunTime } from '../utils/cronUtils.js';

export class Scheduler {
    private static instance: Scheduler;
    private tasks: Map<string, any> = new Map();

    private constructor() {}

    public static getInstance(): Scheduler {
        if (!Scheduler.instance) {
            Scheduler.instance = new Scheduler();
        }
        return Scheduler.instance;
    }

    /**
     * Starts the scheduler: loads all active tournament maintenance tasks
     * and starts the global timeout checker (every minute).
     */
    public async start(): Promise<void> {
        logInfo('Starting Scheduler...');
        const db = await getDatabase();
        // v2.4.14: LEFT JOIN game_rooms so per-tournament log lines carry the
        // room slug. Two rooms can independently have a "Daily Grind"; without
        // the slug the super-admin log reads "Scheduling maintenance for Daily
        // Grind" with no way to tell which room is being scheduled.
        const activeTournaments = await db.all(`
            SELECT t.*, r.slug AS room_slug
            FROM tournaments t
            LEFT JOIN game_rooms r ON r.id = t.game_room_id
            WHERE t.is_active = 1
        `);

        for (const row of activeTournaments) {
            const tournament: Tournament = {
                id: row.id,
                name: row.name,
                type: row.type,
                mode: row.mode || 'pinball',
                cadence: JSON.parse(row.cadence || '{}'),
                discordChannelId: row.discord_channel_id,
                discordRoleId: row.discord_role_id,
                isActive: row.is_active === 1,
                winnerPicks: row.winner_picks !== 0,
                autoPick: row.auto_pick !== 0,
                eligibilityDays: row.eligibility_days ?? 120,
                winnerPickWindowMin: row.winner_pick_window_min ?? 60,
                runnerupPickWindowMin: row.runnerup_pick_window_min ?? 30,
            };

            this.scheduleTournament(tournament, row.room_slug ?? null);

            // Schedule cleanup cron if configured
            let cleanupRule: CleanupRule | null = null;
            try { cleanupRule = JSON.parse(row.cleanup_rule || 'null'); } catch {}
            if (cleanupRule?.mode === 'scheduled') {
                this.scheduleCleanup(tournament.id, tournament.name, cleanupRule, row.room_slug ?? null);
            }
        }

        // Run the timeout checker every minute to handle winner/runner-up pick windows
        this.startTimeoutChecker();

        // Daily cleanup of old room events (3 AM)
        this.startRoomEventCleanup();

        // Daily cleanup of old lobby feed events (3:30 AM)
        this.startLobbyFeedCleanup();

        // Expire stale submission drafts (every 5 minutes)
        this.startSubmissionDraftCleanup();

        // Weekly VPS catalogue sync (Wednesday 2 AM Pacific)
        this.startVpsCatalogueSync();

        // Tournament starting notifications (every 15 minutes)
        this.startTournamentStartingNotifier();
    }

    /**
     * Schedules a per-minute check for picker timeouts across all tournaments.
     */
    private startTimeoutChecker(): void {
        const timezone = process.env.BOT_TIMEZONE || 'America/Chicago';
        const task = cron.schedule('* * * * *', async () => {
            try {
                await TimeoutManager.getInstance().checkTimeouts();
            } catch (error) {
                logError('Timeout checker error:', error);
            }
        }, { timezone });

        this.tasks.set('__timeout_checker__', task);
        logInfo('Timeout checker started (every minute).');
    }

    /**
     * Schedules a daily cleanup of old room events at 3 AM.
     */
    private startRoomEventCleanup(): void {
        const timezone = process.env.BOT_TIMEZONE || 'America/Chicago';
        const task = cron.schedule('0 3 * * *', async () => {
            try {
                const deleted = await RoomEventService.cleanup(7);
                if (deleted > 0) logInfo(`Room event cleanup: removed ${deleted} old events.`);
            } catch (error) {
                logError('Room event cleanup error:', error);
            }
        }, { timezone });

        this.tasks.set('__room_event_cleanup__', task);
        logInfo('Room event cleanup scheduled (daily at 3 AM).');
    }

    /**
     * Schedules a daily cleanup of old lobby feed events at 3:30 AM (90-day retention).
     */
    private startLobbyFeedCleanup(): void {
        const timezone = process.env.BOT_TIMEZONE || 'America/Chicago';
        const task = cron.schedule('30 3 * * *', async () => {
            try {
                const { LobbyFeedService } = await import('../services/LobbyFeedService.js');
                const deleted = await LobbyFeedService.cleanup(90);
                if (deleted > 0) logInfo(`Lobby feed cleanup: removed ${deleted} old events.`);
            } catch (error) {
                logError('Lobby feed cleanup error:', error);
            }
        }, { timezone });

        this.tasks.set('__lobby_feed_cleanup__', task);
        logInfo('Lobby feed cleanup scheduled (daily at 3:30 AM).');
    }

    /**
     * Sprint 10 — sweeps expired submission drafts (plan §15). 5-minute TTL so
     * a 5-minute sweep is frequent enough that storage never builds up.
     */
    private startSubmissionDraftCleanup(): void {
        const timezone = process.env.BOT_TIMEZONE || 'America/Chicago';
        const task = cron.schedule('*/5 * * * *', async () => {
            try {
                const { SubmissionDraftService } = await import('../services/SubmissionDraftService.js');
                const deleted = await SubmissionDraftService.cleanup();
                if (deleted > 0) logInfo(`Submission draft cleanup: removed ${deleted} stale drafts.`);
            } catch (error) {
                logError('Submission draft cleanup error:', error);
            }
        }, { timezone });

        this.tasks.set('__submission_draft_cleanup__', task);
        logInfo('Submission draft cleanup scheduled (every 5 minutes).');
    }

    /** Tracks which tournament+timestamp combos have already been notified to avoid repeats. */
    private notifiedStarting = new Set<string>();

    /**
     * Every 15 minutes, checks if any tournament's next maintenance is within 60 minutes.
     * Sends a one-time "tournament starting" DM to opted-in players.
     */
    private startTournamentStartingNotifier(): void {
        const task = cron.schedule('*/15 * * * *', async () => {
            try {
                const db = await getDatabase();
                const tournaments = await db.all(
                    "SELECT id, name, cadence, game_room_id FROM tournaments WHERE is_active = 1 AND cadence IS NOT NULL"
                );
                const now = Date.now();

                for (const t of tournaments) {
                    let cadence: CadenceConfig;
                    try { cadence = JSON.parse(t.cadence); } catch { continue; }
                    if (!cadence.cron) continue;

                    const tz = cadence.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
                    const nextRun = getNextRunTime(cadence.cron, tz);
                    if (!nextRun) continue;

                    const msUntil = nextRun.getTime() - now;
                    // Notify if within 45–60 minutes (narrow window avoids repeat sends)
                    if (msUntil > 0 && msUntil <= 60 * 60000 && msUntil > 45 * 60000) {
                        const key = `${t.id}:${nextRun.toISOString()}`;
                        if (this.notifiedStarting.has(key)) continue;
                        this.notifiedStarting.add(key);

                        // Clean old keys (keep set from growing)
                        if (this.notifiedStarting.size > 200) {
                            const iter = this.notifiedStarting.values();
                            for (let i = 0; i < 100; i++) iter.next();
                            // Just clear old entries
                            this.notifiedStarting.clear();
                        }

                        // Get all opted-in users
                        const { NotificationService } = await import('../services/NotificationService.js');
                        const users = await db.all(
                            "SELECT discord_user_id, notification_prefs FROM user_preferences WHERE notification_prefs IS NOT NULL"
                        );
                        const room = t.game_room_id
                            ? await db.get('SELECT slug FROM game_rooms WHERE id = ?', t.game_room_id)
                            : null;
                        const link = room?.slug ? NotificationService.buildLink(room.slug) : '';
                        const mins = Math.round(msUntil / 60000);

                        for (const u of users) {
                            try {
                                const prefs = JSON.parse(u.notification_prefs || '{}');
                                if (!prefs.tournamentStarting) continue;
                                NotificationService.notify({
                                    userId: u.discord_user_id,
                                    type: 'tournamentStarting',
                                    message: `**${t.name}** rotates in ~${mins} minutes — get your scores in!${link ? `\n${link}` : ''}`,
                                }).catch(() => {});
                            } catch { /* skip malformed prefs */ }
                        }
                    }
                }
            } catch (error) {
                logError('Tournament starting notifier error:', error);
            }
        });

        this.tasks.set('__tournament_starting_notifier__', task);
        logInfo('Tournament starting notifier scheduled (every 15 minutes).');
    }

    /**
     * Schedules a weekly VPS catalogue sync every Wednesday at 2 AM Pacific.
     */
    private startVpsCatalogueSync(): void {
        const task = cron.schedule('0 2 * * 3', async () => {
            logInfo('Running scheduled VPS catalogue sync...');
            try {
                const result = await VpsImportService.importFromVps();
                logInfo(`VPS catalogue sync complete: ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped (${result.total} total).`);
            } catch (error) {
                logError('VPS catalogue sync error:', error);
            }
        }, { timezone: 'America/Los_Angeles' });

        this.tasks.set('__vps_catalogue_sync__', task);
        logInfo('VPS catalogue sync scheduled (Wednesday 2 AM Pacific).');
    }

    /**
     * Schedules a maintenance task for a specific tournament.
     */
    public scheduleTournament(tournament: Tournament, roomSlug?: string | null): void {
        const { id, name, cadence } = tournament;
        const tag = roomSlug ? ` [${roomSlug}]` : '';

        if (!cadence || !cadence.cron) {
            logInfo(`Skipping scheduler for tournament ${name}${tag} (ID: ${id}) - No cadence configured.`);
            return;
        }

        // Stop existing task if it exists
        if (this.tasks.has(id)) {
            this.tasks.get(id)?.stop();
        }

        const timezone = cadence.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
        const { cronExpr, isLastDay } = this.resolveCron(cadence.cron);
        logInfo(`Scheduling maintenance for ${name}${tag} using cron: '${cadence.cron}'${isLastDay ? ' (last day of month)' : ''}`);

        const task = cron.schedule(cronExpr, async () => {
            if (isLastDay && !this.isLastDayOfMonth(timezone)) return;
            logInfo(`Running scheduled maintenance for tournament: ${name}${tag}`);
            try {
                await TournamentEngine.getInstance().runMaintenance(id);
            } catch (error) {
                logError(`Maintenance failed for tournament ${name}${tag}:`, error);
            }
        }, { timezone });

        this.tasks.set(id, task);
    }

    /**
     * Schedules a cleanup task for a tournament with 'scheduled' cleanup_rule.
     */
    private scheduleCleanup(tournamentId: string, name: string, rule: CleanupRule & { mode: 'scheduled' }, roomSlug?: string | null): void {
        const taskKey = `__cleanup_${tournamentId}__`;
        const tag = roomSlug ? ` [${roomSlug}]` : '';

        if (this.tasks.has(taskKey)) {
            this.tasks.get(taskKey)?.stop();
        }

        const timezone = rule.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
        const { cronExpr, isLastDay } = this.resolveCron(rule.cron);
        logInfo(`Scheduling cleanup for ${name}${tag} using cron: '${cronExpr}' (${timezone})${isLastDay ? ' (last day of month)' : ''}`);

        const task = cron.schedule(cronExpr, async () => {
            if (isLastDay && !this.isLastDayOfMonth(timezone)) return;
            logInfo(`Running scheduled cleanup for tournament: ${name}${tag}`);
            try {
                await TournamentEngine.getInstance().runScheduledCleanup(tournamentId);
            } catch (error) {
                logError(`Scheduled cleanup failed for tournament ${name}${tag}:`, error);
            }
        }, { timezone });

        this.tasks.set(taskKey, task);
    }

    /**
     * Resolves a cron expression, handling the custom 'L' (last day of month) marker.
     * node-cron doesn't support 'L', so we replace it with '28-31' and flag it
     * for a runtime check.
     */
    private resolveCron(cronStr: string): { cronExpr: string; isLastDay: boolean } {
        const parts = cronStr.split(' ');
        if (parts[2] === 'L') {
            parts[2] = '28-31';
            return { cronExpr: parts.join(' '), isLastDay: true };
        }
        return { cronExpr: cronStr, isLastDay: false };
    }

    /**
     * Returns true if today is the last day of the month in the given timezone.
     */
    private isLastDayOfMonth(timezone: string): boolean {
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        return tomorrow.getDate() === 1;
    }

    /**
     * Reloads all scheduled tasks from the database.
     * Call after tournament create/update/delete to pick up schedule changes.
     */
    public async reload(): Promise<void> {
        logInfo('Reloading Scheduler...');
        this.stop();
        await this.start();
    }

    /**
     * Stops all scheduled tasks.
     */
    public stop(): void {
        for (const task of this.tasks.values()) {
            task.stop();
        }
        this.tasks.clear();
        logInfo('Scheduler stopped.');
    }
}
