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
import { buildGameAutocompleteChoices } from '../gameAutocomplete.js';
import { queueGameOnBehalf, notifyQueuedOnBehalf } from '../../services/PickQueueService.js';
import { trackBackground } from '../../utils/backgroundTasks.js';

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
        )
        // v2.121.0 — queue-on-behalf ("I won't be around to pick but I want
        // Medieval Madness if I win"). Always QUEUES, never activates: see
        // `PickQueueService.queueGameOnBehalf`.
        .addSubcommand(sub =>
            sub.setName('queue')
                .setDescription("Queue a game in a player's own pick queue on their behalf.")
                .addStringOption(option => option.setName('tournament-id').setDescription('ID of the tournament').setRequired(true))
                .addUserOption(option => option.setName('for-user').setDescription('The player whose queue this goes in').setRequired(true))
                .addStringOption(option =>
                    option.setName('game').setDescription('The game to queue').setRequired(true).setAutocomplete(true)
                )
        ) as SlashCommandBuilder,

    // The `game` option offers exactly what `/pick-game` offers — same helper,
    // same tournament-derived mode/platform-rule filter — so an admin can't be
    // shown something the shared eligibility pipeline would then reject. Guild
    // scoped: a tournament outside this guild yields an empty list, never a
    // catalogue dump for someone else's room.
    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'game') {
            await interaction.respond([]);
            return;
        }

        const scope = await resolveGuildReadScope(interaction.guildId);
        if (!scope) {
            await interaction.respond([]);
            return;
        }

        const tournamentId = interaction.options.getString('tournament-id');
        if (!tournamentId) {
            await interaction.respond([]);
            return;
        }

        const db = await getDatabase();
        const tournament = await db.get(
            'SELECT id, mode, platform_rules, game_room_id FROM tournaments WHERE id = ?',
            tournamentId,
        );
        if (!tournament || !isRoomInGuildScope(tournament.game_room_id ?? null, scope)) {
            await interaction.respond([]);
            return;
        }

        await interaction.respond(await buildGameAutocompleteChoices(tournament, focused.value));
    },

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
                // v2.120.2 — `UPDATE ... LIMIT 1` is not valid in stock SQLite
                // (it needs the optional SQLITE_ENABLE_UPDATE_DELETE_LIMIT
                // compile flag, which the bundled build does not set), so this
                // branch threw `SQLITE_ERROR: near "LIMIT"` on every run and
                // replied with the generic error message. Rewritten as an
                // id-subquery, which expresses the same "exactly one row"
                // intent portably. Selection semantics are unchanged: the same
                // WHERE, and — since the original had no ORDER BY — the same
                // arbitrary-but-stable pick, made explicit as `rowid` (the
                // order SQLite scanned in) so it can't drift.
                await db.run(`
                    UPDATE games
                    SET picker_discord_id = ?, picker_type = 'WINNER', picker_designated_at = ?
                    WHERE id = (
                        SELECT id FROM games
                        WHERE tournament_id = ? AND status = 'QUEUED'
                        ORDER BY rowid ASC
                        LIMIT 1
                    )
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

            if (subcommand === 'queue') {
                const forUser = interaction.options.getUser('for-user', true);
                const gameName = interaction.options.getString('game', true);

                if (!tournament.game_room_id) {
                    await interaction.editReply("That tournament isn't attached to a game room, so a queue can't be resolved for it.");
                    return;
                }

                // Identical pipeline to the player's own `/pick-game` queue
                // branch (mode, platform rules, cooldown, max-5 cap) plus a
                // duplicate guard — typed rejection reasons come back as
                // ready-to-render copy.
                const result = await queueGameOnBehalf({
                    roomId: tournament.game_room_id,
                    tournamentId,
                    gameName,
                    forUserId: forUser.id,
                });

                if (!result.ok) {
                    await interaction.editReply(result.message);
                    return;
                }

                await AuditService.log({
                    actor: interaction.user.id,
                    action: 'pick.queue_on_behalf',
                    target_type: 'tournament',
                    target_id: tournamentId,
                    details: JSON.stringify({ forUserId: forUser.id, gameName: result.game.name, tournamentId }),
                    ip_address: 'discord',
                    correlation_id: interaction.id,
                });

                trackBackground(notifyQueuedOnBehalf({
                    forUserId: forUser.id,
                    roomId: tournament.game_room_id,
                    tournamentName: result.tournament.name,
                    gameName: result.game.name,
                })).catch(() => {});

                const queueList = result.queue.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
                await interaction.editReply(
                    `Queued **${result.game.name}** for ${forUser.toString()} in **${result.tournament.name}**. ` +
                    `If they win the next round it becomes their pick.\n\nTheir queue now:\n${queueList}`,
                );
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
