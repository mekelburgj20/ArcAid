import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getTerminology, capitalize } from '../../utils/terminology.js';
import { logError } from '../../utils/logger.js';
import {
    resolveGuildReadScope,
    DISCORD_GUILD_NOT_LINKED_MESSAGE,
} from '../../utils/discordRoomFilter.js';
import { listActiveGamesForScope } from '../activeGames.js';

export const listactive: Command = {
    data: new SlashCommandBuilder()
        .setName('list-active')
        .setDescription('Shows the currently active games.'),
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
        const term = getTerminology();

        try {
            // v2.123.0 — the query moved to `listActiveGamesForScope` so the
            // `active_games` callout responder answers from the same rows.
            const activeGames = await listActiveGamesForScope(scope);

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
