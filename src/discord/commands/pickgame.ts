import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
// IScoredClient construction is owned by IScoredSessionRegistry.
import { checkCooldown } from '../../utils/cooldown.js';
import { getTournamentColor } from '../../utils/discord.js';
import { passesplatformRules, parsePlatformsList } from '../../utils/platformRules.js';
import { PickAwardGate, PICK_AWARD_DISABLED_REPLY } from '../../services/PickAwardGate.js';
import { BanService } from '../../services/BanService.js';
import { v4 as uuidv4 } from 'uuid';
// TODO(§8): gate /mystery-award when that command is authored (Q6 — out of scope for Sprint 5).

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
            let tournamentRoomId: string | null = null;
            let platformRules = { required: [] as string[], excluded: [] as string[] };

            if (selectedTournamentName) {
                const tournamentRow = await db.get("SELECT id, type, mode, platform_rules, game_room_id FROM tournaments WHERE name = ? COLLATE NOCASE", selectedTournamentName);
                if (tournamentRow) {
                    tournamentId = tournamentRow.id;
                    tournamentMode = tournamentRow.mode;
                    tournamentRoomId = tournamentRow.game_room_id;
                    try { platformRules = { ...platformRules, ...JSON.parse(tournamentRow.platform_rules || '{}') }; } catch {}
                }
            }

            // Fetch the catalogue for autocomplete (one row per name).
            const rows = await db.all(`
                SELECT name, MIN(type) AS mode, MIN(platforms) AS platforms
                FROM global_games WHERE status = 'approved'
                GROUP BY LOWER(name)
            `);

            // Pre-load this room's tag map (name → tags) so the platform-rule
            // filter unions room tags into each game's effective platforms.
            // Single query — much cheaper than per-game lookup at autocomplete
            // latencies.
            let tagMap: Map<string, string[]> = new Map();
            if (tournamentRoomId) {
                const { RoomGameTagsService } = await import('../../services/RoomGameTagsService.js');
                tagMap = await RoomGameTagsService.getTagMapByGameNameForRoom(tournamentRoomId);
            }

            let choices = rows;

            // Filter by tournament mode
            if (tournamentMode) {
                choices = choices.filter(r => r.mode === tournamentMode);
            }

            // Filter by platform rules
            choices = choices.filter(r => {
                const cataloguePlatforms = parsePlatformsList(r.platforms || '[]');
                const tags = tagMap.get(r.name.toLowerCase()) || [];
                const gamePlatforms = [...cataloguePlatforms, ...tags];
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
        // v2.47.0 (S22 follow-ups Workstream 1) — per-submit ban enforcement.
        // Inline check (no Express middleware chain for Discord commands).
        const banCheck = await BanService.isIdentityBanned(interaction.user.id);
        if (banCheck.banned) {
            await interaction.reply({ content: 'This account is banned.', ephemeral: true });
            return;
        }

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
            const tournament = await db.get('SELECT id, type, mode, max_active_games, game_room_id FROM tournaments WHERE name = ? COLLATE NOCASE', tournamentName);

            if (!tournament) {
                await interaction.editReply(`Could not find a tournament named '${tournamentName}'.`);
                return;
            }

            // S22 Phase 2 (v2.44.0, M1 fix) — same rationale as activategame.ts:
            // tournament name resolution isn't guild-scoped.
            if (tournament.game_room_id) {
                const { RoomAccessService } = await import('../../services/RoomAccessService.js');
                if (await RoomAccessService.isSuspended(tournament.game_room_id)) {
                    await interaction.editReply('This room has been suspended pending review. Game picking is disabled.');
                    return;
                }

                // v2.49.0 (room-tier bans) — the initial ban check above (before
                // the tournament's room was known) can only see GLOBAL bans.
                // Re-check room-aware now that the room is resolved.
                const roomBanCheck = await BanService.isIdentityBanned(interaction.user.id, tournament.game_room_id);
                if (roomBanCheck.banned) {
                    await interaction.editReply('This account is banned.');
                    return;
                }
            }

            // Pick-award gate (plan §8) — short-circuit with exact reply string.
            const pickEnabled = await PickAwardGate.isEnabled(tournament.game_room_id, tournament.id);
            if (!pickEnabled) {
                await interaction.editReply(PICK_AWARD_DISABLED_REPLY);
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

            // Check queue limit (max 5 per user per tournament)
            const queueCount = await db.get(
                `SELECT COUNT(*) as count FROM games
                 WHERE tournament_id = ? AND status = 'QUEUED'
                   AND picker_discord_id = ? AND name != '[Pending Pick]'`,
                tournament.id, interaction.user.id
            );
            if ((queueCount?.count ?? 0) >= 5) {
                await interaction.editReply('Queue limit reached (max 5 games per tournament). Remove a queued game first.');
                return;
            }

            const styleId: string | undefined = undefined;

            // Determine if we should activate immediately or queue
            const maxSlots = tournament.max_active_games ?? 1;
            const activeGames = await engine.getActiveGames(tournament.id);
            const hasOpenSlot = activeGames.length < maxSlots;

            // Find an outstanding pick reward this user can fulfil. ORDER BY
            // picker_designated_at ASC matches the FIFO contract from the web
            // /pick-game route — the oldest [Pending Pick] for this user gets
            // filled first, so per-slot wins are consumed in win order.
            const pendingPick = await db.get(
                `SELECT id FROM games WHERE tournament_id = ? AND status = 'QUEUED'
                   AND name = '[Pending Pick]' AND picker_discord_id = ?
                 ORDER BY picker_designated_at ASC, rowid ASC LIMIT 1`,
                tournament.id, interaction.user.id,
            );

            let outcome: 'activated' | 'queued' | 'queuedFromPick';

            if (pendingPick && !hasOpenSlot) {
                // Pending pick + slots full — repurpose the placeholder. queue_order
                // stays NULL on the row so it sorts ahead of explicit queue games
                // and activates first at next maintenance.
                await db.run(
                    `UPDATE games SET name = ?, style_id = ? WHERE id = ?`,
                    gameName, styleId || null, pendingPick.id,
                );
                outcome = 'queuedFromPick';
            } else if (hasOpenSlot) {
                // Slot available — create on iScored and activate immediately. If a
                // [Pending Pick] placeholder exists for this user/tournament, drop
                // it inside the same txn so the win is fulfilled (web /pick-game
                // mirrors this); otherwise it dangles as a stale QUEUED row.
                await interaction.editReply(`Creating **${gameName}** on iScored... This may take a moment.`);

                const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
                const creds = await getIScoredCredsForRoom(tournament.game_room_id);
                if (!creds) {
                    await interaction.editReply('No iScored credentials configured for this tournament. Cannot activate.');
                    return;
                }
                const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                const iscoredId = await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                    const id = await client.createGame(gameName, styleId);
                    await client.setGameTags(id, tournament.type);
                    await client.setGameStatus(id, { locked: false, hidden: false });
                    return id;
                });

                await db.exec('BEGIN TRANSACTION');
                try {
                    if (pendingPick) {
                        await db.run('DELETE FROM games WHERE id = ?', pendingPick.id);
                    }
                    await engine.activateGame(tournament.id, gameName, styleId, iscoredId, false);
                    await db.exec('COMMIT');
                } catch (dbError) {
                    await db.exec('ROLLBACK');
                    throw dbError;
                }
                outcome = 'activated';
            } else {
                // No pending pick + slots full — queue the game (no iScored
                // creation yet, happens at maintenance).
                await engine.queueGame(tournament.id, gameName, styleId, undefined, interaction.user.id);
                outcome = 'queued';
            }

            logInfo(`User ${interaction.user.tag} picked ${gameName} for ${tournamentName} (${outcome})`);

            // Reorder iScored lineup in background
            if (outcome === 'activated') {
                engine.reorderIScoredLineup().catch(() => {});
            }

            const color = getTournamentColor(tournament.type);

            const statusText = outcome === 'activated'
                ? `**${gameName}** is now active for the **${tournamentName}** tournament — play immediately!`
                : outcome === 'queuedFromPick'
                    ? `**${gameName}** will activate next for **${tournamentName}** — your won pick slot will fill at the next rotation.`
                    : `**${gameName}** has been queued for the **${tournamentName}** tournament.`;

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
