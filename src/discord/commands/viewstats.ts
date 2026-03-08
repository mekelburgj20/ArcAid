import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';

export const viewstats: Command = {
    data: new SlashCommandBuilder()
        .setName('view-stats')
        .setDescription('Shows historical stats for a game.')
        .addStringOption(option => option.setName('game-name').setDescription('Name of the game').setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const gameName = interaction.options.getString('game-name', true);
        const term = getTerminology();
        const db = await getDatabase();
        
        try {
            const games = await db.all(`SELECT id FROM games WHERE name = ?`, gameName);
            if (games.length === 0) {
                await interaction.editReply(`No play history found for "${gameName}".`);
                return;
            }

            const placeholders = games.map(() => '?').join(',');
            const gameIds = games.map(g => g.id);

            const row = await db.get(`
                SELECT COUNT(*) as playCount, MAX(score) as highScore
                FROM submissions
                WHERE game_id IN (${placeholders})
            `, ...gameIds);

            if (!row || row.playCount === 0) {
                await interaction.editReply(`No ${term.submission.toLowerCase()} history found for "${gameName}".`);
                return;
            }

            const highScoreSub = await db.get(`
                SELECT iscored_username 
                FROM submissions 
                WHERE game_id IN (${placeholders}) AND score = ?
                LIMIT 1
            `, ...gameIds, row.highScore);

            const embed = new EmbedBuilder()
                .setTitle(`Statistics for ${gameName}`)
                .setColor(0x1E90FF)
                .addFields(
                    { name: 'Total Plays', value: row.playCount.toString(), inline: true },
                    { name: 'All-Time High Score', value: `${(row.highScore || 0).toLocaleString()} (by ${highScoreSub?.iscored_username || 'Unknown'})`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logError('Error in view-stats command:', error);
            await interaction.editReply('An error occurred while fetching stats.');
        }
    },
};
