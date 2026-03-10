import cron from 'node-cron';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { Tournament, CadenceConfig } from '../types/index.js';
import { TournamentEngine } from './TournamentEngine.js';
import { TimeoutManager } from './TimeoutManager.js';

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
        logInfo('⏰ Starting Scheduler...');
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
                isActive: row.is_active === 1
            };

            this.scheduleTournament(tournament);
        }

        // Run the timeout checker every minute to handle winner/runner-up pick windows
        this.startTimeoutChecker();
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
                logError('❌ Timeout checker error:', error);
            }
        }, { timezone });

        this.tasks.set('__timeout_checker__', task);
        logInfo('⏱️ Timeout checker started (every minute).');
    }

    /**
     * Schedules a maintenance task for a specific tournament.
     */
    public scheduleTournament(tournament: Tournament): void {
        const { id, name, cadence } = tournament;

        if (!cadence || !cadence.cron) {
            logInfo(`⚠️ Skipping scheduler for tournament ${name} (ID: ${id}) - No cadence configured.`);
            return;
        }

        // Stop existing task if it exists
        if (this.tasks.has(id)) {
            this.tasks.get(id)?.stop();
        }

        logInfo(`📅 Scheduling maintenance for ${name} using cron: '${cadence.cron}'`);

        const timezone = cadence.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
        const task = cron.schedule(cadence.cron, async () => {
            logInfo(`🔄 Running scheduled maintenance for tournament: ${name}`);
            try {
                await TournamentEngine.getInstance().runMaintenance(id);
            } catch (error) {
                logError(`❌ Maintenance failed for tournament ${name}:`, error);
            }
        }, { timezone });

        this.tasks.set(id, task);
    }

    /**
     * Stops all scheduled tasks.
     */
    public stop(): void {
        for (const task of this.tasks.values()) {
            task.stop();
        }
        this.tasks.clear();
        logInfo('🛑 Scheduler stopped.');
    }
}
