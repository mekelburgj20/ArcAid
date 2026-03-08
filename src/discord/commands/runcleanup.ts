import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { logError, logInfo } from '../../utils/logger.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { getDatabase } from '../../database/database.js';

export const runcleanup: Command = {
    data: new SlashCommandBuilder()
        .setName('run-cleanup')
        .setDescription('Sweep iScored lineup to hide old games.'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        
        // Basic permission check (can refine later)
        const modRoleId = process.env.MOD_ROLE_ID;
        const memberRoles = interaction.member?.roles as any;
        if (modRoleId && (!memberRoles || !memberRoles.cache.has(modRoleId))) {
             await interaction.editReply('You do not have permission to use this command.');
             return;
        }

        try {
            logInfo('🚀 Manually triggering cleanup for MANAGED games...');
            const iscored = new IScoredClient();
            await iscored.connect();
            
            const db = await getDatabase();
            
            // 1. Get all games from iScored
            const allIscoredGames = await iscored.getAllGames();
            
            // 2. Identify games in our DB that SHOULD be hidden (status = COMPLETED or HIDDEN)
            const gamesToHide = await db.all('SELECT iscored_id, name FROM games WHERE status IN ("COMPLETED", "HIDDEN") AND iscored_id IS NOT NULL');
            const idsToHide = new Set(gamesToHide.map(g => g.iscored_id));
            
            let hiddenCount = 0;
            
            for (const game of allIscoredGames) {
                // ONLY hide it if it's explicitly in our "Finished" list.
                // If it's not in our DB at all, we don't own it - leave it alone!
                if (idsToHide.has(game.id) && !game.isHidden) {
                    logInfo(`   -> Sweeping managed game: ${game.name} (ID: ${game.id})`);
                    await iscored.setGameStatus(game.id, { hidden: true });
                    hiddenCount++;
                }
            }
            
            await iscored.disconnect();
            
            await interaction.editReply(`**Cleanup Complete!**\n\nSwept and hid ${hiddenCount} managed games. Untracked manual games were left untouched.`);
        } catch (error) {
            logError('Error in run-cleanup command:', error);
            await interaction.editReply('An error occurred while running the cleanup routine. Check the logs.');
        }
    },
};
