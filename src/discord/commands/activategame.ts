import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
// IScoredClient construction is owned by IScoredSessionRegistry.
import { getTournamentColor } from '../../utils/discord.js';
import { passesplatformRules, parsePlatformsList, parseTournamentRules, hasAnyPlatformRules } from '../../utils/platformRules.js';
import { catalogueTypeMatchesTournamentMode } from '../../utils/tournamentMode.js';

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
            // Filter by tournament mode, same as /pick-game's autocomplete
            // (catalogueTypeMatchesTournamentMode bridges tournament.mode
            // against global_games.type — see src/utils/tournamentMode.ts).
            const selectedTournamentName = interaction.options.getString('tournament');
            let tournamentMode: string | null = null;
            if (selectedTournamentName) {
                const tournamentRow = await db.get("SELECT mode FROM tournaments WHERE name = ? COLLATE NOCASE", selectedTournamentName);
                if (tournamentRow) {
                    tournamentMode = tournamentRow.mode;
                }
            }

            const rows = await db.all(
                `SELECT name, MIN(type) AS mode FROM global_games WHERE status = 'approved' GROUP BY LOWER(name) ORDER BY name`
            );
            let choices = rows;
            if (tournamentMode) {
                choices = choices.filter(r => catalogueTypeMatchesTournamentMode(r.mode, tournamentMode as string));
            }
            const filtered = choices
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
            const tournament = await db.get('SELECT id, type, mode, platform_rules, game_room_id FROM tournaments WHERE name = ? COLLATE NOCASE', tournamentName);

            if (!tournament) {
                await interaction.editReply(`Could not find a tournament named '${tournamentName}'.`);
                return;
            }

            // S22 Phase 2 (v2.44.0, M1 fix) — tournament name resolution is
            // NOT guild-scoped (autocomplete lists ALL active tournaments), so
            // the guild-level suspension gate (DiscordClient.ts) can't catch a
            // same-named tournament belonging to a DIFFERENT, suspended room.
            // Drift-audit fix: also rejects when the resolved room is
            // Discord-disabled/approval-gated or linked to a DIFFERENT guild
            // than the one this interaction came from — see discordWriteTarget.ts.
            if (tournament.game_room_id) {
                const { validateDiscordWriteTarget } = await import('../../utils/discordWriteTarget.js');
                const targetCheck = await validateDiscordWriteTarget(tournament.game_room_id, interaction.guildId);
                if (!targetCheck.allowed) {
                    await interaction.editReply(
                        targetCheck.denial === 'suspended'
                            ? 'This room has been suspended pending review. Game activation is disabled.'
                            : "That game belongs to a room this server isn't linked to."
                    );
                    return;
                }
            }

            // Enforce platform rules. Game's effective platforms = catalogue ∪ room tags.
            const platformRules = parseTournamentRules(tournament);
            if (hasAnyPlatformRules(platformRules)) {
                const gameLibRow = await db.get(
                    `SELECT platforms, features FROM global_games WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
                    gameName,
                );
                const cataloguePlatforms = parsePlatformsList(gameLibRow?.platforms || '[]');
                const { RoomGameTagsService } = await import('../../services/RoomGameTagsService.js');
                const roomTags = await RoomGameTagsService.getTagsForGameName(tournament.game_room_id, gameName);
                const gamePlatforms = Array.from(new Set([...cataloguePlatforms, ...roomTags]));
                const gameFeatures = parsePlatformsList(gameLibRow?.features || '[]');
                if (!passesplatformRules(gamePlatforms, platformRules, gameFeatures)) {
                    await interaction.editReply(`**${gameName}** does not meet the platform requirements for **${tournamentName}**.`);
                    return;
                }
            }

            const term = getTerminology(tournament.mode);
            const engine = TournamentEngine.getInstance();

            const styleId: string | undefined = undefined;

            await interaction.editReply(`Creating **${gameName}** on iScored... This may take a moment.`);

            // Create game on iScored if credentials available (per-room → env fallback).
            let iscoredId: string | undefined;
            const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
            const creds = await getIScoredCredsForRoom(tournament.game_room_id);
            if (creds) {
                const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                iscoredId = await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                    const id = await client.createGame(gameName, styleId);
                    await client.setGameTags(id, tournament.type);
                    await client.setGameStatus(id, { locked: false, hidden: false });
                    return id;
                });
            }

            // Activate in DB without completing existing active games
            await db.exec('BEGIN TRANSACTION');
            try {
                await engine.activateGame(tournament.id, gameName, styleId, iscoredId, false);
                await db.exec('COMMIT');
            } catch (dbError) {
                await db.exec('ROLLBACK');
                // v2.103.0 duplicate-activation guard — friendly reply, not
                // the generic error path.
                const { DuplicateActiveGameError } = await import('../../engine/TournamentEngine.js');
                if (dbError instanceof DuplicateActiveGameError) {
                    await interaction.editReply(`${dbError.message} Deactivate it first if you mean to restart it.`);
                    return;
                }
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
