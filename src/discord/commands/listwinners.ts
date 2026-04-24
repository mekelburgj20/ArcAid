import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import { buildEnabledRoomSqlFilter } from '../../utils/discordRoomFilter.js';

export const listwinners: Command = {
    data: new SlashCommandBuilder()
        .setName('list-winners')
        .setDescription('Displays recent tournament winners.'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const db = await getDatabase();
        const term = getTerminology();
        
        try {
            const { sql: enabledFilter, params } = await buildEnabledRoomSqlFilter('t.game_room_id');
            // INNER JOIN — orphan games (no tournament, no room) don't belong
            // to any guild's view.
            const completedGames = await db.all(`
                SELECT g.id, g.name as game_name, t.name as tournament_name, g.end_date
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'COMPLETED' ${enabledFilter}
                ORDER BY g.end_date DESC
                LIMIT 5
            `, ...params);

            if (completedGames.length === 0) {
                await interaction.editReply('No past winners found for any tournament.');
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('Recent Winners')
                .setColor(0x00FF00)
                .setTimestamp();

            let description = '';
            for (let i = 0; i < completedGames.length; i++) {
                const game = completedGames[i];
                const winner = await db.get(`
                    SELECT iscored_username, score 
                    FROM submissions 
                    WHERE game_id = ?
                    ORDER BY score DESC
                    LIMIT 1
                `, game.id);

                const date = game.end_date ? new Date(game.end_date).toLocaleDateString() : 'Unknown Date';
                if (winner) {
                    const tName = game.tournament_name || 'Manual';
                    description += `**${i + 1}. [${tName}]** ${date}: **${winner.iscored_username}** - \`${game.game_name}\`\n`;
                }
            }

            if (!description) description = 'No winning scores found.';
            embed.setDescription(description);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logError('Error in list-winners command:', error);
            await interaction.editReply('An error occurred while fetching the winners.');
        }
    },
};
