import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import { StatsService } from '../../services/StatsService.js';
import { getTournamentColor } from '../../utils/discord.js';

export const viewstats: Command = {
    data: new SlashCommandBuilder()
        .setName('view-stats')
        .setDescription('Shows historical stats for a game.')
        .addStringOption(option =>
            option.setName('game-name')
                .setDescription('Name of the game')
                .setRequired(true)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused();
        const db = await getDatabase();

        // Suggest from game_library (all known games)
        const rows = await db.all('SELECT DISTINCT name FROM game_library ORDER BY name');
        const filtered = rows
            .map(r => r.name)
            .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
            .slice(0, 25);

        await interaction.respond(
            filtered.map(name => ({ name, value: name }))
        );
    },

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const gameName = interaction.options.getString('game-name', true);
        const term = getTerminology();
        const db = await getDatabase();

        try {
            const stats = await StatsService.getGameStats(gameName);

            if (!stats) {
                await interaction.editReply(`No play history found for "${gameName}".`);
                return;
            }

            // Resolve all-time high holder to Discord mention
            let highHolderDisplay = stats.allTimeHighPlayer || 'Unknown';
            if (stats.allTimeHighPlayer) {
                const mapping = await db.get(
                    'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
                    stats.allTimeHighPlayer
                );
                if (mapping?.discord_user_id) {
                    highHolderDisplay = `<@${mapping.discord_user_id}>`;
                }
            }

            // Get tournament type for color (from most recent game instance)
            const recentGame = await db.get(`
                SELECT t.type FROM games g
                LEFT JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.name = ? COLLATE NOCASE
                ORDER BY g.start_date DESC LIMIT 1
            `, gameName);
            const color = getTournamentColor(recentGame?.type);

            // Calculate win percentage if possible
            const winData = await db.get(`
                SELECT COUNT(DISTINCT g.id) as total_instances,
                       COUNT(DISTINCT CASE WHEN g.status = 'COMPLETED' THEN g.id END) as completed
                FROM games g WHERE g.name = ? COLLATE NOCASE
            `, gameName);

            const embed = new EmbedBuilder()
                .setTitle(`Statistics: ${gameName}`)
                .setColor(color)
                .addFields(
                    { name: 'Times Played', value: stats.timesPlayed.toString(), inline: true },
                    { name: 'Avg Score', value: stats.avgScore ? Math.round(stats.avgScore).toLocaleString() : 'N/A', inline: true },
                    { name: 'Unique Players', value: stats.uniquePlayers?.toString() ?? 'N/A', inline: true },
                    { name: 'All-Time High', value: `${(stats.allTimeHigh || 0).toLocaleString()}`, inline: true },
                    { name: 'Record Holder', value: highHolderDisplay, inline: true },
                )
                .setTimestamp();

            if (winData && winData.completed > 0) {
                embed.addFields({
                    name: 'Completed Rounds',
                    value: `${winData.completed} of ${winData.total_instances}`,
                    inline: true,
                });
            }

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logError('Error in view-stats command:', error);
            await interaction.editReply('An error occurred while fetching stats.');
        }
    },
};
