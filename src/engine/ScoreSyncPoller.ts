import { logInfo, logError, logWarn, logDebug } from '../utils/logger.js';
import { IScoredApiClient } from './IScoredApiClient.js';
import { IScoredNotificationGate } from './IScoredNotificationGate.js';
import { getDatabase } from '../database/database.js';
import { normalizeSubmitterUserId } from '../services/SubmissionContextService.js';
import { OpsAlertService } from '../services/OpsAlertService.js';
import { trackBackground } from '../utils/backgroundTasks.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import type { IScoredCreds } from '../utils/iscoredCreds.js';
import { normalizeIScoredScoreResponse } from '../utils/iscoredScores.js';
import { IdentityAutoLinkService } from '../services/IdentityAutoLinkService.js';

// Tick cadence for the notification-file gate. The actual `getAllScores` call
// is gated inside `IScoredNotificationGate.shouldSync` so most ticks are a
// single static .txt fetch. See `IScoredNotificationGate` doc-comment for the
// background (Daniel Reynolds → Justin Mekelburg, 2026-04-29).
const DEFAULT_INTERVAL_MS = 10_000; // 10 seconds

// After this many consecutive poll failures for a single iScored account, fire
// a one-time operator alert (S10). Re-arms after a successful poll. Sits just
// past the log-suppression cadence (errors are already suppressed after the 4th).
const OPS_ALERT_FAIL_THRESHOLD = 5;

interface AccountHealth {
    consecutiveErrors: number;
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    lastError: string | null;
    /** True once the operator alert has fired for the current outage. */
    alerted: boolean;
}

export interface PollerAccountStatus {
    name: string;
    consecutiveErrors: number;
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    lastError: string | null;
}

export interface PollerStatus {
    running: boolean;
    paused: boolean;
    intervalMs: number;
    pollCount: number;
    lastPollAt: number | null;
    lastSuccessAt: number | null;
    lastPollSucceeded: boolean;
    consecutiveErrors: number;
    accounts: PollerAccountStatus[];
}

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
    private _lastPollAt: number | null = null;
    private _lastSuccessAt: number | null = null;
    /**
     * Per-account health. `consecutiveErrors` mirrors the outer suppression so
     * an iScored outage affecting one account doesn't spam the logs every
     * cycle. `alerted` debounces the S10 operator alert so it fires once per
     * outage (on threshold crossing) and re-arms on recovery. Reset on the
     * first successful poll for that account.
     */
    private accountHealth = new Map<string, AccountHealth>();
    private gate = new IScoredNotificationGate();

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

    /**
     * Snapshot of poller health for the S10 room-admin health surface. Exposes
     * global + per-account sync state (timestamps, consecutive-failure counts,
     * last error message). Read-only; safe to call from route handlers.
     */
    getStatus(): PollerStatus {
        return {
            running: this.isRunning(),
            paused: this._paused,
            intervalMs: this.intervalMs,
            pollCount: this._pollCount,
            lastPollAt: this._lastPollAt,
            lastSuccessAt: this._lastSuccessAt,
            lastPollSucceeded: this._lastPollSucceeded,
            consecutiveErrors: this.consecutiveErrors,
            accounts: Array.from(this.accountHealth.entries()).map(([name, h]) => ({
                name,
                consecutiveErrors: h.consecutiveErrors,
                lastSuccessAt: h.lastSuccessAt,
                lastErrorAt: h.lastErrorAt,
                lastError: h.lastError,
            })),
        };
    }

    /**
     * Record a successful poll for an account: clears failure state and, if an
     * operator alert had fired for the just-ended outage, sends a recovery note.
     * Extracted from poll() so the debounce is unit-testable (S10).
     */
    private recordAccountSuccess(accountName: string): void {
        const prior = this.accountHealth.get(accountName);
        const priorErrors = prior?.consecutiveErrors ?? 0;
        if (priorErrors > 0) {
            logInfo(`ScoreSyncPoller: account ${accountName} recovered after ${priorErrors} failure(s)`);
            if (prior?.alerted) {
                trackBackground(OpsAlertService.sendOperatorAlert(
                    `iScored sync for account "${accountName}" has RECOVERED after ${priorErrors} consecutive failure(s).`,
                ));
            }
        }
        this.accountHealth.set(accountName, {
            consecutiveErrors: 0,
            lastSuccessAt: Date.now(),
            lastErrorAt: prior?.lastErrorAt ?? null,
            lastError: null,
            alerted: false,
        });
    }

    /**
     * Record a failed poll for an account: increments the failure tally and
     * fires a one-time operator alert on crossing OPS_ALERT_FAIL_THRESHOLD
     * (re-armed by the next success). Returns the new consecutive-failure count
     * so the caller can drive log suppression. Extracted for testability (S10).
     */
    private recordAccountFailure(accountName: string, message: string): number {
        const prior = this.accountHealth.get(accountName);
        const errs = (prior?.consecutiveErrors ?? 0) + 1;
        const crossedThreshold = errs >= OPS_ALERT_FAIL_THRESHOLD && !prior?.alerted;
        this.accountHealth.set(accountName, {
            consecutiveErrors: errs,
            lastSuccessAt: prior?.lastSuccessAt ?? null,
            lastErrorAt: Date.now(),
            lastError: message,
            alerted: prior?.alerted || crossedThreshold,
        });
        if (crossedThreshold) {
            trackBackground(OpsAlertService.sendOperatorAlert(
                `iScored sync for account "${accountName}" has failed ${errs} times in a row. Last error: ${message}`,
            ));
        }
        return errs;
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
        this._lastPollAt = Date.now();
        try {
            // Group rooms by unique iScored account so we poll each account
            // exactly once per cycle, even if two rooms share credentials.
            //
            // v2.74.0 (S24.2): creds for ALL rooms resolve in ONE settings
            // query. Pre-S24 this loop called `getIScoredCredsForRoom` per
            // room, and each call was ≥4 uncached `game_room_settings` reads —
            // paid every 10s for every room, including the iScored-disabled
            // ones whose answer is always null.
            const { getIScoredCredsForRooms } = await import('../utils/iscoredCreds.js');
            const db = await getDatabase();
            const rooms = (await db.all('SELECT id FROM game_rooms')) as Array<{ id: string }>;
            const credsByRoom = await getIScoredCredsForRooms(rooms.map(r => r.id));

            const accounts = new Map<string, { creds: IScoredCreds; roomIds: string[] }>();
            // Track the env-fallback "account" for rooms with no per-room config.
            for (const room of rooms) {
                const c = credsByRoom.get(room.id);
                if (!c) continue;
                const key = `${c.gameroomName}::${c.publicUrl}`;
                if (!accounts.has(key)) accounts.set(key, { creds: c, roomIds: [] });
                accounts.get(key)!.roomIds.push(room.id);
            }

            if (accounts.size === 0) {
                // No rooms have iScored enabled — nothing to do.
                this.consecutiveErrors = 0;
                this._lastPollSucceeded = true;
                this._lastSuccessAt = Date.now();
                return;
            }

            /**
             * v2.74.0 (S24.2): the `user_mappings` + `player_aliases` full-table
             * loads are DEFERRED until an account actually decides to sync.
             *
             * The notification gate means the overwhelming majority of ticks
             * skip every account, and those ticks were still scanning both
             * global tables end to end. Loading lazily preserves the freshness
             * contract exactly — the tables are still read fresh once per
             * cycle, at most, and shared by every account that syncs in that
             * cycle (which is what `pollOneAccount` always assumed).
             */
            let identityMaps: { mappingMap: Map<string, string>; aliasMap: Map<string, string> } | null = null;
            const loadIdentityMaps = async () => {
                if (identityMaps) return identityMaps;
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
                identityMaps = { mappingMap, aliasMap };
                return identityMaps;
            };

            const changedGameIds = new Set<string>();
            let anyAccountSucceeded = false;

            // Per-CYCLE negative cache for the exact-match auto-linker: every
            // unmapped iScored name this cycle has already looked at, whether or
            // not it resolved to an account. Lives out here so two accounts that
            // sync in the same cycle never re-query the same names, and so a
            // board full of permanently-unclaimed names costs one lookup per
            // cycle rather than one per score.
            const autoLinkChecked = new Set<string>();

            for (const [accountKey, { creds, roomIds }] of accounts) {
                if (!creds) continue;
                try {
                    // Gate the expensive getAllScores call behind iScored's
                    // notification .txt file. Most ticks are a single static
                    // text fetch; we only run pollOneAccount when the file
                    // body actually changed (or the backstop interval has
                    // elapsed, or discovery hasn't resolved a roomID yet).
                    const roomId = await this.gate.resolveRoomId(
                        accountKey,
                        creds.gameroomName,
                        creds.source === 'env',
                    );
                    const notifValue = roomId ? await this.gate.fetchNotification(roomId) : null;
                    const decision = this.gate.shouldSync(accountKey, notifValue, !!roomId);

                    if (decision.run) {
                        logDebug(`ScoreSyncPoller[${creds.gameroomName}]: full sync (${decision.reason})`);
                        const { mappingMap, aliasMap } = await loadIdentityMaps();
                        await this.pollOneAccount(db, creds, roomIds, mappingMap, aliasMap, changedGameIds, autoLinkChecked);
                        this.gate.markSynced(accountKey, notifValue);
                    } else {
                        logDebug(`ScoreSyncPoller[${creds.gameroomName}]: skip (${decision.reason})`);
                    }

                    anyAccountSucceeded = true;
                    this.recordAccountSuccess(creds.gameroomName);
                } catch (accountErr) {
                    const message = accountErr instanceof Error ? accountErr.message : String(accountErr);
                    const errs = this.recordAccountFailure(creds.gameroomName, message);
                    if (errs <= 3) {
                        logError(`ScoreSyncPoller: account ${creds.gameroomName} poll failed:`, accountErr);
                    } else if (errs === 4) {
                        logError(`ScoreSyncPoller: account ${creds.gameroomName} poll failed (suppressing further errors until recovery):`, accountErr);
                    }
                }
            }
            // Pre-fix bug: this was unconditionally set to true regardless of
            // per-account outcomes. Now reflects whether ANY account succeeded.
            this._lastPollSucceeded = anyAccountSucceeded || accounts.size === 0;
            if (this._lastPollSucceeded) this._lastSuccessAt = Date.now();

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
    /**
     * Deterministically pick the local `games` row for an iScored GameID within
     * the given rooms. ORDER BY status-pref then recency, so a legacy COMPLETED
     * row sharing an iscored_id never shadows the ACTIVE row — without this the
     * poller could match a stale COMPLETED row that has no submissions for the
     * player and re-fire every dethrone DM (WHO dunnit / rtx_pinball, 2026-04-27).
     * Static + isolated so the selection contract is regression-testable.
     */
    static async findLocalGameForIscoredId(db: any, iscoredId: string, roomIds: string[]): Promise<any> {
        if (roomIds.length === 0) return undefined;
        const placeholders = roomIds.map(() => '?').join(', ');
        return db.get(
            // ADR 0016 P2 §3a: the JOIN is deliberately an INNER JOIN. Pinned
            // rows (`games.tournament_id IS NULL`) must never be reachable from
            // the poller — sync applies to tournament games only. Locked by
            // test in `iscored-provenance.test.ts`; do not relax to LEFT JOIN.
            //
            // ADR 0016 P2 §3b: `t.iscored_default_engine` / `_device` are NOT
            // selected. Synced scores are always unknown/unknown — no inference.
            `SELECT g.id, g.tournament_id, g.name, t.game_room_id,
                    t.iscored_default_platform AS platform
             FROM games g
             JOIN tournaments t ON t.id = g.tournament_id
             WHERE g.iscored_id = ? AND t.game_room_id IN (${placeholders})
             ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 WHEN 'COMPLETED' THEN 1 ELSE 2 END,
                      g.created_at DESC
             LIMIT 1`,
            iscoredId, ...roomIds,
        );
    }

    private async pollOneAccount(
        db: any,
        creds: { username: string; password: string; publicUrl: string; gameroomName: string; source: 'room' | 'env' },
        roomIds: string[],
        mappingMap: Map<string, string>,
        aliasMap: Map<string, string>,
        changedGameIds: Set<string>,
        autoLinkChecked: Set<string> = new Set(),
    ): Promise<void> {
        const apiClient = new IScoredApiClient({ gameroomName: creds.gameroomName });
        const rawResponse = await apiClient.getAllScores();

        if (this.consecutiveErrors > 0 || !this._lastPollSucceeded) {
            logInfo(`ScoreSyncPoller[${creds.gameroomName}]: API returned ${Array.isArray(rawResponse) ? rawResponse.length : '?'} entries`);
        }

        const allScores = normalizeIScoredScoreResponse(rawResponse, {
            context: 'ScoreSyncPoller',
            logTotals: this._pollCount === 0,
        });

        if (roomIds.length === 0) return; // defensive; should not happen

        // Exact-match auto-link, BEFORE the write loop, so a name that resolves
        // to an account attributes THIS cycle's score rather than landing as
        // `iscored:<name>` and waiting for the next sync (owner ruling,
        // 2026-08-20). It mutates `mappingMap` in place — the same map the write
        // loop reads two lines down, and the same one shared by every account
        // that syncs in this cycle.
        await this.autoLinkUnmappedNames(db, allScores, mappingMap, aliasMap, autoLinkChecked, roomIds);

        for (const gameData of allScores) {
            if (!gameData.GameID || !gameData.scores) continue;

            // Scope to rooms sharing this account and pick the ACTIVE row
            // deterministically when a legacy COMPLETED row shares the
            // iscored_id (the iscored_default_platform fallback stamp rides
            // along). Extracted to findLocalGameForIscoredId so the
            // row-selection contract is regression-locked (v2.7.2 duplicate-DM).
            const localGame = await ScoreSyncPoller.findLocalGameForIscoredId(db, gameData.GameID, roomIds);
            if (!localGame) continue;

            const existingRows = await db.all(
                'SELECT id, score, discord_user_id FROM submissions WHERE game_id = ?',
                localGame.id,
            );
            const existingMap = new Map<string, { score: number; discord_user_id: string }>();
            for (const r of existingRows) {
                existingMap.set(r.id, { score: r.score, discord_user_id: r.discord_user_id });
            }

            // Tombstones from admin/player deletes. iScored has no per-score
            // delete API so the score is still on iScored — this table tells
            // us "don't re-import anything <= the suppressed value." A new
            // higher score (legit re-submit) still flows through.
            const suppressionRows = await db.all(
                'SELECT iscored_username_lower, suppressed_score FROM deleted_score_suppressions WHERE game_id = ?',
                localGame.id,
            );
            const suppressionMap = new Map<string, number>();
            for (const r of suppressionRows) {
                suppressionMap.set(r.iscored_username_lower, r.suppressed_score);
            }

            for (const score of gameData.scores) {
                const scoreValue = parseInt(String(score.score).replace(/[^0-9-]/g, ''), 10);
                if (isNaN(scoreValue)) continue;

                const resolvedName = aliasMap.get(score.name.toLowerCase()) || score.name;
                const syncId = `${localGame.id}-${resolvedName.toLowerCase()}`;
                const existing = existingMap.get(syncId);

                // Skip if the deletion tombstone covers this score. Match by
                // both the original iScored name AND the post-alias resolved
                // name so suppression survives later /map-user mappings.
                const suppressed = suppressionMap.get(resolvedName.toLowerCase())
                    ?? suppressionMap.get(score.name.toLowerCase());
                if (suppressed !== undefined && scoreValue <= suppressed) continue;

                if (!existing || scoreValue > existing.score) {
                    const discordUserId = mappingMap.get(resolvedName.toLowerCase()) || mappingMap.get(score.name.toLowerCase()) || `iscored:${resolvedName}`;

                    const submittedByUserId = normalizeSubmitterUserId(
                        discordUserId.startsWith('iscored:') ? null : discordUserId,
                    );
                    const submittedByAnonymousName = submittedByUserId ? null : resolvedName;
                    // ADR 0016 P2 §3b — NO INFERENCE, EVER. iScored exposes no
                    // per-score provenance, and the product owner ruled
                    // (2026-07-31) that none may be inferred: iScored is a
                    // migration stopgap, so inference machinery would invest in
                    // a path the product intends to retire. Synced scores are
                    // ALWAYS unknown/unknown — not derived from tournament
                    // rules, not from `tournaments.iscored_default_engine`
                    // /`_device` (now vestigial), not from anything. A player
                    // who wants provenance enters the score in Arcaid.
                    const syncEngine = UNKNOWN;
                    const syncDevice = UNKNOWN;
                    await db.run(`
                        INSERT INTO submissions (
                            id, game_id, iscored_username, score, timestamp, discord_user_id,
                            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                            submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                            engine, device
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            score = excluded.score,
                            discord_user_id = excluded.discord_user_id,
                            iscored_username = excluded.iscored_username,
                            platform = COALESCE(excluded.platform, submissions.platform),
                            -- v2.53.0: COALESCE-preserve on both new columns, so a
                            -- re-sync never blanks provenance a player supplied.
                            -- NULLIF strips the sync path's 'unknown' placeholder
                            -- first (COALESCE alone would treat it as a real value
                            -- and clobber a concrete engine); the trailing literal
                            -- keeps the column non-NULL when nothing is known.
                            engine = COALESCE(NULLIF(excluded.engine, 'unknown'), submissions.engine, 'unknown'),
                            device = COALESCE(NULLIF(excluded.device, 'unknown'), submissions.device, 'unknown')
                    `, syncId, localGame.id, resolvedName, scoreValue, new Date().toISOString(), discordUserId,
                        localGame.game_room_id || null, localGame.tournament_id || null,
                        submittedByUserId, submittedByAnonymousName, localGame.platform ?? null,
                        syncEngine, syncDevice);

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
                                platform: localGame.platform ?? null,
                                engine: syncEngine,
                                device: syncDevice,
                            });

                            trackBackground(
                                import('../services/LobbyFeedGenerator.js')
                                    .then(({ LobbyFeedGenerator }) => LobbyFeedGenerator.onScoreSubmitted({
                                        gameRoomId: localGame.game_room_id, gameName: localGame.name,
                                        username: resolvedName, score: scoreValue,
                                        discordUserId, source: 'sync',
                                    }))
                                    .catch(() => {}),
                            );

                            // ADR 0016 P2 §3c — NO GLOBAL FAN-OUT FROM SYNC.
                            // The `GlobalScoreService.fanOutFromRoomSubmission`
                            // call (and its `emitScoreNewGlobal` follow-up) that
                            // used to live here is deliberately gone: a synced
                            // score carries no provenance, so it can never earn
                            // a place on the cross-room board. Synced scores
                            // stay fully visible on room leaderboards and in
                            // tournament standings. The invariant is ALSO
                            // enforced inside the service (it rejects
                            // `source: 'sync'`), so re-adding a call here would
                            // be a no-op rather than a regression. Do not
                            // restore it.
                        } catch {}
                    }
                }
            }
        }
    }

    /**
     * Auto-link the iScored names in this payload that nobody has claimed but
     * that exactly match an Arcaid account's username or display name.
     *
     * SHAPE, and why. One batched `user_profiles` lookup per cycle over the
     * DISTINCT unmapped names seen — never a per-score query — with the
     * cycle-wide `autoLinkChecked` set caching negatives so a board of
     * permanently-unclaimed names costs nothing after the first look. Names that
     * link are written straight into `mappingMap`, which is exactly what the
     * write loop consults, so the very score that surfaced the name gets
     * `submitted_by_user_id` on its first insert.
     *
     * Candidates are restricted to MEMBERS of the rooms this account serves —
     * an iScored name on this board must not attach to an unrelated Arcaid user
     * who happens to share the string. See `candidateOwnersForNames`.
     *
     * The decision itself is NOT made here: `IdentityAutoLinkService.autoLinkName`
     * routes through `IdentityClaimService.claim`, so the alias cap, the
     * one-name-one-account rule, the pending-claim guard and the audit row all
     * come from P1. This method only decides WHICH names to offer it.
     *
     * Fully swallowed. A poll that failed because of an identity nicety would
     * stop score sync for the whole account.
     */
    private async autoLinkUnmappedNames(
        db: any,
        allScores: Array<{ scores?: Array<{ name: string }> }>,
        mappingMap: Map<string, string>,
        aliasMap: Map<string, string>,
        autoLinkChecked: Set<string>,
        roomIds: string[],
    ): Promise<void> {
        try {
            // Review-routing room for the audit row. An auto-approved claim needs
            // no queue, so any room this account serves is honest context.
            const roomId = roomIds[0] ?? null;
            if (!(await IdentityAutoLinkService.isEnabled(roomId))) return;

            const unmapped = new Map<string, string>();  // lower key -> stored casing
            for (const gameData of allScores) {
                for (const score of gameData.scores ?? []) {
                    if (!score?.name) continue;
                    const resolved = aliasMap.get(score.name.toLowerCase()) || score.name;
                    const key = resolved.trim().toLowerCase();
                    if (!key || mappingMap.has(key) || autoLinkChecked.has(key)) continue;
                    unmapped.set(key, resolved.trim());
                }
            }
            if (unmapped.size === 0) return;
            for (const key of unmapped.keys()) autoLinkChecked.add(key);

            const owners = await IdentityAutoLinkService.candidateOwnersForNames(db, Array.from(unmapped.keys()), roomIds);
            for (const [key, userId] of owners) {
                const name = unmapped.get(key)!;
                if (await IdentityAutoLinkService.autoLinkName(userId, roomId, name)) {
                    mappingMap.set(key, userId);
                    logInfo(`ScoreSyncPoller: auto-linked "${name}" -> ${userId} (exact match on an Arcaid account name).`);
                }
            }
        } catch (err) {
            logWarn('ScoreSyncPoller: exact-match auto-link pass failed (sync continues):', err);
        }
    }
}

