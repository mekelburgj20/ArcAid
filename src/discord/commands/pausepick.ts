import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { PickAwardGate, PICK_AWARD_DISABLED_REPLY } from '../../services/PickAwardGate.js';
import { v4 as uuidv4 } from 'uuid';

export const pausepick: Command = {
    data: new SlashCommandBuilder()
        .setName('pause-pick')
        .setDescription('Inject a specific game into the lineup (Manual Override).')
        .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true))
        .addStringOption(option => option.setName('game-name').setDescription('Name of the game').setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const tournamentId = interaction.options.getString('tournament-id', true);
        const gameName = interaction.options.getString('game-name', true);
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
                INSERT INTO games (id, tournament_id, name, status) 
                VALUES (?, ?, ?, 'QUEUED')
            `, uuidv4(), tournamentId, gameName);

            await interaction.editReply(`**Manual Override Successful!**\nThe game **${gameName}** has been injected into the next available slot for tournament \`${tournamentId}\`.`);
        } catch (error) {
            logError('Error in pause-pick command:', error);
            await interaction.editReply('An error occurred while injecting the special game.');
        }
    },
};
