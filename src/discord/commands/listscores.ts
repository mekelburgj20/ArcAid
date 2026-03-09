import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { LeaderboardService } from '../../services/LeaderboardService.js';

export const listscores: Command = {
    data: new SlashCommandBuilder()
        .setName('list-scores')
        .setDescription('Displays the leaderboard for active games.'),
    async execute(interaction: ChatInputCommandInteraction) {
        // Check cooldown (5 seconds)
        const remaining = checkCooldown(interaction.user.id, 'list-scores', 5);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before listing scores again.`, ephemeral: true });
            return;
        }

        await interaction.deferReply();
        const term = getTerminology();
        const db = await getDatabase();
        
        try {
            const activeGames = await db.all(`
                SELECT g.id, g.name as game_name, t.name as tournament_name
                FROM games g
                LEFT JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status IN ('ACTIVE', 'COMPLETED')
                ORDER BY g.start_date DESC
                LIMIT 5
            `);

            if (activeGames.length === 0) {
                await interaction.editReply(`There are no recent ${term.games.toLowerCase()} to show scores for.`);
                return;
            }

            const embeds = [];
            for (const game of activeGames) {
                const rankings = await LeaderboardService.getForGame(game.id);

                const tName = game.tournament_name || 'Manual Game';
                const embed = new EmbedBuilder()
                    .setTitle(`Standings: [${tName}] ${game.game_name}`)
                    .setColor(0x00AE86)
                    .setTimestamp();

                if (rankings.length === 0) {
                    embed.setDescription(`No ${term.submission.toLowerCase()}s submitted yet.`);
                } else {
                    let desc = '';
                    rankings.slice(0, 10).forEach((entry) => {
                        desc += `**${entry.rank}. ${entry.iscored_username}** - ${entry.score.toLocaleString()}\n`;
                    });
                    embed.setDescription(desc);
                }
                embeds.push(embed);
            }

            await interaction.editReply({ embeds });
        } catch (error) {
            logError('Error in list-scores command:', error);
            await interaction.editReply('An error occurred while fetching the scores.');
        }
    },
};
