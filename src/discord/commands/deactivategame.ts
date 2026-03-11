import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';

export const deactivategame: Command = {
    data: new SlashCommandBuilder()
        .setName('deactivate-game')
        .setDescription('(Admin) Deactivate an active game — locks on iScored and marks completed.')
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
            const engine = TournamentEngine.getInstance();
            const result = await engine.deactivateGame(gameId);

            logInfo(`Admin ${interaction.user.tag} deactivated ${result.gameName} from ${result.tournamentName}`);
            const embed = new EmbedBuilder()
                .setTitle('Game Deactivated')
                .setDescription(`**${result.gameName}** has been deactivated from **${result.tournamentName}**.\nScores have been preserved. The game is locked on iScored.`)
                .setColor(0xFF6B6B)
                .setFooter({ text: `Deactivated by ${interaction.user.displayName}` })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logError('Error in /deactivate-game:', error);
            await interaction.editReply(`❌ ${message}`);
        }
    },
};
