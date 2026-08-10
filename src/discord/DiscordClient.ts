import { Client, GatewayIntentBits, Collection, Events, REST, Routes, Message } from 'discord.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { emitBotStatus } from '../api/websocket.js';
import { Command } from './commands/index.js';
import { ping } from './commands/ping.js';
import { setup } from './commands/setup.js';
import { mapuser } from './commands/mapuser.js';
import { pickgame } from './commands/pickgame.js';
import { submitscore } from './commands/submitscore.js';
import { listactive } from './commands/listactive.js';
import { listscores } from './commands/listscores.js';
import { viewstats } from './commands/viewstats.js';
import { listwinners } from './commands/listwinners.js';
import { viewselection } from './commands/viewselection.js';
import { forcemaintenance } from './commands/forcemaintenance.js';
import { syncstate } from './commands/syncstate.js';
import { runcleanup } from './commands/runcleanup.js';
import { createbackup } from './commands/createbackup.js';
import { pausepick } from './commands/pausepick.js';
import { nominatepicker } from './commands/nominatepicker.js';
import { mypick } from './commands/mypick.js';
import { mystats } from './commands/mystats.js';
import { activategame } from './commands/activategame.js';
import { deactivategame } from './commands/deactivategame.js';
import { reorderlineup } from './commands/reorderlineup.js';
import { notifications } from './commands/notifications.js';
import fs from 'fs';
import path from 'path';

/**
 * Module-level handle to the live DiscordClient, set in the constructor so
 * route/service code (e.g. the S10 /admin/health endpoint) can query real
 * gateway readiness + guild membership. Null when Discord isn't configured
 * (the constructor throws before assigning if creds are missing, and
 * index.ts only constructs it when canStartBot) — callers must null-check and
 * treat null as "not ready".
 */
let _instance: DiscordClient | null = null;

export function getDiscordClient(): DiscordClient | null {
    return _instance;
}

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

        // Register this live instance so route/service code can reach real
        // gateway state via getDiscordClient() (S10 health surface).
        _instance = this;
    }

    private registerCommands(): void {
        const commandList = [
            ping, setup, mapuser, pickgame, submitscore,
            listactive, listscores, viewstats, listwinners, viewselection,
            forcemaintenance, syncstate, runcleanup, createbackup, pausepick, nominatepicker, mystats,
            activategame, deactivategame, reorderlineup, notifications, mypick
        ];
        for (const command of commandList) {
            this.commands.set(command.data.name, command);
        }
    }

    /**
     * True once the Discord gateway has fired ClientReady. Reflects real
     * connection state (not env-var presence) for the S10 health surface.
     */
    public isReady(): boolean {
        return this.client.isReady();
    }

    /**
     * Whether the bot is currently a member of the given guild. Reads the
     * gateway's guild cache (populated under the Guilds intent). Returns false
     * when the gateway isn't ready yet.
     */
    public isInGuild(guildId: string): boolean {
        return this.client.guilds.cache.has(guildId);
    }

    /**
     * Whether `userId` is a member of `guildId` (Discord HQ arc, v2.72.0).
     *
     * This is the deliverability primitive behind `DiscordReachabilityService`:
     * a bot may DM a user only while they share at least one guild, so
     * membership here is the closest thing to a "can I DM them?" probe that
     * does not involve actually sending a message.
     *
     * Reads via `guild.members.fetch(userId)`, which needs the SERVER MEMBERS
     * (`GatewayIntentBits.GuildMembers`) privileged intent — already requested
     * in this client's constructor (see `intents` above), so no portal change
     * is implied by this method existing.
     *
     * Returns false — never throws — for: gateway not ready, bot not in the
     * guild, unknown member (Discord error 10007), or any transport failure.
     * Callers must treat false as "unknown or absent", not as proof of
     * non-membership.
     */
    public async isMemberOfGuild(guildId: string, userId: string): Promise<boolean> {
        try {
            if (!this.client.isReady()) return false;
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return false;
            const member = await guild.members.fetch(userId);
            return !!member;
        } catch {
            // 10007 Unknown Member is the expected "not a member" path; every
            // other failure (rate limit, transport) degrades the same way.
            return false;
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
            logInfo(`Discord bot ready! Logged in as ${readyClient.user.tag}`);
            emitBotStatus({ online: true });
        });

        this.client.on(Events.MessageCreate, async (message: Message) => {
            if (message.author.bot) return;
            if (process.env.ENABLE_CALLOUTS !== 'true') return;

            const content = message.content.toLowerCase();
            const calloutsPath = path.join(process.cwd(), 'data', 'callouts.json');
            
            if (fs.existsSync(calloutsPath)) {
                try {
                    const callouts = JSON.parse(fs.readFileSync(calloutsPath, 'utf8'));
                    for (const entry of callouts) {
                        const allTriggers: string[] = entry.triggers;
                        const inclusionTriggers = allTriggers.filter(t => !t.startsWith('!'));
                        const exclusionTriggers = allTriggers.filter(t => t.startsWith('!')).map(t => t.slice(1));

                        const hasInclusion = inclusionTriggers.some((trigger: string) => {
                            const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            return new RegExp(`\\b${escaped}\\b`, 'i').test(content);
                        });

                        if (hasInclusion) {
                            const isExcluded = exclusionTriggers.some((trigger: string) => {
                                const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                return new RegExp(`\\b${escaped}\\b`).test(message.content);
                            });

                            if (!isExcluded) {
                                const response = entry.responses[Math.floor(Math.random() * entry.responses.length)];
                                await message.reply(response);
                                return;
                            }
                        }
                    }
                } catch (e) {
                    logError('Failed to load or parse callouts.json:', e);
                }
            }
        });

        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (interaction.isAutocomplete()) {
                const command = this.commands.get(interaction.commandName);
                if (!command || !command.autocomplete) return;

                try {
                    await command.autocomplete(interaction);
                } catch (error) {
                    logError(`Error in autocomplete for ${interaction.commandName}:`, error);
                }
                return;
            }

            if (!interaction.isChatInputCommand()) return;

            const command = this.commands.get(interaction.commandName);
            if (!command) return;

            // Per-room gate: if this guild maps to a room that has Discord
            // integration disabled OR is suspended (S22 Phase 2, v2.44.0),
            // refuse. Covers slash commands the same way
            // `resolveAnnouncementChannelId` gates outbound announcements.
            // DM interactions (no guildId) and guilds not linked to any room
            // fall through to normal handling. See `guildInteractionBlockReason`
            // for the combined check (extracted for unit-testability).
            if (interaction.guildId) {
                try {
                    const { guildInteractionBlockReason } = await import('../utils/discord.js');
                    const blockReason = await guildInteractionBlockReason(interaction.guildId);
                    if (blockReason) {
                        await interaction.reply({ content: blockReason, ephemeral: true });
                        return;
                    }
                } catch (gateErr) {
                    logError('Discord-enabled/suspension gate check failed — allowing command:', gateErr);
                }
            }

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
