import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';

export const setup: Command = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure Arcaid settings for this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub.setName('announcement-channel')
                .setDescription('Set the default channel for bot announcements.')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('The announcement channel')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText)
                )
        )
        .addSubcommand(sub =>
            sub.setName('admin-role')
                .setDescription('Set the role required for admin commands.')
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('The admin role')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View current Arcaid configuration.')
        ) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        const subcommand = interaction.options.getSubcommand();
        const db = await getDatabase();

        // Drift-audit fix (2026-08): `/setup announcement-channel` and
        // `/setup admin-role` wrote to the GLOBAL `settings` table + a live
        // `process.env` mutation — dead weight since the multi-room migration
        // moved Discord config to per-room `game_room_settings`
        // (`DISCORD_ANNOUNCEMENT_CHANNEL_ID` via the web admin's Settings →
        // Discord page), and an active footgun: running this command would
        // silently change behavior for EVERY room sharing the env fallback,
        // not just the invoking server's room. Admin role is separately
        // obsolete — Discord's own permission system
        // (`setDefaultMemberPermissions`) gates admin commands now, not a
        // configurable role. Retired to a signpost rather than deleted, to
        // avoid Discord command re-registration edge cases.
        if (subcommand === 'announcement-channel' || subcommand === 'admin-role') {
            await interaction.reply({
                content: '⚠️ /setup is retired — configure Discord settings per room in the web admin: Settings → Discord (https://arcaid.app/<your-room>/admin/settings). '
                    + 'The admin-role setting is obsolete (Discord\'s own permission system gates admin commands now).',
                ephemeral: true,
            });
        }

        else if (subcommand === 'view') {
            const guildId = interaction.guildId;
            if (!guildId) {
                await interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
                return;
            }

            const rows = await db.all(
                `SELECT game_room_id FROM game_room_settings WHERE key = 'DISCORD_GUILD_ID' AND value = ?`,
                guildId,
            ) as Array<{ game_room_id: string }>;

            if (rows.length === 0) {
                await interaction.reply({
                    content: 'No Arcaid room is linked to this Discord server yet. Configure Discord settings per room in the web admin: Settings → Discord.',
                    ephemeral: true,
                });
                return;
            }

            const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
            const { GameRoomService } = await import('../../services/GameRoomService.js');

            let msg = '**Arcaid Configuration** (per-room, read from the web admin\'s Settings → Discord)\n';
            for (const row of rows) {
                const room = await GameRoomService.getById(row.game_room_id);
                const channelId = await GameRoomSettingsService.get(row.game_room_id, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID');
                msg += `\n**Room:** ${room?.name ?? row.game_room_id}\n`;
                msg += `**Announcement Channel:** ${channelId ? `<#${channelId}>` : '*Not set*'}\n`;
            }
            msg += '\n*Admin role is obsolete — Discord\'s own permission system gates admin commands. Manage more settings in the web admin.*\n';

            await interaction.reply(msg);
        }
    },
};
