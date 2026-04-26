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
import { IScoredClient } from '../../engine/IScoredClient.js';
import { LeaderboardService } from '../../services/LeaderboardService.js';
import { checkCooldown } from '../../utils/cooldown.js';
import { normalizeSubmitterUserId } from '../../services/SubmissionContextService.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

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
        .addStringOption(option =>
            option.setName('platform')
                .setDescription('Platform you played on (auto-filled when the game has only one)')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('exclude_global')
                .setDescription('Don\'t post this score to the global ArcAid scoreboard')
                .setRequired(false)
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const db = await getDatabase();

        if (focusedOption.name === 'game') {
            // Only suggest ACTIVE games with a tournament for score submission
            const rows = await db.all(`
                SELECT g.name, t.name as tournament_name
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.status = 'ACTIVE'
                ORDER BY t.display_order ASC, g.name ASC
            `);

            const filtered = rows
                .filter((r: any) => r.name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);

            await interaction.respond(
                filtered.map((r: any) => ({
                    name: r.tournament_name ? `${r.name} (${r.tournament_name})` : r.name,
                    value: r.name,
                }))
            );
        }
    },

    async execute(interaction: ChatInputCommandInteraction) {
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
        let platform = interaction.options.getString('platform') || undefined;
        const excludeGlobal = interaction.options.getBoolean('exclude_global') || false;

        // Validate score is a positive integer
        if (score <= 0) {
            await interaction.editReply('Score must be a positive number.');
            return;
        }

        const db = await getDatabase();

        try {
            // Find the game ID and room
            const game = await db.get(`
                SELECT g.id, g.iscored_id, g.tournament_id, t.game_room_id
                FROM games g
                JOIN tournaments t ON g.tournament_id = t.id
                WHERE g.name = ? COLLATE NOCASE AND g.status = 'ACTIVE'
            `, gameName);

            if (!game || !game.iscored_id) {
                await interaction.editReply(`Could not find an active ${term.game} named '${gameName}' linked to iScored.`);
                return;
            }

            // v2.5.0: resolve submittable platforms for this game in this room.
            // If the game has 1 submittable platform, auto-fill. If 2+ and the
            // user didn't pass `platform`, reply ephemerally with valid choices
            // so they can re-run. If `platform` was passed, validate it.
            const { parsePlatformsList, mergeEffectivePlatforms, resolveSubmittablePlatforms } = await import('../../utils/platformRules.js');
            const grglib = await db.get(`
                SELECT gl.platforms AS lib_platforms,
                       grgl.custom_platforms AS room_platforms
                FROM game_room_game_library grgl
                JOIN game_library gl ON gl.name = grgl.game_name
                WHERE grgl.game_room_id = ? AND LOWER(gl.name) = LOWER(?)
                LIMIT 1
            `, game.game_room_id, gameName);
            let effectivePlatforms: string[] = [];
            if (grglib) {
                effectivePlatforms = mergeEffectivePlatforms(grglib.lib_platforms, grglib.room_platforms);
            } else {
                const gg = await db.get(
                    'SELECT platforms FROM global_games WHERE LOWER(name) = LOWER(?) AND status = ? LIMIT 1',
                    gameName, 'approved',
                );
                if (gg) effectivePlatforms = parsePlatformsList(gg.platforms || '[]');
            }
            let platformRules: { required: string[]; excluded: string[] } | null = null;
            const tournamentRow = await db.get(
                'SELECT platform_rules FROM tournaments WHERE id = ?',
                game.tournament_id,
            );
            if (tournamentRow?.platform_rules) {
                try {
                    const parsed = JSON.parse(tournamentRow.platform_rules);
                    platformRules = {
                        required: Array.isArray(parsed.required) ? parsed.required : [],
                        excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
                    };
                } catch { /* ignore */ }
            }
            const submittablePlatforms = resolveSubmittablePlatforms(effectivePlatforms, platformRules);
            if (submittablePlatforms.length === 0) {
                await interaction.editReply(`No platforms are configured for **${gameName}**. Ask an admin to set them up.`);
                return;
            }
            if (!platform) {
                if (submittablePlatforms.length === 1) {
                    platform = submittablePlatforms[0];
                } else {
                    await interaction.editReply(
                        `**${gameName}** can be played on multiple platforms. Re-run /submit-score with \`platform:\` set to one of: ${submittablePlatforms.join(', ')}.`,
                    );
                    return;
                }
            } else {
                const want = platform.toUpperCase();
                const matched = submittablePlatforms.find(p => p.toUpperCase() === want);
                if (!matched) {
                    await interaction.editReply(
                        `Platform "${platform}" is not allowed for **${gameName}**. Allowed: ${submittablePlatforms.join(', ')}.`,
                    );
                    return;
                }
                platform = matched; // normalize casing
            }

            // Resolve username: explicit param > saved mapping > auto-map from Discord display name
            if (!username) {
                const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', interaction.user.id);
                if (mapping) {
                    username = mapping.iscored_username;
                } else {
                    // Auto-map using Discord display name as iScored username
                    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
                    username = member?.displayName || interaction.user.displayName;
                    await db.run(
                        `INSERT INTO user_mappings (discord_user_id, iscored_username)
                         VALUES (?, ?)
                         ON CONFLICT(discord_user_id) DO UPDATE SET iscored_username = excluded.iscored_username`,
                        interaction.user.id, username
                    );
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
                // Submit to iScored
                const client = new IScoredClient();
                await client.connect();
                try {
                    await client.submitScore(game.iscored_id, username!, score, tempPhotoPath);
                } finally {
                    await client.disconnect();
                }

                // Record internally (use sync-compatible ID so sync won't create a duplicate)
                const submittedByUserId = normalizeSubmitterUserId(interaction.user.id);
                const submittedByAnonymousName = submittedByUserId ? null : username!;
                await db.run(
                    `INSERT INTO submissions (
                        id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                        submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                        submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform
                     )
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                     ON CONFLICT(id) DO UPDATE SET score = MAX(score, excluded.score), discord_user_id = excluded.discord_user_id, photo_url = excluded.photo_url, platform = excluded.platform`,
                    `${game.id}-${username!.toLowerCase()}`, game.id, interaction.user.id, username, score, photo.url, new Date().toISOString(),
                    game.game_room_id || null, game.tournament_id || null, submittedByUserId, submittedByAnonymousName, platform,
                );

                // Log to score history
                const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
                await ScoreHistoryService.log({
                    gameName, gameRoomId: game.game_room_id, gameId: game.id,
                    username: username!, discordUserId: interaction.user.id,
                    score, photoUrl: photo.url, source: 'tournament',
                    tournamentId: game.tournament_id,
                    anonymousName: submittedByAnonymousName,
                    platform,
                });

                // Invalidate leaderboard cache
                await LeaderboardService.invalidate(game.id);

                // Invalidate ranking group caches (scores changed)
                const { RankingService } = await import('../../services/RankingService.js');
                await RankingService.invalidateAll();

                logInfo(`Score submitted: ${username} scored ${score} on ${gameName}`);

                // Fire-and-forget lobby feed event
                import('../../services/LobbyFeedGenerator.js').then(({ LobbyFeedGenerator }) => {
                    LobbyFeedGenerator.onScoreSubmitted({
                        gameRoomId: game.game_room_id, gameName, username: username!,
                        score, discordUserId: interaction.user.id, source: 'tournament',
                    }).catch(() => {});
                }).catch(() => {});

                // Fan-out to global scoreboard (best-effort — never blocks the room submission)
                try {
                    const { GlobalScoreService } = await import('../../services/GlobalScoreService.js');
                    const fanOut = await GlobalScoreService.fanOutFromRoomSubmission({
                        gameRoomId: game.game_room_id,
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
                    });
                    if (fanOut && !excludeGlobal) {
                        const { emitScoreNewGlobal } = await import('../../api/websocket.js');
                        const room = await db.get('SELECT name, slug FROM game_rooms WHERE id = ?', game.game_room_id);
                        emitScoreNewGlobal({
                            globalGameId: fanOut.globalGameId,
                            gameName: fanOut.gameName,
                            playerName: username!,
                            score,
                            originRoomSlug: room?.slug || null,
                            originRoomName: room?.name || null,
                        });
                    }
                } catch (err) {
                    logError('Global fan-out from /submit-score failed (non-fatal):', err);
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

                await interaction.editReply(`Successfully submitted your score of **${score.toLocaleString()}** to **${gameName}**!${webTip}`);

                // Send rating follow-up (fire-and-forget, don't block the score confirmation)
                sendRatingFollowUp(interaction, gameName, username!).catch(err => {
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

        // Save the rating
        try {
            const { RatingService } = await import('../../services/RatingService.js');
            await RatingService.setRating(gameName, interaction.user.id, rating);
            logInfo(`Game rated: ${interaction.user.tag} gave ${gameName} ${rating} stars`);
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
