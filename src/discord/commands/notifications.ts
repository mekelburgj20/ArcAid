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
    rotationReady: 'Rotation Ready',
    queueLow: 'Queue Running Low',
};

export const notifications: Command = {
    data: new SlashCommandBuilder()
        .setName('arcaid-notifications')
        .setDescription('Manage your Arcaid notification preferences.')
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
                    { name: 'Toggle: Rotation Ready', value: 'rotationReady' },
                    { name: 'Toggle: Queue Running Low', value: 'queueLow' },
                    { name: 'Enable all', value: 'enable_all' },
                    { name: 'Disable all', value: 'disable_all' },
                    // v2.125.0 — Arcaid Chat Responses. Two explicit choices
                    // rather than a toggle: this one defaults ON, so someone
                    // reaching for it wants a specific direction ("make it
                    // stop"), not a flip whose result they have to read back.
                    { name: 'Chat responses: ON', value: 'chat_responses_on' },
                    { name: 'Chat responses: OFF', value: 'chat_responses_off' },
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

            if (action === 'chat_responses_on' || action === 'chat_responses_off') {
                const enabled = action === 'chat_responses_on';
                await NotificationService.setChatResponsesEnabled(userId, enabled);
                await interaction.editReply(enabled
                    ? "**Arcaid chat responses**: `ON` — I'll reply to your messages again."
                    : "**Arcaid chat responses**: `OFF` — I'll stay out of your conversations.");
                return;
            }

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

                // Not one of PREF_LABELS: it is an inbound reply defaulting to
                // ON, not an outbound DM defaulting to OFF, so it is reported
                // apart from them (and is untouched by Enable/Disable all).
                const chatOn = await NotificationService.chatResponsesEnabled(userId);
                embed.addFields({
                    name: 'Arcaid Chat Responses',
                    value: chatOn ? '`ON`' : '`OFF`',
                    inline: true,
                });

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
