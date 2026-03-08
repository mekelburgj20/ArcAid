import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { Game } from '../types/index.js';
import { sendChannelMessage } from '../utils/discord.js';

export class TimeoutManager {
    private static instance: TimeoutManager;

    private constructor() {}

    public static getInstance(): TimeoutManager {
        if (!TimeoutManager.instance) {
            TimeoutManager.instance = new TimeoutManager();
        }
        return TimeoutManager.instance;
    }

    /**
     * Checks all QUEUED games for picker timeouts and handles pivots/auto-selections.
     */
    public async checkTimeouts(): Promise<void> {
        const db = await getDatabase();
        const term = getTerminology();
        
        try {
            // Find all queued games that have a designated picker
            const pendingGames = await db.all(`
                SELECT * FROM games 
                WHERE status = 'QUEUED' 
                AND picker_discord_id IS NOT NULL 
                AND picker_designated_at IS NOT NULL
            `);

            for (const row of pendingGames) {
                const game: Game = {
                    id: row.id,
                    tournamentId: row.tournament_id,
                    name: row.name,
                    status: row.status as any,
                    pickerDiscordId: row.picker_discord_id,
                    pickerType: row.picker_type as any,
                    pickerDesignatedAt: row.picker_designated_at ? new Date(row.picker_designated_at) : undefined,
                    reminderCount: row.reminder_count,
                    wonGameId: row.won_game_id
                };

                await this.handleTieredTimeout(game);
            }
        } catch (error) {
            logError('❌ Error checking picker timeouts:', error);
        }
    }

    private async handleTieredTimeout(game: Game): Promise<void> {
        if (!game.pickerDesignatedAt) return;

        const now = new Date();
        const elapsedMins = (now.getTime() - game.pickerDesignatedAt.getTime()) / (1000 * 60);
        const term = getTerminology();

        if (game.pickerType === 'WINNER') {
            // WINNER TIMEOUT: 60 mins
            if (elapsedMins >= 60) {
                logInfo(`⏰ Winner for ${term.tournament} (Game ID: ${game.id}) has timed out. Pivoting to Runner-Up...`);
                await this.pivotToRunnerUp(game);
            } else {
                const nextReminder = (game.reminderCount! + 1) * 15;
                if (elapsedMins >= nextReminder) {
                    await this.sendReminder(game, 60 - Math.floor(elapsedMins));
                }
            }
        } else if (game.pickerType === 'RUNNER_UP') {
            // RUNNER-UP TIMEOUT: 30 mins
            if (elapsedMins >= 30) {
                logInfo(`⏰ Runner-Up for ${term.tournament} (Game ID: ${game.id}) has timed out. Falling back to auto-selection...`);
                await this.fallbackToAutoSelection(game);
            } else {
                const nextReminder = (game.reminderCount! + 1) * 10;
                if (elapsedMins >= nextReminder) {
                    await this.sendReminder(game, 30 - Math.floor(elapsedMins));
                }
            }
        }
    }

    private async sendDiscordMessage(channelId: string, content: string): Promise<void> {
        await sendChannelMessage(channelId, content);
    }

    private async sendReminder(game: Game, minsRemaining: number): Promise<void> {
        const db = await getDatabase();
        try {
            const term = getTerminology();
            const message = `🔔 Reminder: <@${game.pickerDiscordId}> has ${minsRemaining} minutes left to pick the next ${term.game}.`;
            logInfo(message);
            
            const channelId = process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
            if (channelId) {
                await this.sendDiscordMessage(channelId, message);
            }

            await db.run(
                'UPDATE games SET reminder_count = reminder_count + 1 WHERE id = ?',
                game.id
            );
        } catch (error) {
            logError(`❌ Failed to send reminder for game ${game.id}:`, error);
        }
    }

    private async pivotToRunnerUp(game: Game): Promise<void> {
        const db = await getDatabase();
        try {
            if (!game.wonGameId) {
                logWarn(`⚠️ No won_game_id found for ${game.id}. Falling back to auto-selection.`);
                await this.fallbackToAutoSelection(game);
                return;
            }

            // Future: Fetch runner-up ID from submissions/history using wonGameId
            // For now, simulate fallback if runner-up isn't found
            logWarn(`⚠️ Runner-Up logic requires Identity Mapping (Phase 3). Falling back to auto-selection for now.`);
            
            const channelId = process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
            if (channelId) {
                await this.sendDiscordMessage(channelId, `⏰ The winner timed out! Pivoting to runner up for game ${game.id}... (Simulation)`);
            }

            await this.fallbackToAutoSelection(game);
            
        } catch (error) {
            logError(`❌ Failed to pivot to runner-up for game ${game.id}:`, error);
            await this.fallbackToAutoSelection(game);
        }
    }

    private async fallbackToAutoSelection(game: Game): Promise<void> {
        const db = await getDatabase();
        const term = getTerminology();
        
        try {
            logInfo(`🤖 Auto-selecting random eligible ${term.game} for ${game.tournamentId}...`);
            
            const channelId = process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
            if (channelId) {
                await this.sendDiscordMessage(channelId, `⏰ All pickers timed out! Falling back to auto-selection for ${game.tournamentId}.`);
            }

            // Future: Query a pool of available games, select one that is isGameEligible(), and activate it
            // For now, mark as failed picker
            await db.run(
                'UPDATE games SET picker_discord_id = NULL, picker_type = NULL WHERE id = ?',
                game.id
            );
            
        } catch (error) {
            logError(`❌ Auto-selection failed for game ${game.id}:`, error);
        }
    }
}
