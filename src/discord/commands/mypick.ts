import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { PickAwardGate, PICK_AWARD_DISABLED_REPLY } from '../../services/PickAwardGate.js';
import { PickDispositionService, SelfNominationError } from '../../services/PickDispositionService.js';
import { BanService } from '../../services/BanService.js';
import { checkCooldown } from '../../utils/cooldown.js';

/**
 * `/my-pick` — the player-facing side of "next-win disposition" (ROADMAP,
 * locked 2026-08-09). Available to EVERYONE (not admin-gated) — it only
 * matters if the invoking player wins the currently active slot for the
 * chosen tournament. Mirrors `/pick-game`'s tournament autocomplete.
 */
async function resolveTournament(db: any, tournamentName: string) {
    return db.get(
        'SELECT id, name, game_room_id FROM tournaments WHERE name = ? COLLATE NOCASE AND is_active = 1',
        tournamentName,
    );
}

export const mypick: Command = {
    data: new SlashCommandBuilder()
        .setName('my-pick')
        .setDescription('Set what happens to YOUR pick if you win the current slot.')
        .addSubcommand(sub =>
            sub.setName('nominate')
                .setDescription("Hand your next win's pick to someone else.")
                .addStringOption(opt =>
                    opt.setName('tournament').setDescription('The tournament').setRequired(true).setAutocomplete(true)
                )
                .addUserOption(opt =>
                    opt.setName('user').setDescription('Who gets the pick if you win').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('forfeit')
                .setDescription('Pass your next win straight to the runner-up.')
                .addStringOption(opt =>
                    opt.setName('tournament').setDescription('The tournament').setRequired(true).setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('Back to "pick from my queue" (the default).')
                .addStringOption(opt =>
                    opt.setName('tournament').setDescription('The tournament').setRequired(true).setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Show your current disposition for a tournament.')
                .addStringOption(opt =>
                    opt.setName('tournament').setDescription('The tournament').setRequired(true).setAutocomplete(true)
                )
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name !== 'tournament') return;
        const db = await getDatabase();
        const rows = await db.all('SELECT name FROM tournaments WHERE is_active = 1');
        const filtered = rows
            .map((r: any) => r.name)
            .filter((name: string) => name.toLowerCase().includes(focusedOption.value.toLowerCase()))
            .slice(0, 25);
        await interaction.respond(filtered.map((name: string) => ({ name, value: name })));
    },

    async execute(interaction: ChatInputCommandInteraction) {
        const banCheck = await BanService.isIdentityBanned(interaction.user.id);
        if (banCheck.banned) {
            await interaction.reply({ content: 'This account is banned.', ephemeral: true });
            return;
        }

        const remaining = checkCooldown(interaction.user.id, 'my-pick', 5);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before using this again.`, ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        const tournamentName = interaction.options.getString('tournament', true);
        const db = await getDatabase();

        try {
            const tournament = await resolveTournament(db, tournamentName);
            if (!tournament) {
                await interaction.editReply(`Could not find an active tournament named '${tournamentName}'.`);
                return;
            }

            if (tournament.game_room_id) {
                const roomBanCheck = await BanService.isIdentityBanned(interaction.user.id, tournament.game_room_id);
                if (roomBanCheck.banned) {
                    await interaction.editReply('This account is banned.');
                    return;
                }
            }

            const pickEnabled = await PickAwardGate.isEnabled(tournament.game_room_id, tournament.id);
            if (!pickEnabled) {
                await interaction.editReply(PICK_AWARD_DISABLED_REPLY);
                return;
            }

            const userId = interaction.user.id;

            if (subcommand === 'status') {
                const disposition = await PickDispositionService.get(tournament.id, userId);
                if (!disposition) {
                    await interaction.editReply(`**${tournament.name}**: your disposition is \`use my queue\` (the default) — if you win, you'll be asked to pick as usual.`);
                    return;
                }
                if (disposition.disposition === 'nominate') {
                    await interaction.editReply(`**${tournament.name}**: if you win, the pick goes to <@${disposition.nominee_discord_id}>. Use \`/my-pick clear\` to revert.`);
                } else {
                    await interaction.editReply(`**${tournament.name}**: if you win, the pick is forfeited straight to the runner-up. Use \`/my-pick clear\` to revert.`);
                }
                return;
            }

            if (subcommand === 'clear') {
                await PickDispositionService.clear(tournament.id, userId);
                await interaction.editReply(`**${tournament.name}**: disposition cleared — back to \`use my queue\`.`);
                return;
            }

            if (subcommand === 'forfeit') {
                await PickDispositionService.set(tournament.id, userId, 'forfeit');
                await interaction.editReply(`**${tournament.name}**: if you win the current slot, your pick will be forfeited straight to the runner-up (no wait). This applies to your NEXT win only — use \`/my-pick clear\` to cancel.`);
                return;
            }

            if (subcommand === 'nominate') {
                const nominee = interaction.options.getUser('user', true);

                // Best-effort guild-membership check (design: "Nomination
                // VALIDITY at set-time" — uncertainty always degrades to
                // allowing the set; only a DEFINITIVE non-member is rejected).
                try {
                    if (tournament.game_room_id) {
                        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
                        const guildId = await GameRoomSettingsService.get(tournament.game_room_id, 'DISCORD_GUILD_ID');
                        if (guildId) {
                            const { getDiscordClient } = await import('../DiscordClient.js');
                            const client = getDiscordClient();
                            if (client?.isReady()) {
                                const isMember = await client.isMemberOfGuild(guildId, nominee.id);
                                if (!isMember) {
                                    await interaction.editReply(`${nominee.toString()} isn't a member of this server, so they can't be nominated.`);
                                    return;
                                }
                            }
                        }
                    }
                } catch {
                    // Uncertain — degrade to allowing the set (per design).
                }

                try {
                    await PickDispositionService.set(tournament.id, userId, 'nominate', nominee.id);
                } catch (err) {
                    if (err instanceof SelfNominationError) {
                        await interaction.editReply('You cannot nominate yourself. Use `/my-pick clear` if you meant to keep your own queue.');
                        return;
                    }
                    throw err;
                }

                await interaction.editReply(`**${tournament.name}**: if you win the current slot, ${nominee.toString()} will get the pick instead. This applies to your NEXT win only — use \`/my-pick clear\` to cancel.`);

                if (interaction.channel && 'send' in interaction.channel) {
                    await interaction.channel.send(`${interaction.user.toString()} has set up a pick hand-off to ${nominee.toString()} for **${tournament.name}** (applies on their next win).`).catch(() => {});
                }
                return;
            }
        } catch (error) {
            logError('Error in /my-pick command:', error);
            await interaction.editReply('An error occurred. Please try again.');
        }
    },
};
