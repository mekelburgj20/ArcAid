import { EmbedBuilder } from 'discord.js';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { Game } from '../types/index.js';
import { sendChannelMessage, sendChannelEmbed, getTournamentColor, formatUserMention } from '../utils/discord.js';
import { TournamentEngine } from './TournamentEngine.js';
// IScoredClient construction is owned by IScoredSessionRegistry.
import { v4 as uuidv4 } from 'uuid';
import {
    parsePlatformsList, parseTournamentRules, hasGameLevelPlatformRules, firstQualifyingVariant,
    type QualificationVariant,
} from '../utils/platformRules.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { computePickDeadline, isPickWindowExpired, pickWindowFallback, pickPromptPushBody, pickFallbackPhrase, DEFAULT_RUNNERUP_PICK_WINDOW_MIN } from '../utils/pickWindow.js';
import { catalogueTypeMatchesTournamentMode } from '../utils/tournamentMode.js';
import { resolveLeaderboardPlaces } from '../utils/submissionAttribution.js';
import { resolvePick, MAX_PLACES } from './pickResolution.js';

export class TimeoutManager {
    private static instance: TimeoutManager;

    private constructor() {}

    public static getInstance(): TimeoutManager {
        if (!TimeoutManager.instance) {
            TimeoutManager.instance = new TimeoutManager();
        }
        return TimeoutManager.instance;
    }

    /**
     * Checks all QUEUED games for picker timeouts and handles pivots/auto-selections.
     * Called periodically by the Scheduler (every minute).
     */
    public async checkTimeouts(): Promise<void> {
        const db = await getDatabase();

        try {
            // Find all queued games that have a designated picker
            const pendingGames = await db.all(`
                SELECT * FROM games
                WHERE status = 'QUEUED'
                AND picker_discord_id IS NOT NULL
                AND picker_designated_at IS NOT NULL
            `);

            if (pendingGames.length === 0) return;

            // Load per-tournament timeout settings + pick-award gate state
            const tournamentIds = [...new Set(pendingGames.map((g: any) => g.tournament_id).filter(Boolean))];
            const tournamentSettings = new Map<string, { winnerWindowMin: number; runnerUpWindowMin: number }>();
            const gateByTournament = new Map<string, boolean>();
            for (const tid of tournamentIds) {
                const t = await db.get('SELECT winner_pick_window_min, runnerup_pick_window_min, game_room_id FROM tournaments WHERE id = ?', tid);
                tournamentSettings.set(tid, {
                    winnerWindowMin: t?.winner_pick_window_min ?? 60,
                    runnerUpWindowMin: t?.runnerup_pick_window_min ?? 30,
                });
                gateByTournament.set(tid, await PickAwardGate.isEnabled(t?.game_room_id ?? null, tid));
            }

            for (const row of pendingGames) {
                // Pick-award gate off — suspend timeout processing for this slot.
                // Existing slots are grandfathered in: admin can clear via game-states page.
                if (!gateByTournament.get(row.tournament_id)) continue;

                const game: Game = {
                    id: row.id,
                    tournamentId: row.tournament_id,
                    name: row.name,
                    status: row.status as any,
                    pickerDiscordId: row.picker_discord_id,
                    pickerType: row.picker_type as any,
                    pickerDesignatedAt: row.picker_designated_at ? new Date(row.picker_designated_at) : undefined,
                    reminderCount: row.reminder_count ?? 0,
                    wonGameId: row.won_game_id
                };

                const settings = tournamentSettings.get(row.tournament_id) ?? { winnerWindowMin: 60, runnerUpWindowMin: 30 };
                await this.handleTieredTimeout(game, settings);
            }
        } catch (error) {
            logError('Error checking picker timeouts:', error);
        }
    }

    /**
     * Resolves the announcement channel for a tournament.
     * Uses the tournament's discord_channel_id, falling back to the global env var.
     */
    private async getChannelId(tournamentId: string | undefined): Promise<string | null> {
        const { resolveAnnouncementChannelId } = await import('../utils/discord.js');
        if (!tournamentId) return resolveAnnouncementChannelId(null, null);

        const db = await getDatabase();
        const row = await db.get(
            'SELECT discord_channel_id, game_room_id FROM tournaments WHERE id = ?',
            tournamentId,
        );
        return resolveAnnouncementChannelId(row?.game_room_id ?? null, row?.discord_channel_id ?? null);
    }

    private async handleTieredTimeout(game: Game, settings: { winnerWindowMin: number; runnerUpWindowMin: number }): Promise<void> {
        if (!game.pickerDesignatedAt) return;

        // Re-verify the slot still exists (it may have been consumed by a pick between query and handler)
        const db = await getDatabase();
        const stillExists = await db.get('SELECT id FROM games WHERE id = ? AND status = ?', game.id, 'QUEUED');
        if (!stillExists) return;

        const now = new Date();
        const elapsedMins = (now.getTime() - game.pickerDesignatedAt.getTime()) / (1000 * 60);

        const { winnerWindowMin, runnerUpWindowMin } = settings;

        if (game.pickerType === 'WINNER') {
            // Expiry uses the shared predicate so the deadline the lobby feed
            // counts down to is byte-for-byte the one enforced here. (Reminder
            // cadence below still works off elapsed minutes — it's an interval,
            // not a deadline.)
            if (isPickWindowExpired(game.pickerDesignatedAt, winnerWindowMin, now)) {
                logInfo(`Winner for game slot ${game.id} timed out after ${winnerWindowMin}min. Pivoting to runner-up...`);
                await this.pivotToRunnerUp(game);
            } else {
                // Send reminders at 15-minute intervals
                const reminderInterval = 15;
                const nextReminderAt = ((game.reminderCount ?? 0) + 1) * reminderInterval;
                if (elapsedMins >= nextReminderAt) {
                    await this.sendReminder(game, winnerWindowMin - Math.floor(elapsedMins));
                }
            }
        } else if (game.pickerType === 'RUNNER_UP') {
            if (isPickWindowExpired(game.pickerDesignatedAt, runnerUpWindowMin, now)) {
                // Contract §3: before auto-picking, third place's QUEUE is
                // consulted (third never gets a window of their own). Pre-fix
                // this went straight to auto-select, so a third-place player who
                // had already done the work of queuing a pick was ignored.
                logInfo(`Runner-up for game slot ${game.id} timed out after ${runnerUpWindowMin}min. Checking third place's queue...`);
                await this.pivotToThirdPlaceQueue(game);
            } else {
                // Send reminders at 10-minute intervals
                const reminderInterval = 10;
                const nextReminderAt = ((game.reminderCount ?? 0) + 1) * reminderInterval;
                if (elapsedMins >= nextReminderAt) {
                    await this.sendReminder(game, runnerUpWindowMin - Math.floor(elapsedMins));
                }
            }
        }
    }

    /** Resolves tournament info for embed coloring and terminology. */
    private async getTournamentInfo(tournamentId: string | undefined): Promise<{ type: string | null; mode: string | null; gameRoomId: string | null }> {
        if (!tournamentId) return { type: null, mode: null, gameRoomId: null };
        const db = await getDatabase();
        const row = await db.get('SELECT type, mode, game_room_id FROM tournaments WHERE id = ?', tournamentId);
        return { type: row?.type ?? null, mode: row?.mode ?? null, gameRoomId: row?.game_room_id ?? null };
    }

    private async sendReminder(game: Game, minsRemaining: number): Promise<void> {
        const db = await getDatabase();
        try {
            const info = await this.getTournamentInfo(game.tournamentId);
            const term = getTerminology(info.mode);
            const channelId = await this.getChannelId(game.tournamentId);
            logInfo(`Reminder for <@${game.pickerDiscordId}>: ${minsRemaining} minutes left.`);

            if (channelId) {
                const color = getTournamentColor(info.type);
                const pickerMention = await formatUserMention(game.pickerDiscordId!, game.pickerDiscordId!, info.gameRoomId);
                const embed = new EmbedBuilder()
                    .setTitle('Pick Reminder')
                    .setDescription(`${pickerMention}, you have **${minsRemaining} minutes** left to pick the next ${term.game}. Use \`/pick-game\` now!`)
                    .setColor(color)
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }

            await db.run(
                'UPDATE games SET reminder_count = reminder_count + 1 WHERE id = ?',
                game.id
            );
        } catch (error) {
            logError(`Failed to send reminder for game ${game.id}:`, error);
        }
    }

    /**
     * Winner timed out — find the runner-up from the completed game's submissions
     * and assign them picking rights.
     */
    private async pivotToRunnerUp(game: Game): Promise<void> {
        const db = await getDatabase();
        const info = await this.getTournamentInfo(game.tournamentId);
        const term = getTerminology(info.mode);

        try {
            // 2026-08-27 incident: this path activated a queued game into an
            // already-full tournament (the slot this placeholder reserved had
            // been given away). Same guard fallbackToAutoSelection has had all
            // along: a full tournament means the slot is gone — delete the
            // stale placeholder instead of over-activating.
            const engine = TournamentEngine.getInstance();
            const tournamentForGuard = await db.get('SELECT name, max_active_games FROM tournaments WHERE id = ?', game.tournamentId);
            const maxSlotsGuard = tournamentForGuard?.max_active_games ?? 1;
            const activeNow = await engine.getActiveGames(game.tournamentId!);
            const otherPendingSlots = Math.max(0, (await engine.countPendingPickSlots(game.tournamentId!)) - 1);
            if (activeNow.length + otherPendingSlots >= maxSlotsGuard) {
                logInfo(`Pick-window expiry skipped: ${tournamentForGuard?.name ?? game.tournamentId} already at max active games (${activeNow.length}/${maxSlotsGuard}). Removing stale picker slot.`);
                await db.run('DELETE FROM games WHERE id = ?', game.id);
                return;
            }

            if (!game.wonGameId) {
                logWarn(`No won_game_id on slot ${game.id}. Cannot determine runner-up. Falling back to auto-select.`);
                await this.fallbackToAutoSelection(game);
                return;
            }

            // Re-enter the SHARED cascade one place below the winner.
            //
            // Pre-2026-08-17 this hand-rolled its own runner-up lookup — a
            // `LIMIT 1 OFFSET 1` join against user_mappings with no
            // `orphaned_at` filter and no identity dedup — and always granted a
            // window even when the runner-up already had a game queued. That
            // divergence from the rotation path is exactly what the contract
            // consolidates: `resolvePick` now decides here too, so the
            // runner-up's own queue is used immediately, their disposition is
            // honored, and third place's queue is consulted before auto-pick.
            const places = await resolveLeaderboardPlaces(db, game.wonGameId, MAX_PLACES);

            // Resume BELOW whoever just timed out, not blindly at place 1.
            // Without this, a winner who nominated the runner-up would hand that
            // same person a second window the moment the first expired: the
            // nominee holds a WINNER-type window, it lapses, and the pivot walks
            // back to place 1 — them again.
            const timedOutIndex = places.findIndex(p => p.playerId === game.pickerDiscordId);
            const startPlaceIndex = timedOutIndex >= 0 ? timedOutIndex + 1 : 1;

            const { outcome, narrative } = await resolvePick({
                tournamentId: game.tournamentId!,
                places,
                nextQueuedFor: (playerId) => engine.nextEligibleQueuedFor(game.tournamentId!, playerId),
                labelFor: (playerId) => engine.labelForPlayer(playerId),
                isRoomMember: async (playerId) => {
                    if (!info.gameRoomId) return true;
                    const row = await db.get(
                        'SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?',
                        info.gameRoomId, playerId,
                    );
                    return !!row;
                },
                startPlaceIndex,
            });
            const reason = narrative.length ? narrative.join(' ') : null;

            if (outcome.kind === 'auto') {
                logWarn(`No eligible picker below the winner for game ${game.wonGameId}. Falling back to auto-select.`);
                const channelId = await this.getChannelId(game.tournamentId);
                if (channelId) {
                    const color = getTournamentColor(info.type);
                    const embed = new EmbedBuilder()
                        .setTitle('Winner Timed Out')
                        .setDescription(reason
                            ? `${reason} Auto-selecting a ${term.game}...`
                            : `No eligible runner-up was found. Auto-selecting a ${term.game}...`)
                        .setColor(color)
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
                await this.fallbackToAutoSelection(game);
                return;
            }

            if (outcome.kind === 'activate') {
                await this.activateQueuedIntoSlot(game, outcome.game, reason, info);
                return;
            }

            const runnerUpId = outcome.playerId;
            const runnerUpName = outcome.iscoredUsername;
            logInfo(`   -> Pivoting to next place: <@${runnerUpId}> (pick window).`);

            // Reassign the QUEUED slot to the resolved picker
            const tournamentRow = await db.get('SELECT name, runnerup_pick_window_min FROM tournaments WHERE id = ?', game.tournamentId);
            const runnerUpWindowMin = tournamentRow?.runnerup_pick_window_min ?? DEFAULT_RUNNERUP_PICK_WINDOW_MIN;

            // Same instant drives the row, the feed countdown and (v2.70.0) the
            // runner-up's own push body.
            const pickerDesignatedAt = new Date().toISOString();
            const pickDeadline = computePickDeadline(pickerDesignatedAt, runnerUpWindowMin);
            await db.run(
                `UPDATE games
                 SET picker_discord_id = ?, picker_type = 'RUNNER_UP', picker_designated_at = ?, reminder_count = 0
                 WHERE id = ?`,
                runnerUpId, pickerDesignatedAt, game.id
            );

            // The pivot hands a fresh manual-pick obligation to a different
            // player, so it gets its own public prompt — same event type, the
            // shorter runner-up window, and fallback 'autopick' (there is no
            // third picker after this one).
            if (info.gameRoomId) {
                const runnerUpLabel = await (await import('../services/UserProfileService.js')).UserProfileService
                    .getDisplayName(runnerUpId)
                    .catch(() => null) || runnerUpName || 'Runner-up';
                import('../services/LobbyFeedService.js').then(({ LobbyFeedService }) => {
                    LobbyFeedService.emit({
                        gameRoomId: info.gameRoomId!,
                        type: 'pick_prompt',
                        title: `${runnerUpLabel}, pick the next ${term.game} for ${tournamentRow?.name ?? 'the tournament'}`,
                        playerId: runnerUpId,
                        tournamentId: game.tournamentId,
                        metadata: {
                            deadline: pickDeadline.toISOString(),
                            windowMin: runnerUpWindowMin,
                            pickerType: 'RUNNER_UP',
                            fallback: pickWindowFallback('RUNNER_UP', game.wonGameId),
                            pickerName: runnerUpLabel,
                            tournamentName: tournamentRow?.name ?? null,
                        },
                    }).catch(() => {});
                }).catch(() => {});
            }

            const channelId = await this.getChannelId(game.tournamentId);
            if (channelId) {
                const color = getTournamentColor(info.type);
                const runnerUpMention = await formatUserMention(runnerUpId, runnerUpName || 'Runner-up', info.gameRoomId);
                const embed = new EmbedBuilder()
                    .setTitle(`⏰ Winner Timed Out`)
                    .setDescription(`${runnerUpMention} — as the runner-up, you now have **${runnerUpWindowMin} minutes** to pick the next ${term.game}. Use \`/pick-game\`!`)
                    .setColor(color)
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }

            // v2.70.0 — the pivot hands a REAL, short pick obligation to someone
            // who was not expecting one, and until now the only warning was a
            // channel embed they had to happen to be reading. The winner gets a
            // personal turnToPick notification at the placeholder-creation site;
            // the runner-up, whose window is the SHORTER of the two, got none.
            //
            // Same `notify` call, so the same opt-in semantics apply (per-type
            // pref, webPush channel flag, rate limit, pick-award gate). Copy is
            // 'autopick', not 'runner-up' — there is no third picker after this
            // one, which is exactly what `pickWindowFallback('RUNNER_UP', …)`
            // returns.
            const runnerUpFallback = pickWindowFallback('RUNNER_UP', game.wonGameId);
            import('../services/NotificationService.js').then(async ({ NotificationService }) => {
                const room = info.gameRoomId
                    ? await db.get('SELECT slug FROM game_rooms WHERE id = ?', info.gameRoomId).catch(() => null)
                    : null;
                const link = room?.slug ? NotificationService.buildLink(room.slug, '/picks') : '';
                await NotificationService.notify({
                    userId: runnerUpId,
                    type: 'turnToPick',
                    message: `The winner's pick window closed, so it's your turn as runner-up in **${tournamentRow?.name ?? 'the tournament'}**. You have **${runnerUpWindowMin} minutes** to use \`/pick-game\` or pick from the web, or ${pickFallbackPhrase(runnerUpFallback)}.${link ? `\n${link}` : ''}`,
                    pushBody: pickPromptPushBody(tournamentRow?.name ?? null, pickDeadline, runnerUpFallback),
                    roomId: info.gameRoomId,
                    tournamentId: game.tournamentId,
                    pushUrl: link || undefined,
                });
            }).catch(() => {});

        } catch (error) {
            logError(`Failed to pivot to runner-up for slot ${game.id}:`, error);
            await this.fallbackToAutoSelection(game);
        }
    }

    /**
     * A runner-up's window expired. Contract §3: third place is consulted for a
     * QUEUED pick only — they never receive a window and their disposition is
     * not read — and auto-pick is the last resort.
     *
     * Routed through the same `resolvePick` as every other step (with
     * `startPlaceIndex: 2`) so there is one implementation of the place table,
     * not a second hand-rolled copy of it here.
     */
    private async pivotToThirdPlaceQueue(game: Game): Promise<void> {
        const db = await getDatabase();
        const info = await this.getTournamentInfo(game.tournamentId);

        try {
            // 2026-08-27 incident: this path activated a queued game into an
            // already-full tournament (the slot this placeholder reserved had
            // been given away). Same guard fallbackToAutoSelection has had all
            // along: a full tournament means the slot is gone — delete the
            // stale placeholder instead of over-activating.
            const engine = TournamentEngine.getInstance();
            const tournamentForGuard = await db.get('SELECT name, max_active_games FROM tournaments WHERE id = ?', game.tournamentId);
            const maxSlotsGuard = tournamentForGuard?.max_active_games ?? 1;
            const activeNow = await engine.getActiveGames(game.tournamentId!);
            const otherPendingSlots = Math.max(0, (await engine.countPendingPickSlots(game.tournamentId!)) - 1);
            if (activeNow.length + otherPendingSlots >= maxSlotsGuard) {
                logInfo(`Pick-window expiry skipped: ${tournamentForGuard?.name ?? game.tournamentId} already at max active games (${activeNow.length}/${maxSlotsGuard}). Removing stale picker slot.`);
                await db.run('DELETE FROM games WHERE id = ?', game.id);
                return;
            }

            if (!game.wonGameId || !game.tournamentId) {
                await this.fallbackToAutoSelection(game);
                return;
            }

            const places = await resolveLeaderboardPlaces(db, game.wonGameId, MAX_PLACES);
            const { outcome, narrative } = await resolvePick({
                tournamentId: game.tournamentId,
                places,
                nextQueuedFor: (playerId) => engine.nextEligibleQueuedFor(game.tournamentId!, playerId),
                labelFor: (playerId) => engine.labelForPlayer(playerId),
                isRoomMember: async () => true, // no window is granted here, so onboarding never applies
                startPlaceIndex: 2,
            });

            if (outcome.kind === 'activate') {
                await this.activateQueuedIntoSlot(
                    game, outcome.game, narrative.length ? narrative.join(' ') : null, info,
                );
                return;
            }

            await this.fallbackToAutoSelection(game);
        } catch (error) {
            logError(`Third-place queue check failed for slot ${game.id}:`, error);
            await this.fallbackToAutoSelection(game);
        }
    }

    /**
     * Fill a picker placeholder with a game that was already sitting in a
     * player's queue, and activate it.
     *
     * The placeholder ROW is reused rather than promoting the queued row, so the
     * slot keeps the identity anything already references (`won_game_id`
     * lookups, the Picks page); the consumed queued row is then deleted. iScored
     * handling mirrors `fallbackToAutoSelection`: create the entry when the
     * queued row was never pushed to iScored, otherwise just unlock the one it
     * already has.
     */
    private async activateQueuedIntoSlot(
        slot: Game,
        queuedRow: any,
        reason: string | null,
        info: { type: string | null; mode: string | null; gameRoomId: string | null },
    ): Promise<void> {
        const db = await getDatabase();
        const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', slot.tournamentId);

        const existingIscoredId: string | null = queuedRow.iscored_id ?? null;
        let iscoredId: string | null = existingIscoredId;

        const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(tournament?.game_room_id ?? null);
        if (creds) {
            const { IScoredSessionRegistry } = await import('./IScoredSessionRegistry.js');
            try {
                iscoredId = await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                    if (!existingIscoredId) {
                        const id = await client.createGame(queuedRow.name, queuedRow.style_id || undefined);
                        await client.setGameTags(id, tournament?.type);
                        await client.setGameStatus(id, { locked: false, hidden: false });
                        return id;
                    }
                    await client.setGameStatus(existingIscoredId, { locked: false, hidden: false });
                    return existingIscoredId;
                });
            } catch (err) {
                logError('   -> Failed to prepare the queued game on iScored (continuing):', err);
            }
        }

        await db.run(
            `UPDATE games
             SET name = ?, style_id = ?, iscored_id = ?, status = 'ACTIVE', start_date = ?,
                 picker_discord_id = NULL, picker_type = NULL, picker_designated_at = NULL, reminder_count = 0
             WHERE id = ?`,
            queuedRow.name, queuedRow.style_id || null, iscoredId, new Date().toISOString(), slot.id,
        );
        await db.run('DELETE FROM games WHERE id = ?', queuedRow.id);
        logInfo(`   -> Activated queued game "${queuedRow.name}" into slot ${slot.id}.`);

        // The engine just consumed one of this player's picks (v2.126.0): close
        // the hole it left in their 1..N sequence, and nudge them if the queue
        // is running low. Both are courtesies — neither may fail the timeout
        // path, which is why they are individually caught.
        if (slot.tournamentId && queuedRow.picker_discord_id) {
            try {
                const { compactQueue } = await import('../services/PickQueueService.js');
                await compactQueue(slot.tournamentId, queuedRow.picker_discord_id);
            } catch (err) {
                logError('   -> Failed to compact the queue after activation (continuing):', err);
            }
            try {
                const { QueueLowNudgeService } = await import('../services/QueueLowNudgeService.js');
                void QueueLowNudgeService.maybeNudge(queuedRow.picker_discord_id, slot.tournamentId).catch(() => {});
            } catch { /* never surfaces */ }
        }

        const channelId = await this.getChannelId(slot.tournamentId);
        if (channelId) {
            const color = getTournamentColor(info.type);
            const embed = new EmbedBuilder()
                .setTitle(`Now Active: ${queuedRow.name}`)
                .setDescription(reason
                    ? `${reason} **${queuedRow.name}** is now active for **${tournament?.name ?? 'the tournament'}**.`
                    : `**${queuedRow.name}** was already queued and is now active for **${tournament?.name ?? 'the tournament'}**.`)
                .setColor(color)
                .setFooter({ text: tournament?.name ?? '' })
                .setTimestamp();
            await sendChannelEmbed(channelId, embed);
        }
    }

    /**
     * All pickers timed out — select a random eligible game from the game_library,
     * create it on iScored, and fill the QUEUED slot.
     */
    private async fallbackToAutoSelection(game: Game): Promise<void> {
        const db = await getDatabase();

        try {
            if (!game.tournamentId) {
                logError(`Cannot auto-select: no tournament_id on game slot ${game.id}.`);
                return;
            }

            const engine = TournamentEngine.getInstance();

            const tournament = await db.get('SELECT * FROM tournaments WHERE id = ?', game.tournamentId);
            if (!tournament) {
                logError(`Cannot auto-select: tournament ${game.tournamentId} not found.`);
                return;
            }

            // Guard: if tournament already has max active games, the winner likely
            // already picked. Remove the orphaned picker slot instead of auto-selecting.
            const maxSlots = tournament.max_active_games ?? 1;
            const currentActive = await engine.getActiveGames(game.tournamentId);
            if (currentActive.length >= maxSlots) {
                logInfo(`Auto-select skipped: ${tournament.name} already at max active games (${currentActive.length}/${maxSlots}). Removing orphaned picker slot.`);
                await db.run('DELETE FROM games WHERE id = ?', game.id);
                return;
            }

            // Check if auto_pick is disabled
            if (tournament.auto_pick === 0) {
                // v2.77.0 — DELETE, don't orphan. Pre-fix this UPDATEd the
                // placeholder to picker_discord_id = NULL and left it QUEUED:
                // invisible to both the Picks page and the nav badge (both key
                // on picker_discord_id) while still sitting at the head of the
                // queue with queue_order = NULL, silently blocking the
                // tournament. The pick is abandoned either way — mirror the
                // "already at max active games" delete above.
                logInfo(`Auto-pick disabled for ${tournament.name}. Removing the unfulfilled picker slot ${game.id}.`);
                await db.run('DELETE FROM games WHERE id = ?', game.id);
                const channelId = await this.getChannelId(game.tournamentId);
                if (channelId) {
                    const term = getTerminology(tournament.mode);
                    const color = getTournamentColor(tournament.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`No ${term.game} Selected`)
                        .setDescription(`All pickers timed out and auto-pick is disabled for **${tournament.name}**. A moderator must use \`/pick-game\`.`)
                        .setColor(color)
                        .setFooter({ text: tournament.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
                return;
            }

            const term = getTerminology(tournament.mode);

            // Parse platform rules
            const platformRules = parseTournamentRules(tournament, game.tournamentId);

            const eligibilityDays = tournament.eligibility_days ?? 120;

            // Get games matching tournament mode + platform rules from the
            // catalogue — one row per catalogue VARIANT, grouped by name in
            // JS below. v2.144.1: a prior `GROUP BY LOWER(name)` +
            // `MIN()`-per-column here could pair one variant's `platforms`
            // with a DIFFERENT variant's `features` (the Walking Dead miss);
            // qualification must judge each variant's platforms + features
            // together, never mixed.
            const catalogueVariantRows = await db.all(`
                SELECT name, type AS mode, platforms, features
                FROM global_games WHERE status = 'approved'
            `);
            // `style_id`: `global_games` was never selected for it here (pre-
            // v2.144.1 either) — always undefined. Kept on the shape only so
            // the downstream `pick.style_id` reads below still type-check;
            // not in scope of the variant-qualification fix.
            const libraryGames = new Map<string, { name: string; variants: QualificationVariant[]; style_id?: string }>();
            for (const r of catalogueVariantRows) {
                const key = r.name.toLowerCase();
                const entry = libraryGames.get(key) ?? { name: r.name, variants: [] as QualificationVariant[] };
                entry.variants.push({
                    mode: r.mode,
                    platforms: parsePlatformsList(r.platforms || '[]'),
                    features: parsePlatformsList(r.features || '[]'),
                });
                libraryGames.set(key, entry);
            }
            // Pre-load room tag map for batched lookup (no N+1 in filter).
            let tagMap: Map<string, string[]> = new Map();
            if (tournament.game_room_id) {
                const { RoomGameTagsService } = await import('../services/RoomGameTagsService.js');
                tagMap = await RoomGameTagsService.getTagMapByGameNameForRoom(tournament.game_room_id);
            }
            const gameLevelRules = hasGameLevelPlatformRules(platformRules);
            // A name qualifies iff ANY ONE of its catalogue variants qualifies
            // on its own (v2.144.1) — never a MIN-mixed pair.
            const modeAndPlatformMatches = [...libraryGames.values()].filter(g => {
                // v2.6.x: `excluded` is a submission-level filter only; the
                // game-level gate checks `required` exclusively against
                // catalogue ∪ room tags. v2.60.0 (ADR 0016 P2): both axes, via
                // the shared `passesplatformRules`.
                if (!gameLevelRules) {
                    // `catalogueTypeMatchesTournamentMode` bridges
                    // tournament.mode ('videogame') against
                    // global_games.type ('video_game' | 'arcade') — see
                    // src/utils/tournamentMode.ts. No platform rules to check,
                    // so any variant matching mode qualifies the name.
                    return g.variants.some(v => catalogueTypeMatchesTournamentMode(v.mode, tournament.mode));
                }
                const tags = tagMap.get(g.name.toLowerCase()) || [];
                return !!firstQualifyingVariant(g.variants, tournament.mode, platformRules, tags);
            });

            // Filter by eligibility — batch query instead of per-game check
            const lookbackDate = new Date();
            lookbackDate.setDate(lookbackDate.getDate() - eligibilityDays);
            const recentlyPlayed = await db.all(
                `SELECT DISTINCT name FROM games
                 WHERE tournament_id = ? AND start_date >= ? AND status != 'QUEUED'`,
                game.tournamentId, lookbackDate.toISOString()
            );
            const recentlyPlayedSet = new Set(recentlyPlayed.map((r: any) => r.name.toLowerCase()));
            const eligible = modeAndPlatformMatches.filter(
                g => !recentlyPlayedSet.has(g.name.toLowerCase())
            );

            if (eligible.length === 0) {
                // v2.77.0 — same orphan fix as the auto-pick-disabled branch:
                // DELETE rather than leave a picker-less QUEUED row wedged at
                // the head of the queue where nothing can see or clear it.
                logWarn(`No eligible ${term.games} found for auto-selection in ${tournament.name}. Removing the unfulfilled picker slot ${game.id}.`);
                await db.run('DELETE FROM games WHERE id = ?', game.id);
                const channelId = await this.getChannelId(game.tournamentId);
                if (channelId) {
                    const color = getTournamentColor(tournament.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`No Eligible ${term.games}`)
                        .setDescription(`All pickers timed out and no eligible ${term.games} were found for **${tournament.name}**. A moderator must use \`/pick-game\` or \`/pause-pick\`.`)
                        .setColor(color)
                        .setFooter({ text: tournament.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
                return;
            }

            // Pick one at random
            const pick = eligible[Math.floor(Math.random() * eligible.length)]!;
            logInfo(`Auto-selected: ${pick.name} for ${tournament.name}`);

            // Create on iScored if credentials are available (per-room → env fallback).
            // Routes through IScoredSessionRegistry so this fallback path can't
            // contend with concurrent maintenance fires on the same account
            // (the timeout cron `* * * * *` overlaps with maintenance crons by
            // design — picker timeouts naturally fire after a maintenance run
            // that just created the picker slot).
            let iscoredId: string | null = null;
            const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
            const creds = await getIScoredCredsForRoom(tournament.game_room_id);

            if (creds) {
                const { IScoredSessionRegistry } = await import('./IScoredSessionRegistry.js');
                try {
                    iscoredId = await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                        const id = await client.createGame(pick.name, pick.style_id || undefined);
                        await client.setGameTags(id, tournament.type);
                        await client.setGameStatus(id, { locked: false, hidden: false });
                        return id;
                    });
                    logInfo(`   -> Created on iScored: ${pick.name} (ID: ${iscoredId})`);
                } catch (err) {
                    logError('   -> Failed to create auto-selected game on iScored:', err);
                }
            }

            // Update the QUEUED slot with the selected game — activate immediately
            await db.run(
                `UPDATE games
                 SET name = ?, style_id = ?, iscored_id = ?, status = 'ACTIVE', start_date = ?,
                     picker_discord_id = NULL, picker_type = NULL, picker_designated_at = NULL, reminder_count = 0
                 WHERE id = ?`,
                pick.name, pick.style_id || null, iscoredId, new Date().toISOString(), game.id
            );
            logInfo(`   -> Auto-selected and activated: ${pick.name}`);

            const channelId = await this.getChannelId(game.tournamentId);
            if (channelId) {
                const color = getTournamentColor(tournament.type);
                const embed = new EmbedBuilder()
                    .setTitle(`Now Active: ${pick.name}`)
                    .setDescription(`All pickers timed out! **${pick.name}** has been auto-selected and activated for **${tournament.name}**.`)
                    .setColor(color)
                    .setFooter({ text: tournament.name })
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }

        } catch (error) {
            // v2.77.0 — a transient failure (iScored down, DB hiccup) must not
            // cost the player their pick. Pre-fix this cleared
            // picker_discord_id, which left the placeholder QUEUED and
            // ownerless: gone from the Picks page and the badge, but still
            // blocking the slot. The row is now left exactly as it was, so the
            // player keeps seeing "Awaiting your pick" and the next timeout
            // sweep can retry it.
            logError(`Auto-selection failed for slot ${game.id} — leaving the picker slot intact for retry:`, error);
        }
    }
}
