import { EmbedBuilder } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { Tournament, Game, TournamentMode, CadenceConfig, CleanupRule } from '../types/index.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { sendChannelMessage, sendChannelEmbed, getTournamentColor } from '../utils/discord.js';
import { IScoredClient } from './IScoredClient.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { emitGameRotated, emitPickerAssigned } from '../api/websocket.js';

export class TournamentEngine {
    private static instance: TournamentEngine;

    private constructor() {}

    public static getInstance(): TournamentEngine {
        if (!TournamentEngine.instance) {
            TournamentEngine.instance = new TournamentEngine();
        }
        return TournamentEngine.instance;
    }

    /**
     * Creates a new tournament in the database.
     */
    public async createTournament(name: string, type: string, mode: TournamentMode, cadence: CadenceConfig, guildId: string, channelId?: string, roleId?: string): Promise<Tournament> {
        const db = await getDatabase();
        const tournament: Tournament = {
            id: uuidv4(),
            name,
            type,
            mode,
            cadence,
            guildId,
            discordChannelId: channelId,
            discordRoleId: roleId,
            isActive: true
        };

        logInfo(`Creating new ${getTerminology(mode).tournament}: ${name} (${type})`);

        await db.run(
            'INSERT INTO tournaments (id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            tournament.id, tournament.name, tournament.type, JSON.stringify(tournament.cadence), tournament.guildId, tournament.discordChannelId, tournament.discordRoleId, tournament.isActive ? 1 : 0
        );

        return tournament;
    }

    /**
     * Activates a new game for a specific tournament immediately.
     * If completeExisting is true (default for /pick-game), marks existing ACTIVE games as COMPLETED.
     * If false (admin activate), allows multiple active games.
     */
    public async activateGame(tournamentId: string, gameName: string, styleId?: string, iscoredId?: string, completeExisting: boolean = true): Promise<Game> {
        const db = await getDatabase();
        const game: Game = {
            id: uuidv4(),
            tournamentId,
            name: gameName,
            iscoredId,
            styleId,
            status: 'ACTIVE',
            startDate: new Date()
        };

        logInfo(`Activating new game for tournament ${tournamentId}: ${gameName}`);

        if (completeExisting) {
            // Deactivate current active game for this tournament
            await db.run(
                'UPDATE games SET status = ?, end_date = ? WHERE tournament_id = ? AND status = ?',
                'COMPLETED', new Date().toISOString(), tournamentId, 'ACTIVE'
            );
        }

        // Insert the new game
        await db.run(
            'INSERT INTO games (id, tournament_id, name, iscored_id, style_id, status, start_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.iscoredId, game.styleId, game.status, game.startDate?.toISOString()
        );

        return game;
    }

    /**
     * Queues a game for a tournament (status = QUEUED, no start date).
     */
    public async queueGame(tournamentId: string, gameName: string, styleId?: string, iscoredId?: string): Promise<Game> {
        const db = await getDatabase();
        const game: Game = {
            id: uuidv4(),
            tournamentId,
            name: gameName,
            iscoredId,
            styleId,
            status: 'QUEUED',
        };

        logInfo(`Queuing game for tournament ${tournamentId}: ${gameName}`);

        await db.run(
            'INSERT INTO games (id, tournament_id, name, iscored_id, style_id, status) VALUES (?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.iscoredId, game.styleId, game.status
        );

        return game;
    }

    /**
     * Deactivates an active game — marks COMPLETED in DB.
     * Only locks on iScored if no other ACTIVE game shares the same iscored_id.
     * Scores/submissions are preserved.
     */
    public async deactivateGame(gameId: string, dbOnly: boolean = false): Promise<{ gameName: string; tournamentName: string }> {
        const db = await getDatabase();

        const row = await db.get(
            `SELECT g.*, t.name as tournament_name, t.type as tournament_type
             FROM games g JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ?`,
            gameId
        );
        if (!row) throw new Error('Game not found');
        if (row.status !== 'ACTIVE') throw new Error(`Game is not active (status: ${row.status})`);

        // Lock on iScored only if:
        // - Not dbOnly mode
        // - Game has an iScored ID
        // - No other ACTIVE game shares this iScored ID
        if (!dbOnly && row.iscored_id) {
            const otherActive = await db.get(
                `SELECT id FROM games WHERE iscored_id = ? AND status = 'ACTIVE' AND id != ?`,
                row.iscored_id, gameId
            );

            if (otherActive) {
                logInfo(`Skipping iScored lock — another active game shares iscored_id ${row.iscored_id}`);
            } else {
                const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
                if (hasCredentials) {
                    const client = new IScoredClient();
                    try {
                        await client.connect();
                        await client.setGameStatus(row.iscored_id, { locked: true });
                        logInfo(`Locked on iScored: ${row.name} (${row.iscored_id})`);
                    } catch (err) {
                        logError('Failed to lock game on iScored (continuing with DB update):', err);
                    } finally {
                        await client.disconnect();
                    }
                }
            }
        }

        // Mark COMPLETED in DB
        await db.run(
            'UPDATE games SET status = ?, end_date = ? WHERE id = ?',
            'COMPLETED', new Date().toISOString(), gameId
        );
        logInfo(`Deactivated game: ${row.name} (tournament: ${row.tournament_name})${dbOnly ? ' [DB only]' : ''}`);

        return { gameName: row.name, tournamentName: row.tournament_name };
    }

    /**
     * Retrieves the currently active game for a tournament (first one found).
     */
    public async getActiveGame(tournamentId: string): Promise<Game | null> {
        const games = await this.getActiveGames(tournamentId);
        return games[0] ?? null;
    }

    /**
     * Retrieves all currently active games for a tournament.
     */
    public async getActiveGames(tournamentId: string): Promise<Game[]> {
        const db = await getDatabase();
        const rows = await db.all('SELECT * FROM games WHERE tournament_id = ? AND status = ? ORDER BY start_date ASC', tournamentId, 'ACTIVE');

        return rows.map((row: any) => ({
            id: row.id,
            tournamentId: row.tournament_id,
            name: row.name,
            iscoredId: row.iscored_id,
            styleId: row.style_id,
            status: row.status as any,
            startDate: row.start_date ? new Date(row.start_date) : undefined,
            endDate: row.end_date ? new Date(row.end_date) : undefined,
        }));
    }

    /**
     * Checks if a game is eligible to be played based on a rolling lookback period.
     * Lookback days defaults to the GAME_ELIGIBILITY_DAYS setting (default 120).
     */
    public async isGameEligible(tournamentId: string, gameName: string, lookbackDays?: number): Promise<boolean> {
        const db = await getDatabase();

        // Read from configurable setting, fallback to parameter, then hardcoded default
        if (lookbackDays === undefined) {
            const setting = await db.get("SELECT value FROM settings WHERE key = 'GAME_ELIGIBILITY_DAYS'");
            lookbackDays = parseInt(setting?.value ?? '120', 10);
        }

        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
        const lookbackString = lookbackDate.toISOString();

        const row = await db.get<{ count: number }>(
            `SELECT COUNT(*) as count FROM games
             WHERE tournament_id = ?
             AND (name = ? OR name LIKE ? || ' %')
             AND start_date >= ?
             AND status != 'QUEUED'`,
            tournamentId, gameName, gameName, lookbackString
        );

        const count = row?.count ?? 0;

        if (count > 0) {
            logInfo(`Game '${gameName}' is NOT eligible (played within last ${lookbackDays} days).`);
            return false;
        }

        logInfo(`Game '${gameName}' is eligible.`);
        return true;
    }

    /**
     * Executes the full maintenance routine for a specific tournament.
     * Supports multi-slot tournaments (max_active_games > 1):
     * each active game is processed independently with its own winner and queued replacement.
     */
    public async runMaintenance(tournamentId: string): Promise<void> {
        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        if (!tournamentRow) throw new Error(`Tournament ${tournamentId} not found.`);

        const term = getTerminology(tournamentRow.mode);
        const channelId: string | undefined = tournamentRow.discord_channel_id || process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;

        logInfo(`Starting maintenance for ${term.tournament}: ${tournamentRow.name}`);

        // --- Gather all active games and queued games ---
        const activeGames = await this.getActiveGames(tournamentId);
        const queuedRows = await db.all(
            'SELECT * FROM games WHERE tournament_id = ? AND status = ? ORDER BY rowid ASC',
            tournamentId, 'QUEUED'
        );

        if (activeGames.length === 0 && queuedRows.length === 0) {
            logWarn(`No active or queued ${term.game} for ${term.tournament} "${tournamentRow.name}". Nothing to do.`);
            return;
        }

        const hasIscoredCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
        const hasPublicUrl = !!process.env.ISCORED_PUBLIC_URL;

        // Process each active game slot independently.
        // Each active game pairs with the next available queued game (FIFO).
        const queuedQueue = [...queuedRows]; // mutable copy to consume from

        // Open one iScored session for all operations
        let client: IScoredClient | null = null;
        if (hasIscoredCredentials) {
            client = new IScoredClient();
            try {
                await client.connect();
            } catch (err) {
                logError('Failed to connect iScored session for maintenance:', err);
                client = null;
            }
        }

        try {
            for (const activeGame of activeGames) {
                await this.processSlotMaintenance(
                    db, tournamentRow, activeGame, queuedQueue, client,
                    hasPublicUrl, term, channelId, tournamentId
                );
            }

            // If there are more queued games than active games (e.g. tournament was just
            // expanded to more slots), activate remaining queued games up to max_active_games.
            const maxSlots = tournamentRow.max_active_games ?? 1;
            const currentActive = await this.getActiveGames(tournamentId);
            let slotsAvailable = maxSlots - currentActive.length;

            while (slotsAvailable > 0 && queuedQueue.length > 0) {
                const queuedRow = queuedQueue.shift()!;
                // Skip placeholder picker slots
                if (queuedRow.name === '[Pending Pick]') continue;

                let newIscoredId: string | null = null;
                if (client && !queuedRow.iscored_id) {
                    try {
                        const libraryEntry = await db.get(
                            'SELECT style_id, css_title, css_initials, css_scores, css_box, bg_color FROM game_library WHERE name = ? COLLATE NOCASE',
                            queuedRow.name
                        );
                        const styleId = libraryEntry?.style_id || queuedRow.style_id || undefined;
                        newIscoredId = await client.createGame(queuedRow.name, styleId);
                        await client.setGameTags(newIscoredId, tournamentRow.type);
                        await client.setGameStatus(newIscoredId, { locked: false, hidden: false });
                        if (newIscoredId && libraryEntry && (libraryEntry.css_title || libraryEntry.css_box || libraryEntry.bg_color)) {
                            try { await client.applyStyle(newIscoredId, libraryEntry); } catch {}
                        }
                    } catch (err) {
                        logError(`Failed to create extra queued game on iScored: ${queuedRow.name}`, err);
                    }
                } else if (client && queuedRow.iscored_id) {
                    try { await client.setGameStatus(queuedRow.iscored_id, { locked: false, hidden: false }); } catch {}
                }

                const finalId = newIscoredId ?? queuedRow.iscored_id ?? null;
                await db.run(
                    'UPDATE games SET status = ?, start_date = ?, iscored_id = COALESCE(?, iscored_id) WHERE id = ?',
                    'ACTIVE', new Date().toISOString(), finalId, queuedRow.id
                );
                logInfo(`   -> Activated extra slot: ${queuedRow.name}`);

                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`Now Active: ${queuedRow.name}`)
                        .setDescription(`New ${term.game} slot opened for **${tournamentRow.name}**!`)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }

                slotsAvailable--;
            }
        } finally {
            if (client) {
                try { await client.disconnect(); } catch {}
            }
        }

        logInfo(`Maintenance complete for ${tournamentRow.name}`);

        // Reorder iScored lineup based on tournament display_order
        try {
            await this.reorderIScoredLineup();
        } catch (err) {
            logWarn('Failed to reorder iScored lineup after maintenance:', err);
        }

        // Run cleanup for 'immediate' and 'retain' modes
        let cleanupRule: CleanupRule = { mode: 'retain', count: 0 };
        try { cleanupRule = JSON.parse(tournamentRow.cleanup_rule || '{}'); } catch {}
        if (cleanupRule.mode === 'immediate' || cleanupRule.mode === 'retain') {
            try {
                await this.runCleanup(tournamentId, cleanupRule);
            } catch (err) {
                logWarn(`Failed to run cleanup for ${tournamentRow.name}:`, err);
            }
        }
    }

    /**
     * Processes maintenance for a single active game slot:
     * lock on iScored, scrape winner, complete, activate next queued, assign picker.
     */
    private async processSlotMaintenance(
        db: any,
        tournamentRow: any,
        activeGame: Game,
        queuedQueue: any[],
        client: IScoredClient | null,
        hasPublicUrl: boolean,
        term: ReturnType<typeof getTerminology>,
        channelId: string | undefined,
        tournamentId: string,
    ): Promise<void> {
        logInfo(`   Processing slot: ${activeGame.name}`);

        let winnerIscoredName: string | null = null;
        let winnerScore: number | null = null;

        // --- iScored work for this slot ---
        if (client) {
            // Lock the completed game
            if (activeGame.iscoredId) {
                try {
                    await client.setGameStatus(activeGame.iscoredId, { locked: true });
                    logInfo(`   -> Locked on iScored: ${activeGame.name}`);
                } catch (err) {
                    logError('   -> Failed to lock game on iScored (continuing):', err);
                }

                // Learn styles
                try {
                    const styles = await client.syncStyle(activeGame.iscoredId);
                    if (styles) {
                        const updated = await GameLibraryService.updateStyles(activeGame.name, styles);
                        if (updated) logInfo(`   -> Learned styles for ${activeGame.name}`);
                    }
                } catch (err) {
                    logWarn('   -> Failed to learn styles (continuing):', err);
                }

                // Scrape final standings
                if (hasPublicUrl) {
                    try {
                        const scores = await client.scrapePublicScores(process.env.ISCORED_PUBLIC_URL!, activeGame.iscoredId);
                        if (scores.length > 0) {
                            winnerIscoredName = scores[0].name;
                            const rawScore = String(scores[0].score).replace(/[^0-9]/g, '');
                            winnerScore = parseInt(rawScore, 10) || null;
                            logInfo(`   -> Top scorer: ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
                        } else {
                            logWarn('   -> No scores found on iScored for this game.');
                        }
                    } catch (err) {
                        logError('   -> Failed to scrape public scores (continuing):', err);
                    }
                }
            }
        }

        // --- Mark active game COMPLETED ---
        await db.run(
            'UPDATE games SET status = ?, end_date = ? WHERE id = ?',
            'COMPLETED', new Date().toISOString(), activeGame.id
        );
        logInfo(`   -> Marked COMPLETED in DB: ${activeGame.name}`);

        // Resolve winner
        let winnerId: string | null = null;
        if (winnerIscoredName) {
            const mapping = await db.get(
                'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
                winnerIscoredName
            );
            if (mapping?.discord_user_id) {
                winnerId = mapping.discord_user_id;
                logInfo(`   -> Winner Discord ID resolved: <@${winnerId}>`);
            } else {
                logWarn(`   -> Winner '${winnerIscoredName}' has no Discord mapping. Use /map-user to link them.`);
            }
        }

        // Announce completion
        if (channelId) {
            const color = getTournamentColor(tournamentRow.type);
            const embed = new EmbedBuilder()
                .setTitle(`${tournamentRow.name} — Rotation`)
                .setColor(color)
                .setTimestamp();

            const displayName = winnerId ? `<@${winnerId}>` : (winnerIscoredName ? `\`${winnerIscoredName}\`` : null);
            let desc = `**Closed:** ${activeGame.name}`;
            if (displayName) {
                desc += `\n**Winner:** ${displayName}`;
                if (winnerScore) desc += ` — **${winnerScore.toLocaleString()}**`;
            }
            embed.setDescription(desc);
            await sendChannelEmbed(channelId, embed);
        }

        // --- Activate the next queued game for this slot ---
        // Find the next non-placeholder queued game
        let queuedRow: any = null;
        while (queuedQueue.length > 0) {
            const candidate = queuedQueue.shift();
            if (candidate.name !== '[Pending Pick]') {
                queuedRow = candidate;
                break;
            }
            // Clean up orphaned picker slots
            await db.run('DELETE FROM games WHERE id = ?', candidate.id);
        }

        if (queuedRow) {
            let newIscoredId: string | null = null;

            // Handle iScored for the queued game
            if (client) {
                const libraryEntry = await db.get(
                    'SELECT style_id, css_title, css_initials, css_scores, css_box, bg_color FROM game_library WHERE name = ? COLLATE NOCASE',
                    queuedRow.name
                );

                if (!queuedRow.iscored_id) {
                    try {
                        const styleId = libraryEntry?.style_id || queuedRow.style_id || undefined;
                        newIscoredId = await client.createGame(queuedRow.name, styleId);
                        await client.setGameTags(newIscoredId, tournamentRow.type);
                        await client.setGameStatus(newIscoredId, { locked: false, hidden: false });
                        logInfo(`   -> Created on iScored: ${queuedRow.name} (ID: ${newIscoredId})`);

                        if (newIscoredId && libraryEntry && (libraryEntry.css_title || libraryEntry.css_box || libraryEntry.bg_color)) {
                            try { await client.applyStyle(newIscoredId, libraryEntry); } catch {}
                        }
                    } catch (err) {
                        logError('   -> Failed to create queued game on iScored (continuing):', err);
                    }
                } else {
                    try {
                        await client.setGameStatus(queuedRow.iscored_id, { locked: false, hidden: false });
                        logInfo(`   -> Unlocked on iScored: ${queuedRow.name}`);
                    } catch (err) {
                        logError('   -> Failed to unlock queued game on iScored (continuing):', err);
                    }
                }
            }

            const finalIscoredId = newIscoredId ?? queuedRow.iscored_id ?? null;
            await db.run(
                'UPDATE games SET status = ?, start_date = ?, iscored_id = COALESCE(?, iscored_id) WHERE id = ?',
                'ACTIVE', new Date().toISOString(), finalIscoredId, queuedRow.id
            );
            logInfo(`   -> Activated in DB: ${queuedRow.name}`);

            // Create picker slot for winner
            if (winnerId) {
                const winnerPickWindowMin = parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60', 10);
                const slotId = uuidv4();
                await db.run(
                    `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
                     VALUES (?, ?, ?, 'QUEUED', ?, 'WINNER', ?, 0, ?)`,
                    slotId, tournamentId, '[Pending Pick]', winnerId, new Date().toISOString(), activeGame.id
                );
                logInfo(`   -> Created picker slot for winner (pick window active).`);
            }

            // Announce new active game
            if (channelId) {
                const winnerPickWindowMin = parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60', 10);
                const color = getTournamentColor(tournamentRow.type);
                const embed = new EmbedBuilder()
                    .setTitle(`Now Active: ${queuedRow.name}`)
                    .setColor(color)
                    .setTimestamp();

                if (winnerId) {
                    embed.setDescription(`<@${winnerId}> — you won! You have **${winnerPickWindowMin} minutes** to use \`/pick-game\` to queue the next ${term.game}.`);
                } else if (winnerIscoredName) {
                    embed.setDescription(`**${winnerIscoredName}** — you won! Ask a moderator to link your iScored account with \`/map-user\`, then use \`/pick-game\`.`);
                } else {
                    embed.setDescription(`A moderator can use \`/nominate-picker\` to assign picking rights.`);
                }
                embed.setFooter({ text: tournamentRow.name });
                await sendChannelEmbed(channelId, embed);
            }

            emitGameRotated({
                tournamentName: tournamentRow.name,
                oldGame: activeGame.name,
                newGame: queuedRow.name,
            });

            if (winnerId) {
                emitPickerAssigned({
                    tournamentName: tournamentRow.name,
                    pickerName: winnerIscoredName || 'Unknown',
                    deadline: new Date(Date.now() + parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60') * 60000).toISOString(),
                });
            }
        } else {
            // No queued game — create picker slot for timeout tracking
            logInfo(`   -> No ${term.game} queued for this slot. Creating picker slot for timeout tracking.`);

            if (winnerId) {
                const winnerPickWindowMin = parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60', 10);
                const slotId = uuidv4();
                await db.run(
                    `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
                     VALUES (?, ?, ?, 'QUEUED', ?, 'WINNER', ?, 0, ?)`,
                    slotId, tournamentId, '[Pending Pick]', winnerId, new Date().toISOString(), activeGame.id
                );
                logInfo(`   -> Created picker slot for winner (pick window active).`);

                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`No ${term.game} Queued`)
                        .setDescription(`<@${winnerId}> — you won! Use \`/pick-game\` within **${winnerPickWindowMin} minutes** to select the next ${term.game}.`)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }

                emitPickerAssigned({
                    tournamentName: tournamentRow.name,
                    pickerName: winnerIscoredName || 'Unknown',
                    deadline: new Date(Date.now() + parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60') * 60000).toISOString(),
                });
            } else {
                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`No ${term.game} Queued`)
                        .setDescription(`A moderator should use \`/pick-game\` or \`/nominate-picker\`.`)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
            }
        }
    }

    /**
     * Hides completed games on iScored based on the tournament's cleanup rule.
     * - immediate / retain(0): hide all completed games
     * - retain(N): keep the N most recent completed games visible, hide the rest
     */
    public async runCleanup(tournamentId: string, rule?: CleanupRule): Promise<void> {
        const db = await getDatabase();

        if (!rule) {
            const row = await db.get('SELECT cleanup_rule FROM tournaments WHERE id = ?', tournamentId);
            try { rule = JSON.parse(row?.cleanup_rule || '{}'); } catch {}
            if (!rule || !rule.mode) rule = { mode: 'retain', count: 0 };
        }

        const retainCount = rule.mode === 'retain' ? rule.count : 0;

        // Get completed games with iScored IDs, newest first
        const completed = await db.all(`
            SELECT id, name, iscored_id FROM games
            WHERE tournament_id = ? AND status = 'COMPLETED' AND iscored_id IS NOT NULL
            ORDER BY end_date DESC
        `, tournamentId);

        // Keep the first `retainCount` visible, hide the rest
        const toHide = completed.slice(retainCount);
        if (toHide.length === 0) return;

        logInfo(`Cleanup for tournament ${tournamentId}: deleting ${toHide.length} completed game(s) from iScored`);

        const client = new IScoredClient();
        await client.connect();
        try {
            for (const game of toHide) {
                try {
                    await client.deleteGame(game.iscored_id, game.name);
                    await db.run('UPDATE games SET status = ? WHERE id = ?', 'HIDDEN', game.id);
                    logInfo(`   -> Deleted: ${game.name}`);
                } catch (err) {
                    logWarn(`   -> Failed to delete ${game.name}:`, err);
                }
            }
        } finally {
            await client.disconnect();
        }
    }

    /**
     * Runs scheduled cleanup for all tournaments with 'scheduled' cleanup_rule.
     * Called by the Scheduler on each tournament's cleanup cron.
     */
    public async runScheduledCleanup(tournamentId: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get('SELECT name, cleanup_rule FROM tournaments WHERE id = ?', tournamentId);
        if (!row) return;

        logInfo(`Running scheduled cleanup for ${row.name}`);

        // For scheduled mode, hide ALL completed games (full weekly/periodic wipe)
        await this.runCleanup(tournamentId, { mode: 'immediate' });
    }

    /**
     * Reorders the iScored lineup based on tournament display_order.
     * Within each tournament group: ACTIVE games first, then COMPLETED (locked).
     * Groups are sorted by tournament display_order, games within by start_date.
     * Unmanaged games (no tournament) remain at the bottom.
     */
    public async reorderIScoredLineup(): Promise<void> {
        const db = await getDatabase();

        // Get all managed games with iScored IDs, ordered by:
        // 1. Tournament display_order (lower = higher in lineup)
        // 2. Status priority (ACTIVE before COMPLETED)
        // 3. Start date (newest first within same status)
        const managedGames = await db.all(`
            SELECT g.iscored_id, g.status, t.display_order
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.status IN ('ACTIVE', 'COMPLETED') AND g.iscored_id IS NOT NULL
            ORDER BY
                t.display_order ASC,
                CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END ASC,
                g.start_date DESC
        `);

        if (managedGames.length === 0) return;

        const orderedIds = managedGames.map((g: any) => g.iscored_id);
        logInfo(`Reordering iScored lineup: ${orderedIds.length} managed games by display_order`);

        const client = new IScoredClient();
        await client.connect();
        try {
            await client.repositionLineup(orderedIds);
        } finally {
            await client.disconnect();
        }
    }
}
