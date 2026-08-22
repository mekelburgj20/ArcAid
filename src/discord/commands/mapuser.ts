import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError } from '../../utils/logger.js';
import { BanService } from '../../services/BanService.js';
import { IdentityAliasEffectsService } from '../../services/IdentityAliasEffectsService.js';

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
        // Drift-audit fix — self-service write commands check bans inline
        // (no Express middleware chain for Discord commands); /map-user
        // was missing it. Global-only check: the mapping isn't room-scoped,
        // so there's no room to re-check against once the target is known.
        const banCheck = await BanService.isIdentityBanned(interaction.user.id);
        if (banCheck.banned) {
            await interaction.reply({ content: 'This account is banned.', ephemeral: true });
            return;
        }

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
            // user_mappings is many-to-one as of v2.x: one Discord user can hold
            // multiple iScored aliases. /map-user now ADDS an alias rather than
            // replacing one. Reject if the name is already mapped to a different
            // Discord user.
            const existing = await db.get<{ discord_user_id: string }>(
                `SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)`,
                iscoredName
            );
            if (existing && existing.discord_user_id !== targetUser.id) {
                await interaction.reply({
                    content: `iScored name **${iscoredName}** is already mapped to a different Discord user (<@${existing.discord_user_id}>). Have them remove it first.`,
                    ephemeral: true,
                });
                return;
            }
            const inserted = await db.run(
                `INSERT INTO user_mappings (discord_user_id, iscored_username)
                 VALUES (?, ?)
                 ON CONFLICT(iscored_username) DO NOTHING`,
                targetUser.id, iscoredName
            );

            // v2.127.0 — a bot-command mapping now runs the same tidy-up a web
            // claim does: fold the synthetic `iscored:*` membership rows onto
            // the real account, re-attribute the unowned synced scores, and
            // hydrate a `user_profiles` row (this command was the ONE path that
            // could link someone who has never web-logged-in, which is exactly
            // how BrickShotBobes ended up with no avatar anywhere).
            let effects = { membersFolded: 0, rowsAttributed: 0 };
            if (inserted?.changes) {
                effects = await IdentityAliasEffectsService.onAliasLinked(targetUser.id, iscoredName);
            }

            logInfo(`User mapped: ${iscoredName} -> ${targetUser.tag}`);
            const tidied: string[] = [];
            if (effects.rowsAttributed > 0) tidied.push(`Re-attributed ${effects.rowsAttributed} synced score${effects.rowsAttributed === 1 ? '' : 's'}.`);
            if (effects.membersFolded > 0) tidied.push(`Merged ${effects.membersFolded} placeholder membership row${effects.membersFolded === 1 ? '' : 's'}.`);
            await interaction.reply(
                [`Added iScored alias **${iscoredName}** for <@${targetUser.id}>.`, ...tidied].join(' ')
            );
        } catch (error) {
            logError('Error mapping user:', error);
            await interaction.reply({ content: 'An error occurred while mapping the user.', ephemeral: true });
        }
    },
};
