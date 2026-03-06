import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
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
            // For picking a new game, we usually search the entire history or a master list.
            // Since we rely heavily on iScored tags (or historical games), we'll query all unique game names.
            const rows = await db.all("SELECT DISTINCT name FROM games");
            const choices = rows.map(r => r.name);
            
            const filtered = choices.filter(choice => 
                choice.toLowerCase().includes(focusedOption.value.toLowerCase())
            ).slice(0, 25);
            
            await interaction.respond(
                filtered.map(choice => ({ name: choice, value: choice }))
            );
        }
    },
        
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        
        const term = getTerminology();
        const tournamentName = interaction.options.getString('tournament', true);
        const gameName = interaction.options.getString('game_name', true);

        try {
            const db = await getDatabase();
            const tournament = await db.get('SELECT id FROM tournaments WHERE name = ? COLLATE NOCASE', tournamentName);

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

            // For now, directly activate it. (A full implementation would queue it if another game is active).
            await engine.activateGame(tournament.id, gameName);

            logInfo(`User ${interaction.user.tag} picked ${gameName} for ${tournamentName}`);
            await interaction.editReply(`🎉 Successfully picked **${gameName}** for the **${tournamentName}** ${term.tournament}!`);

        } catch (error) {
            logError('Error in /pick-game:', error);
            await interaction.editReply('❌ An error occurred while picking the game.');
        }
    },
};
