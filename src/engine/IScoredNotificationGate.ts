import { logInfo, logWarn, logDebug } from '../utils/logger.js';

const DEFAULT_BACKSTOP_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_DISCOVERY_RETRY_MS = 10 * 60 * 1000; // 10 minutes

interface AccountState {
    /** Numeric iScored room ID (e.g. "1784"), null if discovery has not yet succeeded. */
    roomId: string | null;
    /** Wall-clock ms of the last discovery attempt — used to back off retries when discovery fails. */
    lastDiscoveryAt: number;
    /** Last seen body of the notification .txt file (trimmed). */
    lastNotifValue: string | null;
    /** Wall-clock ms of the last full sync — used for the backstop interval. */
    lastSyncAt: number;
    /** Has a "discovery failed" warning already been logged? Avoids spamming the warn line every backstop tick. */
    warnedOnDiscovery: boolean;
}

export interface SyncDecision {
    run: boolean;
    /** Reason code, for debug logging only. Stable strings used by tests. */
    reason:
        | 'first'
        | 'changed'
        | 'backstop'
        | 'unchanged'
        | 'no-room-id'
        | 'no-room-id-backstop'
        | 'notif-fetch-failed'
        | 'notif-fetch-failed-backstop';
}

/**
 * Gates `ScoreSyncPoller` full-sync calls behind iScored's per-room notification
 * file. iScored exposes a small static .txt at
 *   https://iscored.info/notifications/rooms/room_<roomID>.txt
 * whose body changes whenever a score is added (or other room events fire).
 * Polling that file is cheap (static text, no DB touch); polling
 * `getAllScores` is not. The gate fetches the .txt every tick and only lets
 * a full sync through when the body has actually changed — plus a backstop
 * interval so we still catch up if the notification file ever stalls.
 *
 * iScored email exchange (2026-04-29, Daniel Reynolds → Justin Mekelburg)
 * suggested polling at 10–15s. We tick at 10s with a 10 min backstop.
 *
 * Numeric room ID discovery uses iScored's own gameroom UI endpoint:
 *   https://iscored.info/roomCommands.php?c=getRoomInfo&user=<slug>
 * which is what the public room iframe queries on every page load. It's not
 * documented under iscored.info/api, so we treat it as best-effort: a
 * discovery failure logs a one-time warning and degrades the account to
 * backstop-only polling. `ISCORED_ROOM_ID` env var overrides discovery for
 * the env-fallback iScored account (single-tenant break-glass).
 */
export class IScoredNotificationGate {
    private state = new Map<string, AccountState>();
    private backstopMs: number;
    private discoveryRetryMs: number;

    constructor(opts: { backstopMs?: number; discoveryRetryMs?: number } = {}) {
        const envBackstop = parseInt(process.env.ISCORED_API_POLL_BACKSTOP_MS || '', 10);
        this.backstopMs = opts.backstopMs ?? (Number.isFinite(envBackstop) && envBackstop > 0 ? envBackstop : DEFAULT_BACKSTOP_MS);
        this.discoveryRetryMs = opts.discoveryRetryMs ?? DEFAULT_DISCOVERY_RETRY_MS;
    }

    /**
     * Resolve the numeric iScored room ID for an account. Cached after first
     * success. Returns null when discovery fails AND the retry window has not
     * elapsed since the last attempt — caller treats that as "no notification
     * gate available" and drops to backstop polling.
     *
     * Env-fallback account only: `ISCORED_ROOM_ID` env wins over discovery.
     */
    async resolveRoomId(accountKey: string, gameroomSlug: string, isEnvAccount: boolean): Promise<string | null> {
        const existing = this.state.get(accountKey);
        if (existing?.roomId) return existing.roomId;
        if (existing && Date.now() - existing.lastDiscoveryAt < this.discoveryRetryMs) {
            return null;
        }

        let roomId: string | null = null;

        if (isEnvAccount && process.env.ISCORED_ROOM_ID) {
            roomId = process.env.ISCORED_ROOM_ID.trim() || null;
            if (roomId) {
                logInfo(`IScoredNotificationGate: using ISCORED_ROOM_ID=${roomId} from env for gameroom ${gameroomSlug}`);
            }
        }

        if (!roomId) {
            roomId = await this.discoverRoomId(gameroomSlug);
            if (roomId) {
                logInfo(`IScoredNotificationGate: discovered roomID=${roomId} for gameroom ${gameroomSlug}`);
            }
        }

        const next: AccountState = {
            roomId,
            lastDiscoveryAt: Date.now(),
            lastNotifValue: existing?.lastNotifValue ?? null,
            lastSyncAt: existing?.lastSyncAt ?? 0,
            warnedOnDiscovery: existing?.warnedOnDiscovery ?? false,
        };

        if (!roomId && !next.warnedOnDiscovery) {
            logWarn(
                `IScoredNotificationGate: could not determine iScored room ID for gameroom ${gameroomSlug} — ` +
                    `falling back to backstop polling at ${Math.round(this.backstopMs / 60000)} min intervals. ` +
                    `Set ISCORED_ROOM_ID env var to override.`,
            );
            next.warnedOnDiscovery = true;
        }

        this.state.set(accountKey, next);
        return roomId;
    }

    /**
     * Hits the public `roomCommands.php?c=getRoomInfo` endpoint, returns the
     * roomID string. Not under /api — discovered from the public gameroom
     * iframe's own JS. Could change without notice; treat any non-OK or
     * missing-field response as "discovery failed" and fall through to the
     * configured override.
     */
    private async discoverRoomId(gameroomSlug: string): Promise<string | null> {
        try {
            const url = `https://iscored.info/roomCommands.php?c=getRoomInfo&user=${encodeURIComponent(gameroomSlug)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) {
                logDebug(`IScoredNotificationGate: getRoomInfo for ${gameroomSlug} returned HTTP ${res.status}`);
                return null;
            }
            const text = await res.text();
            const data = JSON.parse(text);
            const raw = data?.roomID;
            if (raw === undefined || raw === null || raw === '') return null;
            return String(raw);
        } catch (err) {
            logDebug(`IScoredNotificationGate: getRoomInfo for ${gameroomSlug} failed: ${err instanceof Error ? err.message : err}`);
            return null;
        }
    }

    /** Fetch the per-room notification .txt body. Returns null on any error. */
    async fetchNotification(roomId: string): Promise<string | null> {
        try {
            // Cache-bust query string mirrors what iScored's own public
            // gameroom client sends (see room.php iframe ~line 22823).
            const url = `https://iscored.info/notifications/rooms/room_${encodeURIComponent(roomId)}.txt?t=${Math.random()}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return null;
            return (await res.text()).trim();
        } catch {
            return null;
        }
    }

    /**
     * Decide whether the caller should run a full sync for this account on
     * this tick. The reason field is for debug logging only.
     */
    shouldSync(accountKey: string, currentValue: string | null, hasRoomId: boolean): SyncDecision {
        const entry = this.state.get(accountKey);
        const now = Date.now();

        // Discovery failed (or env override missing for env account): we have
        // no cheap way to check for changes — fall back to backstop only.
        if (!hasRoomId) {
            if (!entry || now - entry.lastSyncAt >= this.backstopMs) {
                return { run: true, reason: 'no-room-id-backstop' };
            }
            return { run: false, reason: 'no-room-id' };
        }

        // First run after process start (or first run after we just resolved
        // the roomId): no cached value to compare against, run a full sync.
        if (!entry || entry.lastSyncAt === 0) {
            return { run: true, reason: 'first' };
        }

        // Notification fetch failed transiently — keep prior cache, run only
        // if backstop has elapsed.
        if (currentValue === null) {
            if (now - entry.lastSyncAt >= this.backstopMs) {
                return { run: true, reason: 'notif-fetch-failed-backstop' };
            }
            return { run: false, reason: 'notif-fetch-failed' };
        }

        if (currentValue !== entry.lastNotifValue) {
            return { run: true, reason: 'changed' };
        }

        if (now - entry.lastSyncAt >= this.backstopMs) {
            return { run: true, reason: 'backstop' };
        }

        return { run: false, reason: 'unchanged' };
    }

    /**
     * Record a successful full-sync. Caller passes the notification value
     * captured BEFORE the sync — that's the "we've now synced through this
     * marker" anchor. If the value was null (fetch failed), keep whatever
     * was cached so a subsequent successful fetch can compare meaningfully.
     */
    markSynced(accountKey: string, notifValue: string | null): void {
        const prev = this.state.get(accountKey);
        this.state.set(accountKey, {
            roomId: prev?.roomId ?? null,
            lastDiscoveryAt: prev?.lastDiscoveryAt ?? 0,
            lastNotifValue: notifValue ?? prev?.lastNotifValue ?? null,
            lastSyncAt: Date.now(),
            warnedOnDiscovery: prev?.warnedOnDiscovery ?? false,
        });
    }

    /** Test/reset hook. */
    reset(): void {
        this.state.clear();
    }

    /** Test hook — read-only snapshot of internal state for an account. */
    _peekState(accountKey: string): AccountState | undefined {
        const s = this.state.get(accountKey);
        return s ? { ...s } : undefined;
    }
}
