import { ChatInputCommandInteraction, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { BackupManager } from '../../engine/BackupManager.js';
import { logError } from '../../utils/logger.js';

export const createbackup: Command = {
    data: new SlashCommandBuilder()
        .setName('create-backup')
        .setDescription('Trigger BackupManager via Discord.')
        // Admin-only (drift audit fix): triggering a full DB+asset backup on
        // demand shouldn't be open to any guild member. Same gate as
        // activate-game / nominate-picker.
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        try {
            const manager = BackupManager.getInstance();
            // No iScored client passed: BackupManager.createBackup(client?) is optional —
            // this performs a DB + assets backup and skips iScored state capture (simplest, safe path).
            const backupPath = await manager.createBackup();
            await interaction.editReply(`**Backup Successful!**\nA full system backup has been created at:\n\`${backupPath}\``);
        } catch (error) {
            logError('Error in create-backup command:', error);
            await interaction.editReply('An error occurred while creating the backup.');
        }
    },
};
