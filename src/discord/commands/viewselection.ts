import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import {
    resolveGuildReadScope,
    buildGuildScopedRoomSqlFilter,
    DISCORD_GUILD_NOT_LINKED_MESSAGE,
} from '../../utils/discordRoomFilter.js';

export const viewselection: Command = {
    data: new SlashCommandBuilder()
        .setName('view-selection')
        .setDescription('Shows the queued and available games.'),
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

        await interaction.deferReply({ ephemeral: true });
        const db = await getDatabase();
        const term = getTerminology();
        
        try {
            const { sql: enabledFilter, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);
            const queuedGames = await db.all(`
                SELECT g.name as game_name, t.name as tournament_name
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'QUEUED' ${enabledFilter}
            `, ...params);

            let message = `**Queued ${term.games}:**\n`;
            if (queuedGames.length > 0) {
                queuedGames.forEach(g => {
                    message += `- [${g.tournament_name}] ${g.game_name}\n`;
                });
            } else {
                message += `*None*\n`;
            }

            // Also show some from the catalogue as available
            const library = await db.all(
                `SELECT name FROM global_games WHERE status = 'approved' GROUP BY LOWER(name) ORDER BY name LIMIT 10`
            );
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
