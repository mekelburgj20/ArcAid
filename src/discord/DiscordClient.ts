import { Client, GatewayIntentBits, Collection, Events, REST, Routes } from 'discord.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { Command } from './commands/index.js';
import { ping } from './commands/ping.js';
import { setup } from './commands/setup.js';
import { mapuser } from './commands/mapuser.js';
import { pickgame } from './commands/pickgame.js';
import { submitscore } from './commands/submitscore.js';

export class DiscordClient {
    private client: Client;
    private commands: Collection<string, Command>;
    private readonly token: string;
    private readonly clientId: string;

    constructor() {
        this.token = process.env.DISCORD_BOT_TOKEN || '';
        this.clientId = process.env.DISCORD_CLIENT_ID || '';

        if (!this.token || !this.clientId) {
            throw new Error('Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID in environment.');
        }

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers // Required for identity mapping auto-match
            ]
        });

        this.commands = new Collection();
        this.registerCommands();
    }

    private registerCommands(): void {
        const commandList = [ping, setup, mapuser, pickgame, submitscore];
        for (const command of commandList) {
            this.commands.set(command.data.name, command);
        }
    }

    /**
     * Deploys the slash commands to Discord.
     */
    public async deployCommands(guildId?: string): Promise<void> {
        const rest = new REST({ version: '10' }).setToken(this.token);
        const body = this.commands.map(command => command.data.toJSON());

        try {
            logInfo(`Started refreshing ${body.length} application (/) commands.`);

            if (guildId) {
                // Guild-specific deployment (faster for testing)
                await rest.put(
                    Routes.applicationGuildCommands(this.clientId, guildId),
                    { body }
                );
            } else {
                // Global deployment
                await rest.put(
                    Routes.applicationCommands(this.clientId),
                    { body }
                );
            }

            logInfo(`Successfully reloaded application (/) commands.`);
        } catch (error) {
            logError('Error deploying commands:', error);
        }
    }

    /**
     * Connects to Discord and starts listening for events.
     */
    public async connect(): Promise<void> {
        this.client.once(Events.ClientReady, (readyClient) => {
            logInfo(`✅ Discord bot ready! Logged in as ${readyClient.user.tag}`);
        });

        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            const command = this.commands.get(interaction.commandName);
            if (!command) return;

            try {
                logInfo(`Executing command: /${interaction.commandName} (User: ${interaction.user.tag})`);
                await command.execute(interaction);
            } catch (error) {
                logError(`Error executing command /${interaction.commandName}:`, error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                }
            }
        });

        await this.client.login(this.token);
    }
}
