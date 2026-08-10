import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';

export const deactivategame: Command = {
    data: new SlashCommandBuilder()
        .setName('deactivate-game')
        .setDescription('(Admin) Deactivate an active game — captures pending scores, locks on iScored, marks completed.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('game')
                .setDescription('The active game to deactivate')
                .setRequired(true)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const db = await getDatabase();

        if (focusedOption.name === 'game') {
            const rows = await db.all(
                `SELECT g.id, g.name, t.name as tournament_name
                 FROM games g JOIN tournaments t ON g.tournament_id = t.id
                 WHERE g.status = 'ACTIVE'
                 ORDER BY g.start_date DESC`
            );
            const filtered = rows
                .filter(r => r.name.toLowerCase().includes(focusedOption.value.toLowerCase())
                    || r.tournament_name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);
            await interaction.respond(
                filtered.map(r => ({ name: `${r.name} (${r.tournament_name})`, value: r.id }))
            );
        }
    },

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const gameId = interaction.options.getString('game', true);

        try {
            const db = await getDatabase();

            // Drift-audit fix — the same guild-scoping gap its siblings
            // (activate-game, pick-game, submit-score, force-maintenance) got
            // fixed for in v2.44.0 M1: `game` autocomplete lists ALL active
            // games regardless of the invoking guild, so the guild-level gate
            // can't catch a game belonging to a DIFFERENT room. Also rejects a
            // room that's Discord-disabled/approval-gated or linked to a
            // DIFFERENT guild — see discordWriteTarget.ts.
            const gameRow = await db.get(
                `SELECT g.id, t.game_room_id FROM games g LEFT JOIN tournaments t ON g.tournament_id = t.id WHERE g.id = ?`,
                gameId,
            );
            if (gameRow?.game_room_id) {
                const { validateDiscordWriteTarget } = await import('../../utils/discordWriteTarget.js');
                const targetCheck = await validateDiscordWriteTarget(gameRow.game_room_id, interaction.guildId);
                if (!targetCheck.allowed) {
                    await interaction.editReply(
                        targetCheck.denial === 'suspended'
                            ? 'This room has been suspended pending review. Game deactivation is disabled.'
                            : "That game belongs to a room this server isn't linked to."
                    );
                    return;
                }
            }

            const engine = TournamentEngine.getInstance();
            const result = await engine.deactivateGame(gameId);

            logInfo(`Admin ${interaction.user.tag} deactivated ${result.gameName} from ${result.tournamentName}`);
            const captured = result.finalSyncedScores ?? 0;
            const capturedSuffix = captured > 0 ? ` Captured ${captured} late score${captured === 1 ? '' : 's'} from iScored before lock.` : '';
            let iScoredLine: string;
            if (result.iscoredStatus === 'locked') {
                iScoredLine = 'Locked on iScored (game stays visible, no new submissions).';
            } else if (result.iscoredStatus === 'shared') {
                iScoredLine = 'iScored game left unlocked (still active in another tournament).';
            } else if (result.iscoredStatus === 'failed') {
                iScoredLine = `iScored lock failed (${result.iscoredError ?? 'unknown'}). Lock it manually on iScored.`;
            } else {
                iScoredLine = 'iScored not configured for this room.';
            }
            const embed = new EmbedBuilder()
                .setTitle('Game Deactivated')
                .setDescription(`**${result.gameName}** has been deactivated from **${result.tournamentName}**.\nScores have been preserved.${capturedSuffix} ${iScoredLine}`)
                .setColor(0xFF6B6B)
                .setFooter({ text: `Deactivated by ${interaction.user.displayName}` })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logError('Error in /deactivate-game:', error);
            await interaction.editReply(message);
        }
    },
};
