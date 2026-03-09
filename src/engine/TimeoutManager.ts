import { EmbedBuilder } from 'discord.js';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { Game } from '../types/index.js';
import { sendChannelMessage, sendChannelEmbed, getTournamentColor } from '../utils/discord.js';
import { TournamentEngine } from './TournamentEngine.js';
import { IScoredClient } from './IScoredClient.js';
import { v4 as uuidv4 } from 'uuid';

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
     * Called periodically by the Scheduler (every minute).
     */
    public async checkTimeouts(): Promise<void> {
        const db = await getDatabase();

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
                    reminderCount: row.reminder_count ?? 0,
                    wonGameId: row.won_game_id
                };

                await this.handleTieredTimeout(game);
            }
        } catch (error) {
            logError('❌ Error checking picker timeouts:', error);
        }
    }

    /**
     * Resolves the announcement channel for a tournament.
     * Uses the tournament's discord_channel_id, falling back to the global env var.
     */
    private async getChannelId(tournamentId: string | undefined): Promise<string | undefined> {
        if (!tournamentId) return process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;

        const db = await getDatabase();
        const row = await db.get('SELECT discord_channel_id FROM tournaments WHERE id = ?', tournamentId);
        return row?.discord_channel_id || process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
    }

    private async handleTieredTimeout(game: Game): Promise<void> {
        if (!game.pickerDesignatedAt) return;

        const db = await getDatabase();
        const now = new Date();
        const elapsedMins = (now.getTime() - game.pickerDesignatedAt.getTime()) / (1000 * 60);

        // Read configurable timeout windows from settings
        const winnerWindowRow = await db.get("SELECT value FROM settings WHERE key = 'WINNER_PICK_WINDOW_MIN'");
        const runnerUpWindowRow = await db.get("SELECT value FROM settings WHERE key = 'RUNNERUP_PICK_WINDOW_MIN'");
        const winnerWindowMin = parseInt(winnerWindowRow?.value ?? '60', 10);
        const runnerUpWindowMin = parseInt(runnerUpWindowRow?.value ?? '30', 10);

        if (game.pickerType === 'WINNER') {
            if (elapsedMins >= winnerWindowMin) {
                logInfo(`⏰ Winner for game slot ${game.id} timed out after ${winnerWindowMin}min. Pivoting to runner-up...`);
                await this.pivotToRunnerUp(game);
            } else {
                // Send reminders at 15-minute intervals
                const reminderInterval = 15;
                const nextReminderAt = ((game.reminderCount ?? 0) + 1) * reminderInterval;
                if (elapsedMins >= nextReminderAt) {
                    await this.sendReminder(game, winnerWindowMin - Math.floor(elapsedMins));
                }
            }
        } else if (game.pickerType === 'RUNNER_UP') {
            if (elapsedMins >= runnerUpWindowMin) {
                logInfo(`⏰ Runner-up for game slot ${game.id} timed out after ${runnerUpWindowMin}min. Auto-selecting...`);
                await this.fallbackToAutoSelection(game);
            } else {
                // Send reminders at 10-minute intervals
                const reminderInterval = 10;
                const nextReminderAt = ((game.reminderCount ?? 0) + 1) * reminderInterval;
                if (elapsedMins >= nextReminderAt) {
                    await this.sendReminder(game, runnerUpWindowMin - Math.floor(elapsedMins));
                }
            }
        }
    }

    /** Resolves the tournament type for embed coloring. */
    private async getTournamentType(tournamentId: string | undefined): Promise<string | null> {
        if (!tournamentId) return null;
        const db = await getDatabase();
        const row = await db.get('SELECT type FROM tournaments WHERE id = ?', tournamentId);
        return row?.type ?? null;
    }

    private async sendReminder(game: Game, minsRemaining: number): Promise<void> {
        const db = await getDatabase();
        try {
            const term = getTerminology();
            const channelId = await this.getChannelId(game.tournamentId);
            logInfo(`🔔 Reminder for <@${game.pickerDiscordId}>: ${minsRemaining} minutes left.`);

            if (channelId) {
                const color = getTournamentColor(await this.getTournamentType(game.tournamentId));
                const embed = new EmbedBuilder()
                    .setTitle(`🔔 Pick Reminder`)
                    .setDescription(`<@${game.pickerDiscordId}>, you have **${minsRemaining} minutes** left to pick the next ${term.game}. Use \`/pick-game\` now!`)
                    .setColor(color)
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }

            await db.run(
                'UPDATE games SET reminder_count = reminder_count + 1 WHERE id = ?',
                game.id
            );
        } catch (error) {
            logError(`❌ Failed to send reminder for game ${game.id}:`, error);
        }
    }

    /**
     * Winner timed out — find the runner-up from the completed game's submissions
     * and assign them picking rights.
     */
    private async pivotToRunnerUp(game: Game): Promise<void> {
        const db = await getDatabase();
        const term = getTerminology();

        try {
            if (!game.wonGameId) {
                logWarn(`⚠️ No won_game_id on slot ${game.id}. Cannot determine runner-up. Falling back to auto-select.`);
                await this.fallbackToAutoSelection(game);
                return;
            }

            // Query the 2nd highest scorer from the completed game's submissions
            const runnerUpRow = await db.get(
                `SELECT s.iscored_username, um.discord_user_id
                 FROM submissions s
                 LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
                 WHERE s.game_id = ?
                 ORDER BY s.score DESC
                 LIMIT 1 OFFSET 1`,
                game.wonGameId
            );

            if (!runnerUpRow?.discord_user_id) {
                // No mapped runner-up found — try scraping if we have public URL
                if (runnerUpRow?.iscored_username) {
                    logWarn(`⚠️ Runner-up '${runnerUpRow.iscored_username}' has no Discord mapping. Falling back to auto-select.`);
                } else {
                    logWarn(`⚠️ No runner-up found in submissions for game ${game.wonGameId}. Falling back to auto-select.`);
                }

                const channelId = await this.getChannelId(game.tournamentId);
                if (channelId) {
                    const color = getTournamentColor(await this.getTournamentType(game.tournamentId));
                    const embed = new EmbedBuilder()
                        .setTitle(`⏰ Winner Timed Out`)
                        .setDescription(`No eligible runner-up was found. Auto-selecting a ${term.game}...`)
                        .setColor(color)
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
                await this.fallbackToAutoSelection(game);
                return;
            }

            const runnerUpId = runnerUpRow.discord_user_id;
            logInfo(`   -> Pivoting to runner-up: <@${runnerUpId}> (${runnerUpRow.iscored_username})`);

            // Reassign the QUEUED slot to the runner-up
            const runnerUpWindowMin = parseInt(
                (await db.get("SELECT value FROM settings WHERE key = 'RUNNERUP_PICK_WINDOW_MIN'"))?.value ?? '30', 10
            );

            await db.run(
                `UPDATE games
                 SET picker_discord_id = ?, picker_type = 'RUNNER_UP', picker_designated_at = ?, reminder_count = 0
                 WHERE id = ?`,
                runnerUpId, new Date().toISOString(), game.id
            );

            const channelId = await this.getChannelId(game.tournamentId);
            if (channelId) {
                const color = getTournamentColor(await this.getTournamentType(game.tournamentId));
                const embed = new EmbedBuilder()
                    .setTitle(`⏰ Winner Timed Out`)
                    .setDescription(`<@${runnerUpId}> — as the runner-up, you now have **${runnerUpWindowMin} minutes** to pick the next ${term.game}. Use \`/pick-game\`!`)
                    .setColor(color)
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }

        } catch (error) {
            logError(`❌ Failed to pivot to runner-up for slot ${game.id}:`, error);
            await this.fallbackToAutoSelection(game);
        }
    }

    /**
     * All pickers timed out — select a random eligible game from the game_library,
     * create it on iScored, and fill the QUEUED slot.
     */
    private async fallbackToAutoSelection(game: Game): Promise<void> {
        const db = await getDatabase();
        const term = getTerminology();

        try {
            if (!game.tournamentId) {
                logError(`❌ Cannot auto-select: no tournament_id on game slot ${game.id}.`);
                return;
            }

            const engine = TournamentEngine.getInstance();

            // Get the tournament's type tag to filter eligible games
            const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', game.tournamentId);
            if (!tournament) {
                logError(`❌ Cannot auto-select: tournament ${game.tournamentId} not found.`);
                return;
            }

            // Read eligibility lookback from settings
            const eligibilityRow = await db.get("SELECT value FROM settings WHERE key = 'GAME_ELIGIBILITY_DAYS'");
            const eligibilityDays = parseInt(eligibilityRow?.value ?? '120', 10);

            // Get all games from the library that match the tournament type
            const libraryGames = await db.all('SELECT name, style_id, tournament_types FROM game_library');
            const typeMatches = libraryGames.filter(g => {
                if (!g.tournament_types) return true; // no type restriction = eligible for all
                const types = g.tournament_types.split(',').map((t: string) => t.trim().toUpperCase());
                // Also try parsing as JSON array
                try {
                    const parsed = JSON.parse(g.tournament_types);
                    if (Array.isArray(parsed)) {
                        return parsed.map((t: string) => t.toUpperCase()).includes(tournament.type.toUpperCase());
                    }
                } catch { /* not JSON, use comma-split above */ }
                return types.includes(tournament.type.toUpperCase());
            });

            // Filter by eligibility (not played within lookback period)
            const eligible: typeof typeMatches = [];
            for (const g of typeMatches) {
                const isEligible = await engine.isGameEligible(game.tournamentId, g.name, eligibilityDays);
                if (isEligible) eligible.push(g);
            }

            if (eligible.length === 0) {
                logWarn(`⚠️ No eligible ${term.games} found for auto-selection in ${tournament.name}.`);
                await db.run(
                    'UPDATE games SET picker_discord_id = NULL, picker_type = NULL, picker_designated_at = NULL WHERE id = ?',
                    game.id
                );
                const channelId = await this.getChannelId(game.tournamentId);
                if (channelId) {
                    const color = getTournamentColor(tournament.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`⚠️ No Eligible ${term.games}`)
                        .setDescription(`All pickers timed out and no eligible ${term.games} were found for **${tournament.name}**. A moderator must use \`/pick-game\` or \`/pause-pick\`.`)
                        .setColor(color)
                        .setFooter({ text: tournament.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
                return;
            }

            // Pick one at random
            const pick = eligible[Math.floor(Math.random() * eligible.length)]!;
            logInfo(`🎲 Auto-selected: ${pick.name} for ${tournament.name}`);

            // Create on iScored if credentials are available
            let iscoredId: string | null = null;
            const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);

            if (hasCredentials) {
                const client = new IScoredClient();
                try {
                    await client.connect();
                    iscoredId = await client.createGame(pick.name, pick.style_id || undefined);
                    await client.setGameTags(iscoredId, tournament.type);
                    await client.setGameStatus(iscoredId, { locked: false, hidden: false });
                    logInfo(`   -> Created on iScored: ${pick.name} (ID: ${iscoredId})`);
                } catch (err) {
                    logError('   -> Failed to create auto-selected game on iScored:', err);
                } finally {
                    await client.disconnect();
                }
            }

            // Update the QUEUED slot with the selected game details
            await db.run(
                `UPDATE games
                 SET name = ?, style_id = ?, iscored_id = ?,
                     picker_discord_id = NULL, picker_type = NULL, picker_designated_at = NULL, reminder_count = 0
                 WHERE id = ?`,
                pick.name, pick.style_id || null, iscoredId, game.id
            );
            logInfo(`   -> Updated QUEUED slot ${game.id} with: ${pick.name}`);

            const channelId = await this.getChannelId(game.tournamentId);
            if (channelId) {
                const color = getTournamentColor(tournament.type);
                const embed = new EmbedBuilder()
                    .setTitle(`🎲 Auto-Selected: ${pick.name}`)
                    .setDescription(`All pickers timed out! **${pick.name}** has been auto-selected as the next ${term.game} for **${tournament.name}**.`)
                    .setColor(color)
                    .setFooter({ text: tournament.name })
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }

        } catch (error) {
            logError(`❌ Auto-selection failed for slot ${game.id}:`, error);
            // Last resort: clear picker so the slot doesn't loop forever
            await db.run(
                'UPDATE games SET picker_discord_id = NULL, picker_type = NULL, picker_designated_at = NULL WHERE id = ?',
                game.id
            ).catch(() => {});
        }
    }
}
