import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';

// ---------------------------------------------------------------------------
// NotificationService — Google-id DM gating (v2.35.0 Google-login contract,
// D3.2). A google:<sub> userId must never reach sendDirectMessage (no DM
// channel exists for non-Discord identities), while web push still
// evaluates independently — same mocking pattern as s15-web-push.test.ts.
// ---------------------------------------------------------------------------

const sentDMs: Array<{ userId: string; content: string }> = [];

vi.mock('../utils/discord.js', () => ({
    sendDirectMessage: vi.fn(async (userId: string, content: string) => {
        sentDMs.push({ userId, content });
        return true;
    }),
    isDiscordEnabledForRoom: async () => true,
}));

vi.mock('web-push', () => ({
    default: {
        sendNotification: vi.fn(async () => ({ statusCode: 201, body: '', headers: {} })),
    },
}));

import { NotificationService } from '../services/NotificationService.js';
import { WebPushService } from '../services/WebPushService.js';

async function setPrefs(discordUserId: string, prefs: Record<string, unknown>) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_preferences (discord_user_id, notification_prefs)
         VALUES (?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET notification_prefs = excluded.notification_prefs`,
        discordUserId, JSON.stringify(prefs)
    );
}

async function seedVapid() {
    const db = await getDatabase();
    await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('WEB_PUSH_VAPID_PUBLIC_KEY', 'test-public-key')`);
    await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('WEB_PUSH_VAPID_PRIVATE_KEY', 'test-private-key')`);
    WebPushService._resetForTesting();
}

async function seedSubscription(discordUserId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO push_subscriptions (discord_user_id, endpoint, p256dh, auth)
         VALUES (?, ?, 'key-p256dh', 'key-auth')`,
        discordUserId, `https://push.example/${discordUserId}`,
    );
}

async function settle(ms = 75) {
    await new Promise((r) => setTimeout(r, ms));
}

beforeEach(async () => {
    await setupTestDb();
    sentDMs.length = 0;
    NotificationService._resetForTesting();
    WebPushService._resetForTesting();
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    delete process.env.SECRETS_KEY;
    vi.clearAllMocks();
});

afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.SECRETS_KEY;
    NotificationService._resetForTesting();
    WebPushService._resetForTesting();
});

describe('NotificationService — google-id user', () => {
    it('never attempts a DM for a google:<sub> userId', async () => {
        const googleId = 'google:notif-test-1';
        await setPrefs(googleId, { rankDethroned: true });

        const delivered = await NotificationService.notify({
            userId: googleId,
            type: 'rankDethroned',
            message: 'You were dethroned!',
        });

        expect(sentDMs.length).toBe(0);
        // No push configured/subscribed in this case, so nothing at all is
        // delivered — but critically, no DM was attempted (the assertion above).
        expect(delivered).toBe(false);
    });

    it('still delivers web push to a google:<sub> userId when subscribed + opted in', async () => {
        await seedVapid();
        const googleId = 'google:notif-test-2';
        await setPrefs(googleId, { rankDethroned: true, webPush: true });
        await seedSubscription(googleId);

        const delivered = await NotificationService.notify({
            userId: googleId,
            type: 'rankDethroned',
            message: 'You were dethroned!',
        });

        expect(sentDMs.length).toBe(0);
        expect(delivered).toBe(true);
        await settle();
    });

    it('a discord snowflake userId still gets a DM (unchanged behavior)', async () => {
        const discordId = '123456789012345678';
        await setPrefs(discordId, { rankDethroned: true });

        const delivered = await NotificationService.notify({
            userId: discordId,
            type: 'rankDethroned',
            message: 'You were dethroned!',
        });

        expect(sentDMs.length).toBe(1);
        expect(sentDMs[0]!.userId).toBe(discordId);
        expect(delivered).toBe(true);
    });
});
