import cron from 'node-cron';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { Tournament, CadenceConfig } from '../types/index.js';
import { TournamentEngine } from './TournamentEngine.js';

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
     * Starts the scheduler and loads all active tournament tasks.
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
                cadence: JSON.parse(row.cadence || '{}'),
                discordChannelId: row.discord_channel_id,
                discordRoleId: row.discord_role_id,
                isActive: row.is_active === 1
            };

            this.scheduleTournament(tournament);
        }
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

        const timezone = process.env.BOT_TIMEZONE || 'America/Chicago';
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
