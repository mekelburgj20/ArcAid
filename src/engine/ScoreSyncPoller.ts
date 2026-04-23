import { logInfo, logError, logWarn, logDebug } from '../utils/logger.js';
import { IScoredApiClient, IScoredApiGameScores } from './IScoredApiClient.js';
import { getDatabase } from '../database/database.js';
import { normalizeSubmitterUserId } from '../services/SubmissionContextService.js';

const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Polls the iScored API on a configurable interval to keep ArcAid leaderboards
 * in sync with scores submitted directly on iScored.
 *
 * - Uses getAllScores (one HTTP GET per poll cycle)
 * - Only upserts new or higher scores (never deletes)
 * - Invalidates leaderboard cache only for games with actual changes
 * - Pauses automatically during tournament maintenance
 */
export class ScoreSyncPoller {
    private static instance: ScoreSyncPoller;
    private timer: ReturnType<typeof setInterval> | null = null;
    private polling = false;
    private _paused = false;
    private intervalMs = DEFAULT_INTERVAL_MS;
    private consecutiveErrors = 0;
    private _lastPollSucceeded = false;
    private _pollCount = 0;

    static getInstance(): ScoreSyncPoller {
        if (!ScoreSyncPoller.instance) {
            ScoreSyncPoller.instance = new ScoreSyncPoller();
        }
        return ScoreSyncPoller.instance;
    }

    start(intervalMs?: number): void {
        if (intervalMs) this.intervalMs = intervalMs;
        this.stop();
        logInfo(`ScoreSyncPoller: starting with ${this.intervalMs / 1000}s interval`);
        this.timer = setInterval(() => this.poll(), this.intervalMs);
        // Run initial poll after a short delay (let other startup tasks finish)
        setTimeout(() => this.poll(), 5000);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logInfo('ScoreSyncPoller: stopped');
        }
    }

    isRunning(): boolean {
        return this.timer !== null;
    }

    pause(): void {
        this._paused = true;
        logDebug('ScoreSyncPoller: paused');
    }

    resume(): void {
        this._paused = false;
        logDebug('ScoreSyncPoller: resumed');
    }

    /** Update interval without full restart. */
    setInterval(ms: number): void {
        this.intervalMs = ms;
        if (this.timer) {
            this.stop();
            this.start(ms);
        }
    }

    private async poll(): Promise<void> {
        if (this.polling || this._paused) return;
        this.polling = true;
        try {
            // Group rooms by unique iScored account so we poll each account
            // exactly once per cycle, even if two rooms share credentials.
            const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
            const db = await getDatabase();
            const rooms = (await db.all('SELECT id FROM game_rooms')) as Array<{ id: string }>;

            const accounts = new Map<string, { creds: Awaited<ReturnType<typeof getIScoredCredsForRoom>>; roomIds: string[] }>();
            // Track the env-fallback "account" for rooms with no per-room config.
            for (const room of rooms) {
                const c = await getIScoredCredsForRoom(room.id);
                if (!c) continue;
                const key = `${c.gameroomName}::${c.publicUrl}`;
                if (!accounts.has(key)) accounts.set(key, { creds: c, roomIds: [] });
                accounts.get(key)!.roomIds.push(room.id);
            }

            if (accounts.size === 0) {
                // No rooms have iScored enabled — nothing to do.
                this.consecutiveErrors = 0;
                this._lastPollSucceeded = true;
                return;
            }

            // Pre-load user mappings and aliases once (global tables).
            const mappingRows = await db.all('SELECT iscored_username, discord_user_id FROM user_mappings');
            const mappingMap = new Map<string, string>();
            for (const m of mappingRows) {
                mappingMap.set(m.iscored_username.toLowerCase(), m.discord_user_id);
            }
            const aliasRows = await db.all('SELECT old_username, new_username FROM player_aliases');
            const aliasMap = new Map<string, string>();
            for (const a of aliasRows) {
                aliasMap.set(a.old_username.toLowerCase(), a.new_username);
            }

            const changedGameIds = new Set<string>();

            for (const [, { creds, roomIds }] of accounts) {
                if (!creds) continue;
                try {
                    await this.pollOneAccount(db, creds, roomIds, mappingMap, aliasMap, changedGameIds);
                } catch (accountErr) {
                    logError(`ScoreSyncPoller: account ${creds.gameroomName} poll failed:`, accountErr);
                }
            }
            this._lastPollSucceeded = true;

            // Invalidate leaderboard cache for changed games
            if (changedGameIds.size > 0) {
                const { LeaderboardService } = await import('../services/LeaderboardService.js');
                for (const gameId of changedGameIds) {
                    await LeaderboardService.invalidate(gameId);
                }
                logInfo(`ScoreSyncPoller: synced score changes for ${changedGameIds.size} game(s)`);
            }

            this.consecutiveErrors = 0;
            this._pollCount++;
        } catch (err) {
            this._lastPollSucceeded = false;
            this.consecutiveErrors++;
            if (this.consecutiveErrors <= 3) {
                logError('ScoreSyncPoller: poll failed:', err);
            } else if (this.consecutiveErrors === 4) {
                logError('ScoreSyncPoller: poll failed (suppressing further errors until recovery):', err);
            }
            // Don't crash — next interval will retry
        } finally {
            this.polling = false;
        }
    }

    /**
     * Polls one iScored account and applies any score changes to rooms that
     * resolve to that account. `roomIds` is the list of rooms attributed to
     * this account — used to scope the local game lookup so two different
     * iScored accounts can share overlapping GameIDs without cross-talk.
     */
    private async pollOneAccount(
        db: any,
        creds: { username: string; password: string; publicUrl: string; gameroomName: string; source: 'room' | 'env' },
        roomIds: string[],
        mappingMap: Map<string, string>,
        aliasMap: Map<string, string>,
        changedGameIds: Set<string>,
    ): Promise<void> {
        const apiClient = new IScoredApiClient({ gameroomName: creds.gameroomName });
        const rawResponse = await apiClient.getAllScores();

        if (this.consecutiveErrors > 0 || !this._lastPollSucceeded) {
            logInfo(`ScoreSyncPoller[${creds.gameroomName}]: API returned ${Array.isArray(rawResponse) ? rawResponse.length : '?'} entries`);
        }

        const allScores = this.normalizeScoreResponse(rawResponse);

        if (roomIds.length === 0) return; // defensive; should not happen

        const placeholders = roomIds.map(() => '?').join(', ');

        for (const gameData of allScores) {
            if (!gameData.GameID || !gameData.scores) continue;

            // Scope the lookup to rooms that share this account, so two
            // accounts using overlapping GameIDs don't cross-talk.
            const localGame = await db.get(
                `SELECT g.id, g.tournament_id, g.name, t.game_room_id
                 FROM games g
                 JOIN tournaments t ON t.id = g.tournament_id
                 WHERE g.iscored_id = ? AND t.game_room_id IN (${placeholders})`,
                gameData.GameID, ...roomIds,
            );
            if (!localGame) continue;

            const existingRows = await db.all(
                'SELECT id, score, discord_user_id FROM submissions WHERE game_id = ?',
                localGame.id,
            );
            const existingMap = new Map<string, { score: number; discord_user_id: string }>();
            for (const r of existingRows) {
                existingMap.set(r.id, { score: r.score, discord_user_id: r.discord_user_id });
            }

            for (const score of gameData.scores) {
                const scoreValue = parseInt(String(score.score).replace(/[^0-9-]/g, ''), 10);
                if (isNaN(scoreValue)) continue;

                const resolvedName = aliasMap.get(score.name.toLowerCase()) || score.name;
                const syncId = `${localGame.id}-${resolvedName.toLowerCase()}`;
                const existing = existingMap.get(syncId);

                if (!existing || scoreValue > existing.score) {
                    const discordUserId = mappingMap.get(resolvedName.toLowerCase()) || mappingMap.get(score.name.toLowerCase()) || `iscored:${resolvedName}`;

                    const submittedByUserId = normalizeSubmitterUserId(
                        discordUserId.startsWith('iscored:') ? null : discordUserId,
                    );
                    const submittedByAnonymousName = submittedByUserId ? null : resolvedName;
                    await db.run(`
                        INSERT INTO submissions (
                            id, game_id, iscored_username, score, timestamp, discord_user_id,
                            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                            submitted_by_anonymous_name, merged_from_anonymous_identity_id
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                        ON CONFLICT(id) DO UPDATE SET
                            score = excluded.score,
                            discord_user_id = excluded.discord_user_id,
                            iscored_username = excluded.iscored_username
                    `, syncId, localGame.id, resolvedName, scoreValue, new Date().toISOString(), discordUserId,
                        localGame.game_room_id || null, localGame.tournament_id || null,
                        submittedByUserId, submittedByAnonymousName);

                    changedGameIds.add(localGame.id);
                    logDebug(`ScoreSyncPoller[${creds.gameroomName}]: ${existing ? 'updated' : 'new'} score for ${resolvedName}${resolvedName !== score.name ? ` (alias of ${score.name})` : ''} on "${gameData.gameName}": ${scoreValue.toLocaleString()}`);

                    if (localGame.tournament_id && localGame.game_room_id) {
                        try {
                            const { ScoreHistoryService } = await import('../services/ScoreHistoryService.js');
                            await ScoreHistoryService.log({
                                gameName: localGame.name,
                                gameRoomId: localGame.game_room_id,
                                gameId: localGame.id,
                                username: resolvedName,
                                discordUserId,
                                score: scoreValue,
                                source: 'sync',
                                tournamentId: localGame.tournament_id,
                                anonymousName: submittedByAnonymousName,
                            });

                            import('../services/LobbyFeedGenerator.js').then(({ LobbyFeedGenerator }) => {
                                LobbyFeedGenerator.onScoreSubmitted({
                                    gameRoomId: localGame.game_room_id, gameName: localGame.name,
                                    username: resolvedName, score: scoreValue,
                                    discordUserId, source: 'sync',
                                }).catch(() => {});
                            }).catch(() => {});

                            const { GlobalScoreService } = await import('../services/GlobalScoreService.js');
                            const fanOut = await GlobalScoreService.fanOutFromRoomSubmission({
                                gameRoomId: localGame.game_room_id,
                                gameName: localGame.name,
                                gameId: localGame.id,
                                playerId: discordUserId,
                                iscoredUsername: resolvedName,
                                score: scoreValue,
                                tournamentId: localGame.tournament_id,
                                submittedByAnonymousName: submittedByAnonymousName ?? undefined,
                            });
                            if (fanOut) {
                                const { emitScoreNewGlobal } = await import('../api/websocket.js');
                                const room = await db.get('SELECT name, slug FROM game_rooms WHERE id = ?', localGame.game_room_id);
                                emitScoreNewGlobal({
                                    globalGameId: fanOut.globalGameId,
                                    gameName: fanOut.gameName,
                                    playerName: resolvedName,
                                    score: scoreValue,
                                    originRoomSlug: room?.slug || null,
                                    originRoomName: room?.name || null,
                                });
                            }
                        } catch {}
                    }
                }
            }
        }
    }

    /**
     * Normalize the getAllScores flat response into grouped-by-game format.
     *
     * API returns: { scores: [{ name, game, gameName, score, date, ... }] }
     * We need:     [{ GameID, gameName, scores: [{ name, score, ... }] }]
     */
    private normalizeScoreResponse(data: any): IScoredApiGameScores[] {
        // getAllScores returns { scores: [...] } with flat score entries
        let flatScores: any[] = [];

        if (data && data.scores && Array.isArray(data.scores)) {
            flatScores = data.scores;
        } else if (Array.isArray(data)) {
            flatScores = data;
        } else {
            logWarn(`ScoreSyncPoller: unexpected API response shape — keys: ${data ? Object.keys(data).join(', ') : 'null'}`);
            return [];
        }

        if (this._pollCount === 0) {
            logInfo(`ScoreSyncPoller: API returned ${flatScores.length} total score entries`);
        }

        // Group flat scores by game ID
        const grouped = new Map<string, IScoredApiGameScores>();
        for (const entry of flatScores) {
            const gameId = String(entry.game || entry.GameID || '');
            if (!gameId) continue;

            if (!grouped.has(gameId)) {
                grouped.set(gameId, {
                    GameID: gameId,
                    gameName: entry.gameName || '',
                    scores: [],
                });
            }
            grouped.get(gameId)!.scores.push({
                name: entry.name || '',
                score: String(entry.score || '0'),
                date: entry.date || '',
                rank: entry.rank || '',
            });
        }

        return Array.from(grouped.values());
    }
}
