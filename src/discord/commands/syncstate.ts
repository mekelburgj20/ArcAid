import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { logError, logInfo, logWarn } from '../../utils/logger.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { getDatabase } from '../../database/database.js';
import { TOURNAMENT_TAG_KEYS, MANAGED_TAGS } from '../../utils/config.js';
import { v4 as uuidv4 } from 'uuid';

export const syncstate: Command = {
    data: new SlashCommandBuilder()
        .setName('sync-state')
        .setDescription('Manually trigger iScored reconciliation and score sync.'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        
        try {
            logInfo('Starting Tournament State & Score Sync...');
            const iscored = new IScoredClient();
            await iscored.connect();
            
            const db = await getDatabase();
            
            // 1. Get all games currently on iScored lineup
            const allIscoredGames = await iscored.getAllGames();
            logInfo(`   -> Found ${allIscoredGames.length} total games on iScored.`);
            
            let managedCount = 0;
            let manualCount = 0;
            let scoresSynced = 0;
            
            for (const iscoredGame of allIscoredGames) {
                // Determine if this is a managed tournament game or a manual game
                let targetTournamentType: string | null = null;
                for (const [type, tag] of Object.entries(TOURNAMENT_TAG_KEYS)) {
                    if (iscoredGame.tags?.some(t => t.toUpperCase() === tag.toUpperCase()) || 
                        iscoredGame.name.toUpperCase().endsWith(' ' + type.toUpperCase())) {
                        targetTournamentType = type;
                        break;
                    }
                }
                
                // Get or Create record in local database
                let localGame = await db.get('SELECT * FROM games WHERE iscored_id = ?', iscoredGame.id);
                
                if (!localGame) {
                    logInfo(`   -> Discovering NEW game: ${iscoredGame.name} (ID: ${iscoredGame.id})`);
                    
                    let tournamentId: string | null = null;
                    if (targetTournamentType) {
                        // Find matching tournament by type
                        const tournament = await db.get('SELECT id FROM tournaments WHERE type = ?', targetTournamentType);
                        tournamentId = tournament?.id || null;
                    }
                    
                    localGame = {
                        id: uuidv4(),
                        tournament_id: tournamentId,
                        name: iscoredGame.name,
                        iscored_id: iscoredGame.id,
                        status: iscoredGame.isHidden ? 'HIDDEN' : (iscoredGame.isLocked ? 'COMPLETED' : 'ACTIVE')
                    };
                    
                    await db.run(
                        'INSERT INTO games (id, tournament_id, name, iscored_id, status) VALUES (?, ?, ?, ?, ?)',
                        localGame.id, localGame.tournament_id, localGame.name, localGame.iscored_id, localGame.status
                    );
                } else {
                    // Update existing record
                    const newStatus = iscoredGame.isHidden ? 'HIDDEN' : (iscoredGame.isLocked ? 'COMPLETED' : 'ACTIVE');
                    await db.run('UPDATE games SET status = ?, name = ? WHERE iscored_id = ?', newStatus, iscoredGame.name, iscoredGame.id);
                }
                
                if (targetTournamentType) managedCount++; else manualCount++;
                
                // 2. Sync Scores for ACTIVE/COMPLETED games
                if (!iscoredGame.isHidden) {
                    const publicUrl = process.env.ISCORED_PUBLIC_URL;
                    if (publicUrl) {
                        const scores = await iscored.scrapePublicScores(publicUrl, iscoredGame.id);

                        // Track synced IDs so we can remove stale ones
                        const syncedIds = new Set<string>();

                        for (const score of scores) {
                            // Normalize ID to lowercase to prevent case-variant duplicates
                            const syncId = `${localGame.id}-${score.name.toLowerCase()}`;
                            syncedIds.add(syncId);

                            // Resolve Discord user ID from user_mappings, or use a placeholder keyed to the iScored name
                            const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE iscored_username = ? COLLATE NOCASE', score.name);
                            const discordUserId = mapping?.discord_user_id || `iscored:${score.name}`;

                            await db.run(`
                                INSERT INTO submissions (id, game_id, iscored_username, score, photo_url, timestamp, discord_user_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET score = excluded.score, photo_url = excluded.photo_url,
                                    discord_user_id = excluded.discord_user_id, iscored_username = excluded.iscored_username
                            `,
                                syncId,
                                localGame.id,
                                score.name,
                                parseInt(score.score.replace(/,/g, '')),
                                score.photoUrl,
                                new Date().toISOString(),
                                discordUserId
                            );
                        }

                        // Remove local synced submissions that no longer exist on iScored
                        // (handles deleted scores, username changes on iScored)
                        // Only remove sync-format IDs (gameId-username), not UUID Discord submissions
                        const localSynced = await db.all(
                            `SELECT id FROM submissions WHERE game_id = ? AND id LIKE ? || '-%'`,
                            localGame.id, localGame.id
                        );
                        for (const row of localSynced) {
                            if (!syncedIds.has(row.id)) {
                                await db.run('DELETE FROM submissions WHERE id = ?', row.id);
                            }
                        }

                        scoresSynced += scores.length;
                    }
                }
            }
            
            await iscored.disconnect();
            
            await interaction.editReply(`**Sync Complete!**\n\n- Managed Games: ${managedCount}\n- Manual Games: ${manualCount}\n- Scores Synced: ${scoresSynced}`);
        } catch (error) {
            logError('Error in sync-state command:', error);
            await interaction.editReply('An error occurred while synchronizing state. Check the logs.');
        }
    },
};
