import { ChatInputCommandInteraction, AutocompleteInteraction, SlashCommandBuilder } from 'discord.js';

export interface Command {
    data: SlashCommandBuilder | Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">;
    execute(interaction: ChatInputCommandInteraction): Promise<void>;
    autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}
