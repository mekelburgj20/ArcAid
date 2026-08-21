import { ChatInputCommandInteraction, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { PickAwardGate, PICK_AWARD_DISABLED_REPLY } from '../../services/PickAwardGate.js';
import { PickDispositionService, SelfNominationError } from '../../services/PickDispositionService.js';
import { AuditService } from '../../services/AuditService.js';
import {
    resolveGuildReadScope,
    isRoomInGuildScope,
    DISCORD_FOREIGN_TOURNAMENT_MESSAGE,
} from '../../utils/discordRoomFilter.js';

async function resolveTournament(db: any, tournamentId: string) {
    return db.get('SELECT id, name, game_room_id FROM tournaments WHERE id = ?', tournamentId);
}

export const nominatepicker: Command = {
    data: new SlashCommandBuilder()
        .setName('nominate-picker')
        .setDescription('Manually assign picker rights, or queue a disposition on a player\'s behalf.')
        // Admin-only (RTX demo follow-up, 2026-08-09): reassigning picker
        // rights is a moderation action — without this flag any guild member
        // could grab the pick for themselves. Same gate as activate-game etc.
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub.setName('designate')
                .setDescription('Immediately assign picker rights for the current pending pick slot.')
                .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true))
                .addUserOption(option => option.setName('user').setDescription('The user to designate').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription("Set a player's next-win disposition on their behalf (\"winner said it in chat\").")
                .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true))
                .addUserOption(option => option.setName('for-user').setDescription('The player whose pick this affects').setRequired(true))
                .addStringOption(option =>
                    option.setName('disposition').setDescription('What happens to their next win').setRequired(true)
                        .addChoices(
                            { name: 'Nominate someone else', value: 'nominate' },
                            { name: 'Forfeit to runner-up', value: 'forfeit' },
                            { name: 'Roll the dice (Arcaid picks)', value: 'auto' },
                        )
                )
                .addUserOption(option => option.setName('nominee').setDescription('Required when disposition = nominate').setRequired(false))
        )
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription("Clear a player's next-win disposition (back to using their own queue).")
                .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true))
                .addUserOption(option => option.setName('for-user').setDescription('The player whose disposition to clear').setRequired(true))
        ) as SlashCommandBuilder,
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const subcommand = interaction.options.getSubcommand();
        const tournamentId = interaction.options.getString('tournament-id', true);
        const db = await getDatabase();

        try {
            const tournament = await resolveTournament(db, tournamentId);

            // v2.120.1 - guild gate. `tournament-id` is a free-text option
            // (no autocomplete), so pre-fix an admin in ANY guild could paste
            // another room's tournament id and reassign its picker rights.
            // Checked before the pick-award gate so a foreign tournament's
            // configuration is never disclosed by the reply.
            const scope = await resolveGuildReadScope(interaction.guildId);
            if (!isRoomInGuildScope(tournament?.game_room_id ?? null, scope)) {
                await interaction.editReply(DISCORD_FOREIGN_TOURNAMENT_MESSAGE);
                return;
            }

            const pickEnabled = await PickAwardGate.isEnabled(tournament?.game_room_id ?? null, tournamentId);
            if (!pickEnabled) {
                await interaction.editReply(PICK_AWARD_DISABLED_REPLY);
                return;
            }

            if (subcommand === 'designate') {
                const nominatedUser = interaction.options.getUser('user', true);
                await db.run(`
                    UPDATE games
                    SET picker_discord_id = ?, picker_type = 'WINNER', picker_designated_at = ?
                    WHERE tournament_id = ? AND status = 'QUEUED'
                    LIMIT 1
                `, nominatedUser.id, new Date().toISOString(), tournamentId);

                await AuditService.log({
                    actor: interaction.user.id,
                    action: 'pick_disposition.designate',
                    target_type: 'tournament',
                    target_id: tournamentId,
                    details: JSON.stringify({ designatedUser: nominatedUser.id }),
                    ip_address: 'discord',
                    correlation_id: interaction.id,
                });

                await interaction.editReply(`You have successfully nominated ${nominatedUser.toString()} to pick the next game for the tournament.`);
                if (interaction.channel && 'send' in interaction.channel) {
                    await interaction.channel.send(`${interaction.user.toString()} has nominated ${nominatedUser.toString()} to pick the next game!`).catch(() => {});
                }
                return;
            }

            if (subcommand === 'set') {
                const forUser = interaction.options.getUser('for-user', true);
                const disposition = interaction.options.getString('disposition', true) as 'nominate' | 'forfeit' | 'auto';
                const nominee = interaction.options.getUser('nominee', false);

                if (disposition === 'nominate' && !nominee) {
                    await interaction.editReply('A nominee is required when disposition = nominate.');
                    return;
                }

                try {
                    await PickDispositionService.set(tournamentId, forUser.id, disposition, nominee?.id ?? null);
                } catch (err) {
                    if (err instanceof SelfNominationError) {
                        await interaction.editReply(`${forUser.toString()} can't be nominated as their own nominee.`);
                        return;
                    }
                    throw err;
                }

                await AuditService.log({
                    actor: interaction.user.id,
                    action: 'pick_disposition.set',
                    target_type: 'tournament',
                    target_id: tournamentId,
                    details: JSON.stringify({ forUser: forUser.id, disposition, nominee: nominee?.id ?? null }),
                    ip_address: 'discord',
                    correlation_id: interaction.id,
                });

                // Lifetime copy follows the split ruling (2026-08-17): nominate is
                // one-shot, forfeit and auto stand until the player changes them.
                const desc = disposition === 'nominate'
                    ? `if ${forUser.toString()} wins the current slot, the pick goes to ${nominee!.toString()} instead (one-shot, applies to their next win only).`
                    : disposition === 'auto'
                        ? `whenever ${forUser.toString()} wins, Arcaid rolls the dice and picks for them. This stands until they change it.`
                        : `whenever ${forUser.toString()} wins, their pick is forfeited to the next place. This stands until they change it.`;
                await interaction.editReply(`Set: ${desc}`);
                return;
            }

            if (subcommand === 'clear') {
                const forUser = interaction.options.getUser('for-user', true);
                await PickDispositionService.clear(tournamentId, forUser.id);

                await AuditService.log({
                    actor: interaction.user.id,
                    action: 'pick_disposition.clear',
                    target_type: 'tournament',
                    target_id: tournamentId,
                    details: JSON.stringify({ forUser: forUser.id }),
                    ip_address: 'discord',
                    correlation_id: interaction.id,
                });

                await interaction.editReply(`Cleared ${forUser.toString()}'s disposition — back to using their own queue.`);
                return;
            }
        } catch (error) {
            logError('Error in nominate-picker command:', error);
            await interaction.editReply('An error occurred while nominating the picker.');
        }
    },
};
