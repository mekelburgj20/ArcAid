import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { Tournament, Game, TournamentType, CadenceConfig } from '../types/index.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { sendChannelMessage } from '../utils/discord.js';
import { IScoredClient } from './IScoredClient.js';
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
    public async createTournament(name: string, type: TournamentType, cadence: CadenceConfig, guildId: string, channelId?: string, roleId?: string): Promise<Tournament> {
        const db = await getDatabase();
        const tournament: Tournament = {
            id: uuidv4(),
            name,
            type,
            cadence,
            guildId,
            discordChannelId: channelId,
            discordRoleId: roleId,
            isActive: true
        };

        logInfo(`Creating new ${getTerminology().tournament}: ${name} (${type})`);

        await db.run(
            'INSERT INTO tournaments (id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            tournament.id, tournament.name, tournament.type, JSON.stringify(tournament.cadence), tournament.guildId, tournament.discordChannelId, tournament.discordRoleId, tournament.isActive ? 1 : 0
        );

        return tournament;
    }

    /**
     * Activates a new game for a specific tournament immediately (used by /pick-game).
     */
    public async activateGame(tournamentId: string, gameName: string, styleId?: string, iscoredId?: string): Promise<Game> {
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

        logInfo(`Activating new ${getTerminology().game} for tournament ${tournamentId}: ${gameName}`);

        // 1. Deactivate current active game for this tournament
        await db.run(
            'UPDATE games SET status = ?, end_date = ? WHERE tournament_id = ? AND status = ?',
            'COMPLETED', new Date().toISOString(), tournamentId, 'ACTIVE'
        );

        // 2. Insert the new game
        await db.run(
            'INSERT INTO games (id, tournament_id, name, iscored_id, style_id, status, start_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.iscoredId, game.styleId, game.status, game.startDate?.toISOString()
        );

        return game;
    }

    /**
     * Retrieves the currently active game for a tournament.
     */
    public async getActiveGame(tournamentId: string): Promise<Game | null> {
        const db = await getDatabase();
        const row = await db.get('SELECT * FROM games WHERE tournament_id = ? AND status = ?', tournamentId, 'ACTIVE');

        if (!row) return null;

        return {
            id: row.id,
            tournamentId: row.tournament_id,
            name: row.name,
            iscoredId: row.iscored_id,
            styleId: row.style_id,
            status: row.status as any,
            startDate: row.start_date ? new Date(row.start_date) : undefined,
            endDate: row.end_date ? new Date(row.end_date) : undefined
        };
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
            logInfo(`🚫 ${getTerminology().game} '${gameName}' is NOT eligible (played within last ${lookbackDays} days).`);
            return false;
        }

        logInfo(`✅ ${getTerminology().game} '${gameName}' is eligible.`);
        return true;
    }

    /**
     * Executes the full maintenance routine for a specific tournament:
     * 1. Lock the active game on iScored and scrape the final winner.
     * 2. Mark the active game COMPLETED in the database.
     * 3. Announce the winner to the tournament's Discord channel.
     * 4. Activate the next QUEUED game (on iScored + in DB).
     * 5. Assign picking rights to the winner for the following slot.
     * 6. Announce the new active game and the winner's pick window.
     */
    public async runMaintenance(tournamentId: string): Promise<void> {
        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        if (!tournamentRow) throw new Error(`Tournament ${tournamentId} not found.`);

        const term = getTerminology();
        const channelId: string | undefined = tournamentRow.discord_channel_id || process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;

        logInfo(`⚙️ Starting maintenance for ${term.tournament}: ${tournamentRow.name}`);

        // --- Phase 1: Gather what we need from the DB ---
        const activeGame = await this.getActiveGame(tournamentId);
        const queuedRow = await db.get(
            'SELECT * FROM games WHERE tournament_id = ? AND status = ? ORDER BY rowid ASC LIMIT 1',
            tournamentId, 'QUEUED'
        );

        if (!activeGame && !queuedRow) {
            logWarn(`⚠️ No active or queued ${term.game} for ${term.tournament} "${tournamentRow.name}". Nothing to do.`);
            return;
        }

        // --- Phase 2: iScored work (one session for all operations) ---
        let winnerIscoredName: string | null = null;
        let winnerScore: number | null = null;
        let newIscoredId: string | null = null;

        const hasIscoredCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
        const hasPublicUrl = !!process.env.ISCORED_PUBLIC_URL;
        const needsIscoredSession = hasIscoredCredentials && (
            (activeGame?.iscoredId) ||
            (queuedRow && !queuedRow.iscored_id) ||
            (queuedRow?.iscored_id)
        );

        if (needsIscoredSession) {
            const client = new IScoredClient();
            try {
                await client.connect();

                // 2a. Lock the completed game on iScored
                if (activeGame?.iscoredId) {
                    try {
                        await client.setGameStatus(activeGame.iscoredId, { locked: true });
                        logInfo(`   -> Locked on iScored: ${activeGame.name}`);
                    } catch (err) {
                        logError('   -> Failed to lock game on iScored (continuing):', err);
                    }
                }

                // 2b. Scrape final standings to determine the winner
                if (activeGame?.iscoredId && hasPublicUrl) {
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

                // 2c. Handle the queued game on iScored
                if (queuedRow) {
                    if (!queuedRow.iscored_id) {
                        // Pre-injected via /pause-pick without an iScored game — create it now
                        try {
                            const styleId = queuedRow.style_id || undefined;
                            newIscoredId = await client.createGame(queuedRow.name, styleId);
                            await client.setGameTags(newIscoredId, tournamentRow.type);
                            await client.setGameStatus(newIscoredId, { locked: false, hidden: false });
                            logInfo(`   -> Created on iScored: ${queuedRow.name} (ID: ${newIscoredId})`);
                        } catch (err) {
                            logError('   -> Failed to create queued game on iScored (continuing):', err);
                        }
                    } else {
                        // Already exists on iScored — just unlock it
                        try {
                            await client.setGameStatus(queuedRow.iscored_id, { locked: false, hidden: false });
                            logInfo(`   -> Unlocked on iScored: ${queuedRow.name}`);
                        } catch (err) {
                            logError('   -> Failed to unlock queued game on iScored (continuing):', err);
                        }
                    }
                }

            } catch (err) {
                logError('❌ iScored session error during maintenance:', err);
            } finally {
                await client.disconnect();
            }
        } else if (!hasIscoredCredentials) {
            logWarn('   -> Skipping iScored operations: credentials not configured.');
        }

        // --- Phase 3: Mark active game COMPLETED in DB ---
        let winnerId: string | null = null;

        if (activeGame) {
            await db.run(
                'UPDATE games SET status = ?, end_date = ? WHERE id = ?',
                'COMPLETED', new Date().toISOString(), activeGame.id
            );
            logInfo(`   -> Marked COMPLETED in DB: ${activeGame.name}`);

            // Resolve winner's iScored name to a Discord user ID
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

            // Send completion announcement
            if (channelId) {
                let msg = `**${tournamentRow.name} — Rotation**\n\n`;
                msg += `**Closed:** ${activeGame.name}\n`;
                if (winnerIscoredName) {
                    const displayName = winnerId ? `<@${winnerId}>` : `\`${winnerIscoredName}\``;
                    msg += `**Winner:** ${displayName}`;
                    if (winnerScore) msg += ` — **${winnerScore.toLocaleString()}**`;
                    msg += '\n';
                }
                await sendChannelMessage(channelId, msg);
            }
        }

        // --- Phase 4: Activate the queued game ---
        if (queuedRow) {
            const finalIscoredId = newIscoredId ?? queuedRow.iscored_id ?? null;

            await db.run(
                'UPDATE games SET status = ?, start_date = ?, iscored_id = COALESCE(?, iscored_id) WHERE id = ?',
                'ACTIVE', new Date().toISOString(), finalIscoredId, queuedRow.id
            );
            logInfo(`   -> Activated in DB: ${queuedRow.name}`);

            // Create a new QUEUED placeholder slot so the winner can queue the next game
            // and TimeoutManager can track the pick window.
            if (winnerId) {
                const winnerPickWindowMin = parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60', 10);
                const slotId = uuidv4();
                await db.run(
                    `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id)
                     VALUES (?, ?, ?, 'QUEUED', ?, 'WINNER', ?, 0, ?)`,
                    slotId, tournamentId, '[Pending Pick]', winnerId, new Date().toISOString(), activeGame?.id ?? null
                );
                logInfo(`   -> Created picker slot for winner (${winnerPickWindowMin}min window).`);
            }

            // Announce new active game
            if (channelId) {
                const winnerPickWindowMin = parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60', 10);
                let msg = `**Now Active:** ${queuedRow.name}\n`;
                if (winnerId) {
                    msg += `\n<@${winnerId}> — you won! You have **${winnerPickWindowMin} minutes** to use \`/pick-game\` to queue the next ${term.game}.`;
                } else if (winnerIscoredName) {
                    msg += `\n**${winnerIscoredName}** — you won! Ask a moderator to link your iScored account with \`/map-user\`, then use \`/pick-game\`.`;
                } else {
                    msg += `\nA moderator can use \`/nominate-picker\` to assign picking rights.`;
                }
                await sendChannelMessage(channelId, msg);
            }

            emitGameRotated({
                tournamentName: tournamentRow.name,
                oldGame: activeGame ? activeGame.name : '[None]',
                newGame: queuedRow.name,
            });

            if (winnerId) {
                const winnerUsername = winnerIscoredName || 'Unknown';
                emitPickerAssigned({
                    tournamentName: tournamentRow.name,
                    pickerName: winnerUsername,
                    deadline: new Date(Date.now() + parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60') * 60000).toISOString(),
                });
            }

        } else {
            // No queued game — winner picks directly into the next slot
            logInfo(`   -> No ${term.game} queued. Winner must use /pick-game.`);

            if (channelId) {
                const winnerPickWindowMin = parseInt(process.env.WINNER_PICK_WINDOW_MIN || '60', 10);
                let msg = `⚠️ No ${term.game} is queued for **${tournamentRow.name}**.`;
                if (winnerId) {
                    msg += `\n<@${winnerId}> — you won! Use \`/pick-game\` within **${winnerPickWindowMin} minutes** to select the next ${term.game}.`;
                } else {
                    msg += ` A moderator should use \`/pick-game\` or \`/nominate-picker\`.`;
                }
                await sendChannelMessage(channelId, msg);
            }
        }

        logInfo(`✅ Maintenance complete for ${tournamentRow.name}`);
    }
}
