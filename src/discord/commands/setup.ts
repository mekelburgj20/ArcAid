import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logInfo } from '../../utils/logger.js';

export const setup: Command = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure ArcAid settings for this server.')
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
                .setDescription('View current ArcAid configuration.')
        ) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        const subcommand = interaction.options.getSubcommand();
        const db = await getDatabase();

        if (subcommand === 'announcement-channel') {
            const channel = interaction.options.getChannel('channel', true);
            await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID', channel.id);
            process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = channel.id;
            logInfo(`User ${interaction.user.tag} set announcement channel to: #${channel.name} (${channel.id})`);
            await interaction.reply(`Announcement channel set to <#${channel.id}>.`);
        }

        else if (subcommand === 'admin-role') {
            const role = interaction.options.getRole('role', true);
            await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'DISCORD_ADMIN_ROLE_ID', role.id);
            process.env.DISCORD_ADMIN_ROLE_ID = role.id;
            logInfo(`User ${interaction.user.tag} set admin role to: @${role.name} (${role.id})`);
            await interaction.reply(`Admin role set to <@&${role.id}>.`);
        }

        else if (subcommand === 'view') {
            const settings = await db.all('SELECT key, value FROM settings WHERE key IN (?, ?)',
                'DISCORD_ANNOUNCEMENT_CHANNEL_ID', 'DISCORD_ADMIN_ROLE_ID'
            );

            const map = new Map(settings.map((s: any) => [s.key, s.value]));
            const channelId = map.get('DISCORD_ANNOUNCEMENT_CHANNEL_ID') || process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
            const roleId = map.get('DISCORD_ADMIN_ROLE_ID') || process.env.DISCORD_ADMIN_ROLE_ID;

            let msg = '**ArcAid Configuration**\n\n';
            msg += `**Announcement Channel:** ${channelId ? `<#${channelId}>` : '*Not set*'}\n`;
            msg += `**Admin Role:** ${roleId ? `<@&${roleId}>` : '*Not set*'}\n`;
            msg += `\n*Pick windows and other settings are managed in the Admin UI → Settings.*\n`;

            await interaction.reply(msg);
        }
    },
};
