import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getTerminology } from '../../utils/terminology.js';
import { getDatabase } from '../../database/database.js';
import { logInfo } from '../../utils/logger.js';

export const setup: Command = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Initial setup and configuration for ArcAid.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('terminology')
                .setDescription('Select the naming convention for your server.')
                .setRequired(true)
                .addChoices(
                    { name: 'Pinball Legacy (Tables/Grinds)', value: 'legacy' },
                    { name: 'Generic (Games/Tournaments)', value: 'generic' }
                )
        ) as SlashCommandBuilder,
    async execute(interaction: ChatInputCommandInteraction) {
        const mode = interaction.options.getString('terminology', true);
        const db = await getDatabase();

        logInfo(`User ${interaction.user.tag} updated terminology mode to: ${mode}`);

        // Update in database (Settings table)
        await db.run(
            'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
            'TERMINOLOGY_MODE', mode
        );

        // Also update env for current session (though process will need restart for full effect if not handled dynamically)
        process.env.TERMINOLOGY_MODE = mode;

        const term = getTerminology();
        await interaction.reply(`✅ Setup complete! ArcAid will now use **${mode}** terminology (e.g., ${term.games} and ${term.tournaments}).`);
    },
};
