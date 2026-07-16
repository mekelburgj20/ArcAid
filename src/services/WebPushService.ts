import webpush from 'web-push';
import { getDatabase } from '../database/database.js';
import { SettingsService } from './SettingsService.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * Browser Web Push dispatch (S15). Second notification channel beside Discord
 * DMs — NotificationService.notify owns opt-in + rate limiting and calls
 * sendToUser only after those gates pass.
 *
 * VAPID keys live in global settings (WEB_PUSH_VAPID_PUBLIC_KEY +
 * WEB_PUSH_VAPID_PRIVATE_KEY — the private key is in ENCRYPTED_SETTING_KEYS,
 * AES-GCM at rest). Both unset → feature inert (the S10 OPS_ALERT ship-inert
 * pattern). Generate a pair with `npm run generate-vapid-keys` and paste both
 * values into the super-admin Global Settings page. Rotating the pair
 * invalidates every existing browser subscription.
 */

export const WEB_PUSH_VAPID_PUBLIC_KEY = 'WEB_PUSH_VAPID_PUBLIC_KEY';
export const WEB_PUSH_VAPID_PRIVATE_KEY = 'WEB_PUSH_VAPID_PRIVATE_KEY';

export interface WebPushPayload {
    title: string;
    body: string;
    /** Absolute URL opened by the SW notificationclick handler. */
    url?: string;
    /** Collapse key — same-tag notifications replace each other in the tray. */
    tag?: string;
}

interface VapidConfig {
    publicKey: string;
    privateKey: string;
    subject: string;
}

// Settings-read TTL cache (mirrors NotificationService's flagCache) — dispatch
// runs on engine hot paths; don't hit the settings table per send.
let vapidCache: { config: VapidConfig | null; ts: number } | null = null;
const VAPID_TTL_MS = 10_000;

// Dead-for-good endpoint statuses. 404/410 = gone per the Push API spec;
// 400/401/403 = malformed subscription or VAPID key mismatch (e.g. after a
// key rotation every pre-rotation row 403s forever) — retrying can never
// succeed, so prune rather than log an error per event per device forever.
const PRUNE_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 410]);

export class WebPushService {
    /** Plaintext public key, or null when push is not configured. */
    static async getPublicKey(): Promise<string | null> {
        const cfg = await this.getVapid();
        return cfg?.publicKey ?? null;
    }

    static async isConfigured(): Promise<boolean> {
        return (await this.getVapid()) !== null;
    }

    /**
     * Push `payload` to every subscription the user holds. Expired endpoints
     * (HTTP 404/410 from the push service) are pruned. Never throws.
     * Returns the delivered count.
     */
    static async sendToUser(discordUserId: string, payload: WebPushPayload): Promise<number> {
        try {
            const cfg = await this.getVapid();
            if (!cfg || !discordUserId) return 0;
            const db = await getDatabase();
            const subs = await db.all(
                'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE discord_user_id = ?',
                discordUserId
            );
            if (!subs.length) return 0;
            const body = JSON.stringify(payload);
            let delivered = 0;
            for (const sub of subs) {
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                        body,
                        { vapidDetails: cfg, TTL: 3600 }
                    );
                    delivered++;
                } catch (err) {
                    const status = (err as { statusCode?: number })?.statusCode;
                    if (status !== undefined && PRUNE_STATUSES.has(status)) {
                        // Endpoint dead for good (revoked/expired/key-mismatch) — prune the row.
                        try {
                            await db.run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
                            logInfo(`WebPushService: pruned dead subscription ${sub.id} for ${discordUserId} (HTTP ${status})`);
                        } catch { /* prune failure is non-fatal */ }
                    } else {
                        // Transient (5xx/429/network) — keep the row, retry on the next event.
                        logError(`WebPushService: send failed for ${discordUserId} (HTTP ${status ?? '?'}):`, err);
                    }
                }
            }
            return delivered;
        } catch (error) {
            logError('WebPushService.sendToUser error:', error);
            return 0;
        }
    }

    private static async getVapid(): Promise<VapidConfig | null> {
        const now = Date.now();
        if (vapidCache && now - vapidCache.ts < VAPID_TTL_MS) return vapidCache.config;
        let config: VapidConfig | null = null;
        try {
            const [publicKey, privateKey] = await Promise.all([
                SettingsService.get(WEB_PUSH_VAPID_PUBLIC_KEY),
                SettingsService.get(WEB_PUSH_VAPID_PRIVATE_KEY),
            ]);
            if (publicKey && privateKey) {
                // web-push requires a mailto: or https: subject for the VAPID JWT.
                const subject = process.env.PUBLIC_URL || 'https://arcaid.app';
                config = { publicKey, privateKey, subject };
            }
        } catch {
            config = null;
        }
        vapidCache = { config, ts: now };
        return config;
    }

    /** Test-only: clear the VAPID settings cache between cases. */
    static _resetForTesting(): void {
        vapidCache = null;
    }
}
