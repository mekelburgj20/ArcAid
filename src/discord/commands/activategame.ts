import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { getTournamentColor } from '../../utils/discord.js';

export const activategame: Command = {
    data: new SlashCommandBuilder()
        .setName('activate-game')
        .setDescription('(Admin) Immediately activate a game for a tournament.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('tournament')
                .setDescription('The tournament to activate for')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option.setName('game_name')
                .setDescription('The name of the game to activate')
                .setRequired(true)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const db = await getDatabase();

        if (focusedOption.name === 'tournament') {
            const rows = await db.all("SELECT name FROM tournaments WHERE is_active = 1");
            const filtered = rows
                .map(r => r.name)
                .filter((name: string) => name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);
            await interaction.respond(filtered.map((name: string) => ({ name, value: name })));
        } else if (focusedOption.name === 'game_name') {
            const rows = await db.all("SELECT name FROM game_library");
            const filtered = rows
                .map(r => r.name)
                .filter((name: string) => name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);
            await interaction.respond(filtered.map((name: string) => ({ name, value: name })));
        }
    },

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const tournamentName = interaction.options.getString('tournament', true);
        const gameName = interaction.options.getString('game_name', true);

        try {
            const db = await getDatabase();
            const tournament = await db.get('SELECT id, type, mode FROM tournaments WHERE name = ? COLLATE NOCASE', tournamentName);

            if (!tournament) {
                await interaction.editReply(`Could not find a tournament named '${tournamentName}'.`);
                return;
            }

            const term = getTerminology(tournament.mode);
            const engine = TournamentEngine.getInstance();

            // Look up style_id from game_library
            const gameLibEntry = await db.get('SELECT style_id FROM game_library WHERE name = ? COLLATE NOCASE', gameName);
            const styleId = gameLibEntry?.style_id || undefined;

            await interaction.editReply(`Creating **${gameName}** on iScored... This may take a moment.`);

            // Create game on iScored if credentials available
            let iscoredId: string | undefined;
            const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
            if (hasCredentials) {
                const client = new IScoredClient();
                try {
                    await client.connect();
                    iscoredId = await client.createGame(gameName, styleId);
                    await client.setGameTags(iscoredId, tournament.type);
                    await client.setGameStatus(iscoredId, { locked: false, hidden: false });
                } finally {
                    await client.disconnect();
                }
            }

            // Activate in DB without completing existing active games
            await db.exec('BEGIN TRANSACTION');
            try {
                await engine.activateGame(tournament.id, gameName, styleId, iscoredId, false);
                await db.exec('COMMIT');
            } catch (dbError) {
                await db.exec('ROLLBACK');
                throw dbError;
            }

            logInfo(`Admin ${interaction.user.tag} activated ${gameName} for ${tournamentName}`);
            const color = getTournamentColor(tournament.type);
            const embed = new EmbedBuilder()
                .setTitle(`${term.game} Activated`)
                .setDescription(`**${gameName}** is now active for **${tournamentName}**.`)
                .setColor(color)
                .setFooter({ text: `Activated by ${interaction.user.displayName}` })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logError('Error in /activate-game:', error);
            await interaction.editReply('An error occurred while activating the game. Check the logs for details.');
        }
    },
};
