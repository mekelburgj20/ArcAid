import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { logError } from '../../utils/logger.js';

export const forcemaintenance: Command = {
    data: new SlashCommandBuilder()
        .setName('force-maintenance')
        .setDescription('Manually trigger a tournament rotation.')
        .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const tournamentId = interaction.options.getString('tournament-id', true);
        const engine = TournamentEngine.getInstance();
        
        try {
            await engine.runMaintenance(tournamentId);
            await interaction.editReply(`Maintenance for tournament \`${tournamentId}\` has been manually triggered and completed.`);
        } catch (error) {
            logError('Error in force-maintenance command:', error);
            await interaction.editReply('An error occurred while running maintenance.');
        }
    },
};
