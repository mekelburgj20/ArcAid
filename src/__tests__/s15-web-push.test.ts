import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';

// ---------------------------------------------------------------------------
// S15 web-push dispatch-gating suite.
//
// Covers: the full happy path (opted-in + webPush flag + subscription +
// VAPID configured → payload shape, deep link, markdown-stripped body);
// every gate that must suppress the push (channel flag off, non-push type,
// type opt-out, VAPID unconfigured, shared rate limit); channel independence
// (a closed-DMs failure must not suppress the push); 404/410 endpoint
// pruning; the account-deletion purge of push_subscriptions; and the
// ENCRYPTED_SETTING_KEYS round-trip for the VAPID private key.
//
// web-push is mocked (no real push-service HTTP); ../utils/discord.js is
// mocked the same way s6-notifications.test.ts does.
// ---------------------------------------------------------------------------

interface RecordedSend {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    body: string;
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number };
}
const pushSends: RecordedSend[] = [];
let pushFailWith: number | null = null; // statusCode every send rejects with while set

vi.mock('web-push', () => ({
    default: {
        sendNotification: vi.fn(async (
            subscription: RecordedSend['subscription'],
            body: RecordedSend['body'],
            options: RecordedSend['options'],
        ) => {
            if (pushFailWith !== null) {
                const err = new Error(`push failed ${pushFailWith}`) as Error & { statusCode: number };
                err.statusCode = pushFailWith;
                throw err;
            }
            pushSends.push({ subscription, body, options });
            return { statusCode: 201, body: '', headers: {} };
        }),
    },
}));

const sentDMs: Array<{ userId: string; content: string }> = [];
let dmResult = true;
// D4 (standalone rooms, v2.32.0) — mutable per-test so the DISCORD_ENABLED
// gate can be exercised without a real game_room_settings row.
let discordEnabledForRoom = true;

vi.mock('../utils/discord.js', () => ({
    sendDirectMessage: vi.fn(async (userId: string, content: string) => {
        sentDMs.push({ userId, content });
        return dmResult;
    }),
    isDiscordEnabledForRoom: async () => discordEnabledForRoom,
}));

// Imported AFTER the mock declarations (hoisted by vitest, but keep it explicit).
import { NotificationService } from '../services/NotificationService.js';
import { WebPushService } from '../services/WebPushService.js';
import { AccountDeletionService } from '../services/AccountDeletionService.js';
import { SettingsService } from '../services/SettingsService.js';

// --- seed helpers ----------------------------------------------------------

async function setPrefs(discordUserId: string, prefs: Record<string, unknown>) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_preferences (discord_user_id, notification_prefs)
         VALUES (?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET notification_prefs = excluded.notification_prefs`,
        discordUserId, JSON.stringify(prefs)
    );
}

/** Plaintext settings rows — decodeValue passes legacy plaintext through for
 * encrypted keys, so the VAPID seed needs no SECRETS_KEY. */
async function seedVapid() {
    const db = await getDatabase();
    await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('WEB_PUSH_VAPID_PUBLIC_KEY', 'test-public-key')`);
    await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('WEB_PUSH_VAPID_PRIVATE_KEY', 'test-private-key')`);
    WebPushService._resetForTesting();
}

async function seedSubscription(discordUserId: string, endpoint?: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO push_subscriptions (discord_user_id, endpoint, p256dh, auth)
         VALUES (?, ?, 'key-p256dh', 'key-auth')`,
        discordUserId, endpoint ?? `https://push.example/${discordUserId}`
    );
}

/** notify() fires the push dispatch without awaiting it — wait for delivery. */
async function waitForPushCount(count: number) {
    await vi.waitFor(() => expect(pushSends.length).toBeGreaterThanOrEqual(count), { timeout: 2000 });
}

/** For NEGATIVE assertions: give the fire-and-forget dispatch time to land. */
async function settle(ms = 75) {
    await new Promise((r) => setTimeout(r, ms));
}

beforeEach(async () => {
    await setupTestDb();
    pushSends.length = 0;
    sentDMs.length = 0;
    pushFailWith = null;
    dmResult = true;
    discordEnabledForRoom = true;
    NotificationService._resetForTesting();
    WebPushService._resetForTesting();
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    delete process.env.PUBLIC_URL;
    delete process.env.SECRETS_KEY;
    vi.clearAllMocks();
});

afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.SECRETS_KEY;
    NotificationService._resetForTesting();
    WebPushService._resetForTesting();
});

// ===========================================================================
describe('web-push dispatch — happy path', () => {
    it('delivers a push beside the DM with title, stripped body, deep link, and tag', async () => {
        await seedVapid();
        await setPrefs('300000000000000001', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000001');

        const ok = await NotificationService.notify({
            userId: '300000000000000001',
            type: 'rankDethroned',
            message: `You've been dethroned on **WHO dunnit?**! Alice posted **123,456** (beating you by 1) to claim #1.\nhttps://arcaid.app/rtx/games/WHO%20dunnit%3F`,
            pushUrl: 'https://arcaid.app/rtx/games/WHO%20dunnit%3F',
        });

        expect(ok).toBe(true); // DM path unchanged
        expect(sentDMs).toHaveLength(1);
        await waitForPushCount(1);

        const send = pushSends[0];
        expect(send.subscription.endpoint).toBe('https://push.example/300000000000000001');
        expect(send.subscription.keys).toEqual({ p256dh: 'key-p256dh', auth: 'key-auth' });
        expect(send.options.vapidDetails.publicKey).toBe('test-public-key');
        expect(send.options.vapidDetails.privateKey).toBe('test-private-key');

        const payload = JSON.parse(send.body);
        expect(payload.title).toContain('dethroned');
        // Markdown stripped, link line dropped (the deep link rides `url`).
        expect(payload.body).toBe(`You've been dethroned on WHO dunnit?! Alice posted 123,456 (beating you by 1) to claim #1.`);
        expect(payload.url).toBe('https://arcaid.app/rtx/games/WHO%20dunnit%3F');
        expect(payload.tag).toBe('arcaid-rankDethroned');
    });

    it('falls back to the app root url when pushUrl is absent', async () => {
        await seedVapid();
        await setPrefs('300000000000000002', { tournamentWin: true, webPush: true });
        await seedSubscription('300000000000000002');

        await NotificationService.notify({
            userId: '300000000000000002',
            type: 'tournamentWin',
            message: 'Congrats! You won **Fire Mountain**!',
        });

        await waitForPushCount(1);
        const payload = JSON.parse(pushSends[0].body);
        expect(payload.url).toBe('https://arcaid.app');
        expect(payload.tag).toBe('arcaid-tournamentWin');
    });

    it('still delivers the push when the Discord DM fails (closed DMs)', async () => {
        dmResult = false;
        await seedVapid();
        await setPrefs('300000000000000003', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000003');

        const ok = await NotificationService.notify({
            userId: '300000000000000003',
            type: 'rankDethroned',
            message: 'You lost the top spot.',
        });

        expect(ok).toBe(false); // return value stays = DM outcome
        await waitForPushCount(1);
    });
});

// ===========================================================================
describe('web-push dispatch — gates', () => {
    it('does NOT push when the webPush channel flag is off (DM still sent)', async () => {
        await seedVapid();
        await setPrefs('300000000000000004', { rankDethroned: true });
        await seedSubscription('300000000000000004');

        const ok = await NotificationService.notify({
            userId: '300000000000000004', type: 'rankDethroned', message: 'm',
        });

        expect(ok).toBe(true);
        await settle();
        expect(pushSends).toHaveLength(0);
    });

    it('does NOT push for a type outside WEB_PUSH_TYPES (DM still sent)', async () => {
        await seedVapid();
        await setPrefs('300000000000000005', { friendScore: true, webPush: true });
        await seedSubscription('300000000000000005');

        const ok = await NotificationService.notify({
            userId: '300000000000000005', type: 'friendScore', message: 'm',
        });

        expect(ok).toBe(true);
        await settle();
        expect(pushSends).toHaveLength(0);
    });

    it('does NOT push (or DM) when the type opt-in is off — webPush alone is not an opt-in', async () => {
        await seedVapid();
        await setPrefs('300000000000000006', { webPush: true });
        await seedSubscription('300000000000000006');

        const ok = await NotificationService.notify({
            userId: '300000000000000006', type: 'rankDethroned', message: 'm',
        });

        expect(ok).toBe(false);
        await settle();
        expect(sentDMs).toHaveLength(0);
        expect(pushSends).toHaveLength(0);
    });

    it('no-ops without throwing when VAPID keys are not configured', async () => {
        await setPrefs('300000000000000007', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000007');

        const ok = await NotificationService.notify({
            userId: '300000000000000007', type: 'rankDethroned', message: 'm',
        });

        expect(ok).toBe(true); // DM unaffected
        await settle();
        expect(pushSends).toHaveLength(0);
    });

    it('shares the DM rate-limit budget — a rate-limited event sends neither channel', async () => {
        await seedVapid();
        await setPrefs('300000000000000008', { tournamentWin: true, rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000008');

        // Exhaust the high-value budget (5/window).
        for (let i = 0; i < 5; i++) {
            expect(await NotificationService.notify({
                userId: '300000000000000008', type: 'tournamentWin', message: `win ${i}`,
            })).toBe(true);
        }
        await waitForPushCount(5);

        // 6th high-value event: blocked → no DM and no push.
        const blocked = await NotificationService.notify({
            userId: '300000000000000008', type: 'rankDethroned', message: 'over budget',
        });
        expect(blocked).toBe(false);
        await settle();
        expect(pushSends).toHaveLength(5);
        expect(sentDMs).toHaveLength(5);
    });
});

// ===========================================================================
// D4 (standalone rooms, v2.32.0) — the two real notification bugs fixed for
// the standalone-room story: the DISCORD_ENABLED gate no longer suppresses
// web push, and turnToPick becomes push-eligible with a deep link.
describe('D4 — DISCORD_ENABLED gate no longer suppresses web push', () => {
    it('a Discord-disabled room still delivers the push; the DM is never attempted', async () => {
        discordEnabledForRoom = false;
        await seedVapid();
        await setPrefs('300000000000000009', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000009');

        const ok = await NotificationService.notify({
            userId: '300000000000000009',
            type: 'rankDethroned',
            message: 'You lost the top spot.',
            roomId: 'room-standalone-1',
        });

        // Pre-fix: the DISCORD_ENABLED early-return suppressed EVERYTHING,
        // including the push channel, and `ok` was always false here.
        expect(ok).toBe(true);
        expect(sentDMs).toHaveLength(0); // DM channel gated off — never attempted
        await waitForPushCount(1);
    });

    it('a Discord-enabled room is unaffected (DM still attempted normally)', async () => {
        discordEnabledForRoom = true;
        await seedVapid();
        await setPrefs('300000000000000010', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000010');

        const ok = await NotificationService.notify({
            userId: '300000000000000010', type: 'rankDethroned', message: 'm', roomId: 'room-connected-1',
        });

        expect(ok).toBe(true);
        expect(sentDMs).toHaveLength(1);
        await waitForPushCount(1);
    });
});

describe('D4 — turnToPick is web-push-eligible with a deep link', () => {
    it('delivers a push with title, correct tag, and the Picks-page deep link', async () => {
        await seedVapid();
        await setPrefs('300000000000000011', { turnToPick: true, webPush: true });
        await seedSubscription('300000000000000011');

        const ok = await NotificationService.notify({
            userId: '300000000000000011',
            type: 'turnToPick',
            message: `You won **Fire Mountain** — it's your turn to pick the next game.\nhttps://arcaid.app/rtx/picks`,
            pushUrl: 'https://arcaid.app/rtx/picks',
        });

        expect(ok).toBe(true);
        expect(sentDMs).toHaveLength(1);
        await waitForPushCount(1);

        const payload = JSON.parse(pushSends[0].body);
        expect(payload.title).toContain('turn to pick');
        expect(payload.url).toBe('https://arcaid.app/rtx/picks');
        expect(payload.tag).toBe('arcaid-turnToPick');
    });

    it('does NOT push when the webPush channel flag is off (DM still sent)', async () => {
        await seedVapid();
        await setPrefs('300000000000000012', { turnToPick: true });
        await seedSubscription('300000000000000012');

        const ok = await NotificationService.notify({
            userId: '300000000000000012', type: 'turnToPick', message: 'm',
        });

        expect(ok).toBe(true);
        await settle();
        expect(pushSends).toHaveLength(0);
    });
});

// ===========================================================================
describe('web-push subscription lifecycle', () => {
    it('prunes the subscription row when the push service returns 410 Gone', async () => {
        await seedVapid();
        await setPrefs('300000000000000013', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000013', 'https://push.example/expired');
        pushFailWith = 410;

        const ok = await NotificationService.notify({
            userId: '300000000000000013', type: 'rankDethroned', message: 'm',
        });
        expect(ok).toBe(true); // DM unaffected by the push failure

        const db = await getDatabase();
        await vi.waitFor(async () => {
            const row = await db.get(
                'SELECT COUNT(*) as c FROM push_subscriptions WHERE discord_user_id = ?', '300000000000000013');
            expect(row.c).toBe(0);
        }, { timeout: 2000 });
    });

    it('prunes the subscription row on 403 (VAPID key mismatch after rotation)', async () => {
        await seedVapid();
        await setPrefs('300000000000000015', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000015', 'https://push.example/rotated');
        pushFailWith = 403;

        await NotificationService.notify({
            userId: '300000000000000015', type: 'rankDethroned', message: 'm',
        });

        const db = await getDatabase();
        await vi.waitFor(async () => {
            const row = await db.get(
                'SELECT COUNT(*) as c FROM push_subscriptions WHERE discord_user_id = ?', '300000000000000015');
            expect(row.c).toBe(0);
        }, { timeout: 2000 });
    });

    it('keeps the subscription row on a non-410 send failure', async () => {
        await seedVapid();
        await setPrefs('300000000000000014', { rankDethroned: true, webPush: true });
        await seedSubscription('300000000000000014');
        pushFailWith = 500;

        await NotificationService.notify({
            userId: '300000000000000014', type: 'rankDethroned', message: 'm',
        });

        await settle(150);
        const db = await getDatabase();
        const row = await db.get(
            'SELECT COUNT(*) as c FROM push_subscriptions WHERE discord_user_id = ?', '300000000000000014');
        expect(row.c).toBe(1);
    });

    it('account deletion purges the user\'s push subscriptions and nobody else\'s', async () => {
        await seedSubscription('300000000000000016', 'https://push.example/del-a');
        await seedSubscription('300000000000000016', 'https://push.example/del-b');
        await seedSubscription('300000000000000017', 'https://push.example/keep');

        await AccountDeletionService.anonymizeUser('300000000000000016', { actor: 'self' });

        const db = await getDatabase();
        const gone = await db.get('SELECT COUNT(*) as c FROM push_subscriptions WHERE discord_user_id = ?', '300000000000000016');
        const kept = await db.get('SELECT COUNT(*) as c FROM push_subscriptions WHERE discord_user_id = ?', '300000000000000017');
        expect(gone.c).toBe(0);
        expect(kept.c).toBe(1);
    });
});

// ===========================================================================
describe('prefs single-writer merge (review findings 1 + 4)', () => {
    it('a bulk enable-all-shaped merge preserves the webPush flag and the footer marker', async () => {
        // Regression: /arcaid-notifications Enable-all used to rebuild the
        // JSON from only the 5 typed keys, silently wiping webPush.
        await setPrefs('300000000000000018', { rankDethroned: false, webPush: true, _hvFooterShown: true });

        await NotificationService.mergePrefs('300000000000000018', {
            tournamentWin: true, turnToPick: true, tournamentStarting: true,
            rankDethroned: true, friendScore: true,
        });

        const db = await getDatabase();
        const row = await db.get(
            'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?', '300000000000000018');
        const stored = JSON.parse(row.notification_prefs);
        expect(stored.webPush).toBe(true);
        expect(stored._hvFooterShown).toBe(true);
        expect(stored.rankDethroned).toBe(true);
        expect(stored.friendScore).toBe(true);
    });

    it('typedPrefUpdates drops unknown keys and non-boolean values', () => {
        const updates = NotificationService.typedPrefUpdates({
            tournamentWin: true,
            friendScore: 'yes',        // non-boolean → dropped
            webPush: false,            // channel flag → never settable via PUT
            _hvFooterShown: false,     // internal marker → never settable
            evil: true,                // unknown → dropped
        });
        expect(updates).toEqual({ tournamentWin: true });
    });

    it('a stale full-object PUT-shaped update cannot clobber webPush (allowlist path)', async () => {
        // Regression: a second tab's stale draft (loaded pre-subscribe, so no
        // webPush key) used to overwrite the JSON wholesale on Save.
        await setPrefs('300000000000000019', { rankDethroned: true, webPush: true });

        const staleDraft = { tournamentWin: false, turnToPick: false, tournamentStarting: false, rankDethroned: false, friendScore: true };
        const merged = await NotificationService.mergePrefs(
            '300000000000000019', NotificationService.typedPrefUpdates(staleDraft));

        expect(merged['webPush']).toBe(true);      // survived
        expect(merged['rankDethroned']).toBe(false); // explicit user choice applied
        expect(merged['friendScore']).toBe(true);
    });
});

// ===========================================================================
describe('VAPID private key at-rest encryption', () => {
    it('round-trips through the ENCRYPTED_SETTING_KEYS allowlist (ciphertext on disk, plaintext on read)', async () => {
        process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

        await SettingsService.saveMany({ WEB_PUSH_VAPID_PRIVATE_KEY: 'super-secret-private-key' });

        const db = await getDatabase();
        const raw = await db.get(`SELECT value FROM settings WHERE key = 'WEB_PUSH_VAPID_PRIVATE_KEY'`);
        expect(raw.value.startsWith('enc:v1:')).toBe(true);
        expect(await SettingsService.get('WEB_PUSH_VAPID_PRIVATE_KEY')).toBe('super-secret-private-key');
    });
});
