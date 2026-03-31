import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { logError, logInfo, logWarn } from '../../utils/logger.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { IScoredApiClient } from '../../engine/IScoredApiClient.js';
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
            const db = await getDatabase();
            const useApi = process.env.ISCORED_API_ENABLED !== 'false';

            // 1. Game state reconciliation (Playwright — needs lock/hide status from admin dashboard)
            const iscored = new IScoredClient();
            await iscored.connect();

            const allIscoredGames = await iscored.getAllGames();
            logInfo(`   -> Found ${allIscoredGames.length} total games on iScored.`);

            let managedCount = 0;
            let manualCount = 0;

            for (const iscoredGame of allIscoredGames) {
                let targetTournamentType: string | null = null;
                for (const [type, tag] of Object.entries(TOURNAMENT_TAG_KEYS)) {
                    if (iscoredGame.tags?.some(t => t.toUpperCase() === tag.toUpperCase()) ||
                        iscoredGame.name.toUpperCase().endsWith(' ' + type.toUpperCase())) {
                        targetTournamentType = type;
                        break;
                    }
                }

                let localGame = await db.get('SELECT * FROM games WHERE iscored_id = ?', iscoredGame.id);

                if (!localGame) {
                    logInfo(`   -> Discovering NEW game: ${iscoredGame.name} (ID: ${iscoredGame.id})`);

                    let tournamentId: string | null = null;
                    if (targetTournamentType) {
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
                    const newStatus = iscoredGame.isHidden ? 'HIDDEN' : (iscoredGame.isLocked ? 'COMPLETED' : 'ACTIVE');
                    await db.run('UPDATE games SET status = ?, name = ? WHERE iscored_id = ?', newStatus, iscoredGame.name, iscoredGame.id);
                }

                if (targetTournamentType) managedCount++; else manualCount++;
            }

            await iscored.disconnect();

            // 2. Score sync — API preferred (one call), Playwright fallback (per-game scraping)
            let scoresSynced = 0;

            if (useApi) {
                scoresSynced = await syncScoresViaApi(db, allIscoredGames);
            } else {
                scoresSynced = await syncScoresViaPlaywright(db, allIscoredGames);
            }

            await interaction.editReply(`**Sync Complete!**\n\n- Managed Games: ${managedCount}\n- Manual Games: ${manualCount}\n- Scores Synced: ${scoresSynced}\n- Method: ${useApi ? 'API' : 'Playwright'}`);
        } catch (error) {
            logError('Error in sync-state command:', error);
            await interaction.editReply('An error occurred while synchronizing state. Check the logs.');
        }
    },
};

/** Sync scores using the iScored REST API (getAllScores — one HTTP call). */
async function syncScoresViaApi(db: any, allIscoredGames: any[]): Promise<number> {
    logInfo('   Syncing scores via iScored API...');
    const apiClient = new IScoredApiClient();
    const rawData = await apiClient.getAllScores();

    // getAllScores returns { scores: [{ name, game, gameName, score, ... }] } — group by game
    const flatScores: any[] = rawData?.scores && Array.isArray(rawData.scores) ? rawData.scores : (Array.isArray(rawData) ? rawData : []);
    const grouped = new Map<string, { GameID: string; gameName: string; scores: any[] }>();
    for (const entry of flatScores) {
        const gameId = String(entry.game || entry.GameID || '');
        if (!gameId) continue;
        if (!grouped.has(gameId)) {
            grouped.set(gameId, { GameID: gameId, gameName: entry.gameName || '', scores: [] });
        }
        grouped.get(gameId)!.scores.push({
            name: entry.name || '',
            score: String(entry.score || '0'),
            date: entry.date || '',
            rank: entry.rank || '',
        });
    }
    const allScores = Array.from(grouped.values());
    logInfo(`   -> API returned ${flatScores.length} score(s) across ${allScores.length} game(s)`);

    let scoresSynced = 0;

    // Build a set of iScored game IDs that are not hidden
    const visibleGameIds = new Set(
        allIscoredGames.filter(g => !g.isHidden).map(g => g.id)
    );

    for (const gameData of allScores) {
        if (!gameData.GameID || !gameData.scores) continue;
        if (!visibleGameIds.has(gameData.GameID)) continue;

        const localGame = await db.get('SELECT * FROM games WHERE iscored_id = ?', gameData.GameID);
        if (!localGame) continue;

        logInfo(`   -> API: ${gameData.scores.length} score(s) for "${gameData.gameName}" (${gameData.GameID})`);

        const syncedIds = new Set<string>();

        for (const score of gameData.scores) {
            const syncId = `${localGame.id}-${score.name.toLowerCase()}`;
            syncedIds.add(syncId);

            const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE iscored_username = ? COLLATE NOCASE', score.name);
            const discordUserId = mapping?.discord_user_id || `iscored:${score.name}`;

            const scoreValue = parseInt(String(score.score).replace(/[^0-9-]/g, ''), 10);
            if (isNaN(scoreValue)) continue;

            const existing = await db.get('SELECT score FROM submissions WHERE id = ?', syncId);
            const isNewOrHigher = !existing || scoreValue > existing.score;

            await db.run(`
                INSERT INTO submissions (id, game_id, iscored_username, score, timestamp, discord_user_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET score = excluded.score,
                    discord_user_id = excluded.discord_user_id, iscored_username = excluded.iscored_username
            `,
                syncId, localGame.id, score.name, scoreValue, new Date().toISOString(), discordUserId
            );

            if (isNewOrHigher && localGame.tournament_id) {
                try {
                    const tournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', localGame.tournament_id);
                    if (tournament?.game_room_id) {
                        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
                        await ScoreHistoryService.log({
                            gameName: localGame.name,
                            gameRoomId: tournament.game_room_id,
                            gameId: localGame.id,
                            username: score.name,
                            discordUserId,
                            score: scoreValue,
                            source: 'sync',
                        });
                    }
                } catch {}
            }
        }

        // Remove stale synced scores (preserve web-submitted COMMUNITY scores)
        const localSynced = await db.all(
            `SELECT id, discord_user_id FROM submissions WHERE game_id = ? AND id LIKE ? || '-%'`,
            localGame.id, localGame.id
        );
        for (const row of localSynced) {
            if (!syncedIds.has(row.id)) {
                if (row.discord_user_id === 'COMMUNITY') {
                    logInfo(`   -> Preserving web-submitted score: ${row.id} (not yet on iScored)`);
                } else {
                    logInfo(`   -> Removing stale synced score: ${row.id}`);
                    await db.run('DELETE FROM submissions WHERE id = ?', row.id);
                }
            }
        }

        scoresSynced += gameData.scores.length;
    }

    // Invalidate leaderboard cache for all synced games
    const { LeaderboardService } = await import('../../services/LeaderboardService.js');
    for (const gameData of allScores) {
        const localGame = await db.get('SELECT id FROM games WHERE iscored_id = ?', gameData.GameID);
        if (localGame) await LeaderboardService.invalidate(localGame.id);
    }

    return scoresSynced;
}

/** Sync scores using Playwright scraping (per-game, legacy fallback). */
async function syncScoresViaPlaywright(db: any, allIscoredGames: any[]): Promise<number> {
    logInfo('   Syncing scores via Playwright scraping...');
    const publicUrl = process.env.ISCORED_PUBLIC_URL;
    if (!publicUrl) return 0;

    const iscored = new IScoredClient();
    await iscored.connect();
    let scoresSynced = 0;

    try {
        for (const iscoredGame of allIscoredGames) {
            if (iscoredGame.isHidden) continue;

            const localGame = await db.get('SELECT * FROM games WHERE iscored_id = ?', iscoredGame.id);
            if (!localGame) continue;

            const scores = await iscored.scrapePublicScores(publicUrl, iscoredGame.id);
            logInfo(`   -> Scraped ${scores.length} score(s) for "${iscoredGame.name}" (${iscoredGame.id})`);

            const syncedIds = new Set<string>();

            for (const score of scores) {
                const syncId = `${localGame.id}-${score.name.toLowerCase()}`;
                syncedIds.add(syncId);

                const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE iscored_username = ? COLLATE NOCASE', score.name);
                const discordUserId = mapping?.discord_user_id || `iscored:${score.name}`;

                const scoreValue = parseInt(score.score.replace(/,/g, ''));

                const existing = await db.get('SELECT score FROM submissions WHERE id = ?', syncId);
                const isNewOrHigher = !existing || scoreValue > existing.score;

                await db.run(`
                    INSERT INTO submissions (id, game_id, iscored_username, score, photo_url, timestamp, discord_user_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET score = excluded.score, photo_url = excluded.photo_url,
                        discord_user_id = excluded.discord_user_id, iscored_username = excluded.iscored_username
                `,
                    syncId, localGame.id, score.name, scoreValue, score.photoUrl,
                    new Date().toISOString(), discordUserId
                );

                if (isNewOrHigher && localGame.tournament_id) {
                    try {
                        const tournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', localGame.tournament_id);
                        if (tournament?.game_room_id) {
                            const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
                            await ScoreHistoryService.log({
                                gameName: localGame.name,
                                gameRoomId: tournament.game_room_id,
                                gameId: localGame.id,
                                username: score.name,
                                discordUserId,
                                score: scoreValue,
                                photoUrl: score.photoUrl,
                                source: 'sync',
                            });
                        }
                    } catch {}
                }
            }

            // Remove stale synced scores (preserve web-submitted COMMUNITY scores)
            const localSynced = await db.all(
                `SELECT id, discord_user_id FROM submissions WHERE game_id = ? AND id LIKE ? || '-%'`,
                localGame.id, localGame.id
            );
            for (const row of localSynced) {
                if (!syncedIds.has(row.id)) {
                    if (row.discord_user_id === 'COMMUNITY') {
                        logInfo(`   -> Preserving web-submitted score: ${row.id} (not yet on iScored)`);
                    } else {
                        logInfo(`   -> Removing stale synced score: ${row.id}`);
                        await db.run('DELETE FROM submissions WHERE id = ?', row.id);
                    }
                }
            }

            scoresSynced += scores.length;
        }
    } finally {
        await iscored.disconnect();
    }

    return scoresSynced;
}
