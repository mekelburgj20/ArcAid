import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { LeaderboardService } from '../../services/LeaderboardService.js';
import { getTournamentColor } from '../../utils/discord.js';

const PAGE_SIZE = 10;

export const listscores: Command = {
    data: new SlashCommandBuilder()
        .setName('list-scores')
        .setDescription('Displays the leaderboard for active games.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Filter scores to a specific player')
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option.setName('page')
                .setDescription('Page number (default: 1)')
                .setRequired(false)
                .setMinValue(1)
        ) as SlashCommandBuilder,
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
        const targetUser = interaction.options.getUser('user');
        const page = interaction.options.getInteger('page') ?? 1;
        const offset = (page - 1) * PAGE_SIZE;

        try {
            const activeGames = await db.all(`
                SELECT g.id, g.name as game_name, t.name as tournament_name, t.type as tournament_type, t.display_order
                FROM games g
                LEFT JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'ACTIVE'
                ORDER BY COALESCE(t.display_order, 999) ASC, g.start_date DESC
            `);

            if (activeGames.length === 0) {
                await interaction.editReply(`There are no recent ${term.games.toLowerCase()} to show scores for.`);
                return;
            }

            const embeds = [];
            for (const game of activeGames) {
                let rankings = await LeaderboardService.getForGame(game.id);

                // Filter to a specific user if requested
                if (targetUser) {
                    const mapping = await db.get(
                        'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
                        targetUser.id
                    );
                    if (mapping) {
                        rankings = rankings.filter(e =>
                            e.iscored_username.toLowerCase() === mapping.iscored_username.toLowerCase()
                        );
                    } else {
                        rankings = [];
                    }
                }

                const total = rankings.length;
                const paged = rankings.slice(offset, offset + PAGE_SIZE);
                const tName = game.tournament_name || 'Manual Game';
                const color = getTournamentColor(game.tournament_type);

                const embed = new EmbedBuilder()
                    .setTitle(`Standings: [${tName}] ${game.game_name}`)
                    .setColor(color)
                    .setTimestamp();

                if (targetUser) {
                    embed.setFooter({ text: `Filtered to ${targetUser.displayName}` });
                }

                if (paged.length === 0) {
                    embed.setDescription(targetUser
                        ? `No scores found for ${targetUser.displayName}.`
                        : `No ${term.submission.toLowerCase()}s submitted yet.`);
                } else {
                    let desc = '';
                    paged.forEach((entry) => {
                        const medal = entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : `**${entry.rank}.**`;
                        desc += `${medal} **${entry.iscored_username}** — ${entry.score.toLocaleString()}\n`;
                    });
                    if (total > PAGE_SIZE) {
                        const totalPages = Math.ceil(total / PAGE_SIZE);
                        desc += `\n*Page ${page}/${totalPages} — use \`/list-scores page:${page + 1}\` for more*`;
                    }
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
