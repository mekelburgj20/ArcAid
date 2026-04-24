import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology, capitalize } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import { buildEnabledRoomSqlFilter } from '../../utils/discordRoomFilter.js';

export const listactive: Command = {
    data: new SlashCommandBuilder()
        .setName('list-active')
        .setDescription('Shows the currently active games.'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const term = getTerminology();
        const db = await getDatabase();

        try {
            const { sql: enabledFilter, params } = await buildEnabledRoomSqlFilter('t.game_room_id');
            // INNER JOIN — orphan games with no tournament (legacy pre-multi-room
            // data) have no room attribution and shouldn't surface in any guild's
            // output. Only tournament-attributed games are relevant to Discord.
            const activeGames = await db.all(`
                SELECT g.name as game_name, t.name as tournament_name
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'ACTIVE' ${enabledFilter}
            `, ...params);

            if (activeGames.length === 0) {
                await interaction.editReply(`There are no active ${term.games.toLowerCase()} right now.`);
                return;
            }

            let message = `**Currently Active ${capitalize(term.games)}:**\n`;
            for (const game of activeGames) {
                const tName = game.tournament_name || 'Manual';
                message += `- **${tName}:** ${game.game_name}\n`;
            }

            await interaction.editReply(message);
        } catch (error) {
            logError('Error in list-active command:', error);
            await interaction.editReply('An error occurred while fetching the active list.');
        }
    },
};
