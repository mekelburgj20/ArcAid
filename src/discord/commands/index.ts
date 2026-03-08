import { ChatInputCommandInteraction, AutocompleteInteraction, SlashCommandBuilder, SharedSlashCommand } from 'discord.js';

export interface Command {
    data: any;
    execute(interaction: ChatInputCommandInteraction): Promise<void>;
    autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}
