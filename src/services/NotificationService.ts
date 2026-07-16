import { getDatabase } from '../database/database.js';
import { sendDirectMessage } from '../utils/discord.js';
import { logError, logInfo } from '../utils/logger.js';
import { PickAwardGate } from './PickAwardGate.js';
import { SettingsService } from './SettingsService.js';
import { WebPushService, type WebPushPayload } from './WebPushService.js';

/** Notification preference keys — all default to false (opt-in only). */
export interface NotificationPrefs {
    tournamentWin: boolean;
    turnToPick: boolean;
    tournamentStarting: boolean;
    rankDethroned: boolean;
    friendScore: boolean;
}

export type NotificationType = keyof NotificationPrefs;

/** The five per-type opt-in keys — the ONLY keys external writers may set. */
export const PREF_TYPE_KEYS: readonly NotificationType[] = [
    'tournamentWin',
    'turnToPick',
    'tournamentStarting',
    'rankDethroned',
    'friendScore',
];

/**
 * High-value retention types. These draw from an INDEPENDENT rate-limit budget
 * from the "chatty" types (turnToPick/friendScore/tournamentStarting) so a flood
 * of cosmetic DMs can never starve a dethrone/win notification — and they are
 * the only two types eligible for the `NOTIFY_HIGH_VALUE_DEFAULT_ON` flag flip.
 */
const HIGH_VALUE_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
    'rankDethroned',
    'tournamentWin',
]);

type NotifClass = 'high' | 'chatty';
function classOf(type: NotificationType): NotifClass {
    return HIGH_VALUE_TYPES.has(type) ? 'high' : 'chatty';
}

/**
 * Types eligible for the browser web-push channel (S15). Smallest shippable
 * per the sprint plan: the two high-value retention types only. Kept as a
 * separate set from HIGH_VALUE_TYPES — today the members coincide, but the
 * flag-default semantics and the push channel are independent concepts.
 */
const WEB_PUSH_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
    'rankDethroned',
    'tournamentWin',
]);

/** Notification-tray titles per push-eligible type; body carries the detail. */
const PUSH_TITLES: Partial<Record<NotificationType, string>> = {
    tournamentWin: '\u{1F3C6} You won the tournament!',
    rankDethroned: '\u{1F451} You’ve been dethroned!',
};

/**
 * Reduce a Discord-markdown DM message to a push notification body: strip
 * bold/code markers and drop everything past the first line (deep links ride
 * the payload's `url` field, not the text).
 */
function toPushBody(message: string): string {
    const firstLine = message.replace(/\*\*/g, '').replace(/`/g, '').split('\n')[0] ?? '';
    return firstLine.trim();
}

/**
 * Global SettingsService key. When `'true'`, the two HIGH_VALUE types
 * (rankDethroned, tournamentWin) are treated as opted-IN by default for any
 * Discord-linked user who has NOT set an explicit pref for that type. Ships with
 * NO seed row → resolves OFF → fully inert on deploy. An explicit user pref
 * (true OR false) ALWAYS wins over this default. Rollback = set to 'false'.
 */
export const NOTIFY_HIGH_VALUE_DEFAULT_ON = 'NOTIFY_HIGH_VALUE_DEFAULT_ON';

/** Marker key written into a user's notification_prefs JSON after the first
 * flag-defaulted DM, so the "manage these notifications" footer appends once. */
const HV_FOOTER_MARKER = '_hvFooterShown';

const HV_FOOTER_TEXT = '\n\n_You can manage these notifications via /arcaid-notifications or Account Settings._';

interface NotifyParams {
    userId: string;
    type: NotificationType;
    message: string;
    /**
     * Game room the event originated in. When supplied, the per-room
     * DISCORD_ENABLED gate applies to EVERY room-originating event (not just
     * `turnToPick`): a room with DISCORD_ENABLED=false suppresses the DM the
     * same way it silences announcements and command responses. Legacy
     * single-room callers may omit it (the gate is skipped when absent).
     */
    roomId?: string | null;
    /** Used by the pick-award gate defense-in-depth check (turnToPick only). */
    tournamentId?: string | null;
    /**
     * Deep link opened when the user clicks the web-push notification (S15).
     * Only consulted for WEB_PUSH_TYPES; the Discord DM already embeds its
     * link inside `message`. Falls back to the app root when absent.
     */
    pushUrl?: string;
}

/** In-memory rate limit bucket per (user, class). */
interface RateBucket {
    count: number;
    resetAt: number;
}

// Separate budgets per notification class so high-value (retention) DMs cannot
// be starved by chatty (cosmetic) ones. Keyed `${userId}:${class}`.
const RATE_LIMIT_HIGH = 5;      // max high-value DMs per user per window
const RATE_LIMIT_CHATTY = 5;    // max chatty DMs per user per window
const RATE_WINDOW_MS = 3600000; // 1 hour
const rateBuckets = new Map<string, RateBucket>();

// Tiny TTL cache for the global default-on flag — reading SettingsService on
// every notify() is a settings-table hit. Mirrors PickAwardGate's pattern.
let flagCache: { value: boolean; ts: number } | null = null;
const FLAG_TTL_MS = 10_000;

export class NotificationService {
    /**
     * Send a Discord DM notification if the user has opted in and is within rate limits.
     * Fire-and-forget — never throws.
     *
     * `roomId` (when supplied) drives the per-room DISCORD_ENABLED gate for ALL
     * room-originating events — future callers should pass it.
     */
    static async notify(params: NotifyParams): Promise<boolean> {
        try {
            const { userId, type, message, roomId, tournamentId } = params;
            if (!userId || !process.env.DISCORD_BOT_TOKEN) return false;

            // 0a. Per-room Discord gate — if roomId is supplied and the room
            // has DISCORD_ENABLED=false, suppress. Means disabling the toggle
            // stops outbound DMs for events originating in that room the same
            // way it silences announcements and command responses.
            if (roomId) {
                const { isDiscordEnabledForRoom } = await import('../utils/discord.js');
                const enabled = await isDiscordEnabledForRoom(roomId);
                if (!enabled) {
                    logInfo(`NotificationService: ${type} suppressed (DISCORD_ENABLED=false) for room ${roomId}`);
                    return false;
                }
            }

            // 0b. Pick-award gate defense-in-depth (plan §5) — callers passing roomId
            // for `turnToPick` get suppressed here too, even if the upstream gate was
            // missed. Callers without roomId fall through to prefs check (legacy).
            if (type === 'turnToPick' && roomId) {
                const pickEnabled = await PickAwardGate.isEnabled(roomId, tournamentId);
                if (!pickEnabled) {
                    logInfo(`NotificationService: turnToPick suppressed (pick-award gate off) for room ${roomId}`);
                    return false;
                }
            }

            // 1. Resolve effective opt-in. Stored prefs win; for the two
            // HIGH_VALUE types only, an UNSET pref may be defaulted-ON by the
            // global flag. An explicit pref (true OR false) ALWAYS overrides.
            const { prefs, explicitKeys, webPushOptIn } = await this.getPrefsWithExplicit(userId);
            let optedIn = prefs[type];
            let optedInByFlag = false;
            if (!optedIn && HIGH_VALUE_TYPES.has(type) && !explicitKeys.has(type)) {
                if (await this.highValueDefaultOn()) {
                    optedIn = true;
                    optedInByFlag = true;
                }
            }
            if (!optedIn) return false;

            // 2. Check rate limit (per-class budget)
            if (!this.checkRateLimit(userId, type)) {
                logInfo(`NotificationService: rate-limited DM to ${userId} (type: ${type}, class: ${classOf(type)})`);
                return false;
            }

            // 2b. Web push — second channel (S15). Rides the SAME opt-in +
            // rate-limit result as the DM (one event = one budget slot);
            // additionally gated on the user's webPush channel flag (set when
            // they subscribe a browser — see POST /me/push-subscriptions) and
            // the smallest-shippable type allowlist. Fire-and-forget: a push
            // failure never affects the DM path, and a closed-DMs failure
            // never suppresses the push. VAPID-unconfigured and
            // no-subscriptions cases no-op inside WebPushService.
            if (WEB_PUSH_TYPES.has(type) && webPushOptIn) {
                const payload: WebPushPayload = {
                    title: PUSH_TITLES[type] ?? 'ArcAid',
                    body: toPushBody(message),
                    url: params.pushUrl || (process.env.PUBLIC_URL || 'https://arcaid.app'),
                    tag: `arcaid-${type}`,
                };
                WebPushService.sendToUser(userId, payload).catch(() => {});
            }

            // 3. Compose message. Flag-defaulted sends get a one-time footer so
            // newly-opted-in users learn how to manage these DMs. Users who set
            // the pref explicitly already know — no footer for them.
            let body = message;
            let appendFooter = false;
            if (optedInByFlag && !explicitKeys.has(HV_FOOTER_MARKER)) {
                body += HV_FOOTER_TEXT;
                appendFooter = true;
            }

            // 4. Send DM
            const sent = await sendDirectMessage(userId, body);
            if (sent) {
                logInfo(`NotificationService: sent ${type} DM to ${userId}`);
                if (appendFooter) {
                    await this.markFooterShown(userId).catch(() => {});
                }
            }
            return sent;
        } catch (error) {
            logError('NotificationService.notify error:', error);
            return false;
        }
    }

    /**
     * Send notifications to multiple users. Each checked independently for prefs + rate limit.
     */
    static async notifyBulk(notifications: NotifyParams[]): Promise<void> {
        for (const n of notifications) {
            await this.notify(n);
        }
    }

    /**
     * Load notification preferences for a user. Returns all-false defaults if not set.
     */
    static async getPrefs(userId: string): Promise<NotificationPrefs> {
        const { prefs } = await this.getPrefsWithExplicit(userId);
        return prefs;
    }

    /**
     * Load prefs AND the set of keys explicitly present in the stored JSON.
     * The merged `prefs` object loses the "explicitly false" vs "absent"
     * distinction; `explicitKeys` preserves it so a flag default never
     * overrides an explicit user choice (true OR false).
     *
     * `webPushOptIn` is the channel flag (`webPush: true` in the same JSON,
     * written by POST /me/push-subscriptions) — deliberately NOT part of
     * NotificationPrefs, which models per-TYPE opt-ins.
     */
    private static async getPrefsWithExplicit(
        userId: string
    ): Promise<{ prefs: NotificationPrefs; explicitKeys: Set<string>; webPushOptIn: boolean }> {
        const defaults: NotificationPrefs = {
            tournamentWin: false,
            turnToPick: false,
            tournamentStarting: false,
            rankDethroned: false,
            friendScore: false,
        };
        try {
            const db = await getDatabase();
            const row = await db.get(
                'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
                userId
            );
            if (!row?.notification_prefs) {
                return { prefs: defaults, explicitKeys: new Set(), webPushOptIn: false };
            }
            const parsed = JSON.parse(row.notification_prefs);
            const explicitKeys = new Set<string>(Object.keys(parsed));
            return {
                prefs: { ...defaults, ...parsed },
                explicitKeys,
                webPushOptIn: parsed['webPush'] === true,
            };
        } catch {
            return { prefs: defaults, explicitKeys: new Set(), webPushOptIn: false };
        }
    }

    /**
     * Read the global high-value-default-on flag with a short TTL cache.
     * ON only when the stored value === 'true' (absent/null/'false' = OFF).
     */
    private static async highValueDefaultOn(): Promise<boolean> {
        const now = Date.now();
        if (flagCache && now - flagCache.ts < FLAG_TTL_MS) return flagCache.value;
        let value = false;
        try {
            value = (await SettingsService.get(NOTIFY_HIGH_VALUE_DEFAULT_ON)) === 'true';
        } catch {
            value = false;
        }
        flagCache = { value, ts: now };
        return value;
    }

    /** Invalidate the flag cache — call on write of NOTIFY_HIGH_VALUE_DEFAULT_ON. */
    static invalidateFlagCache(): void {
        flagCache = null;
    }

    /**
     * Merge `updates` into the user's stored notification_prefs JSON and
     * return the merged object. THE single write path for the prefs blob —
     * every writer (the PUT route, the /arcaid-notifications command, the
     * push-subscribe flow, the footer marker) must go through here so
     * cross-feature keys (`webPush`, `_hvFooterShown`) survive each other's
     * writes. Never rebuild-and-replace the JSON wholesale.
     */
    static async mergePrefs(
        userId: string,
        updates: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
            userId
        );
        let parsed: Record<string, unknown> = {};
        if (row?.notification_prefs) {
            try { parsed = JSON.parse(row.notification_prefs); } catch { parsed = {}; }
        }
        const merged = { ...parsed, ...updates };
        // UPSERT so a user with no prior row still gets one.
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, notification_prefs)
             VALUES (?, ?)
             ON CONFLICT(discord_user_id) DO UPDATE SET notification_prefs = excluded.notification_prefs`,
            userId, JSON.stringify(merged)
        );
        return merged;
    }

    /**
     * Extract ONLY the five typed opt-in booleans from an untrusted body —
     * unknown keys and non-boolean values are dropped, so a caller-supplied
     * object can never set (or clobber) channel flags or internal markers.
     */
    static typedPrefUpdates(body: unknown): Partial<Record<NotificationType, boolean>> {
        const out: Partial<Record<NotificationType, boolean>> = {};
        if (body && typeof body === 'object') {
            for (const key of PREF_TYPE_KEYS) {
                const value = (body as Record<string, unknown>)[key];
                if (typeof value === 'boolean') out[key] = value;
            }
        }
        return out;
    }

    /**
     * Record that the one-time flag-default footer has been shown to this user,
     * by writing the `_hvFooterShown` marker into their notification_prefs JSON.
     */
    private static async markFooterShown(userId: string): Promise<void> {
        await this.mergePrefs(userId, { [HV_FOOTER_MARKER]: true });
    }

    /**
     * Check (and consume) the rate limit for a user + notification class.
     * High-value and chatty types draw from INDEPENDENT budgets. Returns true
     * if under the limit for that class.
     */
    private static checkRateLimit(userId: string, type: NotificationType): boolean {
        const cls = classOf(type);
        const cap = cls === 'high' ? RATE_LIMIT_HIGH : RATE_LIMIT_CHATTY;
        const bucketKey = `${userId}:${cls}`;
        const now = Date.now();
        let bucket = rateBuckets.get(bucketKey);

        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
            rateBuckets.set(bucketKey, bucket);
        }

        if (bucket.count >= cap) return false;
        bucket.count++;
        return true;
    }

    /** Test-only: clear the in-memory rate buckets + flag cache between cases. */
    static _resetForTesting(): void {
        rateBuckets.clear();
        flagCache = null;
    }

    /**
     * Build a deep link URL for a room page.
     */
    static buildLink(roomSlug: string, path: string = ''): string {
        const base = process.env.PUBLIC_URL || 'https://arcaid.app';
        return `${base}/${roomSlug}${path}`;
    }
}
