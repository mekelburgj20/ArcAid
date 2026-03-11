import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { logError } from '../../utils/logger.js';

export const reorderlineup: Command = {
    data: new SlashCommandBuilder()
        .setName('reorder-lineup')
        .setDescription('(Admin) Reorder the iScored lineup based on tournament display positions.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const engine = TournamentEngine.getInstance();

        try {
            await engine.reorderIScoredLineup();
            await interaction.editReply('iScored lineup has been reordered based on tournament positions.');
        } catch (error) {
            logError('Error in reorder-lineup command:', error);
            await interaction.editReply('An error occurred while reordering the lineup.');
        }
    },
};
