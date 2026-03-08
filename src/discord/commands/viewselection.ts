import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';

export const viewselection: Command = {
    data: new SlashCommandBuilder()
        .setName('view-selection')
        .setDescription('Shows the queued and available games.'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const db = await getDatabase();
        const term = getTerminology();
        
        try {
            const queuedGames = await db.all(`
                SELECT g.name as game_name, t.name as tournament_name
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'QUEUED'
            `);

            let message = `**Queued ${term.games}:**\n`;
            if (queuedGames.length > 0) {
                queuedGames.forEach(g => {
                    message += `- [${g.tournament_name}] ${g.game_name}\n`;
                });
            } else {
                message += `*None*\n`;
            }

            // Also show some from game library as available
            const library = await db.all(`SELECT name FROM game_library LIMIT 10`);
            if (library.length > 0) {
                message += `\n**Available to Pick (Sample):**\n`;
                library.forEach(l => {
                    message += `- ${l.name}\n`;
                });
            }

            await interaction.editReply(message);
        } catch (error) {
            logError('Error in view-selection command:', error);
            await interaction.editReply('An error occurred while fetching selections.');
        }
    },
};
