import { getDatabase } from '../database/database.js';
import { sendDirectMessage } from '../utils/discord.js';
import { logError, logInfo } from '../utils/logger.js';
import { PickAwardGate } from './PickAwardGate.js';

/** Notification preference keys — all default to false (opt-in only). */
export interface NotificationPrefs {
    tournamentWin: boolean;
    turnToPick: boolean;
    tournamentStarting: boolean;
    rankDethroned: boolean;
    friendScore: boolean;
}

export type NotificationType = keyof NotificationPrefs;

interface NotifyParams {
    userId: string;
    type: NotificationType;
    message: string;
    /** Required for `turnToPick` — used by the pick-award gate defense-in-depth check. */
    roomId?: string | null;
    tournamentId?: string | null;
}

/** In-memory rate limit bucket per user. */
interface RateBucket {
    count: number;
    resetAt: number;
}

const RATE_LIMIT = 5;          // max notifications per user per hour
const RATE_WINDOW_MS = 3600000; // 1 hour
const rateBuckets = new Map<string, RateBucket>();

export class NotificationService {
    /**
     * Send a Discord DM notification if the user has opted in and is within rate limits.
     * Fire-and-forget — never throws.
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

            // 1. Load user's notification_prefs
            const prefs = await this.getPrefs(userId);
            if (!prefs[type]) return false;

            // 2. Check rate limit
            if (!this.checkRateLimit(userId)) {
                logInfo(`NotificationService: rate-limited DM to ${userId} (type: ${type})`);
                return false;
            }

            // 3. Send DM
            const sent = await sendDirectMessage(userId, message);
            if (sent) {
                logInfo(`NotificationService: sent ${type} DM to ${userId}`);
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
            if (!row?.notification_prefs) return defaults;
            const parsed = JSON.parse(row.notification_prefs);
            return { ...defaults, ...parsed };
        } catch {
            return defaults;
        }
    }

    /**
     * Check (and consume) rate limit for a user. Returns true if under limit.
     */
    private static checkRateLimit(userId: string): boolean {
        const now = Date.now();
        let bucket = rateBuckets.get(userId);

        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
            rateBuckets.set(userId, bucket);
        }

        if (bucket.count >= RATE_LIMIT) return false;
        bucket.count++;
        return true;
    }

    /**
     * Build a deep link URL for a room page.
     */
    static buildLink(roomSlug: string, path: string = ''): string {
        const base = process.env.PUBLIC_URL || 'https://arcaid.app';
        return `${base}/${roomSlug}${path}`;
    }
}
