import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { BackupManager } from '../../engine/BackupManager.js';
import { logError } from '../../utils/logger.js';

export const createbackup: Command = {
    data: new SlashCommandBuilder()
        .setName('create-backup')
        .setDescription('Trigger BackupManager via Discord.'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        try {
            const manager = BackupManager.getInstance();
            const backupPath = await manager.createBackup(null as any);
            await interaction.editReply(`**Backup Successful!**\nA full system backup has been created at:\n\`${backupPath}\``);
        } catch (error) {
            logError('Error in create-backup command:', error);
            await interaction.editReply('An error occurred while creating the backup.');
        }
    },
};
