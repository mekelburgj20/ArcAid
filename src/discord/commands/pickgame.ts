import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
// IScoredClient construction is owned by IScoredSessionRegistry.
import { checkCooldown } from '../../utils/cooldown.js';
import { getTournamentColor } from '../../utils/discord.js';
import { PickAwardGate, PICK_AWARD_DISABLED_REPLY } from '../../services/PickAwardGate.js';
import { catalogueTypeMatchesTournamentMode } from '../../utils/tournamentMode.js';
import { BanService } from '../../services/BanService.js';
import { PickDispositionService, SelfNominationError } from '../../services/PickDispositionService.js';
import { resolveSubmissionPlayerId } from '../../utils/submissionAttribution.js';
import { trackBackground } from '../../utils/backgroundTasks.js';
import { buildGameAutocompleteChoices, type AutocompleteTournament } from '../gameAutocomplete.js';
import { resolveGuildReadScope, buildGuildScopedRoomSqlFilter } from '../../utils/discordRoomFilter.js';
import { v4 as uuidv4 } from 'uuid';
// TODO(§8): gate /mystery-award when that command is authored (Q6 — out of scope for Sprint 5).

/**
 * `/pick-game` consolidation (ROADMAP "[FEATURE] /pick-game consolidation",
 * owner-designed 2026-08-12) — folds the retired `/my-pick` in via optional,
 * MUTUALLY-EXCLUSIVE params on top of the original `tournament` + `game`
 * pick flow:
 *   - `game`      — today's exact pick behavior (autocomplete), unchanged.
 *   - `forfeit`   — context-sensitive: HOLDING the pick right now (a live
 *                   `[Pending Pick]` row for this tournament with
 *                   `picker_discord_id` = invoker) resolves it to the
 *                   runner-up immediately; otherwise sets the next-win
 *                   disposition (today's `/my-pick forfeit`).
 *   - `pass-pick` — same context split: HOLDING reassigns the live pick to
 *                   the target now (mirrors `/nominate-picker designate`'s
 *                   mechanics + the nominee onboarding pathway); otherwise
 *                   sets the next-win disposition (today's `/my-pick
 *                   nominate`).
 *   - `clear`     — clears the stored next-win disposition (today's
 *                   `/my-pick clear`).
 *   - Bare invoke (tournament only) — status reply absorbing
 *     `/my-pick status`.
 * `/nominate-picker` (admin on-behalf) is untouched.
 */

async function findHeldPick(db: any, tournamentId: string, userId: string) {
    return db.get(
        `SELECT * FROM games WHERE tournament_id = ? AND status = 'QUEUED'
           AND name = '[Pending Pick]' AND picker_discord_id = ?
         ORDER BY picker_designated_at ASC, rowid ASC LIMIT 1`,
        tournamentId, userId,
    );
}

export const pickgame: Command = {
    data: new SlashCommandBuilder()
        .setName('pick-game')
        .setDescription('Pick the next game for a tournament, or manage what happens to your pick.')
        .addStringOption(option =>
            option.setName('tournament')
                .setDescription('The tournament to pick for')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option.setName('game')
                .setDescription('The name of the game (only when it is your turn to pick)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addBooleanOption(option =>
            option.setName('forfeit')
                .setDescription('Forfeit your pick to the runner-up')
                .setRequired(false)
        )
        .addUserOption(option =>
            option.setName('pass-pick')
                .setDescription('Hand your pick to someone else')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('clear')
                .setDescription('Clear your stored next-win disposition')
                .setRequired(false)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);

        // v2.120.2 — guild-scoped autocomplete (see activate-game for the
        // full rationale). The `game` branch's catalogue is global, but the
        // tournament it derives mode/platform-rules/room-tags from must be
        // one of THIS guild's.
        const scope = await resolveGuildReadScope(interaction.guildId);
        if (!scope) {
            await interaction.respond([]);
            return;
        }
        const { sql: scopeFilter, params: scopeParams } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);

        const db = await getDatabase();

        if (focusedOption.name === 'tournament') {
            const rows = await db.all(
                `SELECT t.name FROM tournaments t WHERE t.is_active = 1 ${scopeFilter}`,
                ...scopeParams,
            );
            const choices = rows.map(r => r.name);

            const filtered = choices.filter(choice =>
                choice.toLowerCase().includes(focusedOption.value.toLowerCase())
            ).slice(0, 25);

            await interaction.respond(
                filtered.map(choice => ({ name: choice, value: choice }))
            );
        }
        else if (focusedOption.name === 'game') {
            const selectedTournamentName = interaction.options.getString('tournament');
            let tournamentRow: AutocompleteTournament | null = null;

            if (selectedTournamentName) {
                const row = await db.get(
                    `SELECT t.id, t.type, t.mode, t.platform_rules, t.game_room_id FROM tournaments t
                     WHERE t.name = ? COLLATE NOCASE ${scopeFilter}`,
                    selectedTournamentName, ...scopeParams,
                );
                if (row) tournamentRow = row;
            }

            // Shared with `/nominate-picker queue` — see src/discord/gameAutocomplete.ts.
            await interaction.respond(await buildGameAutocompleteChoices(tournamentRow, focusedOption.value));
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

        const tournamentName = interaction.options.getString('tournament', true);
        const gameName = interaction.options.getString('game', false);
        const forfeit = interaction.options.getBoolean('forfeit', false) === true;
        const passPickUser = interaction.options.getUser('pass-pick', false);
        const clear = interaction.options.getBoolean('clear', false) === true;

        // Mutual exclusion — at most one of {game, forfeit:True, pass-pick, clear:True}.
        const providedCount = [gameName != null, forfeit, passPickUser != null, clear].filter(Boolean).length;
        const isGamePath = gameName != null && providedCount === 1;

        // The `game` path replies publicly (unchanged — the "picked!" embed
        // is meant to be seen in-channel); every other path is a personal
        // status/disposition reply, ephemeral like `/my-pick` was.
        await interaction.deferReply({ ephemeral: !isGamePath });

        if (providedCount > 1) {
            await interaction.editReply('Use only one of `game`, `forfeit`, `pass-pick`, or `clear` per invocation.');
            return;
        }

        try {
            const db = await getDatabase();
            const tournament = await db.get(
                'SELECT id, name, type, mode, max_active_games, game_room_id, discord_channel_id FROM tournaments WHERE name = ? COLLATE NOCASE',
                tournamentName,
            );

            if (!tournament) {
                await interaction.editReply(`Could not find a tournament named '${tournamentName}'.`);
                return;
            }

            // S22 Phase 2 (v2.44.0, M1 fix) — same rationale as activategame.ts:
            // tournament name resolution isn't guild-scoped. Drift-audit fix:
            // also rejects a room that's Discord-disabled/approval-gated or
            // linked to a DIFFERENT guild — see discordWriteTarget.ts.
            if (tournament.game_room_id) {
                const { validateDiscordWriteTarget } = await import('../../utils/discordWriteTarget.js');
                const targetCheck = await validateDiscordWriteTarget(tournament.game_room_id, interaction.guildId);
                if (!targetCheck.allowed) {
                    await interaction.editReply(
                        targetCheck.denial === 'suspended'
                            ? 'This room has been suspended pending review. Game picking is disabled.'
                            : "That game belongs to a room this server isn't linked to."
                    );
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

            const userId = interaction.user.id;

            // The FIFO-oldest live `[Pending Pick]` slot this user currently
            // holds for this tournament, if any — "invoker HOLDS the pick"
            // per the consolidation spec. Same query the pre-consolidation
            // `game` path used to look up `pendingPick`; reused here for
            // every branch so "holding" means the same thing everywhere.
            const heldPick = await findHeldPick(db, tournament.id, userId);

            if (isGamePath) {
                const term = getTerminology(tournament.mode);
                const engine = TournamentEngine.getInstance();

                // Check eligibility
                const isEligible = await engine.isGameEligible(tournament.id, gameName!);
                if (!isEligible) {
                    await interaction.editReply(`**${gameName}** has been played recently and is not eligible right now.`);
                    return;
                }

                // Check queue limit (max 5 per user per tournament)
                const queueCount = await db.get(
                    `SELECT COUNT(*) as count FROM games
                     WHERE tournament_id = ? AND status = 'QUEUED'
                       AND picker_discord_id = ? AND name != '[Pending Pick]'`,
                    tournament.id, userId
                );
                if ((queueCount?.count ?? 0) >= 5) {
                    await interaction.editReply('Queue limit reached (max 5 games per tournament). Remove a queued game first.');
                    return;
                }

                const styleId: string | undefined = undefined;

                // v2.103.0 duplicate-activation guard (UAT incident: two
                // rotation-granted pickers chose the same game 5 minutes
                // apart → twin ACTIVE rows + twin iScored boards). Rejecting
                // BEFORE any side effect (iScored creation, placeholder
                // consumption) means the player keeps their pick rights and
                // just picks something else. `activateGame` carries the same
                // check as the engine-level backstop.
                const activeTwin = await db.get(
                    `SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE' AND LOWER(name) = LOWER(?)`,
                    tournament.id, gameName,
                );
                if (activeTwin) {
                    await interaction.editReply(`**${gameName}** is already running in **${tournamentName}** — pick a different game (your pick is still yours).`);
                    return;
                }

                // Determine if we should activate immediately or queue
                const maxSlots = tournament.max_active_games ?? 1;
                const activeGames = await engine.getActiveGames(tournament.id);
                const hasOpenSlot = activeGames.length < maxSlots;

                let outcome: 'activated' | 'queued' | 'queuedFromPick';

                if (heldPick && !hasOpenSlot) {
                    // Pending pick + slots full — repurpose the placeholder. queue_order
                    // stays NULL on the row so it sorts ahead of explicit queue games
                    // and activates first at next maintenance.
                    await db.run(
                        `UPDATE games SET name = ?, style_id = ? WHERE id = ?`,
                        gameName, styleId || null, heldPick.id,
                    );
                    outcome = 'queuedFromPick';
                } else if (hasOpenSlot) {
                    // Slot available — create on iScored and activate immediately. If a
                    // [Pending Pick] placeholder exists for this user/tournament, drop
                    // it inside the same txn so the win is fulfilled (web /pick-game
                    // mirrors this); otherwise it dangles as a stale QUEUED row.
                    await interaction.editReply(`Creating **${gameName}** on iScored... This may take a moment.`);

                    // Create game on iScored if credentials available (per-room → env
                    // fallback); iScored-disabled rooms activate without a synced game
                    // (v2.81.0 standalone-room default — mirrors activategame.ts and the
                    // web /pick-game route in rooms.ts).
                    let iscoredId: string | undefined;
                    const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
                    const creds = await getIScoredCredsForRoom(tournament.game_room_id);
                    if (creds) {
                        const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                        iscoredId = await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                            const id = await client.createGame(gameName!, styleId);
                            await client.setGameTags(id, tournament.type);
                            await client.setGameStatus(id, { locked: false, hidden: false });
                            return id;
                        });
                    }

                    await db.exec('BEGIN TRANSACTION');
                    try {
                        if (heldPick) {
                            await db.run('DELETE FROM games WHERE id = ?', heldPick.id);
                        }
                        await engine.activateGame(tournament.id, gameName!, styleId, iscoredId, false);
                        await db.exec('COMMIT');
                    } catch (dbError) {
                        await db.exec('ROLLBACK');
                        throw dbError;
                    }
                    outcome = 'activated';
                } else {
                    // No pending pick + slots full — queue the game (no iScored
                    // creation yet, happens at maintenance).
                    await engine.queueGame(tournament.id, gameName!, styleId, undefined, userId);
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
                return;
            }

            if (clear) {
                await PickDispositionService.clear(tournament.id, userId);
                await interaction.editReply(`**${tournament.name}**: disposition cleared — back to \`use my queue\`.`);
                return;
            }

            if (forfeit) {
                if (heldPick) {
                    // Invoker HOLDS the pick right now — resolve it to the
                    // runner-up immediately. Runner-up derivation mirrors
                    // `TournamentEngine.resolveNextPicker`'s forfeit branch
                    // exactly: 2nd-place `submissions` row for the won game,
                    // resolved through the shared `resolveSubmissionPlayerId`
                    // helper. No guessing — a dangling/missing link is a hard
                    // stop with an actionable error.
                    if (!heldPick.won_game_id) {
                        await interaction.editReply("This pick isn't linked to a specific game, so a runner-up can't be determined. Ask an admin to use `/nominate-picker` to assign it.");
                        return;
                    }

                    const runnerUpRow = await db.get(
                        `SELECT iscored_username, discord_user_id, submitted_by_user_id FROM submissions
                         WHERE game_id = ? AND orphaned_at IS NULL ORDER BY score DESC LIMIT 1 OFFSET 1`,
                        heldPick.won_game_id,
                    );
                    const runnerUpId = await resolveSubmissionPlayerId(db, runnerUpRow);

                    if (!runnerUpId) {
                        await interaction.editReply('No eligible runner-up was found for this pick. Ask an admin to use `/nominate-picker` to assign it.');
                        return;
                    }

                    await db.run(
                        `UPDATE games SET picker_discord_id = ?, picker_type = 'RUNNER_UP', picker_designated_at = ?, reminder_count = 0 WHERE id = ?`,
                        runnerUpId, new Date().toISOString(), heldPick.id,
                    );

                    await interaction.editReply(`You're holding the pick — forfeited it to <@${runnerUpId}> (the runner-up).`);

                    if (interaction.channel && 'send' in interaction.channel) {
                        await interaction.channel.send(`${interaction.user.toString()} forfeited their pick for **${tournament.name}** — it passes to <@${runnerUpId}>.`).catch(() => {});
                    }
                    return;
                }

                // Not holding — set the next-win disposition (today's
                // `/my-pick forfeit` semantics).
                await PickDispositionService.set(tournament.id, userId, 'forfeit');
                await interaction.editReply(`Saved for your NEXT win: your pick will be forfeited straight to the runner-up (no wait). Use \`/pick-game clear:True\` to cancel.`);
                return;
            }

            if (passPickUser) {
                if (passPickUser.id === userId) {
                    await interaction.editReply("You can't pass your pick to yourself.");
                    return;
                }

                if (heldPick) {
                    // Invoker HOLDS the pick right now — reassign the live
                    // placeholder immediately. Mirrors `/nominate-picker
                    // designate`'s mechanics (placeholder reassignment,
                    // picker_type stays 'WINNER' — the target inherits the
                    // standard window/reminders/timeout chain), plus the
                    // v2.96.0 nominee onboarding pathway when the target
                    // isn't a room member yet.
                    await db.run(
                        `UPDATE games SET picker_discord_id = ?, picker_type = 'WINNER', picker_designated_at = ? WHERE id = ?`,
                        passPickUser.id, new Date().toISOString(), heldPick.id,
                    );

                    const roomMember = tournament.game_room_id
                        ? await db.get('SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?', tournament.game_room_id, passPickUser.id)
                        : null;

                    if (!roomMember) {
                        const { resolveAnnouncementChannelId } = await import('../../utils/discord.js');
                        const channelId = await resolveAnnouncementChannelId(tournament.game_room_id, tournament.discord_channel_id);
                        const term = getTerminology(tournament.mode);
                        trackBackground(
                            TournamentEngine.getInstance().announceNomineeOnboarding(passPickUser.id, tournament, channelId, term)
                        ).catch(() => {});
                    }

                    await interaction.editReply(`You're holding the pick — passed it to ${passPickUser.toString()}.`);

                    if (interaction.channel && 'send' in interaction.channel) {
                        await interaction.channel.send(`${interaction.user.toString()} passed their pick for **${tournament.name}** to ${passPickUser.toString()}.`).catch(() => {});
                    }
                    return;
                }

                // Not holding — set the next-win disposition (today's
                // `/my-pick nominate` semantics), including the best-effort
                // guild-membership check ("Nomination VALIDITY at set-time" —
                // uncertainty always degrades to allowing the set; only a
                // DEFINITIVE non-member is rejected).
                try {
                    if (tournament.game_room_id) {
                        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
                        const guildId = await GameRoomSettingsService.get(tournament.game_room_id, 'DISCORD_GUILD_ID');
                        if (guildId) {
                            const { getDiscordClient } = await import('../DiscordClient.js');
                            const client = getDiscordClient();
                            if (client?.isReady()) {
                                const isMember = await client.isMemberOfGuild(guildId, passPickUser.id);
                                if (!isMember) {
                                    await interaction.editReply(`${passPickUser.toString()} isn't a member of this server, so they can't be nominated.`);
                                    return;
                                }
                            }
                        }
                    }
                } catch {
                    // Uncertain — degrade to allowing the set (per design).
                }

                try {
                    await PickDispositionService.set(tournament.id, userId, 'nominate', passPickUser.id);
                } catch (err) {
                    if (err instanceof SelfNominationError) {
                        await interaction.editReply("You can't pass your pick to yourself.");
                        return;
                    }
                    throw err;
                }

                await interaction.editReply(`Saved for your NEXT win: ${passPickUser.toString()} gets your pick.`);

                if (interaction.channel && 'send' in interaction.channel) {
                    await interaction.channel.send(`${interaction.user.toString()} has set up a pick hand-off to ${passPickUser.toString()} for **${tournament.name}** (applies on their next win).`).catch(() => {});
                }
                return;
            }

            // Bare invoke — status reply absorbing `/my-pick status`.
            const lines: string[] = [`**${tournament.name}**`];

            if (heldPick) {
                let wonGameName: string | null = null;
                if (heldPick.won_game_id) {
                    const wonGame = await db.get('SELECT name FROM games WHERE id = ?', heldPick.won_game_id);
                    wonGameName = wonGame?.name ?? null;
                }
                lines.push(
                    wonGameName
                        ? `You're holding the pick right now (you won **${wonGameName}**) — use \`/pick-game game:<name>\` to pick, \`forfeit:True\` to pass it to the runner-up, or \`pass-pick:@user\` to hand it off.`
                        : `You're holding the pick right now — use \`/pick-game game:<name>\` to pick, \`forfeit:True\` to pass it to the runner-up, or \`pass-pick:@user\` to hand it off.`
                );
            }

            const disposition = await PickDispositionService.get(tournament.id, userId);
            if (disposition) {
                lines.push(
                    disposition.disposition === 'nominate'
                        ? `If you win next, the pick goes to <@${disposition.nominee_discord_id}>.`
                        : 'If you win next, your pick is forfeited straight to the runner-up.'
                );
                lines.push('Use `/pick-game clear:True` to revert.');
            } else if (!heldPick) {
                lines.push("Your disposition is `use my queue` (the default) — if you win, you'll be asked to pick as usual.");
            }

            const queueCount = await db.get(
                `SELECT COUNT(*) as count FROM games
                 WHERE tournament_id = ? AND status = 'QUEUED'
                   AND picker_discord_id = ? AND name != '[Pending Pick]'`,
                tournament.id, userId
            );
            lines.push(`Queue: ${queueCount?.count ?? 0}/5 games queued.`);

            await interaction.editReply(lines.join('\n'));

        } catch (error) {
            logError('Error in /pick-game:', error);
            await interaction.editReply('An error occurred while picking the game. Check the logs for details.');
        }
    },
};
