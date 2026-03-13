import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { getTournamentColor } from '../../utils/discord.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Checks if a game passes a tournament's platform rules.
 */
function passesplatformRules(
    gamePlatforms: string[],
    rules: { required: string[]; excluded: string[] }
): boolean {
    const upper = gamePlatforms.map(p => p.toUpperCase());

    if (rules.required.length > 0) {
        const hasRequired = rules.required.some(rp => upper.includes(rp.toUpperCase()));
        if (!hasRequired) return false;
    }

    if (rules.excluded.length > 0) {
        const hasExcluded = rules.excluded.some(ep => upper.includes(ep.toUpperCase()));
        if (hasExcluded) return false;
    }

    return true;
}

export const pickgame: Command = {
    data: new SlashCommandBuilder()
        .setName('pick-game')
        .setDescription('Pick the next game for a tournament.')
        .addStringOption(option =>
            option.setName('tournament')
                .setDescription('The tournament to pick for')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option.setName('game_name')
                .setDescription('The name of the game')
                .setRequired(true)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const db = await getDatabase();

        if (focusedOption.name === 'tournament') {
            const rows = await db.all("SELECT name FROM tournaments WHERE is_active = 1");
            const choices = rows.map(r => r.name);

            const filtered = choices.filter(choice =>
                choice.toLowerCase().includes(focusedOption.value.toLowerCase())
            ).slice(0, 25);

            await interaction.respond(
                filtered.map(choice => ({ name: choice, value: choice }))
            );
        }
        else if (focusedOption.name === 'game_name') {
            const selectedTournamentName = interaction.options.getString('tournament');
            let tournamentId: string | null = null;
            let tournamentMode: string | null = null;
            let platformRules = { required: [] as string[], excluded: [] as string[] };

            if (selectedTournamentName) {
                const tournamentRow = await db.get("SELECT id, type, mode, platform_rules FROM tournaments WHERE name = ? COLLATE NOCASE", selectedTournamentName);
                if (tournamentRow) {
                    tournamentId = tournamentRow.id;
                    tournamentMode = tournamentRow.mode;
                    try { platformRules = { ...platformRules, ...JSON.parse(tournamentRow.platform_rules || '{}') }; } catch {}
                }
            }

            // Fetch from the master Game Library
            const rows = await db.all("SELECT name, mode, platforms FROM game_library");

            let choices = rows;

            // Filter by tournament mode
            if (tournamentMode) {
                choices = choices.filter(r => r.mode === tournamentMode);
            }

            // Filter by platform rules
            choices = choices.filter(r => {
                let gamePlatforms: string[] = [];
                try { gamePlatforms = JSON.parse(r.platforms || '[]'); } catch {}
                return passesplatformRules(gamePlatforms, platformRules);
            });

            // Filter by what the user is currently typing
            const filtered = choices
                .filter(r => r.name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);

            // Check eligibility for display labels
            const engine = TournamentEngine.getInstance();
            const results = await Promise.all(filtered.map(async (r) => {
                if (!tournamentId) return { name: r.name, label: r.name };
                const eligible = await engine.isGameEligible(tournamentId, r.name);
                const label = eligible ? r.name : `${r.name} (recently played)`;
                return { name: r.name, label };
            }));

            await interaction.respond(
                results.map(r => ({ name: r.label, value: r.name }))
            );
        }
    },

    async execute(interaction: ChatInputCommandInteraction) {
        const remaining = checkCooldown(interaction.user.id, 'pick-game', 10);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before picking again.`, ephemeral: true });
            return;
        }

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

            // Check eligibility
            const isEligible = await engine.isGameEligible(tournament.id, gameName);
            if (!isEligible) {
                await interaction.editReply(`**${gameName}** has been played recently and is not eligible right now.`);
                return;
            }

            // Look up style_id from game_library
            const gameLibEntry = await db.get('SELECT style_id FROM game_library WHERE name = ? COLLATE NOCASE', gameName);
            const styleId = gameLibEntry?.style_id || undefined;

            await interaction.editReply(`Creating **${gameName}** on iScored... This may take a moment.`);

            // Create game on iScored
            const client = new IScoredClient();
            await client.connect();
            let iscoredId: string;
            try {
                iscoredId = await client.createGame(gameName, styleId);

                // Apply the tournament tag and unlock the game
                await client.setGameTags(iscoredId, tournament.type);
                await client.setGameStatus(iscoredId, { locked: false, hidden: false });
            } finally {
                await client.disconnect();
            }

            // Activate locally in a transaction
            await db.exec('BEGIN TRANSACTION');
            try {
                await engine.activateGame(tournament.id, gameName, styleId, iscoredId);
                await db.exec('COMMIT');
            } catch (dbError) {
                await db.exec('ROLLBACK');
                throw dbError;
            }

            logInfo(`User ${interaction.user.tag} picked ${gameName} for ${tournamentName}`);
            const color = getTournamentColor(tournament.type);

            // Check if the game is now active (no other active game) or queued behind one
            const activeGame = await db.get(
                'SELECT id FROM games WHERE tournament_id = ? AND status = ? AND name != ? COLLATE NOCASE',
                tournament.id, 'ACTIVE', gameName
            );
            const statusText = activeGame
                ? `**${gameName}** has been queued for the **${tournamentName}** tournament.`
                : `**${gameName}** is now active for the **${tournamentName}** tournament — play immediately!`;

            const embed = new EmbedBuilder()
                .setTitle(`${term.game} Picked!`)
                .setDescription(statusText)
                .setColor(color)
                .setFooter({ text: `Picked by ${interaction.user.displayName}` })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logError('Error in /pick-game:', error);
            await interaction.editReply('An error occurred while picking the game. Check the logs for details.');
        }
    },
};
