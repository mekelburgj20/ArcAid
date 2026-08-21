import { ChatInputCommandInteraction, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { PickAwardGate, PICK_AWARD_DISABLED_REPLY } from '../../services/PickAwardGate.js';
import { v4 as uuidv4 } from 'uuid';
import {
    resolveGuildReadScope,
    isRoomInGuildScope,
    DISCORD_FOREIGN_TOURNAMENT_MESSAGE,
} from '../../utils/discordRoomFilter.js';

export const pausepick: Command = {
    data: new SlashCommandBuilder()
        .setName('pause-pick')
        .setDescription('Inject a specific game into the lineup (Manual Override).')
        // Admin-only (RTX demo follow-up, 2026-08-09): lineup injection is a
        // moderation action — same gate as activate-game etc.
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true))
        .addStringOption(option => option.setName('game-name').setDescription('Name of the game').setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const tournamentId = interaction.options.getString('tournament-id', true);
        const gameName = interaction.options.getString('game-name', true);
        const db = await getDatabase();

        try {
            const tournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);

            // v2.120.1 - guild gate. Same shape as /nominate-picker:
            // `tournament-id` is free text, and this command INSERTs a QUEUED
            // game row, so without the gate any guild could inject a game into
            // any room's lineup.
            const scope = await resolveGuildReadScope(interaction.guildId);
            if (!isRoomInGuildScope(tournament?.game_room_id ?? null, scope)) {
                await interaction.editReply(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
                return;
            }

            // Pick-award gate (plan §8) — short-circuit with exact reply string.
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
