import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';

export const ping: Command = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong! (Test connection)'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.reply('🏓 Pong! ArcAid is online and ready.');
    },
};
