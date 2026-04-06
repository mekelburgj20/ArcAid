import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { Tournament, Game, TournamentMode, CadenceConfig, CleanupRule } from '../types/index.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { sendChannelMessage, sendChannelEmbed, getTournamentColor, formatUserMention } from '../utils/discord.js';
import { IScoredClient } from './IScoredClient.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { emitGameRotated, emitPickerAssigned } from '../api/websocket.js';
import { RoomEventService } from '../services/RoomEventService.js';

export class TournamentEngine {
    private static instance: TournamentEngine;

    /** Per-tournament mutex to prevent concurrent maintenance on the same tournament */
    private maintenanceLocks: Map<string, Promise<void>> = new Map();

    private constructor() {}

    /** Check if iScored integration is enabled for a room. Defaults to true. */
    private async isIScoredEnabled(gameRoomId: string | null): Promise<boolean> {
        if (!gameRoomId) return true;
        const setting = await GameRoomSettingsService.get(gameRoomId, 'ISCORED_ENABLED');
        return setting !== 'false';
    }

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
            isActive: true,
            winnerPicks: true,
            autoPick: true,
            eligibilityDays: 120,
            winnerPickWindowMin: 60,
            runnerupPickWindowMin: 30,
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

        // Auto-apply default catalogue style and display_name from room's game library (if set)
        const tournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);
        if (tournament?.game_room_id) {
            const libraryEntry = await db.get(
                `SELECT catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled FROM game_room_game_library
                 WHERE game_room_id = ? AND game_name = ? AND (catalogue_style_id IS NOT NULL OR logo_style_id IS NOT NULL OR bg_style_id IS NOT NULL)`,
                tournament.game_room_id, gameName
            );
            if (libraryEntry) {
                await db.run(
                    'UPDATE games SET catalogue_style_id = ?, logo_style_id = ?, bg_style_id = ?, style_header_disabled = ? WHERE id = ?',
                    libraryEntry.catalogue_style_id, libraryEntry.logo_style_id, libraryEntry.bg_style_id, libraryEntry.style_header_disabled, game.id
                );
            }
            // Apply display_name from global library (exact match first, then prefix match for names with manufacturer suffix)
            const libGame = await db.get(
                'SELECT display_name FROM game_library WHERE name = ? COLLATE NOCASE',
                gameName
            ) || await db.get(
                'SELECT display_name FROM game_library WHERE ? LIKE name || \'%\' COLLATE NOCASE ORDER BY LENGTH(name) DESC LIMIT 1',
                gameName
            );
            if (libGame?.display_name) {
                await db.run('UPDATE games SET display_name = ? WHERE id = ?', libGame.display_name, game.id);
            }
        }

        return game;
    }

    /**
     * Queues a game for a tournament (status = QUEUED, no start date).
     */
    public async queueGame(tournamentId: string, gameName: string, styleId?: string, iscoredId?: string, pickerDiscordId?: string): Promise<Game> {
        const db = await getDatabase();

        // Get next queue_order for this tournament
        const maxRow = await db.get(
            'SELECT COALESCE(MAX(queue_order), 0) + 1 as next_order FROM games WHERE tournament_id = ? AND status = ?',
            tournamentId, 'QUEUED'
        );
        const queueOrder = maxRow?.next_order ?? 1;

        const game: Game = {
            id: uuidv4(),
            tournamentId,
            name: gameName,
            iscoredId,
            styleId,
            status: 'QUEUED',
            queueOrder,
        };

        logInfo(`Queuing game for tournament ${tournamentId}: ${gameName} (queue_order: ${queueOrder})`);

        await db.run(
            'INSERT INTO games (id, tournament_id, name, iscored_id, style_id, status, picker_discord_id, queue_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.iscoredId, game.styleId, game.status, pickerDiscordId || null, queueOrder
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
            `SELECT g.*, t.name as tournament_name, t.type as tournament_type, t.game_room_id
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
        // - iScored is enabled for this room
        const iscoredEnabled = await this.isIScoredEnabled(row.game_room_id);
        if (!dbOnly && row.iscored_id && iscoredEnabled) {
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
    public async isGameEligible(tournamentId: string, gameName: string, lookbackDaysParam?: number): Promise<boolean> {
        const db = await getDatabase();

        // Read from tournament column, fallback to parameter, then hardcoded default
        let lookbackDays: number;
        if (lookbackDaysParam !== undefined) {
            lookbackDays = lookbackDaysParam;
        } else {
            const tournament = await db.get('SELECT eligibility_days FROM tournaments WHERE id = ?', tournamentId);
            lookbackDays = tournament?.eligibility_days ?? 120;
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
     * Uses per-tournament mutex to prevent concurrent maintenance collisions.
     */
    public async runMaintenance(tournamentId: string): Promise<void> {
        // Per-tournament mutex: wait for any in-flight maintenance to complete
        const existing = this.maintenanceLocks.get(tournamentId);
        if (existing) {
            logWarn(`Maintenance already running for tournament ${tournamentId}, waiting...`);
            await existing;
        }

        const maintenancePromise = this.runMaintenanceInternal(tournamentId);
        this.maintenanceLocks.set(tournamentId, maintenancePromise);
        try {
            await maintenancePromise;
        } finally {
            this.maintenanceLocks.delete(tournamentId);
        }
    }

    private async runMaintenanceInternal(tournamentId: string): Promise<void> {
        // Pause score poller during maintenance to avoid conflicts
        const { ScoreSyncPoller } = await import('./ScoreSyncPoller.js');
        const poller = ScoreSyncPoller.getInstance();
        poller.pause();

        try {
            await this.runMaintenanceWork(tournamentId);
        } finally {
            poller.resume();
        }
    }

    private async runMaintenanceWork(tournamentId: string): Promise<void> {
        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        if (!tournamentRow) throw new Error(`Tournament ${tournamentId} not found.`);

        const term = getTerminology(tournamentRow.mode);
        const channelId: string | undefined = tournamentRow.discord_channel_id || process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;

        logInfo(`Starting maintenance for ${term.tournament}: ${tournamentRow.name}`);

        // --- Gather all active games and queued games ---
        const activeGames = await this.getActiveGames(tournamentId);
        const queuedRows = await db.all(
            'SELECT * FROM games WHERE tournament_id = ? AND status = ? ORDER BY queue_order ASC, rowid ASC',
            tournamentId, 'QUEUED'
        );

        if (activeGames.length === 0 && queuedRows.length === 0) {
            logWarn(`No active or queued ${term.game} for ${term.tournament} "${tournamentRow.name}". Nothing to do.`);
            return;
        }

        const iscoredEnabled = await this.isIScoredEnabled(tournamentRow.game_room_id);
        const hasIscoredCredentials = iscoredEnabled && !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
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

                // Cooldown revalidation — skip games that became ineligible while queued
                const stillEligible = await this.isGameEligible(tournamentId, queuedRow.name);
                if (!stillEligible) {
                    logWarn(`   -> Skipping queued game "${queuedRow.name}" — no longer eligible (cooldown). Removing from queue.`);
                    await db.run('DELETE FROM games WHERE id = ?', queuedRow.id);
                    continue;
                }

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

                // Get final standings — API preferred, Playwright fallback
                const useApi = process.env.ISCORED_API_ENABLED !== 'false';
                if (useApi && activeGame.iscoredId) {
                    try {
                        const { IScoredApiClient } = await import('./IScoredApiClient.js');
                        const apiClient = new IScoredApiClient();
                        const gameScores = await apiClient.getGameScores(activeGame.iscoredId, 1);
                        const topScore = gameScores.scores?.[0];
                        if (topScore) {
                            winnerIscoredName = topScore.name;
                            const rawScore = String(topScore.score).replace(/[^0-9]/g, '');
                            winnerScore = parseInt(rawScore, 10) || null;
                            logInfo(`   -> Top scorer (API): ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
                        } else {
                            logWarn('   -> No scores found on iScored API for this game.');
                        }
                    } catch (err) {
                        logError('   -> iScored API failed, trying Playwright fallback:', err);
                        // Fall through to Playwright
                        if (hasPublicUrl && client) {
                            try {
                                const scores = await client.scrapePublicScores(process.env.ISCORED_PUBLIC_URL!, activeGame.iscoredId!);
                                if (scores.length > 0) {
                                    winnerIscoredName = scores[0].name;
                                    const rawScore = String(scores[0].score).replace(/[^0-9]/g, '');
                                    winnerScore = parseInt(rawScore, 10) || null;
                                    logInfo(`   -> Top scorer (Playwright fallback): ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
                                }
                            } catch (err2) {
                                logError('   -> Playwright fallback also failed:', err2);
                            }
                        }
                    }
                } else if (hasPublicUrl && activeGame.iscoredId) {
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

        // --- Fallback: check ArcAid DB if iScored scraping found no winner ---
        if (!winnerIscoredName) {
            const topSubmission = await db.get(
                `SELECT iscored_username, score FROM submissions
                 WHERE game_id = ? ORDER BY score DESC LIMIT 1`,
                activeGame.id
            );
            if (topSubmission) {
                winnerIscoredName = topSubmission.iscored_username;
                winnerScore = topSubmission.score;
                logInfo(`   -> Winner from ArcAid DB: ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
            } else {
                logWarn('   -> No scores found in ArcAid DB either.');
            }
        }

        // --- Mark active game COMPLETED ---
        await db.run(
            'UPDATE games SET status = ?, end_date = ? WHERE id = ?',
            'COMPLETED', new Date().toISOString(), activeGame.id
        );
        logInfo(`   -> Marked COMPLETED in DB: ${activeGame.name}`);

        // Log tournament completion event
        if (tournamentRow.game_room_id) {
            RoomEventService.log(tournamentRow.game_room_id, 'tournament_completion', {
                tournamentName: tournamentRow.name,
            }).catch(() => {});
        }

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

            const displayName = winnerId ? await formatUserMention(winnerId, winnerIscoredName || 'Unknown', tournamentRow.game_room_id) : (winnerIscoredName ? `\`${winnerIscoredName}\`` : null);
            let desc = `**Closed:** ${activeGame.name}`;
            if (displayName) {
                desc += `\n**Winner:** ${displayName}`;
                if (winnerScore) desc += ` — **${winnerScore.toLocaleString()}**`;
            }
            embed.setDescription(desc);
            await sendChannelEmbed(channelId, embed);
        }

        // --- Activate the next queued game for this slot ---
        // Find the next non-placeholder, eligible queued game
        let queuedRow: any = null;
        while (queuedQueue.length > 0) {
            const candidate = queuedQueue.shift();
            if (candidate.name === '[Pending Pick]') {
                // Clean up orphaned picker slots
                await db.run('DELETE FROM games WHERE id = ?', candidate.id);
                continue;
            }
            // Cooldown revalidation — skip games that became ineligible while queued
            const stillEligible = await this.isGameEligible(tournamentId, candidate.name);
            if (!stillEligible) {
                logWarn(`   -> Skipping queued game "${candidate.name}" — no longer eligible (cooldown). Removing from queue.`);
                await db.run('DELETE FROM games WHERE id = ?', candidate.id);
                continue;
            }
            queuedRow = candidate;
            break;
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

            // Log game rotation event
            if (tournamentRow.game_room_id) {
                RoomEventService.log(tournamentRow.game_room_id, 'game_rotation', {
                    tournamentName: tournamentRow.name,
                    oldGame: activeGame.name,
                    newGame: queuedRow.name,
                }).catch(() => {});
            }

            // Queued game was activated — no picker slot needed (queue already had a game).
            // The winner can still use /pick-game to add more games to queue at any time.

            // Announce new active game
            if (channelId) {
                const color = getTournamentColor(tournamentRow.type);
                const embed = new EmbedBuilder()
                    .setTitle(`Now Active: ${queuedRow.name}`)
                    .setColor(color)
                    .setTimestamp();

                if (winnerId) {
                    const winnerMention = await formatUserMention(winnerId, winnerIscoredName || 'Unknown', tournamentRow.game_room_id);
                    embed.setDescription(`${winnerMention} — congrats on the win! **${queuedRow.name}** is now active from the queue.`);
                } else if (winnerIscoredName) {
                    embed.setDescription(`**${winnerIscoredName}** wins! **${queuedRow.name}** is now active from the queue.`);
                } else {
                    embed.setDescription(`**${queuedRow.name}** is now active from the queue.`);
                }
                embed.setFooter({ text: tournamentRow.name });
                await sendChannelEmbed(channelId, embed);
            }

            emitGameRotated({
                tournamentName: tournamentRow.name,
                oldGame: activeGame.name,
                newGame: queuedRow.name,
            });
        } else {
            // No queued game — behavior depends on winner_picks and auto_pick settings
            const winnerPicks = tournamentRow.winner_picks !== 0;
            const autoPick = tournamentRow.auto_pick !== 0;

            if (!winnerPicks && autoPick) {
                // Skip pick windows — immediately auto-select and activate
                logInfo(`   -> No ${term.game} queued. winner_picks=off, auto_pick=on — auto-selecting immediately.`);
                await this.autoPickAndActivate(db, tournamentRow, tournamentId, activeGame, client, term, channelId);
            } else if (winnerPicks && winnerId) {
                // Current behavior: give winner a pick window
                logInfo(`   -> No ${term.game} queued for this slot. Creating picker slot for timeout tracking.`);
                const winnerPickWindowMin = tournamentRow.winner_pick_window_min ?? 60;
                const slotId = uuidv4();
                await db.run(
                    `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
                     VALUES (?, ?, ?, 'QUEUED', ?, 'WINNER', ?, 0, ?)`,
                    slotId, tournamentId, '[Pending Pick]', winnerId, new Date().toISOString(), activeGame.id
                );
                logInfo(`   -> Created picker slot for winner (pick window active).`);

                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const winnerMention = await formatUserMention(winnerId, winnerIscoredName || 'Unknown', tournamentRow.game_room_id);
                    const embed = new EmbedBuilder()
                        .setTitle(`No ${term.game} Queued`)
                        .setDescription(`${winnerMention} — you won! Use \`/pick-game\` within **${winnerPickWindowMin} minutes** to select the next ${term.game}.`)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }

                emitPickerAssigned({
                    tournamentName: tournamentRow.name,
                    pickerName: winnerIscoredName || 'Unknown',
                    deadline: new Date(Date.now() + (tournamentRow.winner_pick_window_min ?? 60) * 60000).toISOString(),
                });
            } else if (!winnerPicks && !autoPick) {
                // Manual only — no pick windows, no auto-select
                logInfo(`   -> No ${term.game} queued. winner_picks=off, auto_pick=off — waiting for admin.`);
                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`No ${term.game} Queued`)
                        .setDescription(`Auto-pick is disabled. A moderator should use \`/pick-game\` to select the next ${term.game}.`)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
            } else {
                // winnerPicks=true but no winner found, or winnerPicks=true with auto_pick
                if (autoPick) {
                    logInfo(`   -> No ${term.game} queued and no winner found. auto_pick=on — auto-selecting.`);
                    await this.autoPickAndActivate(db, tournamentRow, tournamentId, activeGame, client, term, channelId);
                } else {
                    logInfo(`   -> No ${term.game} queued and no winner found. auto_pick=off — waiting for admin.`);
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
    }

    /**
     * Auto-select a random eligible game and immediately activate it.
     * Used when winner_picks is disabled or as a fallback when no winner exists.
     */
    private async autoPickAndActivate(
        db: any,
        tournamentRow: any,
        tournamentId: string,
        completedGame: Game,
        client: IScoredClient | null,
        term: ReturnType<typeof getTerminology>,
        channelId: string | undefined,
    ): Promise<void> {
        // Parse platform rules
        let platformRules = { required: [] as string[], excluded: [] as string[] };
        try { platformRules = { ...platformRules, ...JSON.parse(tournamentRow.platform_rules || '{}') }; } catch {}

        const eligibilityDays = tournamentRow.eligibility_days ?? 120;

        // Get room-curated library if room-scoped, otherwise global library
        let libraryGames: any[];
        if (tournamentRow.game_room_id) {
            libraryGames = await db.all(
                `SELECT gl.name, gl.style_id, gl.mode, gl.platforms
                 FROM game_library gl
                 INNER JOIN game_room_game_library grgl ON gl.name = grgl.game_name AND grgl.game_room_id = ?`,
                tournamentRow.game_room_id
            );
        } else {
            libraryGames = await db.all('SELECT name, style_id, mode, platforms FROM game_library');
        }

        // Filter by mode + platform rules
        const eligible = libraryGames.filter(g => {
            if (g.mode !== tournamentRow.mode) return false;
            let gamePlatforms: string[] = [];
            try { gamePlatforms = JSON.parse(g.platforms || '[]'); } catch {}
            const upperPlatforms = gamePlatforms.map((p: string) => p.toUpperCase());
            if (platformRules.required.length > 0) {
                if (!platformRules.required.some((rp: string) => upperPlatforms.includes(rp.toUpperCase()))) return false;
            }
            if (platformRules.excluded.length > 0) {
                if (platformRules.excluded.some((ep: string) => upperPlatforms.includes(ep.toUpperCase()))) return false;
            }
            return true;
        });

        // Filter by cooldown
        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - eligibilityDays);
        const recentlyPlayed = await db.all(
            `SELECT DISTINCT name FROM games
             WHERE tournament_id = ? AND start_date >= ? AND status != 'QUEUED'`,
            tournamentId, lookbackDate.toISOString()
        );
        const recentlyPlayedSet = new Set(recentlyPlayed.map((r: any) => r.name.toLowerCase()));
        const finalEligible = eligible.filter(g => !recentlyPlayedSet.has(g.name.toLowerCase()));

        if (finalEligible.length === 0) {
            logWarn(`No eligible ${term.games} found for auto-pick in ${tournamentRow.name}.`);
            if (channelId) {
                const color = getTournamentColor(tournamentRow.type);
                const embed = new EmbedBuilder()
                    .setTitle(`No Eligible ${term.games}`)
                    .setDescription(`No eligible ${term.games} were found for auto-pick in **${tournamentRow.name}**. A moderator must use \`/pick-game\`.`)
                    .setColor(color)
                    .setFooter({ text: tournamentRow.name })
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }
            return;
        }

        // Pick one at random
        const pick = finalEligible[Math.floor(Math.random() * finalEligible.length)]!;
        logInfo(`   -> Auto-picked: ${pick.name} for ${tournamentRow.name}`);

        // Create on iScored if client available
        let iscoredId: string | null = null;
        if (client) {
            const libraryEntry = await db.get(
                'SELECT style_id, css_title, css_initials, css_scores, css_box, bg_color FROM game_library WHERE name = ? COLLATE NOCASE',
                pick.name
            );
            try {
                const styleId = libraryEntry?.style_id || pick.style_id || undefined;
                iscoredId = await client.createGame(pick.name, styleId);
                await client.setGameTags(iscoredId, tournamentRow.type);
                await client.setGameStatus(iscoredId, { locked: false, hidden: false });
                logInfo(`   -> Created on iScored: ${pick.name} (ID: ${iscoredId})`);
                if (iscoredId && libraryEntry && (libraryEntry.css_title || libraryEntry.css_box || libraryEntry.bg_color)) {
                    try { await client.applyStyle(iscoredId, libraryEntry); } catch {}
                }
            } catch (err) {
                logError('   -> Failed to create auto-picked game on iScored (continuing):', err);
            }
        }

        // Create game record as ACTIVE immediately
        const gameId = uuidv4();
        // Propagate display_name and style defaults from library
        const libRow = await db.get('SELECT display_name FROM game_library WHERE name = ? COLLATE NOCASE', pick.name);
        let catalogueStyleId: string | null = null;
        let logoStyleId: string | null = null;
        let bgStyleId: string | null = null;
        if (tournamentRow.game_room_id) {
            const libStyle = await db.get(
                'SELECT catalogue_style_id, logo_style_id, bg_style_id FROM game_room_game_library WHERE game_room_id = ? AND game_name = ?',
                tournamentRow.game_room_id, pick.name
            );
            if (libStyle) {
                catalogueStyleId = libStyle.catalogue_style_id;
                logoStyleId = libStyle.logo_style_id;
                bgStyleId = libStyle.bg_style_id;
            }
        }

        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, iscored_id, style_id, display_name, catalogue_style_id, logo_style_id, bg_style_id)
             VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
            gameId, tournamentId, pick.name, new Date().toISOString(),
            iscoredId, pick.style_id || null,
            libRow?.display_name || null,
            catalogueStyleId, logoStyleId, bgStyleId
        );
        logInfo(`   -> Activated in DB: ${pick.name}`);

        // Log game rotation event
        if (tournamentRow.game_room_id) {
            RoomEventService.log(tournamentRow.game_room_id, 'game_rotation', {
                tournamentName: tournamentRow.name,
                oldGame: completedGame.name,
                newGame: pick.name,
            }).catch(() => {});
        }

        // Announce
        if (channelId) {
            const color = getTournamentColor(tournamentRow.type);
            const embed = new EmbedBuilder()
                .setTitle(`Now Active: ${pick.name}`)
                .setDescription(`**${pick.name}** has been auto-selected and activated for **${tournamentRow.name}**.`)
                .setColor(color)
                .setFooter({ text: tournamentRow.name })
                .setTimestamp();
            await sendChannelEmbed(channelId, embed);
        }

        emitGameRotated({
            tournamentName: tournamentRow.name,
            oldGame: completedGame.name,
            newGame: pick.name,
        });
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

        // Check if iScored is enabled for this tournament's room
        const tournamentRow = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);
        const iscoredEnabled = await this.isIScoredEnabled(tournamentRow?.game_room_id);

        if (iscoredEnabled) {
            logInfo(`Cleanup for tournament ${tournamentId}: deleting ${toHide.length} completed game(s) from iScored`);
            const client = new IScoredClient();
            await client.connect();
            try {
                for (const game of toHide) {
                    try {
                        await client.deleteGame(game.iscored_id, game.name);
                        logInfo(`   -> Deleted from iScored: ${game.name}`);
                    } catch (err) {
                        logWarn(`   -> Failed to delete ${game.name} from iScored:`, err);
                    }
                }
            } finally {
                await client.disconnect();
            }
        } else {
            logInfo(`Cleanup for tournament ${tournamentId}: marking ${toHide.length} completed game(s) as HIDDEN (iScored disabled)`);
        }

        // Always mark as HIDDEN in DB regardless of iScored
        const roomId = tournamentRow?.game_room_id;
        for (const game of toHide) {
            await db.run('UPDATE games SET status = ? WHERE id = ?', 'HIDDEN', game.id);

            // Clean up score photos for this game
            if (roomId) {
                try {
                    const photoRows = await db.all(`
                        SELECT photo_url FROM score_history
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                        UNION
                        SELECT photo_url FROM community_scores
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                    `, game.name, roomId, game.name, roomId);

                    for (const row of photoRows) {
                        const relativePath = (row.photo_url as string).replace('/api/score-photos/', '');
                        const filePath = path.join(process.cwd(), 'data', 'score-photos', relativePath);
                        try { fs.unlinkSync(filePath); } catch {}
                    }

                    // Null out photo_url in DB to prevent broken image links
                    await db.run(`
                        UPDATE score_history SET photo_url = NULL
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                    `, game.name, roomId);
                    await db.run(`
                        UPDATE community_scores SET photo_url = NULL
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                    `, game.name, roomId);

                    if (photoRows.length > 0) {
                        logInfo(`   -> Cleaned up ${photoRows.length} score photo(s) for ${game.name}`);
                    }
                } catch (err) {
                    logWarn(`   -> Failed to clean up score photos for ${game.name}:`, err);
                }
            }
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
