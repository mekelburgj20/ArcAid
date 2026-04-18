import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { PickAwardGate, PICK_AWARD_DISABLED_REPLY } from '../../services/PickAwardGate.js';

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
            // Pick-award gate (plan §8) — short-circuit with exact reply string.
            const tournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);
            const pickEnabled = await PickAwardGate.isEnabled(tournament?.game_room_id ?? null, tournamentId);
            if (!pickEnabled) {
                await interaction.editReply(PICK_AWARD_DISABLED_REPLY);
                return;
            }

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
