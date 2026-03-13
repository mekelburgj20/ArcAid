import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { logError, logInfo } from '../../utils/logger.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { getDatabase } from '../../database/database.js';

export const runcleanup: Command = {
    data: new SlashCommandBuilder()
        .setName('run-cleanup')
        .setDescription('(Admin) Delete completed/hidden games from iScored.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            logInfo('Manually triggering cleanup for MANAGED games...');
            const client = new IScoredClient();
            await client.connect();

            const db = await getDatabase();

            // Get all games on iScored
            const allIscoredGames = await client.getAllGames();

            // Identify games to remove:
            // 1. COMPLETED or HIDDEN (finished games)
            // 2. ACTIVE with no tournament (orphans from sync)
            const gamesToRemove = await db.all(
                `SELECT iscored_id, id, name, status, tournament_id FROM games
                 WHERE iscored_id IS NOT NULL AND (
                     status IN ('COMPLETED', 'HIDDEN')
                     OR (status = 'ACTIVE' AND tournament_id IS NULL)
                 )`
            );
            const idsToRemove = new Map(gamesToRemove.map(g => [g.iscored_id, g]));

            let deletedCount = 0;

            for (const game of allIscoredGames) {
                const dbGame = idsToRemove.get(game.id);
                if (dbGame) {
                    const reason = dbGame.tournament_id ? dbGame.status.toLowerCase() : 'orphan (no tournament)';
                    logInfo(`   -> Deleting ${reason}: ${game.name} (ID: ${game.id})`);
                    try {
                        await client.deleteGame(game.id, game.name);
                        await db.run('UPDATE games SET status = ? WHERE id = ?', 'HIDDEN', dbGame.id);
                        deletedCount++;
                    } catch (err) {
                        logError(`   -> Failed to delete ${game.name}:`, err);
                    }
                }
            }

            await client.disconnect();

            await interaction.editReply(`**Cleanup Complete!**\n\nDeleted ${deletedCount} game(s) from iScored. Untracked games were left untouched.`);
        } catch (error) {
            logError('Error in run-cleanup command:', error);
            await interaction.editReply('An error occurred while running the cleanup routine. Check the logs.');
        }
    },
};
