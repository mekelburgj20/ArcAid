import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { logError } from '../../utils/logger.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { StatsService } from '../../services/StatsService.js';

export const mystats: Command = {
    data: new SlashCommandBuilder()
        .setName('my-stats')
        .setDescription('View your personal stats — wins, scores, and game history.'),

    async execute(interaction: ChatInputCommandInteraction) {
        const remaining = checkCooldown(interaction.user.id, 'my-stats', 5);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before checking stats again.`, ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const stats = await StatsService.getPlayerStats(interaction.user.id);

            if (stats.totalGamesPlayed === 0) {
                await interaction.editReply('You haven\'t submitted any scores yet. Use `/submit-score` to get started!');
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`Stats for ${interaction.user.displayName}`)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setColor(0x00BFFF)
                .addFields(
                    { name: 'Games Played', value: stats.totalGamesPlayed.toString(), inline: true },
                    { name: 'Wins', value: stats.totalWins.toString(), inline: true },
                    { name: 'Win %', value: `${stats.winPercentage}%`, inline: true },
                    { name: 'Average Score', value: stats.averageScore.toLocaleString(), inline: true },
                    { name: 'Best Score', value: stats.bestScore.toLocaleString(), inline: true },
                    { name: 'Best Game', value: stats.bestGame || 'N/A', inline: true },
                )
                .setTimestamp();

            if (stats.recentScores.length > 0) {
                const recent = stats.recentScores.slice(0, 5).map(s =>
                    `**${s.game_name}** — ${s.score.toLocaleString()}`
                ).join('\n');
                embed.addFields({ name: 'Recent Scores', value: recent });
            }

            if (stats.iscoredUsername) {
                embed.setFooter({ text: `iScored: ${stats.iscoredUsername}` });
            }

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logError('Error in /my-stats:', error);
            await interaction.editReply('An error occurred while fetching your stats.');
        }
    },
};
