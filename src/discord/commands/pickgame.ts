import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { v4 as uuidv4 } from 'uuid';

export const pickgame: Command = {
    data: new SlashCommandBuilder()
        .setName('pick-game')
        .setDescription(`Pick the next ${getTerminology().game} for a ${getTerminology().tournament}.`)
        .addStringOption(option =>
            option.setName('tournament')
                .setDescription(`The ${getTerminology().tournament} to pick for`)
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option.setName('game_name')
                .setDescription(`The name of the ${getTerminology().game}`)
                .setRequired(true)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const db = await getDatabase();

        if (focusedOption.name === 'tournament') {
            // Fetch active tournaments
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
            // Fetch the currently selected tournament to filter games by type
            const selectedTournamentName = interaction.options.getString('tournament');
            let tournamentType = null;
            
            if (selectedTournamentName) {
                const tournamentRow = await db.get("SELECT type FROM tournaments WHERE name = ? COLLATE NOCASE", selectedTournamentName);
                if (tournamentRow) {
                    tournamentType = tournamentRow.type;
                }
            }

            // Fetch from the master Game Library
            const rows = await db.all("SELECT name, tournament_types FROM game_library");
            
            let choices = rows;
            
            // Filter by tournament type if one is selected
            if (tournamentType) {
                choices = choices.filter(r => {
                    if (!r.tournament_types) return true; // If no tags, assume eligible for all
                    const tags = r.tournament_types.split(',').map((t: string) => t.trim().toUpperCase());
                    return tags.includes(tournamentType.toUpperCase());
                });
            }
            
            // Filter by what the user is currently typing
            const filtered = choices
                .map(r => r.name)
                .filter(name => name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);
            
            await interaction.respond(
                filtered.map(choice => ({ name: choice, value: choice }))
            );
        }
    },
        
    async execute(interaction: ChatInputCommandInteraction) {
        // Check cooldown (10 seconds)
        const remaining = checkCooldown(interaction.user.id, 'pick-game', 10);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before picking again.`, ephemeral: true });
            return;
        }

        await interaction.deferReply();

        const term = getTerminology();
        const tournamentName = interaction.options.getString('tournament', true);
        const gameName = interaction.options.getString('game_name', true);

        try {
            const db = await getDatabase();
            const tournament = await db.get('SELECT id, type FROM tournaments WHERE name = ? COLLATE NOCASE', tournamentName);

            if (!tournament) {
                await interaction.editReply(`❌ Could not find a ${term.tournament} named '${tournamentName}'.`);
                return;
            }

            const engine = TournamentEngine.getInstance();
            
            // Check eligibility
            const isEligible = await engine.isGameEligible(tournament.id, gameName);
            if (!isEligible) {
                await interaction.editReply(`🚫 **${gameName}** has been played recently and is not eligible right now.`);
                return;
            }

            // Look up style_id from game_library
            const gameLibEntry = await db.get('SELECT style_id FROM game_library WHERE name = ? COLLATE NOCASE', gameName);
            const styleId = gameLibEntry?.style_id || undefined;

            await interaction.editReply(`⏳ Creating **${gameName}** on iScored... This may take a moment.`);

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

            // Activate locally in a transaction — if this fails, the iScored game
            // still exists but we don't have a dangling DB entry
            await db.exec('BEGIN TRANSACTION');
            try {
                await engine.activateGame(tournament.id, gameName, styleId, iscoredId);
                await db.exec('COMMIT');
            } catch (dbError) {
                await db.exec('ROLLBACK');
                throw dbError;
            }

            logInfo(`User ${interaction.user.tag} picked ${gameName} for ${tournamentName}`);
            await interaction.editReply(`🎉 Successfully created and picked **${gameName}** for the **${tournamentName}** ${term.tournament}!`);

        } catch (error) {
            logError('Error in /pick-game:', error);
            await interaction.editReply('❌ An error occurred while picking the game. Check the logs for details.');
        }
    },
};
