import {
    ChatInputCommandInteraction, SlashCommandBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ComponentType,
} from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { getTerminology } from '../../utils/terminology.js';
import { logInfo, logError } from '../../utils/logger.js';
// IScoredClient construction is owned by IScoredSessionRegistry.
import { LeaderboardService } from '../../services/LeaderboardService.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { normalizeSubmitterUserId } from '../../services/SubmissionContextService.js';
import { trackBackground } from '../../utils/backgroundTasks.js';
import { BanService } from '../../services/BanService.js';
import { ScoreProvenanceService } from '../../services/ScoreProvenanceService.js';
import { getEngineDisplay, getDeviceDisplay, UNKNOWN } from '../../utils/scoreProvenance.js';
import {
    resolveGuildReadScope, buildGuildScopedRoomSqlFilter, isRoomInGuildScope,
} from '../../utils/discordRoomFilter.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface ResolvedSubmitGame {
    id: string;
    /**
     * S23.1 (v2.73.0): nullable. A game that was never pushed to iScored — the
     * normal state for a standalone room, which seeds `ISCORED_ENABLED='false'`
     * (`GameRoomService`) — still resolves. iScored sync is a conditional
     * downstream step now, not a precondition for submitting.
     */
    iscored_id: string | null;
    tournament_id: string;
    game_room_id: string | null;
}

export type ResolveSubmitGameResult =
    | { ok: true; game: ResolvedSubmitGame }
    | { ok: false; reason: 'not_found' }
    | { ok: false; reason: 'suspended' };

/**
 * S22 Phase 2 (v2.44.0, M1 fix) — extracted so the suspension guard is
 * unit-testable without a full discord.js interaction mock. `/submit-score`'s
 * autocomplete lists ACTIVE games across every room (not scoped to the
 * invoking guild — see the autocomplete handler below), so the guild-level
 * Discord-enabled/suspension gate in `DiscordClient.ts` (which only knows
 * about the INVOKING guild's mapped room) cannot catch a resolved game
 * belonging to a DIFFERENT, suspended room. This function re-checks
 * suspension against the game's ACTUAL room right before any write happens.
 */
export async function resolveActiveSubmitGame(gameName: string): Promise<ResolveSubmitGameResult> {
    const db = await getDatabase();
    const game = await db.get<ResolvedSubmitGame>(`
        SELECT g.id, g.iscored_id, g.tournament_id, t.game_room_id
        FROM games g
        JOIN tournaments t ON g.tournament_id = t.id
        WHERE g.name = ? COLLATE NOCASE AND g.status = 'ACTIVE'
    `, gameName);
    // S23.1: `iscored_id` is NOT required. Pre-v2.73.0 a null `iscored_id`
    // resolved as not_found, which locked every standalone room out of
    // /submit-score entirely.
    if (!game) return { ok: false, reason: 'not_found' };
    if (game.game_room_id) {
        const { RoomAccessService } = await import('../../services/RoomAccessService.js');
        if (await RoomAccessService.isSuspended(game.game_room_id)) {
            return { ok: false, reason: 'suspended' };
        }
    }
    return { ok: true, game };
}

export const submitscore: Command = {
    data: new SlashCommandBuilder()
        .setName('submit-score')
        .setDescription(`Submit a score for an active ${getTerminology().game}.`)
        .addStringOption(option =>
            option.setName('game')
                .setDescription(`The active ${getTerminology().game} to submit for`)
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addIntegerOption(option =>
            option.setName('score')
                .setDescription('Your score')
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('photo')
                .setDescription('A photo of your score')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Your iScored username (if different from mapping)')
                .setRequired(false)
        )
        // v2.53.0 (ADR 0016) — provenance is two questions now. BOTH carry
        // autocomplete: `platform` never did, so users had to type raw canonical
        // ids and the command mostly rejected and asked for a re-run.
        .addStringOption(option =>
            option.setName('engine')
                .setDescription('What you played on — VPX, Pinball FX, a real machine… (auto-filled when only one fits)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option.setName('device')
                .setDescription('Hardware you played it on — PC, AtGames cabinet, VR headset… (auto-filled when only one fits)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addBooleanOption(option =>
            option.setName('exclude_global')
                .setDescription('Don\'t post this score to the global Arcaid scoreboard')
                .setRequired(false)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);

        // v2.120.2 — guild-scoped autocomplete. Pre-fix the `game` list showed
        // every room's ACTIVE games plus their tournament names to any guild.
        // `null` scope (unlinked guild / DM) → empty list for every branch.
        const guildScope = await resolveGuildReadScope(interaction.guildId);
        if (!guildScope) {
            await interaction.respond([]);
            return;
        }

        const db = await getDatabase();

        if (focusedOption.name === 'game') {
            // Only suggest ACTIVE games with a tournament for score submission
            const { sql: scopeFilter, params: scopeParams } =
                buildGuildScopedRoomSqlFilter('t.game_room_id', guildScope);
            const rows = await db.all(`
                SELECT g.name, t.name as tournament_name
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'ACTIVE' ${scopeFilter}
                ORDER BY t.display_order ASC, g.name ASC
            `, ...scopeParams);

            const filtered = rows
                .filter((r: any) => r.name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);

            await interaction.respond(
                filtered.map((r: any) => ({
                    name: r.tournament_name ? `${r.name} (${r.tournament_name})` : r.name,
                    value: r.name,
                }))
            );
            return;
        }

        // v2.53.0 — engine/device autocomplete, resolved against the game
        // already selected in the `game` option. Uses the SAME resolver the web
        // picker's scope comes from (ScoreProvenanceService), so both surfaces
        // offer the same set — including room tags, which the old Discord path
        // never unioned.
        if (focusedOption.name === 'engine' || focusedOption.name === 'device') {
            const gameName = interaction.options.getString('game');
            if (!gameName) {
                await interaction.respond([]);
                return;
            }
            const resolved = await resolveActiveSubmitGame(gameName);
            if (!resolved.ok) {
                await interaction.respond([]);
                return;
            }
            // A game name typed by hand can still name another guild's game —
            // don't disclose its engine/device availability.
            if (!isRoomInGuildScope(resolved.game.game_room_id, guildScope)) {
                await interaction.respond([]);
                return;
            }
            const scope = await ScoreProvenanceService.resolveForTournamentGame(
                resolved.game.tournament_id, gameName,
            );
            const typed = focusedOption.value.toLowerCase();

            if (focusedOption.name === 'engine') {
                const options = ScoreProvenanceService.enginesFor(scope)
                    .map(id => ({ name: getEngineDisplay(id), value: id }))
                    .filter(o => o.name.toLowerCase().includes(typed) || o.value.includes(typed))
                    .slice(0, 25);
                await interaction.respond(options);
                return;
            }

            // Device list narrows to what the already-chosen engine can run.
            const chosenEngine = interaction.options.getString('engine')
                || (ScoreProvenanceService.enginesFor(scope)[0] ?? UNKNOWN);
            const options = ScoreProvenanceService.devicesFor(scope, chosenEngine)
                .map(id => ({ name: getDeviceDisplay(id), value: id }))
                .filter(o => o.name.toLowerCase().includes(typed) || o.value.includes(typed))
                .slice(0, 25);
            await interaction.respond(options);
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

        // Check cooldown (30 seconds)
        const remaining = checkCooldown(interaction.user.id, 'submit-score', 30);
        if (remaining > 0) {
            await interaction.reply({ content: `Please wait ${remaining}s before submitting another score.`, ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const term = getTerminology();
        const gameName = interaction.options.getString('game', true);
        const score = interaction.options.getInteger('score', true);
        const photo = interaction.options.getAttachment('photo', true);
        let username = interaction.options.getString('username');
        let engine = interaction.options.getString('engine') || undefined;
        let device = interaction.options.getString('device') || undefined;
        const excludeGlobal = interaction.options.getBoolean('exclude_global') || false;

        // Validate score is a positive integer
        if (score <= 0) {
            await interaction.editReply('Score must be a positive number.');
            return;
        }

        const db = await getDatabase();

        try {
            // Find the game ID and room, refusing when the game's room is
            // suspended (S22 Phase 2, M1 fix — see resolveActiveSubmitGame).
            const resolved = await resolveActiveSubmitGame(gameName);
            if (!resolved.ok) {
                if (resolved.reason === 'suspended') {
                    await interaction.editReply('This room has been suspended pending review. Score submission is disabled.');
                } else {
                    // S23.1: the "linked to iScored" phrasing is gone — iScored
                    // linkage is no longer a precondition for submitting.
                    await interaction.editReply(`Could not find an active ${term.game} named '${gameName}'.`);
                }
                return;
            }
            const game = resolved.game;

            // Drift-audit fix: resolveActiveSubmitGame's name lookup isn't
            // guild-scoped either (see its doc comment), so a game whose room
            // is Discord-disabled/approval-gated or linked to a DIFFERENT
            // guild than this interaction must also be rejected — see
            // discordWriteTarget.ts. (Its 'suspended' branch is redundant
            // with the check resolveActiveSubmitGame already made above, but
            // harmless — this call is the one that also covers (b)/(c).)
            if (game.game_room_id) {
                const { validateDiscordWriteTarget } = await import('../../utils/discordWriteTarget.js');
                const targetCheck = await validateDiscordWriteTarget(game.game_room_id, interaction.guildId);
                if (!targetCheck.allowed) {
                    await interaction.editReply(
                        targetCheck.denial === 'suspended'
                            ? 'This room has been suspended pending review. Score submission is disabled.'
                            : "That game belongs to a room this server isn't linked to."
                    );
                    return;
                }
            }

            // v2.49.0 (room-tier bans) — the initial ban check above (before
            // the game/room was known) can only see GLOBAL bans. Now that the
            // game's room is resolved, re-check room-aware so a room-scoped
            // ban also blocks this submission.
            if (game.game_room_id) {
                const roomBanCheck = await BanService.isIdentityBanned(interaction.user.id, game.game_room_id);
                if (roomBanCheck.banned) {
                    await interaction.editReply('This account is banned.');
                    return;
                }
            }

            // v2.53.0 (ADR 0016): resolve the engine + device scope for this
            // game. `resolveForTournamentGame` unions the room's game tags —
            // pre-v2.53.0 this command read `global_games.platforms` alone while
            // the web path unioned tags, so a room-tagged platform was
            // submittable on web and rejected here. Both surfaces now resolve
            // the same set.
            const scope = await ScoreProvenanceService.resolveForTournamentGame(game.tournament_id, gameName);
            if (scope.submittable.length === 0) {
                await interaction.editReply(`No platforms are configured for **${gameName}**. Ask an admin to set them up.`);
                return;
            }

            // Auto-fill each axis when only one option is valid, so the common
            // single-engine / single-device case stays a one-shot command.
            const engineOptions = ScoreProvenanceService.enginesFor(scope);
            if (!engine) {
                if (engineOptions.length === 1) {
                    engine = engineOptions[0];
                } else {
                    await interaction.editReply(
                        `**${gameName}** is playable on more than one engine. Re-run /submit-score with \`engine:\` set to one of: ${engineOptions.map(getEngineDisplay).join(', ')}.`,
                    );
                    return;
                }
            }
            const deviceOptions = ScoreProvenanceService.devicesFor(scope, engine!);
            if (!device) {
                if (deviceOptions.length === 1) {
                    device = deviceOptions[0];
                } else {
                    await interaction.editReply(
                        `Which device did you play **${gameName}** on? Re-run /submit-score with \`device:\` set to one of: ${deviceOptions.map(getDeviceDisplay).join(', ')}.`,
                    );
                    return;
                }
            }

            const provenance = ScoreProvenanceService.validate(scope, engine, device);
            if (!provenance.ok) {
                await interaction.editReply(provenance.error);
                return;
            }
            engine = provenance.engine;
            device = provenance.device;
            const platform = provenance.platform;

            // Resolve username: explicit param > saved mapping > auto-map from Discord display name
            if (!username) {
                const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', interaction.user.id);
                if (mapping) {
                    username = mapping.iscored_username;
                } else {
                    // Auto-map using Discord display name as iScored username
                    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
                    username = member?.displayName || interaction.user.displayName;
                    const inserted = await db.run(
                        `INSERT INTO user_mappings (discord_user_id, iscored_username)
                         VALUES (?, ?)
                         ON CONFLICT(iscored_username) DO NOTHING`,
                        interaction.user.id, username
                    );
                    // v2.127.0 — same alias-link effects every other
                    // user_mappings writer runs. Gated on `changes` so the
                    // DO NOTHING case (name already held) stays a no-op.
                    if (inserted?.changes) {
                        const { IdentityAliasEffectsService } = await import('../../services/IdentityAliasEffectsService.js');
                        await IdentityAliasEffectsService.onAliasLinked(interaction.user.id, username);
                    }
                    logInfo(`Auto-mapped user: ${username} -> ${interaction.user.tag}`);
                }
            }

            // Download Photo
            const photoRes = await fetch(photo.url);
            const arrayBuffer = await photoRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const ext = path.extname(photo.name) || '.jpg';
            const tempPhotoPath = path.join(process.cwd(), 'data', `${uuidv4()}${ext}`);

            await fs.writeFile(tempPhotoPath, buffer);

            try {
                // Record internally (use sync-compatible ID so sync won't create a duplicate)
                const submittedByUserId = normalizeSubmitterUserId(interaction.user.id);
                const submittedByAnonymousName = submittedByUserId ? null : username!;
                await db.run(
                    `INSERT INTO submissions (
                        id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                        submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                        submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                        engine, device
                     )
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET score = MAX(score, excluded.score), discord_user_id = excluded.discord_user_id, photo_url = excluded.photo_url,
                        -- v2.53.0: the two upsert families disagreed (this one
                        -- overwrote, the sync paths COALESCE-preserved). One rule
                        -- now: COALESCE-preserve everywhere. Behaviour here is
                        -- unchanged, since an interactive submit always supplies a
                        -- concrete value — it just can't blank anything any more.
                        platform = COALESCE(excluded.platform, submissions.platform),
                        engine = COALESCE(NULLIF(excluded.engine, 'unknown'), submissions.engine, 'unknown'),
                        device = COALESCE(NULLIF(excluded.device, 'unknown'), submissions.device, 'unknown')`,
                    `${game.id}-${username!.toLowerCase()}`, game.id, interaction.user.id, username, score, photo.url, new Date().toISOString(),
                    game.game_room_id || null, game.tournament_id || null, submittedByUserId, submittedByAnonymousName, platform,
                    engine, device,
                );

                // Log to score history
                const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
                await ScoreHistoryService.log({
                    gameName, gameRoomId: game.game_room_id!, gameId: game.id,
                    username: username!, discordUserId: interaction.user.id,
                    score, photoUrl: photo.url, source: 'tournament',
                    tournamentId: game.tournament_id,
                    anonymousName: submittedByAnonymousName,
                    platform,
                    engine,
                    device,
                });

                // Invalidate leaderboard cache
                await LeaderboardService.invalidate(game.id);

                // S23.2 — resulting rank for the success reply. `getForGame`
                // recomputes off the freshly-invalidated cache and returns the
                // SAME ranking the board renders (score_history filtered by
                // submitted_during_tournament_id, identity-collapsed), so the
                // number quoted here can't disagree with the leaderboard. The
                // recalculate isn't extra work — the invalidate above already
                // forced one on the next read; this just warms it.
                let rankLine = '';
                try {
                    const rankings = await LeaderboardService.getForGame(game.id);
                    const mine = rankings.find(r =>
                        (!!submittedByUserId && r.discord_user_id === submittedByUserId)
                        || r.iscored_username.toLowerCase() === username!.toLowerCase(),
                    );
                    if (mine) {
                        rankLine = mine.rank === 1
                            ? `\n> You're **#1** on **${gameName}**!`
                            : `\n> You're **#${mine.rank}** of ${rankings.length} on **${gameName}**.`;
                    }
                } catch (err) {
                    logError('Rank lookup for /submit-score reply failed (non-fatal):', err);
                }

                // Ranking group caches self-invalidate via data watermark on
                // next read — no explicit invalidation call needed (v2.10.x).

                logInfo(`Score submitted: ${username} scored ${score} on ${gameName}`);

                // Fire-and-forget lobby feed event (tracked for test drain)
                trackBackground(
                    import('../../services/LobbyFeedGenerator.js')
                        .then(({ LobbyFeedGenerator }) => LobbyFeedGenerator.onScoreSubmitted({
                            gameRoomId: game.game_room_id!, gameName, username: username!,
                            score, discordUserId: interaction.user.id, source: 'tournament',
                        }))
                        .catch(() => {}),
                );

                // Fan-out to global scoreboard (best-effort — never blocks the room submission)
                try {
                    const { GlobalScoreService } = await import('../../services/GlobalScoreService.js');
                    const fanOut = await GlobalScoreService.fanOutFromRoomSubmission({
                        gameRoomId: game.game_room_id!,
                        gameName,
                        gameId: game.id,
                        playerId: interaction.user.id,
                        iscoredUsername: username!,
                        score,
                        photoUrl: photo.url,
                        excludeFromGlobal: excludeGlobal,
                        tournamentId: game.tournament_id,
                        submittedByAnonymousName: submittedByAnonymousName ?? undefined,
                        platform,
                        engine,
                        device,
                        // Discord /submit-score is a tournament submission
                        // (ADR 0016 P2 §3c).
                        source: 'tournament',
                    });
                    if (fanOut && !excludeGlobal) {
                        const { emitScoreNewGlobal } = await import('../../api/websocket.js');
                        const room = await db.get('SELECT name, slug FROM game_rooms WHERE id = ?', game.game_room_id);
                        emitScoreNewGlobal({
                            globalGameId: fanOut.globalGameId,
                            gameName: fanOut.gameName,
                            playerName: username!,
                            score,
                            engine,
                            originRoomSlug: room?.slug || null,
                            originRoomName: room?.name || null,
                        });
                    }
                } catch (err) {
                    logError('Global fan-out from /submit-score failed (non-fatal):', err);
                }

                // S23.1 — iScored sync is now a CONDITIONAL, non-fatal step that
                // runs AFTER the local write, mirroring the web paths'
                // `IScoredSubmitSync.syncScoreToIScored`: no creds (room has
                // iScored disabled/unconfigured) → silent skip with an info log;
                // any throw → logged, never surfaced as a submit failure. The
                // local row is already committed by this point, so a sync
                // outage can no longer cost the player their score.
                // (The success reply deliberately says nothing about iScored, so
                // it stays honest whether the sync ran, was skipped, or failed.)
                try {
                    const { getIScoredCredsForRoom } = await import('../../utils/iscoredCreds.js');
                    const creds = game.iscored_id ? await getIScoredCredsForRoom(game.game_room_id) : null;
                    if (!creds) {
                        logInfo(`iScored sync skipped for "${gameName}" (${game.iscored_id ? 'no creds for room' : 'game not linked to iScored'})`);
                    } else {
                        // Route through the registry so this can't race with
                        // parallel maintenance fires on the same account.
                        const { IScoredSessionRegistry } = await import('../../engine/IScoredSessionRegistry.js');
                        await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                            await client.submitScore(game.iscored_id!, username!, score, tempPhotoPath);
                        });
                    }
                } catch (err) {
                    logError(`iScored sync failed for "${gameName}" by ${username} (non-fatal):`, err);
                }

                // Build web UI tip with room slug
                let webTip = '';
                try {
                    const roomRow = await db.get(
                        'SELECT gr.slug FROM game_rooms gr JOIN tournaments t ON t.game_room_id = gr.id JOIN games g ON g.tournament_id = t.id WHERE g.id = ?',
                        game.id
                    );
                    const publicUrl = process.env.PUBLIC_URL || 'https://arcaid.app';
                    if (roomRow?.slug) {
                        webTip = `\n> **Tip:** You can also submit scores and pick games at ${publicUrl}/${roomRow.slug}`;
                    }
                } catch { /* non-critical */ }

                await interaction.editReply(`Successfully submitted your score of **${score.toLocaleString()}** to **${gameName}**!${rankLine}${webTip}`);

                // Send rating follow-up (fire-and-forget, don't block the score confirmation)
                sendRatingFollowUp(interaction, gameName, username!, game.game_room_id).catch(err => {
                    logError('Error in rating follow-up:', err);
                });
            } finally {
                // Always cleanup temp photo, even on error
                await fs.unlink(tempPhotoPath).catch(() => {});
            }

        } catch (error) {
            logError('Error in /submit-score:', error);
            await interaction.editReply('An error occurred while submitting your score.');
        }
    },
};

/**
 * After a successful score submission, send an ephemeral follow-up asking the user to rate the game.
 * Flow: Star buttons (1-5) + Skip → if rated, show comment modal → done.
 * Buttons auto-expire after 5 minutes with no action needed.
 */
async function sendRatingFollowUp(
    interaction: ChatInputCommandInteraction,
    gameName: string,
    username: string,
    gameRoomId: string | null,
) {
    const uniqueId = uuidv4().slice(0, 8);

    // Build star rating buttons (1-5) in first row, Skip in second row
    // Discord allows max 5 buttons per ActionRow
    const starRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...[1, 2, 3, 4, 5].map(n =>
            new ButtonBuilder()
                .setCustomId(`rate_${uniqueId}_${n}`)
                .setLabel(`${n} ⭐`)
                .setStyle(ButtonStyle.Primary)
        ),
    );
    const skipRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`rate_${uniqueId}_skip`)
            .setLabel('Skip')
            .setStyle(ButtonStyle.Secondary),
    );

    const followUp = await interaction.followUp({
        content: `**Rate ${gameName}!** How would you rate this game?`,
        components: [starRow, skipRow],
        ephemeral: true,
    });

    // Collect a single button click (5 min timeout)
    const collector = followUp.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 5 * 60 * 1000,
        max: 1,
    });

    collector.on('collect', async (btnInteraction) => {
        const customId = btnInteraction.customId;

        // v2.47.0 (S22 follow-ups Workstream 1) — this collector can fire up
        // to 5 minutes after the score submission it followed, so re-check:
        // a ban placed in that window must still block the rating/comment
        // writes below. v2.49.0: room-aware, using the room the score was
        // actually submitted to.
        const banCheck = await BanService.isIdentityBanned(interaction.user.id, gameRoomId);
        if (banCheck.banned) {
            await btnInteraction.update({ content: 'This account is banned.', components: [] });
            return;
        }

        // Skip button — no rating, no modal
        if (customId.endsWith('_skip')) {
            await btnInteraction.update({
                content: 'No problem! You can rate anytime on the web.',
                components: [],
            });
            return;
        }

        // Parse rating value
        const ratingStr = customId.split('_').pop();
        const rating = parseInt(ratingStr || '0', 10);
        if (rating < 1 || rating > 5) return;

        // Save the rating. v2.86.0: ratings are room-scoped (migration 139) —
        // skip the save if this game somehow has no room (RatingService now
        // requires a roomId; BanService above tolerates null, RatingService
        // does not).
        try {
            if (gameRoomId) {
                const { RatingService } = await import('../../services/RatingService.js');
                await RatingService.setRating(gameRoomId, gameName, interaction.user.id, rating);
                logInfo(`Game rated: ${interaction.user.tag} gave ${gameName} ${rating} stars`);
            } else {
                logError('Skipping rating save: no game_room_id for game', gameName);
            }
        } catch (err) {
            logError('Error saving rating:', err);
        }

        // Show comment modal
        const modalId = `comment_${uniqueId}`;
        const modal = new ModalBuilder()
            .setCustomId(modalId)
            .setTitle(`${gameName} — Leave a Comment`)
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('comment_body')
                        .setLabel('Any tips or comments? (optional)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(500)
                        .setRequired(false)
                        .setPlaceholder('Share a pro tip or leave a comment...')
                ),
            );

        await btnInteraction.showModal(modal);

        // Update the button message to show the rating was saved
        await btnInteraction.editReply({
            content: `Thanks! You rated **${gameName}** ${'⭐'.repeat(rating)}`,
            components: [],
        });

        // Wait for modal submission (5 min timeout)
        try {
            const modalInteraction = await btnInteraction.awaitModalSubmit({
                filter: (i) => i.customId === modalId,
                time: 5 * 60 * 1000,
            });

            const commentText = modalInteraction.fields.getTextInputValue('comment_body')?.trim();
            if (commentText) {
                // v2.47.0 (S22 follow-ups L3) — the modal itself can be open
                // for up to another 5 minutes after the star-rating ban check
                // above, so re-check immediately before the write. Silent
                // drop (ephemeral notice, no comment saved) matching the
                // pattern at ~420-424. v2.49.0: room-aware.
                const modalBanCheck = await BanService.isIdentityBanned(interaction.user.id, gameRoomId);
                if (modalBanCheck.banned) {
                    await modalInteraction.reply({ content: 'This account is banned.', ephemeral: true });
                    return;
                }
                // Save the comment
                try {
                    const { CommentService } = await import('../../services/CommentService.js');
                    // Resolve game room ID for the comment
                    const db = await getDatabase();
                    const game = await db.get("SELECT g.id, t.game_room_id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE g.name = ? COLLATE NOCASE", gameName);
                    if (game?.game_room_id) {
                        await CommentService.addComment(
                            game.game_room_id,
                            gameName,
                            interaction.user.id,
                            username,
                            'tip',
                            commentText,
                        );
                        logInfo(`Comment saved: ${username} on ${gameName}`);
                    }
                } catch (err) {
                    logError('Error saving comment:', err);
                }
                await modalInteraction.reply({ content: 'Thanks for the feedback!', ephemeral: true });
            } else {
                await modalInteraction.reply({ content: 'No problem!', ephemeral: true });
            }
        } catch {
            // Modal timed out or was cancelled — no action needed
        }
    });

    collector.on('end', async (collected) => {
        // If no buttons were clicked, silently clean up
        if (collected.size === 0) {
            await interaction.editReply({
                content: `Successfully submitted your score to **${gameName}**!`,
                components: [],
            }).catch(() => {});
        }
    });
}
