import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { Command } from './index.js';
import { getTerminology } from '../../utils/terminology.js';
import { getDatabase } from '../../database/database.js';
import { logInfo } from '../../utils/logger.js';

export const setup: Command = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure ArcAid settings for this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub.setName('terminology')
                .setDescription('Set the naming convention (legacy or generic).')
                .addStringOption(opt =>
                    opt.setName('mode')
                        .setDescription('Terminology mode')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Pinball Legacy (Tables/Grinds)', value: 'legacy' },
                            { name: 'Generic (Games/Tournaments)', value: 'generic' }
                        )
                )
        )
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
            sub.setName('pick-windows')
                .setDescription('Set the pick timeout windows (in minutes).')
                .addIntegerOption(opt =>
                    opt.setName('winner')
                        .setDescription('Winner pick window in minutes (default: 60)')
                        .setRequired(false)
                        .setMinValue(5)
                        .setMaxValue(1440)
                )
                .addIntegerOption(opt =>
                    opt.setName('runner-up')
                        .setDescription('Runner-up pick window in minutes (default: 30)')
                        .setRequired(false)
                        .setMinValue(5)
                        .setMaxValue(1440)
                )
        )
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View current ArcAid configuration.')
        ) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        const subcommand = interaction.options.getSubcommand();
        const db = await getDatabase();

        if (subcommand === 'terminology') {
            const mode = interaction.options.getString('mode', true);
            await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'TERMINOLOGY_MODE', mode);
            process.env.TERMINOLOGY_MODE = mode;
            logInfo(`User ${interaction.user.tag} updated terminology mode to: ${mode}`);
            const term = getTerminology();
            await interaction.reply(`✅ Terminology set to **${mode}** (e.g., ${term.games} and ${term.tournaments}).`);
        }

        else if (subcommand === 'announcement-channel') {
            const channel = interaction.options.getChannel('channel', true);
            await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID', channel.id);
            process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = channel.id;
            logInfo(`User ${interaction.user.tag} set announcement channel to: #${channel.name} (${channel.id})`);
            await interaction.reply(`✅ Announcement channel set to <#${channel.id}>.`);
        }

        else if (subcommand === 'admin-role') {
            const role = interaction.options.getRole('role', true);
            await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'DISCORD_ADMIN_ROLE_ID', role.id);
            process.env.DISCORD_ADMIN_ROLE_ID = role.id;
            logInfo(`User ${interaction.user.tag} set admin role to: @${role.name} (${role.id})`);
            await interaction.reply(`✅ Admin role set to <@&${role.id}>.`);
        }

        else if (subcommand === 'pick-windows') {
            const winner = interaction.options.getInteger('winner');
            const runnerUp = interaction.options.getInteger('runner-up');

            if (!winner && !runnerUp) {
                await interaction.reply({ content: 'Please provide at least one window value to update.', ephemeral: true });
                return;
            }

            const updates: string[] = [];
            if (winner) {
                await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'WINNER_PICK_WINDOW_MIN', winner.toString());
                process.env.WINNER_PICK_WINDOW_MIN = winner.toString();
                updates.push(`Winner: **${winner} minutes**`);
            }
            if (runnerUp) {
                await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'RUNNERUP_PICK_WINDOW_MIN', runnerUp.toString());
                process.env.RUNNERUP_PICK_WINDOW_MIN = runnerUp.toString();
                updates.push(`Runner-up: **${runnerUp} minutes**`);
            }

            logInfo(`User ${interaction.user.tag} updated pick windows: ${updates.join(', ')}`);
            await interaction.reply(`✅ Pick windows updated:\n${updates.join('\n')}`);
        }

        else if (subcommand === 'view') {
            const settings = await db.all('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?)',
                'TERMINOLOGY_MODE', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID', 'DISCORD_ADMIN_ROLE_ID',
                'WINNER_PICK_WINDOW_MIN', 'RUNNERUP_PICK_WINDOW_MIN'
            );

            const map = new Map(settings.map((s: any) => [s.key, s.value]));
            const termMode = map.get('TERMINOLOGY_MODE') || process.env.TERMINOLOGY_MODE || 'generic';
            const channelId = map.get('DISCORD_ANNOUNCEMENT_CHANNEL_ID') || process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
            const roleId = map.get('DISCORD_ADMIN_ROLE_ID') || process.env.DISCORD_ADMIN_ROLE_ID;
            const winnerMin = map.get('WINNER_PICK_WINDOW_MIN') || process.env.WINNER_PICK_WINDOW_MIN || '60';
            const runnerUpMin = map.get('RUNNERUP_PICK_WINDOW_MIN') || process.env.RUNNERUP_PICK_WINDOW_MIN || '30';

            let msg = '**ArcAid Configuration**\n\n';
            msg += `**Terminology:** ${termMode}\n`;
            msg += `**Announcement Channel:** ${channelId ? `<#${channelId}>` : '*Not set*'}\n`;
            msg += `**Admin Role:** ${roleId ? `<@&${roleId}>` : '*Not set*'}\n`;
            msg += `**Winner Pick Window:** ${winnerMin} minutes\n`;
            msg += `**Runner-up Pick Window:** ${runnerUpMin} minutes\n`;

            await interaction.reply(msg);
        }
    },
};
