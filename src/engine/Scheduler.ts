import cron from 'node-cron';
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
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
            // Guard: a tournament whose game_room_id points to a deleted room
            // (non-NULL game_room_id but the LEFT JOIN found no room, so
            // room_slug is null) is an orphan from a pre-cascade room deletion.
            // Skip it — scheduling it would keep minting games on iScored for a
            // room that no longer exists. Legacy NULL-room tournaments are fine.
            if (row.game_room_id && !row.room_slug) {
                logWarn(`Scheduler: skipping orphaned tournament '${row.name}' (${row.id}) — game_room ${row.game_room_id} no longer exists. Run GameRoomService.purgeOrphanedTournaments() to clean it up.`);
                continue;
            }
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

        // S9: scheduled DB+assets backup (driven by global settings)
        await this.startBackupCron();
    }

    /**
     * S9 — registers (or re-registers) the scheduled backup cron from global
     * settings. Gated on `BACKUP_ENABLED !== 'false'` and a non-empty
     * `BACKUP_SCHEDULE_CRON`. On fire it creates a DB+assets backup (no iScored
     * client → live-state capture is skipped) then prunes per retention.
     *
     * Driven by global settings keys:
     *   - `BACKUP_ENABLED`           ('true' | 'false', default enabled)
     *   - `BACKUP_SCHEDULE_CRON`     (5-field cron; supports custom 'L')
     *   - `BACKUP_RETENTION_COUNT`   (keep newest N — optional)
     *   - `BACKUP_RETENTION_DAYS`    (delete older than N days — optional)
     */
    private async startBackupCron(): Promise<void> {
        const TASK_KEY = '__backup__';
        // Always clear any existing handle first (idempotent re-register).
        if (this.tasks.has(TASK_KEY)) {
            this.tasks.get(TASK_KEY)?.stop();
            this.tasks.delete(TASK_KEY);
        }

        const { SettingsService } = await import('../services/SettingsService.js');
        const enabled = (await SettingsService.get('BACKUP_ENABLED')) !== 'false';
        const cronStr = (await SettingsService.get('BACKUP_SCHEDULE_CRON')) || '';
        if (!enabled || !cronStr.trim()) {
            logInfo('Backup cron not scheduled (disabled or no schedule configured).');
            return;
        }

        const retentionCount = parseInt((await SettingsService.get('BACKUP_RETENTION_COUNT')) || '', 10);
        const retentionDays = parseInt((await SettingsService.get('BACKUP_RETENTION_DAYS')) || '', 10);

        const timezone = process.env.BOT_TIMEZONE || 'America/Chicago';
        const { cronExpr, isLastDay } = this.resolveCron(cronStr);

        const task = cron.schedule(cronExpr, async () => {
            if (isLastDay && !this.isLastDayOfMonth(timezone)) return;
            logInfo('Running scheduled backup (DB + assets, no iScored client)...');
            try {
                const { BackupManager } = await import('./BackupManager.js');
                const manager = BackupManager.getInstance();
                // Scheduled backups are DB+assets only — no live iScored capture.
                // createBackup() with no client skips the iScored step.
                const backupPath = await manager.createBackup();
                if (backupPath) {
                    logInfo(`Scheduled backup completed: ${backupPath}`);
                } else {
                    logError('Scheduled backup returned no path (createBackup failed).');
                }

                // Prune per retention policy.
                const opts: { retentionCount?: number; retentionDays?: number } = {};
                if (Number.isFinite(retentionCount) && retentionCount > 0) opts.retentionCount = retentionCount;
                if (Number.isFinite(retentionDays) && retentionDays > 0) opts.retentionDays = retentionDays;
                if (opts.retentionCount || opts.retentionDays) {
                    const removed = await manager.pruneBackups(opts);
                    if (removed > 0) logInfo(`Backup prune: removed ${removed} old backup(s).`);
                }
            } catch (error) {
                logError('Scheduled backup error:', error);
            }
        }, { timezone });

        this.tasks.set(TASK_KEY, task);
        logInfo(`Backup cron scheduled using cron: '${cronStr}'${isLastDay ? ' (last day of month)' : ''} (${timezone}).`);
    }

    /**
     * S9 — hot-reload entry point for the backup cron. Called from the admin
     * `PUT /api/admin/backups/config` route handler after it persists
     * BACKUP_SCHEDULE_CRON / BACKUP_ENABLED, so the schedule updates without a
     * full Scheduler reload (which would re-register every tournament cron).
     * Re-reads settings and re-registers the backup task. (NOTE: settings
     * written via SettingsService.saveMany outside that route do NOT auto-call
     * this — the schedule keys are only edited through that endpoint today.)
     */
    public async rescheduleBackup(): Promise<void> {
        logInfo('Rescheduling backup cron...');
        await this.startBackupCron();
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

                        const { NotificationService } = await import('../services/NotificationService.js');
                        const users = await Scheduler.resolveTournamentStartingRecipients(db, t.game_room_id);
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
                                    roomId: t.game_room_id,
                                    tournamentId: t.id,
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
     * Resolve the recipient set for a tournamentStarting DM.
     *
     * Recipients are the MEMBERS of the tournament's room (room_members is the
     * authoritative, backfilled membership set — see migration 055). Scoping
     * here prevents cross-room spam where a server-wide opt-in user got DMed
     * about a tournament in a room they never touched. Legacy single-room
     * tournaments (game_room_id NULL) have no room_members rows to scope by, so
     * fall back to the global query for them.
     *
     * Extracted as a static seam so the room-scoping is unit-testable without
     * driving the cron. room_members PK is (user_id, room_id) → one row per
     * user per room, so no DISTINCT is needed.
     */
    static async resolveTournamentStartingRecipients(
        db: { all: (sql: string, ...params: any[]) => Promise<any[]> },
        gameRoomId: string | null | undefined
    ): Promise<Array<{ discord_user_id: string; notification_prefs: string | null }>> {
        if (gameRoomId) {
            return db.all(
                `SELECT up.discord_user_id, up.notification_prefs
                 FROM room_members rm
                 JOIN user_preferences up ON up.discord_user_id = rm.user_id
                 WHERE rm.room_id = ?
                   AND up.notification_prefs IS NOT NULL`,
                gameRoomId
            );
        }
        return db.all(
            "SELECT discord_user_id, notification_prefs FROM user_preferences WHERE notification_prefs IS NOT NULL"
        );
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
