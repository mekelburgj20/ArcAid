import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import { StatsService } from '../../services/StatsService.js';
import { getTournamentColor } from '../../utils/discord.js';
import {
    resolveGuildReadScope,
    buildGuildScopedRoomSqlFilter,
    DISCORD_GUILD_NOT_LINKED_MESSAGE,
} from '../../utils/discordRoomFilter.js';
import { rankName } from '../../utils/searchRank.js';

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

        // Suggest from the catalogue (all approved games).
        const rows = await db.all(
            `SELECT name FROM global_games WHERE status = 'approved' GROUP BY LOWER(name) ORDER BY name`
        );
        const filtered = rows
            .map(r => r.name)
            .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
            .sort((a, b) => {
                const diff = rankName(a, focused) - rankName(b, focused);
                return diff !== 0 ? diff : a.localeCompare(b);
            })
            .slice(0, 25);

        await interaction.respond(
            filtered.map(name => ({ name, value: name }))
        );
    },

    async execute(interaction: ChatInputCommandInteraction) {
        // v2.120.1 - guild-scoped read. Resolved BEFORE deferring so the
        // not-linked notice can be ephemeral. `null` = this guild maps to
        // no Arcaid room (or the interaction is a DM, which has no guild
        // context at all) - show nothing rather than every room's data.
        const scope = await resolveGuildReadScope(interaction.guildId);
        if (!scope) {
            await interaction.reply({ content: DISCORD_GUILD_NOT_LINKED_MESSAGE, ephemeral: true });
            return;
        }

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

            const { sql: enabledFilter, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);

            // Get tournament type for color (from most recent game instance)
            const recentGame = await db.get(`
                SELECT t.type FROM games g
                LEFT JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.name = ? COLLATE NOCASE ${enabledFilter}
                ORDER BY g.start_date DESC LIMIT 1
            `, gameName, ...params);
            const color = getTournamentColor(recentGame?.type);

            // Calculate win percentage if possible (scoped same way so stats
            // don't count instances that belong to Discord-disabled rooms).
            const winData = await db.get(`
                SELECT COUNT(DISTINCT g.id) as total_instances,
                       COUNT(DISTINCT CASE WHEN g.status = 'COMPLETED' THEN g.id END) as completed
                FROM games g LEFT JOIN tournaments t ON t.id = g.tournament_id
                WHERE g.name = ? COLLATE NOCASE ${enabledFilter}
            `, gameName, ...params);

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
