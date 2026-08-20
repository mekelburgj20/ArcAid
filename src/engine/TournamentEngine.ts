import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/database.js';
import { Tournament, Game, TournamentMode, CadenceConfig, CleanupRule } from '../types/index.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getTerminology } from '../utils/terminology.js';
import { sendChannelMessage, sendChannelEmbed, getTournamentColor, formatUserMention } from '../utils/discord.js';
import { IScoredClient } from './IScoredClient.js';
import { IScoredSessionRegistry } from './IScoredSessionRegistry.js';
import { IScoredCreds } from '../utils/iscoredCreds.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import { emitGameRotated, emitPickerAssigned } from '../api/websocket.js';
import { computePickDeadline, pickWindowFallback, pickPromptPushBody, pickFallbackPhrase, DEFAULT_WINNER_PICK_WINDOW_MIN, DEFAULT_RUNNERUP_PICK_WINDOW_MIN, windowMinForPicker } from '../utils/pickWindow.js';
import { RoomEventService } from '../services/RoomEventService.js';
import { parsePlatformsList, parseTournamentRules, passesplatformRules, hasGameLevelPlatformRules } from '../utils/platformRules.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import { MaintenanceRunService } from '../services/MaintenanceRunService.js';
import { AchievementService } from '../services/AchievementService.js';
import { isProviderUserId } from '../utils/identityProvider.js';
import { catalogueTypeMatchesTournamentMode } from '../utils/tournamentMode.js';
import { trackBackground } from '../utils/backgroundTasks.js';
import { PickDispositionService } from '../services/PickDispositionService.js';
import { resolveSubmissionPlayerId, resolveLeaderboardPlaces } from '../utils/submissionAttribution.js';
import { resolvePick, MAX_PLACES } from './pickResolution.js';
import { tournamentUrlSlug } from '../utils/tournamentSlug.js';

/**
 * v2.103.0 — thrown by `activateGame` when the tournament already has an
 * ACTIVE game of the same name (case-insensitive). Callers surface it as a
 * friendly "already running" message; anything else propagating it is a bug.
 */
export class DuplicateActiveGameError extends Error {
    constructor(gameName: string) {
        super(`"${gameName}" is already active in this tournament.`);
        this.name = 'DuplicateActiveGameError';
    }
}

/**
 * Outcome of a single maintenance run, surfaced to the S10 maintenance-run
 * trail. 'error' is recorded by runMaintenance when the work throws.
 */
type MaintenanceRunOutcome = { outcome: 'success' | 'skipped'; summary: string };

export class TournamentEngine {
    private static instance: TournamentEngine;

    /** Per-tournament mutex to prevent concurrent maintenance on the same tournament */
    private maintenanceLocks: Map<string, Promise<MaintenanceRunOutcome>> = new Map();

    private constructor() {}

    /** Check if iScored integration is enabled for a room. Defaults to true. */
    private async isIScoredEnabled(gameRoomId: string | null): Promise<boolean> {
        if (!gameRoomId) return true;
        const setting = await GameRoomSettingsService.get(gameRoomId, 'ISCORED_ENABLED');
        return setting !== 'false';
    }

    public static getInstance(): TournamentEngine {
        if (!TournamentEngine.instance) {
            TournamentEngine.instance = new TournamentEngine();
        }
        return TournamentEngine.instance;
    }

    /**
     * Creates a new tournament in the database.
     */
    public async createTournament(name: string, type: string, mode: TournamentMode, cadence: CadenceConfig, guildId: string, channelId?: string, roleId?: string): Promise<Tournament> {
        const db = await getDatabase();
        const tournament: Tournament = {
            id: uuidv4(),
            name,
            type,
            mode,
            cadence,
            guildId,
            discordChannelId: channelId,
            discordRoleId: roleId,
            isActive: true,
            winnerPicks: true,
            autoPick: true,
            eligibilityDays: 120,
            winnerPickWindowMin: 60,
            runnerupPickWindowMin: 30,
        };

        logInfo(`Creating new ${getTerminology(mode).tournament}: ${name} (${type})`);

        await db.run(
            'INSERT INTO tournaments (id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            tournament.id, tournament.name, tournament.type, JSON.stringify(tournament.cadence), tournament.guildId, tournament.discordChannelId, tournament.discordRoleId, tournament.isActive ? 1 : 0
        );

        return tournament;
    }

    /**
     * Activates a new game for a specific tournament immediately.
     * If completeExisting is true (default for /pick-game), marks existing ACTIVE games as COMPLETED.
     * If false (admin activate), allows multiple active games.
     */
    public async activateGame(tournamentId: string, gameName: string, styleId?: string, iscoredId?: string, completeExisting: boolean = true): Promise<Game> {
        const db = await getDatabase();
        const game: Game = {
            id: uuidv4(),
            tournamentId,
            name: gameName,
            iscoredId,
            styleId,
            status: 'ACTIVE',
            startDate: new Date()
        };

        logInfo(`Activating new game for tournament ${tournamentId}: ${gameName}`);

        if (completeExisting) {
            // Deactivate current active game for this tournament
            await db.run(
                'UPDATE games SET status = ?, end_date = ? WHERE tournament_id = ? AND status = ?',
                'COMPLETED', new Date().toISOString(), tournamentId, 'ACTIVE'
            );
        }

        // v2.103.0 — duplicate-activation guard (UAT field incident 2026-08-12:
        // two players with rotation-granted pick rights picked "Tales from the
        // Crypt" 5 minutes apart and BOTH activations landed, each creating
        // its own iScored board; cooldown only inspects FINISHED games, so a
        // live twin sailed through). This is the one chokepoint every
        // interactive activation routes through (web pick, admin activate,
        // Discord /pick-game + /activate-game) — the queued-promotion path in
        // runMaintenanceWork has its own skip-and-stay-queued twin of this
        // check. Placed AFTER the completeExisting block so single-slot
        // rotation (which completes the incumbent first) is unaffected.
        const activeTwin = await db.get(
            `SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE' AND LOWER(name) = LOWER(?)`,
            tournamentId, gameName,
        );
        if (activeTwin) {
            throw new DuplicateActiveGameError(gameName);
        }

        // Look up the owning room up-front so the games row carries game_room_id
        // directly (denormalized, see migration 102) and not only via tournament_id.
        const tournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);

        // Insert the new game
        await db.run(
            'INSERT INTO games (id, tournament_id, name, iscored_id, style_id, status, start_date, game_room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.iscoredId, game.styleId, game.status, game.startDate?.toISOString(), tournament?.game_room_id ?? null
        );

        // Auto-apply default catalogue style and display_name from room's game library (if set)
        if (tournament?.game_room_id) {
            const libraryEntry = await db.get(
                `SELECT catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled,
                        bg_zoom, bg_pos_x, bg_pos_y
                 FROM game_room_game_library
                 WHERE game_room_id = ? AND game_name = ? AND (catalogue_style_id IS NOT NULL OR logo_style_id IS NOT NULL OR bg_style_id IS NOT NULL)`,
                tournament.game_room_id, gameName
            );
            if (libraryEntry) {
                // v2.115.0: the background framing travels with the style, so a
                // saved library default keeps its framing across rotations.
                await db.run(
                    `UPDATE games SET catalogue_style_id = ?, logo_style_id = ?, bg_style_id = ?, style_header_disabled = ?,
                        bg_zoom = ?, bg_pos_x = ?, bg_pos_y = ? WHERE id = ?`,
                    libraryEntry.catalogue_style_id, libraryEntry.logo_style_id, libraryEntry.bg_style_id, libraryEntry.style_header_disabled,
                    libraryEntry.bg_zoom ?? null, libraryEntry.bg_pos_x ?? null, libraryEntry.bg_pos_y ?? null,
                    game.id
                );
            }
            // Apply display_name and external_url from the catalogue.
            const libGame = await db.get(
                `SELECT display_name, external_url FROM global_games
                 WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
                gameName
            );
            if (libGame?.display_name || libGame?.external_url) {
                await db.run('UPDATE games SET display_name = COALESCE(?, display_name), external_url = COALESCE(?, external_url) WHERE id = ?',
                    libGame.display_name || null, libGame.external_url || null, game.id);
            }
        }

        return game;
    }

    /**
     * Queues a game for a tournament (status = QUEUED, no start date).
     */
    public async queueGame(tournamentId: string, gameName: string, styleId?: string, iscoredId?: string, pickerDiscordId?: string): Promise<Game> {
        const db = await getDatabase();

        // Next queue_order for THIS PLAYER in this tournament.
        //
        // Queues are per-player (owner spec 2026-08-17): a queue is "my pick if
        // I win", not a room-level play-next list, so two players legitimately
        // both hold position 1. Allocating from a tournament-global MAX was the
        // root of the reorder collision — PUT /:roomId/queue/reorder renumbers a
        // player's own games 1..N, which only agrees with the allocator once the
        // allocator is player-scoped too.
        //
        // '[Pending Pick]' placeholders are excluded: they carry queue_order
        // NULL so they sort ahead of everything, and counting them would leave a
        // hole in the sequence.
        const maxRow = await db.get(
            `SELECT COALESCE(MAX(queue_order), 0) + 1 as next_order FROM games
             WHERE tournament_id = ? AND status = ? AND name != '[Pending Pick]'
               AND picker_discord_id IS ?`,
            tournamentId, 'QUEUED', pickerDiscordId ?? null
        );
        const queueOrder = maxRow?.next_order ?? 1;

        const game: Game = {
            id: uuidv4(),
            tournamentId,
            name: gameName,
            iscoredId,
            styleId,
            status: 'QUEUED',
            queueOrder,
        };

        logInfo(`Queuing game for tournament ${tournamentId}: ${gameName} (queue_order: ${queueOrder})`);

        const qTournament = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);
        await db.run(
            'INSERT INTO games (id, tournament_id, name, iscored_id, style_id, status, picker_discord_id, queue_order, game_room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            game.id, game.tournamentId, game.name, game.iscoredId, game.styleId, game.status, pickerDiscordId || null, queueOrder, qTournament?.game_room_id ?? null
        );

        return game;
    }

    /**
     * Deactivates an active game — locks on iScored (preserving the historical
     * record) and marks COMPLETED in DB. Pairs with `deleteGameCompletely()`,
     * which is the destructive variant for "wrong game in wrong tournament"
     * scenarios.
     *
     * Flow:
     *   1. `finalSyncScoresForGame()` pulls iScored scores into submissions +
     *      score_history so anything submitted between the last poll cycle
     *      and this deactivation is captured.
     *   2. `setGameStatus({ locked: true })` on iScored — the game stays
     *      visible there for historical browsing but accepts no new scores.
     *      Skipped (`'shared'`) when another ACTIVE games row shares the
     *      iscored_id, since locking would block the other tournament.
     *   3. Mark COMPLETED. **`iscored_id` is intentionally KEPT non-NULL** so
     *      `runCleanup` (cleanup_rule retain/scheduled/immediate) can find
     *      this row later. The duplicate-DM bug that motivated the v2.7.x
     *      cleanup contract is now killed by the SyncPoller's `ORDER BY` —
     *      see `ScoreSyncPoller.pollOneAccount` (Fix B for the WHO dunnit /
     *      rtx_pinball incident, 2026-04-27).
     */
    public async deactivateGame(gameId: string, dbOnly: boolean = false): Promise<{
        gameName: string;
        tournamentName: string;
        iscoredStatus: 'locked' | 'failed' | 'shared' | 'skipped';
        iscoredError?: string;
        finalSyncedScores?: number;
    }> {
        const db = await getDatabase();

        const row = await db.get(
            // ADR 0016 P2 §3b: `iscored_default_engine`/`_device` are NOT
            // selected — synced scores are always unknown/unknown, no inference.
            `SELECT g.*, t.name as tournament_name, t.type as tournament_type, t.game_room_id,
                    t.iscored_default_platform
             FROM games g JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ?`,
            gameId
        );
        if (!row) throw new Error('Game not found');
        if (row.status !== 'ACTIVE') throw new Error(`Game is not active (status: ${row.status})`);

        let iscoredStatus: 'locked' | 'failed' | 'shared' | 'skipped' = 'skipped';
        let iscoredError: string | undefined;
        let finalSyncedScores: number | undefined;

        if (!dbOnly && row.iscored_id) {
            const otherActive = await db.get(
                `SELECT id FROM games WHERE iscored_id = ? AND status = 'ACTIVE' AND id != ?`,
                row.iscored_id, gameId
            );

            if (otherActive) {
                // Another ACTIVE row owns this iScored entity — locking would
                // block its tournament too. Leave iScored alone.
                logInfo(`Skipping iScored lock — another active game shares iscored_id ${row.iscored_id}`);
                iscoredStatus = 'shared';
            } else {
                // Capture pending scores so anything that landed on iScored
                // since the last poll cycle is mirrored locally before lock.
                try {
                    finalSyncedScores = await this.finalSyncScoresForGame(row);
                    if (finalSyncedScores > 0) {
                        logInfo(`Final-synced ${finalSyncedScores} score(s) for ${row.name} before iScored lock`);
                    }
                } catch (err) {
                    logError(`Final sync failed for ${row.name} (continuing with lock):`, err);
                }

                const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
                const creds = await getIScoredCredsForRoom(row.game_room_id);
                if (creds) {
                    try {
                        await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                            await client.setGameStatus(row.iscored_id, { locked: true });
                        });
                        logInfo(`Locked on iScored: ${row.name} (${row.iscored_id})`);
                        iscoredStatus = 'locked';
                    } catch (err) {
                        logError('Failed to lock game on iScored (continuing with DB update):', err);
                        iscoredStatus = 'failed';
                        iscoredError = err instanceof Error ? err.message : String(err);
                    }
                }
            }
        }

        await db.run(
            'UPDATE games SET status = ?, end_date = ? WHERE id = ?',
            'COMPLETED', new Date().toISOString(), gameId
        );
        const syncSuffix = finalSyncedScores ? `, captured ${finalSyncedScores}` : '';
        logInfo(`Deactivated game: ${row.name} (tournament: ${row.tournament_name})${dbOnly ? ' [DB only]' : ''} (iScored: ${iscoredStatus}${syncSuffix})`);

        return {
            gameName: row.name,
            tournamentName: row.tournament_name,
            iscoredStatus,
            iscoredError,
            finalSyncedScores,
        };
    }

    /**
     * Destructive removal: pairs with `deactivateGame()` for the case where a
     * game was activated for the wrong tournament (or otherwise should never
     * have existed). Final-syncs scores, deletes from iScored, orphans the
     * local scores (sets game_id = NULL on submissions/score_history and
     * origin_game_id = NULL on global_scores), then DELETEs the games row.
     *
     * Score *records* are preserved (orphaned, not deleted) so the player who
     * submitted to the wrong-tournament game still keeps their entry in their
     * personal history — matches the unpin/cascade pattern in ADR 0005.
     *
     * Status guard: caller-controlled. Default behavior allows ACTIVE,
     * COMPLETED, and QUEUED — anything except already-ARCHIVED. Use
     * `requireActive: true` to restrict to ACTIVE rows.
     */
    public async deleteGameCompletely(
        gameId: string,
        opts: { requireActive?: boolean } = {},
    ): Promise<{
        gameName: string;
        tournamentName: string | null;
        iscoredStatus: 'deleted' | 'failed' | 'shared' | 'skipped';
        iscoredError?: string;
        finalSyncedScores?: number;
        scoresOrphaned: { submissions: number; scoreHistory: number; globalScores: number };
    }> {
        const db = await getDatabase();

        const row = await db.get(
            // ADR 0016 P2 §3b: engine/device defaults are not read (see above).
            `SELECT g.*, t.name as tournament_name, t.game_room_id,
                    t.iscored_default_platform
             FROM games g LEFT JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ?`,
            gameId,
        );
        if (!row) throw new Error('Game not found');
        if (opts.requireActive && row.status !== 'ACTIVE') {
            throw new Error(`Game is not active (status: ${row.status})`);
        }

        let iscoredStatus: 'deleted' | 'failed' | 'shared' | 'skipped' = 'skipped';
        let iscoredError: string | undefined;
        let finalSyncedScores: number | undefined;

        if (row.iscored_id) {
            const otherActive = await db.get(
                `SELECT id FROM games WHERE iscored_id = ? AND status = 'ACTIVE' AND id != ?`,
                row.iscored_id, gameId,
            );
            if (otherActive) {
                logInfo(`Skipping iScored delete — another active game shares iscored_id ${row.iscored_id}`);
                iscoredStatus = 'shared';
            } else {
                // Capture pending scores even on a "wrong game" delete — the
                // submitter probably still wants their entry preserved in
                // personal history.
                try {
                    finalSyncedScores = await this.finalSyncScoresForGame(row);
                    if (finalSyncedScores > 0) {
                        logInfo(`Final-synced ${finalSyncedScores} score(s) for ${row.name} before iScored delete`);
                    }
                } catch (err) {
                    logError(`Final sync failed for ${row.name} (continuing with delete):`, err);
                }

                const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
                const creds = row.game_room_id ? await getIScoredCredsForRoom(row.game_room_id) : null;
                if (creds) {
                    try {
                        const deleted = await IScoredSessionRegistry.getInstance().withSession(creds, (client) =>
                            client.deleteGame(row.iscored_id, row.name),
                        );
                        if (deleted) {
                            logInfo(`Deleted on iScored: ${row.name} (${row.iscored_id})`);
                            iscoredStatus = 'deleted';
                        } else {
                            // Game wasn't in iScored's dropdown — local row still
                            // gets deleted, but iScored side stayed (orphan).
                            logWarn(`iScored delete skipped for ${row.name} (${row.iscored_id}): not in dropdown.`);
                            iscoredStatus = 'failed';
                            iscoredError = 'Game not found in iScored dropdown — iScored entity may need manual cleanup.';
                        }
                    } catch (err) {
                        logError('Failed to delete game on iScored (continuing with DB delete):', err);
                        iscoredStatus = 'failed';
                        iscoredError = err instanceof Error ? err.message : String(err);
                    }
                }
            }
        }

        // Orphan local scores (cascade pattern from ADR 0005 — preserve player
        // history, just sever the FK).
        const subRes = await db.run('UPDATE submissions SET game_id = NULL WHERE game_id = ?', gameId);
        const histRes = await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', gameId);
        const globalRes = await db.run('UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?', gameId);
        await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', gameId);
        await db.run('DELETE FROM games WHERE id = ?', gameId);

        const scoresOrphaned = {
            submissions: subRes.changes ?? 0,
            scoreHistory: histRes.changes ?? 0,
            globalScores: globalRes.changes ?? 0,
        };
        const orphanSuffix = (scoresOrphaned.submissions || scoresOrphaned.scoreHistory || scoresOrphaned.globalScores)
            ? `, orphaned ${scoresOrphaned.submissions}/${scoresOrphaned.scoreHistory}/${scoresOrphaned.globalScores} (sub/hist/global)`
            : '';
        logInfo(`Deleted game completely: ${row.name} (tournament: ${row.tournament_name ?? 'pinned'}) (iScored: ${iscoredStatus}${orphanSuffix})`);

        return {
            gameName: row.name,
            tournamentName: row.tournament_name ?? null,
            iscoredStatus,
            iscoredError,
            finalSyncedScores,
            scoresOrphaned,
        };
    }

    /**
     * Pulls scores for a single iScored game and writes any missing/higher
     * entries into submissions + score_history. Used by deactivation paths so
     * the iScored game can be deleted without losing scores that arrived after
     * the last SyncPoller cycle.
     *
     * Does NOT fire LobbyFeedGenerator.onScoreSubmitted, fan out to global, or
     * emit WebSocket events — this is best-effort capture, not a live event
     * path. Score-history dedup (game_room_id + game_name + iscored_username +
     * score) keeps duplicates out when this races with the live SyncPoller.
     *
     * Returns the count of submissions rows actually inserted/updated.
     */
    private async finalSyncScoresForGame(row: {
        id: string;
        name: string;
        iscored_id: string;
        tournament_id: string;
        game_room_id: string | null;
        iscored_default_platform?: string | null;
    }): Promise<number> {
        if (!row.iscored_id || !row.game_room_id) return 0;
        const db = await getDatabase();

        const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(row.game_room_id);
        if (!creds) return 0;

        const { IScoredApiClient } = await import('./IScoredApiClient.js');
        const apiClient = new IScoredApiClient({ gameroomName: creds.gameroomName });

        let raw: { scores?: Array<{ name: string; score: string }> } | null = null;
        try {
            raw = await apiClient.getGameScores(row.iscored_id, 0); // 0 = all scores
        } catch (err) {
            logWarn(`finalSyncScoresForGame(${row.name}): getGameScores failed — ${err instanceof Error ? err.message : String(err)}`);
            return 0;
        }
        const incoming = raw?.scores ?? [];
        if (incoming.length === 0) return 0;

        const mappingRows = await db.all('SELECT iscored_username, discord_user_id FROM user_mappings');
        const mappingMap = new Map<string, string>();
        for (const m of mappingRows) mappingMap.set((m.iscored_username as string).toLowerCase(), m.discord_user_id as string);
        const aliasRows = await db.all('SELECT old_username, new_username FROM player_aliases');
        const aliasMap = new Map<string, string>();
        for (const a of aliasRows) aliasMap.set((a.old_username as string).toLowerCase(), a.new_username as string);

        const existingRows = await db.all(
            'SELECT id, score FROM submissions WHERE game_id = ?',
            row.id,
        );
        const existingMap = new Map<string, number>();
        for (const r of existingRows) existingMap.set(r.id as string, r.score as number);

        // Deletion tombstones — the SAME check `ScoreSyncPoller.pollOneAccount`
        // applies (see its comment). Omitting it here was a live prod defect,
        // 2026-08-17 on rtx_pinball's Blackbelt 2018:
        //
        //   00:23:38  ChalataLove submits 3,588,843,950 in Arcaid; Arcaid syncs
        //             it out to iScored.
        //   00:24:42  He deletes it in Arcaid (typo, extra digit). Tombstone
        //             written. Nothing deletes it from iScored, so it lingers
        //             there as the high score.
        //   00:25:54  He submits the correct 358,884,390.
        //   ~5s loop  The poller honours the tombstone and correctly refuses to
        //             re-import the deleted score, for two and a half hours.
        //   03:00:03  Deactivation calls THIS method, which had no tombstone
        //             check — it re-imported 3,588,843,950 and handed him a win
        //             on a score he had already deleted.
        //
        // Deleting the score on iScored too is the deeper fix (ADR 0011's
        // "no per-score delete API" premise is wrong — see ROADMAP); until then
        // this check has to exist on BOTH read paths, not one.
        const suppressionRows = await db.all(
            'SELECT iscored_username_lower, suppressed_score FROM deleted_score_suppressions WHERE game_id = ?',
            row.id,
        );
        const suppressionMap = new Map<string, number>();
        for (const r of suppressionRows) {
            suppressionMap.set(r.iscored_username_lower as string, r.suppressed_score as number);
        }

        const platform = row.iscored_default_platform ?? null;
        // ADR 0016 P2 §3b — NO INFERENCE, EVER. Same rule as ScoreSyncPoller:
        // iScored carries no per-score provenance and none may be inferred
        // (product decision 2026-07-31 — iScored is a migration stopgap).
        // `tournaments.iscored_default_engine`/`_device` are vestigial and
        // deliberately unread. Synced scores are always unknown/unknown.
        //
        // This path also deliberately has NO global fan-out (§3c) — do not add
        // one; it never had one, and synced scores are excluded from global.
        const engine = UNKNOWN;
        const device = UNKNOWN;
        const { ScoreHistoryService } = await import('../services/ScoreHistoryService.js');
        const { normalizeSubmitterUserId } = await import('../services/SubmissionContextService.js');

        let captured = 0;
        for (const entry of incoming) {
            const scoreValue = parseInt(String(entry.score).replace(/[^0-9-]/g, ''), 10);
            if (isNaN(scoreValue)) continue;

            const resolvedName = aliasMap.get(entry.name.toLowerCase()) || entry.name;
            const submissionId = `${row.id}-${resolvedName.toLowerCase()}`;

            // Matched on both the raw iScored name and the post-alias resolved
            // name, so a suppression survives a later /map-user mapping —
            // same rule as the poller.
            const suppressed = suppressionMap.get(resolvedName.toLowerCase())
                ?? suppressionMap.get(entry.name.toLowerCase());
            if (suppressed !== undefined && scoreValue <= suppressed) {
                logInfo(`   -> Final sync: skipping ${resolvedName} ${scoreValue.toLocaleString()} — deleted locally (tombstone ${suppressed.toLocaleString()}).`);
                continue;
            }

            const existingScore = existingMap.get(submissionId);
            if (existingScore !== undefined && scoreValue <= existingScore) continue;

            const discordUserId = mappingMap.get(resolvedName.toLowerCase())
                || mappingMap.get(entry.name.toLowerCase())
                || `iscored:${resolvedName}`;
            const submittedByUserId = normalizeSubmitterUserId(
                discordUserId.startsWith('iscored:') ? null : discordUserId,
            );
            const submittedByAnonymousName = submittedByUserId ? null : resolvedName;

            await db.run(`
                INSERT INTO submissions (
                    id, game_id, iscored_username, score, timestamp, discord_user_id,
                    submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                    submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                    engine, device
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    score = excluded.score,
                    discord_user_id = excluded.discord_user_id,
                    iscored_username = excluded.iscored_username,
                    platform = COALESCE(excluded.platform, submissions.platform),
                    -- v2.53.0: COALESCE-preserve, same rule as ScoreSyncPoller.
                    -- NULLIF drops the 'unknown' placeholder so a final sync can
                    -- never blank provenance the player supplied; the trailing
                    -- literal keeps the column non-NULL.
                    engine = COALESCE(NULLIF(excluded.engine, 'unknown'), submissions.engine, 'unknown'),
                    device = COALESCE(NULLIF(excluded.device, 'unknown'), submissions.device, 'unknown')
            `, submissionId, row.id, resolvedName, scoreValue, new Date().toISOString(), discordUserId,
                row.game_room_id, row.tournament_id, submittedByUserId,
                submittedByAnonymousName, platform, engine, device,
            );

            try {
                await ScoreHistoryService.log({
                    gameName: row.name,
                    gameRoomId: row.game_room_id,
                    gameId: row.id,
                    username: resolvedName,
                    discordUserId,
                    score: scoreValue,
                    source: 'sync',
                    tournamentId: row.tournament_id,
                    anonymousName: submittedByAnonymousName,
                    platform,
                    engine,
                    device,
                });
            } catch (err) {
                logWarn(`finalSyncScoresForGame(${row.name}): score_history log failed — ${err instanceof Error ? err.message : String(err)}`);
            }

            captured++;
        }

        if (captured > 0) {
            try {
                const { LeaderboardService } = await import('../services/LeaderboardService.js');
                await LeaderboardService.invalidate(row.id);
            } catch {}
        }

        return captured;
    }

    /**
     * Retrieves the currently active game for a tournament (first one found).
     */
    public async getActiveGame(tournamentId: string): Promise<Game | null> {
        const games = await this.getActiveGames(tournamentId);
        return games[0] ?? null;
    }

    /**
     * Retrieves all currently active games for a tournament.
     */
    public async getActiveGames(tournamentId: string): Promise<Game[]> {
        const db = await getDatabase();
        const rows = await db.all('SELECT * FROM games WHERE tournament_id = ? AND status = ? ORDER BY start_date ASC', tournamentId, 'ACTIVE');

        return rows.map((row: any) => ({
            id: row.id,
            tournamentId: row.tournament_id,
            name: row.name,
            iscoredId: row.iscored_id,
            styleId: row.style_id,
            status: row.status as any,
            startDate: row.start_date ? new Date(row.start_date) : undefined,
            endDate: row.end_date ? new Date(row.end_date) : undefined,
        }));
    }

    /**
     * Checks if a game is eligible to be played based on a rolling lookback period.
     * Lookback days defaults to the GAME_ELIGIBILITY_DAYS setting (default 120).
     *
     * This is the shared cooldown check the activation path runs (both the
     * rotation loop and the extra-slot fill loop call it before activating a
     * queued row). PickAlertService reuses it verbatim so the Picks nav badge
     * can never disagree with what maintenance will actually do — pass
     * `{ quiet: true }` for such read-only probes so a per-navigation check
     * doesn't emit a log line per queued game.
     */
    public async isGameEligible(tournamentId: string, gameName: string, lookbackDaysParam?: number, opts?: { quiet?: boolean }): Promise<boolean> {
        const db = await getDatabase();

        // Read from tournament column, fallback to parameter, then hardcoded default
        let lookbackDays: number;
        if (lookbackDaysParam !== undefined) {
            lookbackDays = lookbackDaysParam;
        } else {
            const tournament = await db.get('SELECT eligibility_days FROM tournaments WHERE id = ?', tournamentId);
            lookbackDays = tournament?.eligibility_days ?? 120;
        }

        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
        const lookbackString = lookbackDate.toISOString();

        const row = await db.get<{ count: number }>(
            `SELECT COUNT(*) as count FROM games
             WHERE tournament_id = ?
             AND (name = ? OR name LIKE ? || ' %')
             AND start_date >= ?
             AND status != 'QUEUED'`,
            tournamentId, gameName, gameName, lookbackString
        );

        const count = row?.count ?? 0;

        if (count > 0) {
            if (!opts?.quiet) logInfo(`Game '${gameName}' is NOT eligible (played within last ${lookbackDays} days).`);
            return false;
        }

        if (!opts?.quiet) logInfo(`Game '${gameName}' is eligible.`);
        return true;
    }

    /**
     * Executes the full maintenance routine for a specific tournament.
     * Supports multi-slot tournaments (max_active_games > 1):
     * each active game is processed independently with its own winner and queued replacement.
     * Uses per-tournament mutex to prevent concurrent maintenance collisions.
     */
    public async runMaintenance(tournamentId: string): Promise<void> {
        // Per-tournament mutex: wait for any in-flight maintenance to complete
        const existing = this.maintenanceLocks.get(tournamentId);
        if (existing) {
            logWarn(`Maintenance already running for tournament ${tournamentId}, waiting...`);
            await existing;
        }

        // Resolve the room upfront so the S10 maintenance-run trail can attribute
        // BOTH success and error rows to the room (the health surface joins by
        // game_room_id, so an unattributed error row would be invisible to the
        // admin — exactly the failure we want surfaced). Best-effort.
        let gameRoomId: string | null = null;
        try {
            const db = await getDatabase();
            const row = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);
            gameRoomId = row?.game_room_id ?? null;
        } catch { /* non-fatal — trail row carries null */ }

        const maintenancePromise = this.runMaintenanceInternal(tournamentId);
        this.maintenanceLocks.set(tournamentId, maintenancePromise);

        const startedAtMs = Date.now();
        const startedAtIso = new Date(startedAtMs).toISOString();
        try {
            const result = await maintenancePromise;
            // AWAITED (was fire-and-forget `void`): callers — the S10 Force
            // Maintenance endpoint and the s10 tests — read the trail row
            // right after runMaintenance resolves; on a slow runner the read
            // could beat the un-awaited INSERT (flaked CI 2026-07-19).
            // record() never throws (internal try/catch), so awaiting cannot
            // break the run.
            await MaintenanceRunService.record({
                gameRoomId,
                tournamentId,
                outcome: result.outcome,
                summary: result.summary,
                startedAt: startedAtIso,
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - startedAtMs,
            });
        } catch (err) {
            await MaintenanceRunService.record({
                gameRoomId,
                tournamentId,
                outcome: 'error',
                summary: err instanceof Error ? err.message : String(err),
                startedAt: startedAtIso,
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - startedAtMs,
            });
            throw err;
        } finally {
            this.maintenanceLocks.delete(tournamentId);
        }
    }

    private async runMaintenanceInternal(tournamentId: string): Promise<MaintenanceRunOutcome> {
        // Pause score poller during maintenance to avoid conflicts
        const { ScoreSyncPoller } = await import('./ScoreSyncPoller.js');
        const poller = ScoreSyncPoller.getInstance();
        poller.pause();

        try {
            // Resolve creds upfront so we can route the entire run through
            // IScoredSessionRegistry. The registry serializes per-account
            // operations end-to-end: parallel cron fires on the same iScored
            // account share a single Playwright session, eliminating the
            // dropdown-state-flipping contention that caused silent
            // "not found in dropdown" delete failures (see ROADMAP entry,
            // 2026-04-29 incident).
            const db = await getDatabase();
            const tournamentRow = await db.get(
                'SELECT game_room_id FROM tournaments WHERE id = ?',
                tournamentId,
            );
            const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
            const creds = await getIScoredCredsForRoom(tournamentRow?.game_room_id);

            if (creds) {
                return await IScoredSessionRegistry.getInstance().withSession(creds, (client) =>
                    this.runMaintenanceWork(tournamentId, client, creds),
                );
            } else {
                return await this.runMaintenanceWork(tournamentId, null, null);
            }
        } finally {
            poller.resume();
        }
    }

    private async runMaintenanceWork(
        tournamentId: string,
        client: IScoredClient | null,
        creds: IScoredCreds | null,
    ): Promise<MaintenanceRunOutcome> {
        const db = await getDatabase();
        const tournamentRow = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        if (!tournamentRow) throw new Error(`Tournament ${tournamentId} not found.`);

        // S7 — pause/resume defensive guard. Pausing a tournament flips
        // `is_active=0` and `Scheduler.reload()` removes its maintenance cron,
        // so the normal API path never reaches here for a paused tournament.
        // But a manual `runMaintenance()` call (or a task that wasn't reloaded)
        // could — short-circuit so a paused tournament never rotates/activates.
        if (!tournamentRow.is_active) {
            logInfo(`Tournament "${tournamentRow.name}" is paused (is_active=0) — skipping maintenance.`);
            return { outcome: 'skipped', summary: 'Skipped — tournament paused' };
        }

        const term = getTerminology(tournamentRow.mode);
        const { resolveAnnouncementChannelId } = await import('../utils/discord.js');
        const channelId: string | null = await resolveAnnouncementChannelId(
            tournamentRow.game_room_id,
            tournamentRow.discord_channel_id,
        );

        logInfo(`Starting maintenance for ${term.tournament}: ${tournamentRow.name}`);

        // --- Gather all active games and queued games ---
        const activeGames = await this.getActiveGames(tournamentId);
        const queuedRows = await db.all(
            'SELECT * FROM games WHERE tournament_id = ? AND status = ? ORDER BY queue_order ASC, rowid ASC',
            tournamentId, 'QUEUED'
        );

        if (activeGames.length === 0 && queuedRows.length === 0) {
            logWarn(`No active or queued ${term.game} for ${term.tournament} "${tournamentRow.name}". Nothing to do.`);
            return { outcome: 'skipped', summary: 'Skipped — no active or queued games' };
        }

        // Process each active game slot independently.
        // Each active game pairs with the next available queued game (FIFO).
        const queuedQueue = [...queuedRows]; // mutable copy to consume from

        try {
            for (const activeGame of activeGames) {
                await this.processSlotMaintenance(
                    db, tournamentRow, activeGame, queuedQueue, client,
                    creds?.publicUrl ?? null, creds?.gameroomName ?? null,
                    term, channelId, tournamentId
                );
            }

            // If there are more queued games than active games (e.g. tournament was just
            // expanded to more slots), activate remaining queued games up to max_active_games.
            const maxSlots = tournamentRow.max_active_games ?? 1;
            const currentActive = await this.getActiveGames(tournamentId);
            let slotsAvailable = maxSlots - currentActive.length;

            // Consume a FRESH queue here, never the run-start `queuedQueue`
            // snapshot.
            //
            // INCIDENT (prod 2026-08-20 03:00 UTC, WG-VPXS): since the pick-
            // delegation arc (2026-08-17) the per-slot cascade consumes queued
            // rows through fresh DB reads (`nextEligibleQueuedFor`) and flips
            // the chosen row to ACTIVE. The run-start snapshot still held that
            // row, so this loop re-encountered the just-activated game ("Bad
            // Cats"), `isGameEligible` returned false (the game's own fresh
            // activation counts as "played within the lookback"), and the
            // cooldown branch below issued a DELETE against a live ACTIVE game
            // with an open iScored board. Only the `leaderboard_cache.game_id`
            // NO-ACTION FK blocked it, and the resulting SQLITE_CONSTRAINT
            // aborted the rest of the maintenance run (second slot unfilled).
            const freshQueue = await db.all(
                `SELECT * FROM games WHERE tournament_id = ? AND status = ? ORDER BY queue_order ASC, rowid ASC`,
                tournamentId, 'QUEUED'
            );

            while (slotsAvailable > 0 && freshQueue.length > 0) {
                const queuedRow = freshQueue.shift()!;
                // Skip placeholder picker slots
                if (queuedRow.name === '[Pending Pick]') continue;

                // v2.103.0 duplicate-activation guard, queued-promotion twin of
                // activateGame's check: a same-name game already ACTIVE means
                // this row stays QUEUED (not deleted — it activates naturally
                // once the twin completes and cooldown allows).
                //
                // ORDER MATTERS — this runs BEFORE the cooldown revalidation.
                // A queued twin of an ACTIVE game trivially fails the cooldown
                // check (its own ACTIVE twin is a recent non-QUEUED row), so
                // while cooldown went first this guard was unreachable dead
                // code on exactly the rows it was written to protect: they were
                // deleted instead of left queued.
                const activeTwin = await db.get(
                    `SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE' AND LOWER(name) = LOWER(?)`,
                    tournamentId, queuedRow.name,
                );
                if (activeTwin) {
                    logWarn(`   -> Skipping queued game "${queuedRow.name}" — a same-name game is already ACTIVE in this tournament. Leaving it queued.`);
                    continue;
                }

                // Cooldown revalidation — skip games that became ineligible while queued
                const stillEligible = await this.isGameEligible(tournamentId, queuedRow.name);
                if (!stillEligible) {
                    logWarn(`   -> Skipping queued game "${queuedRow.name}" — no longer eligible (cooldown). Removing from queue.`);
                    // `leaderboard_cache` carries a NO-ACTION FK to `games`, so
                    // a cached row makes the DELETE throw (that FK is what
                    // turned the 2026-08-20 incident into an aborted run rather
                    // than a destroyed ACTIVE game). Clear it first, then guard
                    // the delete on `status = 'QUEUED'` so this statement is
                    // structurally incapable of removing a non-queued row no
                    // matter how stale the caller's view of it is.
                    await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', queuedRow.id);
                    await db.run(`DELETE FROM games WHERE id = ? AND status = 'QUEUED'`, queuedRow.id);
                    continue;
                }

                let newIscoredId: string | null = null;
                if (client && !queuedRow.iscored_id) {
                    try {
                        const styleId = queuedRow.style_id || undefined;
                        newIscoredId = await client.createGame(queuedRow.name, styleId);
                        await client.setGameTags(newIscoredId, tournamentRow.type);
                        await client.setGameStatus(newIscoredId, { locked: false, hidden: false });
                    } catch (err) {
                        logError(`Failed to create extra queued game on iScored: ${queuedRow.name}`, err);
                    }
                } else if (client && queuedRow.iscored_id) {
                    try { await client.setGameStatus(queuedRow.iscored_id, { locked: false, hidden: false }); } catch {}
                }

                const finalId = newIscoredId ?? queuedRow.iscored_id ?? null;
                // `queue_order` is cleared on promotion: an ACTIVE row is no
                // longer in anybody's queue, and leftover positions are what
                // let a stale snapshot mistake it for a queued row.
                await db.run(
                    'UPDATE games SET status = ?, start_date = ?, iscored_id = COALESCE(?, iscored_id), queue_order = NULL WHERE id = ?',
                    'ACTIVE', new Date().toISOString(), finalId, queuedRow.id
                );
                logInfo(`   -> Activated extra slot: ${queuedRow.name}`);

                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const embed = new EmbedBuilder()
                        .setTitle(`Now Active: ${queuedRow.name}`)
                        .setDescription(`New ${term.game} slot opened for **${tournamentRow.name}**!`)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }

                slotsAvailable--;
            }
        } finally {
            // Session lifecycle is owned by IScoredSessionRegistry; we never
            // disconnect the client here. The registry holds it for an idle
            // TTL so consecutive batch members reuse the same Playwright page.
        }

        logInfo(`Maintenance complete for ${tournamentRow.name}`);

        // Reorder iScored lineup based on tournament display_order. Scope to
        // this room only — pre-fix this scanned every room's lineup on every
        // maintenance fire, which was wasteful (running 5 weeklies on the same
        // room re-ordered the same lineup 5 times). Pass the shared client so
        // the reorder reuses the registry-managed session.
        try {
            await this.reorderIScoredLineup(tournamentRow.game_room_id ?? undefined, client);
        } catch (err) {
            logWarn('Failed to reorder iScored lineup after maintenance:', err);
        }

        // Run cleanup for 'immediate' and 'retain' modes inline. For 'scheduled'
        // mode, run cleanup inline IFF the cleanup cron's minute/hour/dom/dow
        // fields would all match right now in the cleanup's timezone — i.e. the
        // separate scheduled cleanup cron would also be firing this minute. This
        // eliminates the race on overlapping crons (e.g. maintenance `0 22 * * *`
        // + cleanup `0 22 * * 3` — Wed 22:00 fired both, cleanup's SELECT ran
        // before maintenance had completed today's active game, leaving the just-
        // completed game stuck in COMPLETED until next Wed). The separate
        // scheduled cleanup cron still fires; it'll just find zero COMPLETED rows
        // because we already hid them — idempotent, no harm. Pass the shared
        // client so cleanup reuses the maintenance session.
        let cleanupRule: CleanupRule = { mode: 'retain', count: 0 };
        try { cleanupRule = JSON.parse(tournamentRow.cleanup_rule || '{}'); } catch {}
        if (cleanupRule.mode === 'immediate' || cleanupRule.mode === 'retain') {
            try {
                await this.runCleanup(tournamentId, cleanupRule, client, creds);
            } catch (err) {
                logWarn(`Failed to run cleanup for ${tournamentRow.name}:`, err);
            }
        } else if (cleanupRule.mode === 'scheduled' && this.cleanupCronMatchesNow(cleanupRule.cron, cleanupRule.timezone)) {
            try {
                logInfo(`Running scheduled cleanup inline (cron overlaps with this maintenance run)`);
                await this.runCleanup(tournamentId, { mode: 'immediate' }, client, creds);
            } catch (err) {
                logWarn(`Failed to run inline scheduled cleanup for ${tournamentRow.name}:`, err);
            }
        }

        return { outcome: 'success', summary: `Completed — ${activeGames.length} active slot(s) processed` };
    }

    /**
     * Returns true if the given 5-field cron expression's minute/hour/day-of-
     * month/month/day-of-week fields all match the current moment in `tz`.
     * Used to detect "the scheduled cleanup cron would fire right now," so
     * maintenance can run cleanup inline and avoid the race with the parallel
     * cleanup cron task.
     *
     * Supports `*`, single integers, comma-separated lists (`1,3,5`), and
     * inclusive ranges (`1-5`). That's the full set used by maintenance and
     * cleanup crons in this codebase — no step values, no `L`, no named
     * weekdays. If the expression is malformed, returns false (better to skip
     * inline cleanup than to fire it incorrectly; the separate cron is still
     * registered).
     */
    private cleanupCronMatchesNow(cron: string, tz?: string, nowOverride?: Date): boolean {
        const timezone = tz || process.env.BOT_TIMEZONE || 'America/Chicago';
        const parts = cron.trim().split(/\s+/);
        if (parts.length !== 5) return false;
        const minF = parts[0]!;
        const hourF = parts[1]!;
        const domF = parts[2]!;
        const monF = parts[3]!;
        const dowF = parts[4]!;

        // Build a "now in tz" Date. Same idiom used elsewhere in Scheduler.ts.
        // nowOverride is supplied by tests to make the match deterministic.
        const now = new Date((nowOverride ?? new Date()).toLocaleString('en-US', { timeZone: timezone }));
        const matchField = (field: string, value: number): boolean => {
            if (field === '*') return true;
            for (const part of field.split(',')) {
                if (part.includes('-')) {
                    const range = part.split('-').map(s => parseInt(s, 10));
                    const lo = range[0];
                    const hi = range[1];
                    if (lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi) && value >= lo && value <= hi) return true;
                } else {
                    const n = parseInt(part, 10);
                    if (Number.isFinite(n) && value === n) return true;
                }
            }
            return false;
        };

        return matchField(minF, now.getMinutes())
            && matchField(hourF, now.getHours())
            && matchField(domF, now.getDate())
            && matchField(monF, now.getMonth() + 1)
            && matchField(dowF, now.getDay());
    }

    /**
     * Processes maintenance for a single active game slot:
     * lock on iScored, scrape winner, complete, activate next queued, assign picker.
     */
    private async processSlotMaintenance(
        db: any,
        tournamentRow: any,
        activeGame: Game,
        queuedQueue: any[],
        client: IScoredClient | null,
        publicUrl: string | null,
        gameroomName: string | null,
        term: ReturnType<typeof getTerminology>,
        channelId: string | null,
        tournamentId: string,
    ): Promise<void> {
        const hasPublicUrl = !!publicUrl;
        logInfo(`   Processing slot: ${activeGame.name}`);

        let winnerIscoredName: string | null = null;
        let winnerScore: number | null = null;

        // --- iScored housekeeping for this slot ---
        // v2.7.x: matches the deactivateGame contract — capture pending iScored
        // scores into submissions, then LOCK the iScored game so it stays
        // visible historically but accepts no new scores. Actual deletion is
        // delegated to runCleanup (cleanup_rule retain/scheduled/immediate),
        // which respects per-tournament retention policy.
        if (activeGame.iscoredId) {
            try {
                const captured = await this.finalSyncScoresForGame({
                    id: activeGame.id,
                    name: activeGame.name,
                    iscored_id: activeGame.iscoredId,
                    tournament_id: activeGame.tournamentId,
                    game_room_id: tournamentRow.game_room_id ?? null,
                    // ADR 0016 P2 §3b: no engine/device defaults are passed —
                    // finalSyncScoresForGame stamps unknown/unknown itself.
                    iscored_default_platform: tournamentRow.iscored_default_platform ?? null,
                });
                if (captured > 0) {
                    logInfo(`   -> Final-synced ${captured} score(s) from iScored before lock`);
                }
            } catch (err) {
                logError('   -> Final sync from iScored failed (continuing):', err);
            }

            if (client) {
                const otherActive = await db.get(
                    `SELECT id FROM games WHERE iscored_id = ? AND status = 'ACTIVE' AND id != ?`,
                    activeGame.iscoredId, activeGame.id,
                );
                if (otherActive) {
                    logInfo(`   -> Skipping iScored lock — another active game shares iscored_id ${activeGame.iscoredId}`);
                } else {
                    try {
                        await client.setGameStatus(activeGame.iscoredId, { locked: true });
                        logInfo(`   -> Locked on iScored: ${activeGame.name}`);
                    } catch (err) {
                        logError('   -> Failed to lock game on iScored (continuing):', err);
                    }
                }
            }
        }

        // --- Winner resolution: local DB is canonical (v2.2.1) ---
        // Previously iScored was the primary source and local DB was the fallback.
        // That broke rooms with anonymous submissions (pre-v2.79.0, before login
        // became mandatory for all score submissions): those scores live in
        // `submissions` but may never reach iScored (iScored can reject them —
        // seen "Access Denied" on a 99.9B submission), so the bot would announce
        // whoever was on top in iScored, not whoever was on top in the room.
        // `submissions` is the union of (Discord-submitted) + (guest-submitted) +
        // (iScored-synced via ScoreSyncPoller), so it's the right source.
        const topSubmission = await db.get(
            `SELECT iscored_username, score, discord_user_id, submitted_by_user_id FROM submissions
             WHERE game_id = ? ORDER BY score DESC LIMIT 1`,
            activeGame.id
        );
        if (topSubmission) {
            winnerIscoredName = topSubmission.iscored_username;
            winnerScore = topSubmission.score;
            logInfo(`   -> Top scorer (local DB): ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
        }

        // Fallback to iScored only when local DB is empty (pure iScored-driven
        // legacy room that never saw a web/Discord submission).
        if (!winnerIscoredName && client && activeGame.iscoredId) {
            const useApi = process.env.ISCORED_API_ENABLED !== 'false';
            if (useApi) {
                try {
                    const { IScoredApiClient } = await import('./IScoredApiClient.js');
                    const apiClient = new IScoredApiClient(
                        gameroomName ? { gameroomName } : undefined,
                    );
                    const gameScores = await apiClient.getGameScores(activeGame.iscoredId, 1);
                    const topScore = gameScores.scores?.[0];
                    if (topScore) {
                        winnerIscoredName = topScore.name;
                        const rawScore = String(topScore.score).replace(/[^0-9]/g, '');
                        winnerScore = parseInt(rawScore, 10) || null;
                        logInfo(`   -> Top scorer (iScored API fallback): ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
                    }
                } catch (err) {
                    logError('   -> iScored API fallback failed:', err);
                    if (publicUrl) {
                        try {
                            const scores = await client.scrapePublicScores(publicUrl, activeGame.iscoredId);
                            if (scores.length > 0) {
                                winnerIscoredName = scores[0].name;
                                const rawScore = String(scores[0].score).replace(/[^0-9]/g, '');
                                winnerScore = parseInt(rawScore, 10) || null;
                                logInfo(`   -> Top scorer (Playwright fallback): ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
                            }
                        } catch (err2) {
                            logError('   -> Playwright fallback also failed:', err2);
                        }
                    }
                }
            } else if (publicUrl) {
                try {
                    const scores = await client.scrapePublicScores(publicUrl, activeGame.iscoredId);
                    if (scores.length > 0) {
                        winnerIscoredName = scores[0].name;
                        const rawScore = String(scores[0].score).replace(/[^0-9]/g, '');
                        winnerScore = parseInt(rawScore, 10) || null;
                        logInfo(`   -> Top scorer (Playwright): ${winnerIscoredName} (${winnerScore?.toLocaleString() ?? 'N/A'})`);
                    }
                } catch (err) {
                    logError('   -> Failed to scrape public scores (continuing):', err);
                }
            }
        }

        if (!winnerIscoredName) {
            logWarn('   -> No scores found in local DB or iScored.');
        }

        // --- Mark active game COMPLETED ---
        // iscored_id is intentionally KEPT non-NULL so runCleanup
        // (cleanup_rule retain/scheduled/immediate) can find this row later.
        // The duplicate-DM bug is now killed by the SyncPoller's ORDER BY
        // status pref + recency (see ScoreSyncPoller Fix B comment).
        await db.run(
            'UPDATE games SET status = ?, end_date = ? WHERE id = ?',
            'COMPLETED', new Date().toISOString(), activeGame.id
        );
        logInfo(`   -> Marked COMPLETED in DB: ${activeGame.name}`);

        // Log tournament completion event
        if (tournamentRow.game_room_id) {
            RoomEventService.log(tournamentRow.game_room_id, 'tournament_completion', {
                tournamentName: tournamentRow.name,
            }).catch(() => {});
        }

        // Resolve winner
        // v2.35.0 — prefer the top submission's OWN attribution
        // (submitted_by_user_id for web submits, discord_user_id for legacy
        // Discord-bot submits/iScored sync) over the user_mappings
        // iscored-username lookup. This makes Google-identified web players
        // first-class winners (they never get a user_mappings row — that
        // table is Discord-alias-only) and is also just more precise for
        // Discord users: a direct attribution beats a name-based guess.
        // Fall back to the user_mappings lookup only when the submission row
        // has no attribution at all (pure iScored-synced/anonymous rows).
        //
        // `discord_user_id` on `submissions` is legacy NOT NULL — anonymous/
        // community submits write a sentinel ('COMMUNITY', 'ANON', 'SYSTEM')
        // rather than leaving it null, so it must be shape-checked via
        // isProviderUserId before being trusted as a real attribution
        // (submitted_by_user_id has no such legacy sentinel problem — it's
        // NULL or a real id, never a placeholder string).
        const directDiscordUserId = topSubmission?.discord_user_id && isProviderUserId(topSubmission.discord_user_id)
            ? topSubmission.discord_user_id
            : null;
        let winnerId: string | null = topSubmission?.submitted_by_user_id || directDiscordUserId || null;
        if (winnerId) {
            logInfo(`   -> Winner ID resolved from submission attribution: ${winnerId}`);
        } else if (winnerIscoredName) {
            const mapping = await db.get(
                'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
                winnerIscoredName
            );
            if (mapping?.discord_user_id) {
                winnerId = mapping.discord_user_id;
                logInfo(`   -> Winner Discord ID resolved: <@${winnerId}>`);
            } else {
                logWarn(`   -> Winner '${winnerIscoredName}' has no Discord mapping. Use /map-user to link them.`);
            }
        }

        // S13 — trophy case: record the tournament win. award() never throws
        // (fully try/catch-wrapped), so awaiting it here is safe.
        if (winnerIscoredName) {
            await AchievementService.award({
                gameRoomId: tournamentRow.game_room_id ?? null,
                discordUserId: winnerId,
                iscoredUsername: winnerIscoredName,
                type: 'tournament_win',
                gameName: activeGame.name,
                gameId: activeGame.id,
                tournamentId,
                metadata: { score: winnerScore },
            });
        }

        // Lobby feed: tournament results
        if (tournamentRow.game_room_id) {
            import('../services/LobbyFeedService.js').then(({ LobbyFeedService }) => {
                LobbyFeedService.emit({
                    gameRoomId: tournamentRow.game_room_id,
                    type: 'tournament_results',
                    icon: undefined,
                    title: `${tournamentRow.name} complete — ${winnerIscoredName || 'Unknown'} takes 1st!`,
                    subtitle: activeGame.name,
                    tournamentId: tournamentRow.id,
                    playerId: winnerId || undefined,
                    gameName: activeGame.name,
                    metadata: { score: winnerScore },
                }).catch(() => {});
            }).catch(() => {});

            // Notify winner via DM
            if (winnerId) {
                import('../services/NotificationService.js').then(({ NotificationService }) => {
                    const room = db.get('SELECT slug FROM game_rooms WHERE id = ?', tournamentRow.game_room_id);
                    (room as Promise<any>).then((r: any) => {
                        const link = r?.slug ? NotificationService.buildLink(r.slug) : '';
                        NotificationService.notify({
                            userId: winnerId!,
                            type: 'tournamentWin',
                            message: `Congrats! You won **${activeGame.name}** in **${tournamentRow.name}**!${winnerScore ? ` Score: **${winnerScore.toLocaleString()}**` : ''}${link ? `\n${link}` : ''}`,
                            roomId: tournamentRow.game_room_id,
                            tournamentId,
                            pushUrl: link || undefined,
                        }).catch(() => {});
                    }).catch(() => {});
                }).catch(() => {});
            }
        }

        // Announce completion
        if (channelId) {
            const color = getTournamentColor(tournamentRow.type);
            const embed = new EmbedBuilder()
                .setTitle(`${tournamentRow.name} — Rotation`)
                .setColor(color)
                .setTimestamp();

            // Resolve user-chosen display name when set (falls back to iScored alias).
            const winnerDisplayName = winnerId
                ? await (await import('../services/UserProfileService.js')).UserProfileService.getDisplayName(winnerId).catch(() => null)
                : null;
            const winnerLabel = winnerDisplayName || winnerIscoredName || 'Unknown';
            const displayName = winnerId ? await formatUserMention(winnerId, winnerLabel, tournamentRow.game_room_id) : (winnerIscoredName ? `\`${winnerIscoredName}\`` : null);
            let desc = `**Closed:** ${activeGame.name}`;
            if (displayName) {
                desc += `\n**Winner:** ${displayName}`;
                if (winnerScore) desc += ` — **${winnerScore.toLocaleString()}**`;
            }
            // v2.2.1: when the winner has no Discord mapping, they can't @mention,
            // they can't use /pick-game, and their identity might not match their
            // real Discord name. Tell them how to claim so future wins work.
            if (!winnerId && winnerIscoredName) {
                const roomRow = tournamentRow.game_room_id
                    ? await db.get('SELECT slug FROM game_rooms WHERE id = ?', tournamentRow.game_room_id)
                    : null;
                const scoreboardLink = roomRow?.slug ? `https://arcaid.app/${roomRow.slug}` : 'the room scoreboard';
                desc += `\n\n_Is this you?_ Log in with Discord on ${scoreboardLink} to claim future scores. If your Discord name differs from \`${winnerIscoredName}\`, ask an admin to merge identities. An admin will pick the next ${term.game} in the meantime.`;
            }
            embed.setDescription(desc);
            await sendChannelEmbed(channelId, embed);
        }

        // --- Decide who gets the pick for this slot ---
        //
        // Pre-2026-08-17 this took the head of a tournament-GLOBAL FIFO queue,
        // and only consulted dispositions when that queue happened to be empty.
        // Two consequences, both seen in prod on 2026-08-17: winning activated
        // whoever queued first (ChalataLove won Blackbelt 2018 and soggybacon's
        // `Magic Castle` activated while the winner's own `Xena` was skipped),
        // and nominate/forfeit were unreachable whenever anything was queued.
        //
        // Queues are now PER PLAYER — "my pick if I win", never a room-level
        // play-next list — and `pickResolution.resolvePick` is the single
        // decision point. See tmp/pick-delegation-contract.md.

        // Sweep genuinely ORPHANED picker placeholders (their won game is gone).
        // A placeholder belonging to a different LIVE slot is deliberately left
        // alone: deleting it would cancel that slot's running pick window.
        for (const candidate of queuedQueue) {
            if (candidate.name !== '[Pending Pick]') continue;
            const wonGame = candidate.won_game_id
                ? await db.get('SELECT id FROM games WHERE id = ?', candidate.won_game_id)
                : null;
            if (!wonGame) {
                await db.run('DELETE FROM games WHERE id = ?', candidate.id);
                logInfo('   -> Cleaned up an orphaned picker placeholder.');
            }
        }

        // Pick-award gate (v2.56.0): per-tournament only — this resolves to
        // `tournaments.winner_picks` for THIS tournament.
        const pickAwardEnabled = await PickAwardGate.isEnabled(tournamentRow.game_room_id, tournamentId);
        const winnerPicks = pickAwardEnabled && tournamentRow.winner_picks !== 0;
        const autoPick = tournamentRow.auto_pick !== 0;

        // Guard: if the tournament already has max active games, skip slot fill
        // entirely. Prevents duplicate picker slots / auto-picks when
        // maintenance re-runs after a winner has already picked.
        const maxSlots = tournamentRow.max_active_games ?? 1;
        const currentActiveGames = await this.getActiveGames(tournamentId);
        if (currentActiveGames.length >= maxSlots) {
            logInfo(`   -> Tournament already at max active games (${currentActiveGames.length}/${maxSlots}). Skipping slot fill.`);
            return;
        }

        // Guard: this slot already produced a picker placeholder.
        //
        // Keyed on won_game_id ALONE (not the picker) because the picker for a
        // given slot can be someone other than the winner — a nominee, or a
        // runner-up via forfeit. This MUST stay ahead of the cascade: resolving
        // fires the winner's one-shot `nominate`, so a re-run past this point
        // would burn a second one.
        const existingPickerSlot = await db.get(
            `SELECT id FROM games WHERE tournament_id = ? AND status = 'QUEUED' AND name = '[Pending Pick]' AND won_game_id = ?`,
            tournamentId, activeGame.id
        );
        if (existingPickerSlot) {
            logInfo(`   -> Game ${activeGame.name} already has a pending pick slot. Skipping duplicate.`);
            return;
        }

        // Resolve the winner's user-chosen display name once for all copy below.
        const winnerDisplayNameForCopy = winnerId
            ? await (await import('../services/UserProfileService.js')).UserProfileService.getDisplayName(winnerId).catch(() => null)
            : null;
        const winnerLabel = winnerDisplayNameForCopy || winnerIscoredName || 'Unknown';

        // Pick-award gate off — emit plain "Congrats" (no pick flow, no DM).
        // Next-game selection still honors auto_pick and manual admin paths.
        if (!pickAwardEnabled && winnerId && channelId) {
            const color = getTournamentColor(tournamentRow.type);
            const winnerMention = await formatUserMention(winnerId, winnerLabel, tournamentRow.game_room_id);
            const embed = new EmbedBuilder()
                .setTitle('Congrats!')
                .setDescription(`${winnerMention} — great ${term.game}! Thanks for playing.`)
                .setColor(color)
                .setFooter({ text: tournamentRow.name })
                .setTimestamp();
            await sendChannelEmbed(channelId, embed);
        }

        // --- Run the cascade ---
        let queuedRow: any = null;
        let pickerResolution: {
            pickerId: string;
            pickerType: 'WINNER' | 'RUNNER_UP';
            pickerLabel: string;
            announceExtra: string | null;
            onboardingNominee: string | null;
        } | null = null;
        let cascadeWantsAutoPick = false;
        let announceExtraForQueue: string | null = null;

        if (winnerPicks) {
            const places = await resolveLeaderboardPlaces(db, activeGame.id, MAX_PLACES);
            const dynastyBlockedWinner = await this.isDynastyBlocked(db, tournamentRow, activeGame, places[0]?.playerId ?? null);
            const { outcome, narrative } = await resolvePick({
                tournamentId,
                places,
                nextQueuedFor: (playerId) => this.nextEligibleQueuedFor(tournamentId, playerId),
                labelFor: (playerId) => this.labelForPlayer(playerId),
                isRoomMember: async (playerId) => {
                    if (!tournamentRow.game_room_id) return true;
                    const row = await db.get(
                        'SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?',
                        tournamentRow.game_room_id, playerId,
                    );
                    return !!row;
                },
                dynastyBlockedWinner,
            });
            const reason = narrative.length ? narrative.join(' ') : null;

            if (outcome.kind === 'activate') {
                queuedRow = outcome.game;
                announceExtraForQueue = reason;
                logInfo(`   -> Cascade: activating ${outcome.playerId}'s queued game "${outcome.game.name}".`);
            } else if (outcome.kind === 'window') {
                pickerResolution = {
                    pickerId: outcome.playerId,
                    pickerType: outcome.pickerType,
                    pickerLabel: await this.labelForPlayer(outcome.playerId),
                    announceExtra: reason,
                    onboardingNominee: outcome.onboardingNominee,
                };
                logInfo(`   -> Cascade: pick window for ${outcome.playerId} (${outcome.pickerType}).`);
            } else {
                cascadeWantsAutoPick = true;
                announceExtraForQueue = reason;
                logInfo('   -> Cascade: exhausted or rolled the dice — auto-pick.');
            }
        }

        if (queuedRow) {
            let newIscoredId: string | null = null;

            // Handle iScored for the queued game
            if (client) {
                if (!queuedRow.iscored_id) {
                    try {
                        const styleId = queuedRow.style_id || undefined;
                        newIscoredId = await client.createGame(queuedRow.name, styleId);
                        await client.setGameTags(newIscoredId, tournamentRow.type);
                        await client.setGameStatus(newIscoredId, { locked: false, hidden: false });
                        logInfo(`   -> Created on iScored: ${queuedRow.name} (ID: ${newIscoredId})`);
                    } catch (err) {
                        logError('   -> Failed to create queued game on iScored (continuing):', err);
                    }
                } else {
                    try {
                        await client.setGameStatus(queuedRow.iscored_id, { locked: false, hidden: false });
                        logInfo(`   -> Unlocked on iScored: ${queuedRow.name}`);
                    } catch (err) {
                        logError('   -> Failed to unlock queued game on iScored (continuing):', err);
                    }
                }
            }

            const finalIscoredId = newIscoredId ?? queuedRow.iscored_id ?? null;
            // `queue_order` is cleared on promotion — see the extra-slot
            // promotion below. A row that keeps its position after going ACTIVE
            // reads as still-queued to anything ordering by `queue_order`
            // (prod carried exactly such a row out of the 2026-08-20 incident).
            await db.run(
                'UPDATE games SET status = ?, start_date = ?, iscored_id = COALESCE(?, iscored_id), queue_order = NULL WHERE id = ?',
                'ACTIVE', new Date().toISOString(), finalIscoredId, queuedRow.id
            );
            logInfo(`   -> Activated in DB: ${queuedRow.name}`);

            // Log game rotation event
            if (tournamentRow.game_room_id) {
                RoomEventService.log(tournamentRow.game_room_id, 'game_rotation', {
                    tournamentName: tournamentRow.name,
                    oldGame: activeGame.name,
                    newGame: queuedRow.name,
                }).catch(() => {});

                // Lobby feed: new active game
                import('../services/LobbyFeedService.js').then(({ LobbyFeedService }) => {
                    LobbyFeedService.emit({
                        gameRoomId: tournamentRow.game_room_id,
                        type: 'tournament_active',
                        icon: undefined,
                        title: `Now active in ${tournamentRow.name}: ${queuedRow.name}`,
                        gameName: queuedRow.name,
                        tournamentId: tournamentRow.id,
                    }).catch(() => {});
                }).catch(() => {});
            }

            // Queued game was activated — no picker slot needed (queue already had a game).
            // The winner can still use /pick-game to add more games to queue at any time.

            // Announce new active game
            if (channelId) {
                const color = getTournamentColor(tournamentRow.type);
                const embed = new EmbedBuilder()
                    .setTitle(`Now Active: ${queuedRow.name}`)
                    .setColor(color)
                    .setTimestamp();

                // The winner is congratulated even when the pick went elsewhere
                // (owner spec: a forfeit still earns the congratulations). The
                // cascade's narrative explains the hand-off, so the copy never
                // implies the activated game was the winner's own pick when it
                // wasn't.
                if (winnerId) {
                    const winnerMention = await formatUserMention(winnerId, winnerLabel, tournamentRow.game_room_id);
                    embed.setDescription(announceExtraForQueue
                        ? `${winnerMention} — congrats on the win! ${announceExtraForQueue} **${queuedRow.name}** is now active.`
                        : `${winnerMention} — congrats on the win! **${queuedRow.name}** is now active from the queue.`);
                } else if (winnerIscoredName) {
                    embed.setDescription(announceExtraForQueue
                        ? `**${winnerIscoredName}** wins! ${announceExtraForQueue} **${queuedRow.name}** is now active.`
                        : `**${winnerIscoredName}** wins! **${queuedRow.name}** is now active from the queue.`);
                } else {
                    embed.setDescription(`**${queuedRow.name}** is now active from the queue.`);
                }
                embed.setFooter({ text: tournamentRow.name });
                await sendChannelEmbed(channelId, embed);
            }

            emitGameRotated({
                tournamentName: tournamentRow.name,
                oldGame: activeGame.name,
                newGame: queuedRow.name,
            });
        } else {
            // Nothing was activated from a queue. The cascade either resolved to
            // a pick window, resolved to auto-pick (roll-the-dice, or every
            // place declined), or the pick-award flow is off entirely.
            //
            // The gate flags, the max-slots / duplicate-placeholder guards, the
            // winner label and the plain "Congrats" embed all now live ABOVE the
            // cascade — they must run before a one-shot disposition can fire —
            // so this branch only dispatches on the already-resolved outcome.
            if (cascadeWantsAutoPick && autoPick) {
                // Contract §4.4: roll-the-dice is an explicit instruction, but a
                // tournament with auto_pick=0 cannot honor it; that case falls
                // through to the admin-wait branch below instead.
                logInfo(`   -> Cascade resolved to auto-pick. Selecting a ${term.game}.`);
                await this.autoPickAndActivate(db, tournamentRow, tournamentId, activeGame, client, term, channelId);
            } else if (!winnerPicks && autoPick) {
                // Skip pick windows — immediately auto-select and activate
                logInfo(`   -> No ${term.game} queued. winner_picks=off, auto_pick=on — auto-selecting immediately.`);
                await this.autoPickAndActivate(db, tournamentRow, tournamentId, activeGame, client, term, channelId);
            } else if (winnerPicks && pickerResolution) {
                const { pickerId, pickerType, pickerLabel, announceExtra, onboardingNominee } = pickerResolution;
                // Current behavior: give the resolved picker a pick window —
                // either the winner (today's default), a nominee (full WINNER
                // window/reminders/timeout chain), or the runner-up
                // (forfeit / dynasty-block, immediate — no wait for a WINNER
                // window that was never granted).
                logInfo(`   -> No ${term.game} queued for this slot. Creating picker slot (${pickerType}) for timeout tracking.`);
                const winnerPickWindowMin = tournamentRow.winner_pick_window_min ?? DEFAULT_WINNER_PICK_WINDOW_MIN;
                const runnerUpPickWindowMin = tournamentRow.runnerup_pick_window_min ?? DEFAULT_RUNNERUP_PICK_WINDOW_MIN;
                const pickWindowMin = windowMinForPicker(pickerType, { winnerWindowMin: winnerPickWindowMin, runnerUpWindowMin: runnerUpPickWindowMin });
                const slotId = uuidv4();
                // Captured once and reused for the row, the ticker payload, the
                // lobby-feed countdown and (v2.70.0) the web-push body so all
                // four describe the same instant as the one TimeoutManager
                // enforces against.
                const pickerDesignatedAt = new Date().toISOString();
                const pickDeadline = computePickDeadline(pickerDesignatedAt, pickWindowMin);
                // A WINNER window expiring pivots to the runner-up; it does NOT
                // auto-pick. Resolved once here so the feed and the push tell
                // the player the same true thing. A RUNNER_UP row (forfeit /
                // dynasty) has no further pivot — its own expiry auto-picks.
                const pickFallback = pickWindowFallback(pickerType, activeGame.id);
                await db.run(
                    `INSERT INTO games (id, tournament_id, name, status, picker_discord_id, picker_type, picker_designated_at, reminder_count, won_game_id, game_room_id)
                     VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, 0, ?, ?)`,
                    slotId, tournamentId, '[Pending Pick]', pickerId, pickerType, pickerDesignatedAt, activeGame.id, tournamentRow.game_room_id ?? null
                );
                logInfo(`   -> Created picker slot for ${pickerType === 'WINNER' ? 'winner/nominee' : 'runner-up'} (pick window active).`);

                // Onboarding hook (nominate only, nominee not yet a room
                // member) — fire-and-forget, never blocks slot creation.
                // trackBackground per the v2.24.1 doctrine: UNTRACKED
                // fire-and-forget chains are the known nested-transaction
                // test-flake family (they outlive the test's DB reset).
                if (onboardingNominee) {
                    trackBackground(
                        this.announceNomineeOnboarding(onboardingNominee, tournamentRow, channelId, term)
                    ).catch(() => {});
                }

                // Public pick prompt on the lobby feed. This branch is
                // specifically the one where the picker must pick BY HAND —
                // when the queue already held an eligible game the rotation
                // path activates it and never reaches here, so no prompt is
                // emitted for an auto-filled slot.
                //
                // The row carries the deadline in metadata rather than baking
                // "N minutes" into the title: the feed is append-only, so a
                // static number would still be shouting the original countdown
                // days later. The FE counts down against the deadline and
                // renders a closed state past it.
                if (tournamentRow.game_room_id) {
                    import('../services/LobbyFeedService.js').then(({ LobbyFeedService }) => {
                        LobbyFeedService.emit({
                            gameRoomId: tournamentRow.game_room_id,
                            type: 'pick_prompt',
                            title: `${pickerLabel}, pick the next ${term.game} for ${tournamentRow.name}`,
                            playerId: pickerId,
                            tournamentId,
                            metadata: {
                                deadline: pickDeadline.toISOString(),
                                windowMin: pickWindowMin,
                                pickerType,
                                fallback: pickFallback,
                                pickerName: pickerLabel,
                                tournamentName: tournamentRow.name,
                                reasonNote: announceExtra,
                            },
                        }).catch(() => {});
                    }).catch(() => {});
                }

                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const pickerMention = await formatUserMention(pickerId, pickerLabel, tournamentRow.game_room_id);
                    const desc = announceExtra
                        ? `${announceExtra} ${pickerMention} has **${pickWindowMin} minutes** to use \`/pick-game\` to select the next ${term.game} for this slot.`
                        : `${pickerMention} — you won **${activeGame.name}**! Use \`/pick-game\` within **${pickWindowMin} minutes** to select the next ${term.game} for this slot.`;
                    const embed = new EmbedBuilder()
                        .setTitle(`Pick Needed — ${activeGame.name}`)
                        .setDescription(desc)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }

                emitPickerAssigned({
                    tournamentName: tournamentRow.name,
                    pickerName: pickerLabel,
                    deadline: pickDeadline.toISOString(),
                });

                // Notify the picker it's their turn to pick. Per-slot DM — when a
                // user wins multiple slots in one maintenance run, they get one
                // turn-to-pick DM per won game so they know exactly which slot
                // each pick fulfills.
                //
                // v2.70.0 — the same call also drives web push (turnToPick has
                // been in WEB_PUSH_TYPES since D4, but nothing shaped a body
                // for it, so the tray got the DM's first line: a sentence about
                // the game just won, with the deadline stranded in line two).
                // `pushBody` now carries the deadline and the honest
                // consequence, derived from the same instant as the feed
                // countdown. Opt-in semantics are untouched — this rides
                // `notify`, so the per-type pref, the webPush channel flag, the
                // rate limit and the pick-award gate all still apply, and a
                // user who never opted in gets nothing.
                import('../services/NotificationService.js').then(({ NotificationService }) => {
                    db.get('SELECT slug FROM game_rooms WHERE id = ?', tournamentRow.game_room_id).then((r: any) => {
                        const link = r?.slug ? NotificationService.buildLink(r.slug, '/picks') : '';
                        const message = announceExtra
                            ? `${announceExtra} It's your turn to pick the next ${term.game} for **${tournamentRow.name}**. You have **${pickWindowMin} minutes** to use \`/pick-game\` or pick from the web, or ${pickFallbackPhrase(pickFallback)}.${link ? `\n${link}` : ''}`
                            : `You won **${activeGame.name}** in **${tournamentRow.name}** — it's your turn to pick the next ${term.game} for that slot. You have **${pickWindowMin} minutes** to use \`/pick-game\` or pick from the web, or ${pickFallbackPhrase(pickFallback)}.${link ? `\n${link}` : ''}`;
                        NotificationService.notify({
                            userId: pickerId,
                            type: 'turnToPick',
                            message,
                            pushBody: pickPromptPushBody(tournamentRow.name, pickDeadline, pickFallback),
                            roomId: tournamentRow.game_room_id,
                            tournamentId,
                            pushUrl: link || undefined,
                        }).catch(() => {});
                    }).catch(() => {});
                }).catch(() => {});
            } else if (!winnerPicks && !autoPick) {
                // Manual only — no pick windows, no auto-select
                logInfo(`   -> No ${term.game} queued. winner_picks=off, auto_pick=off — waiting for admin.`);
                if (channelId) {
                    const color = getTournamentColor(tournamentRow.type);
                    const description = pickAwardEnabled
                        ? `Auto-pick is disabled. A moderator should use \`/pick-game\` to select the next ${term.game}.`
                        : `Auto-pick is disabled. A moderator will queue the next ${term.game}.`;
                    const embed = new EmbedBuilder()
                        .setTitle(`No ${term.game} Queued`)
                        .setDescription(description)
                        .setColor(color)
                        .setFooter({ text: tournamentRow.name })
                        .setTimestamp();
                    await sendChannelEmbed(channelId, embed);
                }
            } else {
                // winnerPicks=true but no winner found, or winnerPicks=true with auto_pick
                if (autoPick) {
                    logInfo(`   -> No ${term.game} queued and no winner found. auto_pick=on — auto-selecting.`);
                    await this.autoPickAndActivate(db, tournamentRow, tournamentId, activeGame, client, term, channelId);
                } else {
                    logInfo(`   -> No ${term.game} queued and no winner found. auto_pick=off — waiting for admin.`);
                    if (channelId) {
                        const color = getTournamentColor(tournamentRow.type);
                        const description = pickAwardEnabled
                            ? `A moderator should use \`/pick-game\` or \`/nominate-picker\`.`
                            : `A moderator will queue the next ${term.game}.`;
                        const embed = new EmbedBuilder()
                            .setTitle(`No ${term.game} Queued`)
                            .setDescription(description)
                            .setColor(color)
                            .setFooter({ text: tournamentRow.name })
                            .setTimestamp();
                        await sendChannelEmbed(channelId, embed);
                    }
                }
            }
        }
    }

    /**
     * `allow_dynasty = 0` AND this winner also took the immediately-previous
     * COMPLETED slot in this tournament.
     *
     * Blocks only their own use-my-queue path — a disposition the winner set is
     * honored regardless (contract §4.5). Extracted from the pre-2026-08-17
     * `resolveNextPicker`; that method's other responsibilities now live in
     * `pickResolution.resolvePick`, which both the rotation and the timeout
     * chain share.
     */
    private async isDynastyBlocked(
        db: any,
        tournamentRow: any,
        activeGame: Game,
        winnerId: string | null,
    ): Promise<boolean> {
        if (!winnerId || tournamentRow.allow_dynasty !== 0) return false;
        const prevGame = await db.get(
            `SELECT id FROM games WHERE tournament_id = ? AND status = 'COMPLETED' AND id != ?
             ORDER BY end_date DESC LIMIT 1`,
            tournamentRow.id, activeGame.id,
        );
        if (!prevGame) return false;
        const prevWinnerRow = await db.get(
            `SELECT iscored_username, discord_user_id, submitted_by_user_id FROM submissions
             WHERE game_id = ? AND orphaned_at IS NULL ORDER BY score DESC LIMIT 1`,
            prevGame.id,
        );
        const prevWinnerId = await resolveSubmissionPlayerId(db, prevWinnerRow);
        return !!prevWinnerId && prevWinnerId === winnerId;
    }

    /**
     * The first cooldown-eligible game in THIS player's queue for this
     * tournament, or null.
     *
     * Queues are per-player and ordered by the player's own `queue_order` (see
     * `queueGame`) — there is no tournament-wide queue to walk any more.
     *
     * Games that lost eligibility while they waited are deleted as we walk past
     * them, preserving the documented "ineligible queued games auto-removed
     * during maintenance" behavior. The scope is now just the player being
     * consulted, rather than sweeping every player's queue on every rotation.
     */
    public async nextEligibleQueuedFor(tournamentId: string, playerId: string): Promise<any | null> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT * FROM games
             WHERE tournament_id = ? AND status = 'QUEUED' AND name != '[Pending Pick]'
               AND picker_discord_id = ?
             ORDER BY queue_order ASC, rowid ASC`,
            tournamentId, playerId,
        );
        for (const row of rows) {
            if (await this.isGameEligible(tournamentId, row.name)) return row;
            logWarn(`   -> Dropping queued game "${row.name}" — no longer eligible (cooldown).`);
            // Same shape as the extra-slot loop's removal (2026-08-20 incident):
            // clear the NO-ACTION `leaderboard_cache` FK first, and constrain
            // the delete to QUEUED rows so this walker can never take out a row
            // that changed status underneath it.
            await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', row.id);
            await db.run(`DELETE FROM games WHERE id = ? AND status = 'QUEUED'`, row.id);
        }
        return null;
    }

    /**
     * Announcement label for a player id: their chosen display name, else any
     * iScored alias linked to them, else the raw id (which at least stays
     * @mentionable in Discord copy).
     */
    public async labelForPlayer(playerId: string): Promise<string> {
        const db = await getDatabase();

        // display_name -> username -> iScored alias -> raw id.
        //
        // The `username` rung was missing until 2026-08-18 and a rotation embed
        // shipped a raw snowflake to the channel: "1393376372025458799 handed
        // their pick to mekelburgj". `user_profiles.username` is the provider
        // name stored on every login (v2.40.0), so it is populated for everyone
        // — the two rungs around it are not. A player only has a display_name
        // if they chose one, and only an alias if they ran /map-user or were
        // merged; two of four active players on rtx_pinball had neither.
        //
        // Same chain as `api/auth.ts`'s token mint (display_name || username ||
        // id), with the alias kept as a last resort before the id.
        const profile = await db.get(
            'SELECT display_name, username FROM user_profiles WHERE discord_user_id = ?',
            playerId,
        ).catch(() => null);
        if (profile?.display_name) return profile.display_name;
        if (profile?.username) return profile.username;

        const alias = await db.get(
            'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ? ORDER BY created_at ASC LIMIT 1',
            playerId,
        ).catch(() => null);
        return alias?.iscored_username || playerId;
    }

    /**
     * Onboarding hook for a nominee who isn't a room member yet (ROADMAP —
     * "deliberate onboarding hook"). Posts to the tournament channel with an
     * @mention + a direct link to the room's Picks page, and DMs the nominee
     * too when reachable. Never throws — fire-and-forget from the caller.
     *
     * Public (was private pre-v2.10x /pick-game consolidation): the live
     * pass-pick path in `pickgame.ts` reuses this exact pathway for a
     * non-room-member target, same as the disposition-driven nominate branch
     * above — one onboarding hook, not a fork.
     */
    public async announceNomineeOnboarding(
        nomineeId: string,
        tournamentRow: any,
        channelId: string | null,
        term: ReturnType<typeof getTerminology>,
    ): Promise<void> {
        try {
            const db = await getDatabase();
            const room = tournamentRow.game_room_id
                ? await db.get('SELECT slug, name FROM game_rooms WHERE id = ?', tournamentRow.game_room_id)
                : null;
            const roomName = room?.name || 'the room';
            const link = room?.slug
                ? `https://arcaid.app/${room.slug}/picks?t=${tournamentUrlSlug(tournamentRow.name)}`
                : null;
            const mention = `<@${nomineeId}>`;
            const copy = `${mention} — you have next pick in **${roomName}**!${link ? ` ${link}` : ''} Log in with your Discord to pick the next ${term.game}.`;

            if (channelId) {
                await sendChannelMessage(channelId, copy);
            }

            const { NotificationService } = await import('../services/NotificationService.js');
            await NotificationService.notify({
                userId: nomineeId,
                type: 'turnToPick',
                message: copy,
                pushBody: `You have next pick in ${roomName}.`,
                roomId: tournamentRow.game_room_id,
                tournamentId: tournamentRow.id,
                pushUrl: link || undefined,
            }).catch(() => {});
        } catch (err) {
            logError('announceNomineeOnboarding failed (continuing):', err);
        }
    }

    /**
     * Auto-select a random eligible game and immediately activate it.
     * Used when winner_picks is disabled or as a fallback when no winner exists.
     */
    private async autoPickAndActivate(
        db: any,
        tournamentRow: any,
        tournamentId: string,
        completedGame: Game,
        client: IScoredClient | null,
        term: ReturnType<typeof getTerminology>,
        channelId: string | null,
    ): Promise<void> {
        // Guard: if tournament already has max active games, skip auto-pick
        const maxSlots = tournamentRow.max_active_games ?? 1;
        const currentActiveGames = await this.getActiveGames(tournamentId);
        if (currentActiveGames.length >= maxSlots) {
            logInfo(`   -> Auto-pick skipped: tournament already at max active games (${currentActiveGames.length}/${maxSlots}).`);
            return;
        }

        // Parse platform rules
        const platformRules = parseTournamentRules(tournamentRow, tournamentId);

        const eligibilityDays = tournamentRow.eligibility_days ?? 120;

        // Get the catalogue (one row per name — variants collapsed for autopick).
        // `MIN(features)` alongside `MIN(platforms)`: the device axis reads
        // availability out of `features` post-fold (ADR 0016 catalogue phase
        // §4). Both are MIN over a name-group for the same pre-existing reason
        // — variants are collapsed for autopick and one row stands for the name.
        const libraryGames = await db.all(`
            SELECT name, MIN(type) AS mode, MIN(platforms) AS platforms, MIN(features) AS features
            FROM global_games WHERE status = 'approved'
            GROUP BY LOWER(name)
        `);

        // Pre-load this room's tag map (single query) so the platform-rule
        // filter can union room tags into each game's effective platforms
        // without N+1 lookups.
        let tagMap: Map<string, string[]> = new Map();
        if (tournamentRow.game_room_id) {
            const { RoomGameTagsService } = await import('../services/RoomGameTagsService.js');
            tagMap = await RoomGameTagsService.getTagMapByGameNameForRoom(tournamentRow.game_room_id);
        }

        // Filter by mode + platform rules. v2.6.x: `excluded` is a submission-
        // level filter only (see `passesplatformRules` JSDoc); game-level gate
        // checks `required` exclusively, against catalogue ∪ room tags.
        // v2.60.0 (ADR 0016 P2): both axes' `required` via `passesplatformRules`
        // — the same helper every other eligibility gate uses, so autopick can
        // no longer disagree with the pick/activate paths about what qualifies.
        const gameLevelRules = hasGameLevelPlatformRules(platformRules);
        const eligible = libraryGames.filter((g: any) => {
            // `catalogueTypeMatchesTournamentMode` bridges tournamentRow.mode
            // ('videogame') against global_games.type ('video_game' |
            // 'arcade') — see src/utils/tournamentMode.ts.
            if (!catalogueTypeMatchesTournamentMode(g.mode, tournamentRow.mode)) return false;
            if (!gameLevelRules) return true;
            const cataloguePlatforms = parsePlatformsList(g.platforms || '[]');
            const tags = tagMap.get(g.name.toLowerCase()) || [];
            return passesplatformRules(
                [...cataloguePlatforms, ...tags], platformRules, parsePlatformsList(g.features || '[]'),
            );
        });

        // Filter by cooldown
        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - eligibilityDays);
        const recentlyPlayed = await db.all(
            `SELECT DISTINCT name FROM games
             WHERE tournament_id = ? AND start_date >= ? AND status != 'QUEUED'`,
            tournamentId, lookbackDate.toISOString()
        );
        const recentlyPlayedSet = new Set(recentlyPlayed.map((r: any) => r.name.toLowerCase()));
        const finalEligible = eligible.filter((g: any) => !recentlyPlayedSet.has(g.name.toLowerCase()));

        if (finalEligible.length === 0) {
            logWarn(`No eligible ${term.games} found for auto-pick in ${tournamentRow.name}.`);
            if (channelId) {
                const color = getTournamentColor(tournamentRow.type);
                const embed = new EmbedBuilder()
                    .setTitle(`No Eligible ${term.games}`)
                    .setDescription(`No eligible ${term.games} were found for auto-pick in **${tournamentRow.name}**. A moderator must use \`/pick-game\`.`)
                    .setColor(color)
                    .setFooter({ text: tournamentRow.name })
                    .setTimestamp();
                await sendChannelEmbed(channelId, embed);
            }
            return;
        }

        // Pick one at random
        const pick = finalEligible[Math.floor(Math.random() * finalEligible.length)]!;
        logInfo(`   -> Auto-picked: ${pick.name} for ${tournamentRow.name}`);

        // Create on iScored if client available
        let iscoredId: string | null = null;
        if (client) {
            try {
                const styleId = pick.style_id || undefined;
                iscoredId = await client.createGame(pick.name, styleId);
                await client.setGameTags(iscoredId, tournamentRow.type);
                await client.setGameStatus(iscoredId, { locked: false, hidden: false });
                logInfo(`   -> Created on iScored: ${pick.name} (ID: ${iscoredId})`);
            } catch (err) {
                logError('   -> Failed to create auto-picked game on iScored (continuing):', err);
            }
        }

        // Create game record as ACTIVE immediately
        const gameId = uuidv4();
        // Propagate display_name from catalogue.
        const libRow = await db.get(
            `SELECT display_name FROM global_games WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
            pick.name,
        );
        let catalogueStyleId: string | null = null;
        let logoStyleId: string | null = null;
        let bgStyleId: string | null = null;
        if (tournamentRow.game_room_id) {
            const libStyle = await db.get(
                'SELECT catalogue_style_id, logo_style_id, bg_style_id FROM game_room_game_library WHERE game_room_id = ? AND game_name = ?',
                tournamentRow.game_room_id, pick.name
            );
            if (libStyle) {
                catalogueStyleId = libStyle.catalogue_style_id;
                logoStyleId = libStyle.logo_style_id;
                bgStyleId = libStyle.bg_style_id;
            }
        }

        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date, iscored_id, style_id, display_name, catalogue_style_id, logo_style_id, bg_style_id, game_room_id)
             VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?)`,
            gameId, tournamentId, pick.name, new Date().toISOString(),
            iscoredId, pick.style_id || null,
            libRow?.display_name || null,
            catalogueStyleId, logoStyleId, bgStyleId, tournamentRow.game_room_id ?? null
        );
        logInfo(`   -> Activated in DB: ${pick.name}`);

        // Log game rotation event
        if (tournamentRow.game_room_id) {
            RoomEventService.log(tournamentRow.game_room_id, 'game_rotation', {
                tournamentName: tournamentRow.name,
                oldGame: completedGame.name,
                newGame: pick.name,
            }).catch(() => {});

            // Lobby feed: auto-picked game activated
            import('../services/LobbyFeedService.js').then(({ LobbyFeedService }) => {
                LobbyFeedService.emit({
                    gameRoomId: tournamentRow.game_room_id,
                    type: 'tournament_active',
                    icon: '\u{1F3C6}',
                    title: `Now active in ${tournamentRow.name}: ${pick.name}`,
                    gameName: pick.name,
                    tournamentId: tournamentRow.id,
                }).catch(() => {});
            }).catch(() => {});
        }

        // Announce
        if (channelId) {
            const color = getTournamentColor(tournamentRow.type);
            const embed = new EmbedBuilder()
                .setTitle(`Now Active: ${pick.name}`)
                .setDescription(`**${pick.name}** has been auto-selected and activated for **${tournamentRow.name}**.`)
                .setColor(color)
                .setFooter({ text: tournamentRow.name })
                .setTimestamp();
            await sendChannelEmbed(channelId, embed);
        }

        emitGameRotated({
            tournamentName: tournamentRow.name,
            oldGame: completedGame.name,
            newGame: pick.name,
        });
    }

    /**
     * Hides completed games on iScored based on the tournament's cleanup rule.
     * - immediate / retain(0): hide all completed games
     * - retain(N): keep the N most recent completed games visible, hide the rest
     */
    public async runCleanup(
        tournamentId: string,
        rule?: CleanupRule,
        sharedClient?: IScoredClient | null,
        sharedCreds?: IScoredCreds | null,
    ): Promise<void> {
        const db = await getDatabase();

        if (!rule) {
            const row = await db.get('SELECT cleanup_rule FROM tournaments WHERE id = ?', tournamentId);
            try { rule = JSON.parse(row?.cleanup_rule || '{}'); } catch {}
            if (!rule || !rule.mode) rule = { mode: 'retain', count: 0 };
        }

        const retainCount = rule.mode === 'retain' ? rule.count : 0;

        // Get completed games with iScored IDs, newest first
        const completed = await db.all(`
            SELECT id, name, iscored_id FROM games
            WHERE tournament_id = ? AND status = 'COMPLETED' AND iscored_id IS NOT NULL
            ORDER BY end_date DESC
        `, tournamentId);

        // Keep the first `retainCount` visible, hide the rest
        const toHide = completed.slice(retainCount);
        if (toHide.length === 0) return;

        // Resolve creds. When called from runMaintenanceWork the caller
        // already has both the registry-managed client and the creds — reuse
        // them. When called standalone (runScheduledCleanup or admin), look
        // up creds and acquire a session via the registry.
        const tournamentRow = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', tournamentId);
        let creds: IScoredCreds | null = sharedCreds ?? null;
        if (!sharedClient && sharedCreds === undefined) {
            const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
            creds = await getIScoredCredsForRoom(tournamentRow?.game_room_id);
        }

        const archivable = new Set<string>(); // game.id values confirmed gone from iScored → safe to ARCHIVE
        const deleteAll = async (client: IScoredClient): Promise<void> => {
            for (const game of toHide) {
                try {
                    const deleted = await client.deleteGame(game.iscored_id, game.name);
                    if (deleted) {
                        logInfo(`   -> Deleted from iScored: ${game.name}`);
                        archivable.add(game.id);
                    } else {
                        logWarn(`   -> Cleanup: iScored delete did NOT confirm for ${game.name} (gameID ${game.iscored_id}); leaving COMPLETED to retry next cycle.`);
                    }
                } catch (err) {
                    logWarn(`   -> Failed to delete ${game.name} from iScored (leaving COMPLETED to retry):`, err);
                }
            }
        };

        if (sharedClient) {
            logInfo(`Cleanup for tournament ${tournamentId}: deleting ${toHide.length} completed game(s) from iScored (shared session)`);
            await deleteAll(sharedClient);
        } else if (creds) {
            logInfo(`Cleanup for tournament ${tournamentId}: deleting ${toHide.length} completed game(s) from iScored`);
            await IScoredSessionRegistry.getInstance().withSession(creds, deleteAll);
        } else {
            // iScored disabled for the room — nothing to delete remotely, so all
            // completed games can move straight to the ARCHIVED terminal state.
            logInfo(`Cleanup for tournament ${tournamentId}: marking ${toHide.length} completed game(s) as ARCHIVED (iScored disabled for room)`);
            toHide.forEach((g) => archivable.add(g.id));
        }

        // ARCHIVE only the games we CONFIRMED gone from iScored. A failed delete
        // stays COMPLETED so the next cleanup cycle retries it. Pre-fix this loop
        // archived unconditionally, which stranded the iScored entity forever —
        // cleanup only ever scans COMPLETED rows, so an ARCHIVED orphan is never
        // retried (the iScored-cleanup-orphan bug). ARCHIVED remains the terminal
        // state and the historical anchor for score_history attribution (Stats and
        // Ranking read status IN ('COMPLETED','ARCHIVED')).
        const roomId = tournamentRow?.game_room_id;
        for (const game of toHide) {
            if (!archivable.has(game.id)) continue; // delete failed → keep COMPLETED, retry next cycle
            await db.run('UPDATE games SET status = ? WHERE id = ?', 'ARCHIVED', game.id);

            // Clean up score photos for this game
            if (roomId) {
                try {
                    const photoRows = await db.all(`
                        SELECT photo_url FROM score_history
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                        UNION
                        SELECT photo_url FROM community_scores
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                    `, game.name, roomId, game.name, roomId);

                    for (const row of photoRows) {
                        const relativePath = (row.photo_url as string).replace('/api/score-photos/', '');
                        const filePath = path.join(process.cwd(), 'data', 'score-photos', relativePath);
                        try { fs.unlinkSync(filePath); } catch {}
                    }

                    // Null out photo_url in DB to prevent broken image links
                    await db.run(`
                        UPDATE score_history SET photo_url = NULL
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                    `, game.name, roomId);
                    await db.run(`
                        UPDATE community_scores SET photo_url = NULL
                        WHERE LOWER(game_name) = LOWER(?) AND game_room_id = ?
                          AND photo_url LIKE '/api/score-photos/%'
                    `, game.name, roomId);

                    if (photoRows.length > 0) {
                        logInfo(`   -> Cleaned up ${photoRows.length} score photo(s) for ${game.name}`);
                    }
                } catch (err) {
                    logWarn(`   -> Failed to clean up score photos for ${game.name}:`, err);
                }
            }
        }
    }

    /**
     * Runs scheduled cleanup for all tournaments with 'scheduled' cleanup_rule.
     * Called by the Scheduler on each tournament's cleanup cron.
     */
    public async runScheduledCleanup(tournamentId: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get('SELECT name, cleanup_rule FROM tournaments WHERE id = ?', tournamentId);
        if (!row) return;

        logInfo(`Running scheduled cleanup for ${row.name}`);

        // For scheduled mode, hide ALL completed games (full weekly/periodic wipe)
        await this.runCleanup(tournamentId, { mode: 'immediate' });
    }

    /**
     * Reorders the iScored lineup based on tournament display_order.
     * Within each tournament group: ACTIVE games first, then COMPLETED (locked).
     * Groups are sorted by tournament display_order, games within by start_date.
     * Unmanaged games (no tournament) remain at the bottom.
     *
     * Per-room aware: when rooms point at different iScored accounts, each
     * account's lineup is reordered independently using that room's creds.
     *
     * If `gameRoomId` is provided, restricts the operation to that room only.
     */
    public async reorderIScoredLineup(
        gameRoomId?: string,
        sharedClient?: IScoredClient | null,
    ): Promise<void> {
        const db = await getDatabase();

        const query = `
            SELECT g.iscored_id, g.status, t.display_order, t.game_room_id
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.status IN ('ACTIVE', 'COMPLETED') AND g.iscored_id IS NOT NULL
              ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY
                t.display_order ASC,
                CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END ASC,
                g.start_date DESC
        `;
        const managedGames = gameRoomId
            ? await db.all(query, gameRoomId)
            : await db.all(query);

        if (managedGames.length === 0) return;

        // Group by room so each iScored account is reordered with its own creds.
        const byRoom = new Map<string | null, string[]>();
        for (const g of managedGames as Array<{ iscored_id: string; game_room_id: string | null }>) {
            const key = g.game_room_id;
            if (!byRoom.has(key)) byRoom.set(key, []);
            byRoom.get(key)!.push(g.iscored_id);
        }

        const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
        for (const [roomId, orderedIds] of byRoom) {
            const creds = await getIScoredCredsForRoom(roomId);
            if (!creds) {
                logWarn(`Reorder: skipping ${orderedIds.length} games from room ${roomId ?? '(unassigned)'} — iScored disabled or misconfigured.`);
                continue;
            }
            logInfo(`Reordering iScored lineup for room ${roomId ?? '(unassigned)'}: ${orderedIds.length} games on account ${creds.gameroomName}`);

            // If the caller already holds a session for this room's account,
            // reuse it. Otherwise route through the registry so we don't open
            // a parallel session contending with concurrent maintenance.
            const sharedAccountMatches = sharedClient
                && roomId === gameRoomId; // shared client is scoped to caller's room
            if (sharedAccountMatches && sharedClient) {
                await sharedClient.repositionLineup(orderedIds);
            } else {
                await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                    await client.repositionLineup(orderedIds);
                });
            }
        }
    }
}
