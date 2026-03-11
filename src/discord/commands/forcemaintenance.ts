import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { logError } from '../../utils/logger.js';

export const forcemaintenance: Command = {
    data: new SlashCommandBuilder()
        .setName('force-maintenance')
        .setDescription('(Admin) Manually trigger a tournament rotation.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('tournament')
                .setDescription('The tournament to run maintenance for')
                .setRequired(true)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const db = await getDatabase();
        const focused = interaction.options.getFocused();
        const rows = await db.all("SELECT id, name FROM tournaments WHERE is_active = 1");
        const filtered = rows
            .filter((r: any) => r.name.toLowerCase().includes(focused.toLowerCase()))
            .slice(0, 25);
        await interaction.respond(filtered.map((r: any) => ({ name: r.name, value: r.id })));
    },

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });
        const tournamentId = interaction.options.getString('tournament', true);
        const engine = TournamentEngine.getInstance();

        try {
            const db = await getDatabase();
            const row = await db.get('SELECT name FROM tournaments WHERE id = ?', tournamentId);
            const name = row?.name || tournamentId;

            await engine.runMaintenance(tournamentId);
            await interaction.editReply(`Maintenance for **${name}** has been manually triggered and completed.`);
        } catch (error) {
            logError('Error in force-maintenance command:', error);
            await interaction.editReply('An error occurred while running maintenance.');
        }
    },
};
