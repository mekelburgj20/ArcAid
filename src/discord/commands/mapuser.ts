import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError } from '../../utils/logger.js';

export const mapuser: Command = {
    data: new SlashCommandBuilder()
        .setName('map-user')
        .setDescription('Maps an iScored username to a Discord user.')
        .addStringOption(option =>
            option.setName('iscored_name')
                .setDescription('The exact username on iScored')
                .setRequired(true)
        )
        .addUserOption(option =>
            option.setName('discord_user')
                .setDescription('The Discord user to map to (defaults to yourself)')
                .setRequired(false)
        ) as SlashCommandBuilder,
    async execute(interaction: ChatInputCommandInteraction) {
        const iscoredName = interaction.options.getString('iscored_name', true);
        const targetUser = interaction.options.getUser('discord_user') || interaction.user;

        // Optional: Add admin check if mapping *other* users
        if (targetUser.id !== interaction.user.id) {
            const member = await interaction.guild?.members.fetch(interaction.user.id);
            if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({ content: 'You must be an Administrator to map other users.', ephemeral: true });
                return;
            }
        }

        const db = await getDatabase();
        try {
            await db.run(
                `INSERT INTO user_mappings (discord_user_id, iscored_username) 
                 VALUES (?, ?) 
                 ON CONFLICT(discord_user_id) DO UPDATE SET iscored_username = excluded.iscored_username`,
                targetUser.id, iscoredName
            );

            logInfo(`User mapped: ${iscoredName} -> ${targetUser.tag}`);
            await interaction.reply(`Successfully mapped iScored username **${iscoredName}** to Discord user <@${targetUser.id}>.`);
        } catch (error) {
            logError('Error mapping user:', error);
            await interaction.reply({ content: 'An error occurred while mapping the user.', ephemeral: true });
        }
    },
};
