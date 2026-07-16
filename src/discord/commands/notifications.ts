import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { logError } from '../../utils/logger.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { NotificationService, NotificationType } from '../../services/NotificationService.js';

const PREF_LABELS: Record<NotificationType, string> = {
    tournamentWin: 'Tournament Win',
    turnToPick: 'Turn to Pick',
    tournamentStarting: 'Tournament Starting',
    rankDethroned: 'Rank Dethroned',
    friendScore: 'Friend Score',
};

export const notifications: Command = {
    data: new SlashCommandBuilder()
        .setName('arcaid-notifications')
        .setDescription('Manage your ArcAid notification preferences.')
        .addStringOption(opt =>
            opt.setName('action')
                .setDescription('Show or toggle notifications')
                .setRequired(true)
                .addChoices(
                    { name: 'Show current settings', value: 'show' },
                    { name: 'Toggle: Tournament Win', value: 'tournamentWin' },
                    { name: 'Toggle: Turn to Pick', value: 'turnToPick' },
                    { name: 'Toggle: Tournament Starting', value: 'tournamentStarting' },
                    { name: 'Toggle: Rank Dethroned', value: 'rankDethroned' },
                    { name: 'Toggle: Friend Score', value: 'friendScore' },
                    { name: 'Enable all', value: 'enable_all' },
                    { name: 'Disable all', value: 'disable_all' },
                )),

    async execute(interaction: ChatInputCommandInteraction) {
        const remaining = checkCooldown(interaction.user.id, 'arcaid-notifications', 3);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before using this again.`, ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const action = interaction.options.getString('action', true);
            const userId = interaction.user.id;
            const prefs = await NotificationService.getPrefs(userId);

            if (action === 'show') {
                const embed = new EmbedBuilder()
                    .setTitle('Notification Preferences')
                    .setColor(0x00BFFF)
                    .setDescription('You will receive Discord DMs for enabled notifications.\nUse `/arcaid-notifications` to toggle each type.')
                    .setTimestamp();

                for (const [key, label] of Object.entries(PREF_LABELS)) {
                    const enabled = prefs[key as NotificationType];
                    embed.addFields({
                        name: label,
                        value: enabled ? '`ON`' : '`OFF`',
                        inline: true,
                    });
                }

                await interaction.editReply({ embeds: [embed] });
                return;
            }

            if (action === 'enable_all' || action === 'disable_all') {
                const value = action === 'enable_all';
                const updated: Record<string, boolean> = {};
                for (const key of Object.keys(PREF_LABELS)) {
                    updated[key] = value;
                }
                // mergePrefs (NOT a wholesale replace) so cross-feature keys in
                // the same JSON — the S15 webPush channel flag, the one-time
                // footer marker — survive a bulk enable/disable.
                await NotificationService.mergePrefs(userId, updated);
                await interaction.editReply(`All notifications ${value ? 'enabled' : 'disabled'}.`);
                return;
            }

            // Toggle a specific pref
            const key = action as NotificationType;
            if (!(key in PREF_LABELS)) {
                await interaction.editReply('Unknown notification type.');
                return;
            }

            const newValue = !prefs[key];
            await NotificationService.mergePrefs(userId, { [key]: newValue });

            await interaction.editReply(`**${PREF_LABELS[key]}** notifications: ${newValue ? '`ON`' : '`OFF`'}`);
        } catch (error) {
            logError('notifications command error:', error);
            await interaction.editReply('Something went wrong. Please try again.');
        }
    },
};
