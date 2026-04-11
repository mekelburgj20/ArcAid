import cron from 'node-cron';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { Tournament, CadenceConfig, CleanupRule } from '../types/index.js';
import { TournamentEngine } from './TournamentEngine.js';
import { TimeoutManager } from './TimeoutManager.js';
import { RoomEventService } from '../services/RoomEventService.js';
import { VpsImportService } from '../services/VpsImportService.js';

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
        const activeTournaments = await db.all('SELECT * FROM tournaments WHERE is_active = 1');

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

            this.scheduleTournament(tournament);

            // Schedule cleanup cron if configured
            let cleanupRule: CleanupRule | null = null;
            try { cleanupRule = JSON.parse(row.cleanup_rule || 'null'); } catch {}
            if (cleanupRule?.mode === 'scheduled') {
                this.scheduleCleanup(tournament.id, tournament.name, cleanupRule);
            }
        }

        // Run the timeout checker every minute to handle winner/runner-up pick windows
        this.startTimeoutChecker();

        // Daily cleanup of old room events (3 AM)
        this.startRoomEventCleanup();

        // Weekly VPS catalogue sync (Wednesday 2 AM Pacific)
        this.startVpsCatalogueSync();
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
    public scheduleTournament(tournament: Tournament): void {
        const { id, name, cadence } = tournament;

        if (!cadence || !cadence.cron) {
            logInfo(`Skipping scheduler for tournament ${name} (ID: ${id}) - No cadence configured.`);
            return;
        }

        // Stop existing task if it exists
        if (this.tasks.has(id)) {
            this.tasks.get(id)?.stop();
        }

        const timezone = cadence.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
        const { cronExpr, isLastDay } = this.resolveCron(cadence.cron);
        logInfo(`Scheduling maintenance for ${name} using cron: '${cadence.cron}'${isLastDay ? ' (last day of month)' : ''}`);

        const task = cron.schedule(cronExpr, async () => {
            if (isLastDay && !this.isLastDayOfMonth(timezone)) return;
            logInfo(`Running scheduled maintenance for tournament: ${name}`);
            try {
                await TournamentEngine.getInstance().runMaintenance(id);
            } catch (error) {
                logError(`Maintenance failed for tournament ${name}:`, error);
            }
        }, { timezone });

        this.tasks.set(id, task);
    }

    /**
     * Schedules a cleanup task for a tournament with 'scheduled' cleanup_rule.
     */
    private scheduleCleanup(tournamentId: string, name: string, rule: CleanupRule & { mode: 'scheduled' }): void {
        const taskKey = `__cleanup_${tournamentId}__`;

        if (this.tasks.has(taskKey)) {
            this.tasks.get(taskKey)?.stop();
        }

        const timezone = rule.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
        const { cronExpr, isLastDay } = this.resolveCron(rule.cron);
        logInfo(`Scheduling cleanup for ${name} using cron: '${cronExpr}' (${timezone})${isLastDay ? ' (last day of month)' : ''}`);

        const task = cron.schedule(cronExpr, async () => {
            if (isLastDay && !this.isLastDayOfMonth(timezone)) return;
            logInfo(`Running scheduled cleanup for tournament: ${name}`);
            try {
                await TournamentEngine.getInstance().runScheduledCleanup(tournamentId);
            } catch (error) {
                logError(`Scheduled cleanup failed for tournament ${name}:`, error);
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
