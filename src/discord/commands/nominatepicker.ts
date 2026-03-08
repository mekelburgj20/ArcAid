import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';

export const nominatepicker: Command = {
    data: new SlashCommandBuilder()
        .setName('nominate-picker')
        .setDescription('Manually assign picker rights.')
        .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true))
        .addUserOption(option => option.setName('user').setDescription('The user to nominate').setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const tournamentId = interaction.options.getString('tournament-id', true);
        const nominatedUser = interaction.options.getUser('user', true);
        const db = await getDatabase();

        try {
            await db.run(`
                UPDATE games 
                SET picker_discord_id = ?, picker_type = 'WINNER', picker_designated_at = ?
                WHERE tournament_id = ? AND status = 'QUEUED'
                LIMIT 1
            `, nominatedUser.id, new Date().toISOString(), tournamentId);

            await interaction.editReply(`You have successfully nominated ${nominatedUser.toString()} to pick the next game for the tournament.`);
            
            if (interaction.channel && 'send' in interaction.channel) {
                await interaction.channel.send(`${interaction.user.toString()} has nominated ${nominatedUser.toString()} to pick the next game!`);
            }
        } catch (error) {
            logError('Error in nominate-picker command:', error);
            await interaction.editReply('An error occurred while nominating the picker.');
        }
    },
};
