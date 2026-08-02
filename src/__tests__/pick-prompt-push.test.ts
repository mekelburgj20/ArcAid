import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { PickAwardGate } from '../services/PickAwardGate.js';
import {
    pickPromptPushBody,
    pickFallbackPhrase,
    formatPickRemaining,
    computePickDeadline,
} from '../utils/pickWindow.js';

// ---------------------------------------------------------------------------
// v2.70.0 — web push for `turnToPick`.
//
// `turnToPick` has been in WEB_PUSH_TYPES since D4, but nothing ever shaped a
// body for it: the tray got `toPushBody(message)`, i.e. the DM's first line,
// which opens by naming the game just won and leaves the deadline stranded in
// line two. A notification whose whole value is "act before the clock runs
// out" has to lead with the clock.
//
// What is asserted here:
//   • the engine's MANUAL-PICK branch (winner won, queue empty — the same
//     branch the lobby pick_prompt fires on) pushes to an opted-in winner;
//   • an opted-OUT winner gets nothing, i.e. the existing default-off opt-in
//     semantics still hold end to end, not just at the notify() unit level;
//   • the body's minutes are DERIVED FROM THE DEADLINE, so it reports what is
//     left rather than the configured window;
//   • the copy names the honest consequence — a winner window pivots to the
//     runner-up, it does not autopick.
//
// web-push is mocked to capture payloads. ../utils/discord.js is spread from
// the real module and only its DM/gate functions overridden, because
// TournamentEngine imports sendChannelEmbed/formatUserMention/etc. from it and
// a partial mock would break the engine's own import.
// ---------------------------------------------------------------------------

interface RecordedSend { body: string }
const pushSends: RecordedSend[] = [];

vi.mock('web-push', () => ({
    default: {
        sendNotification: vi.fn(async (_sub: unknown, body: string) => {
            pushSends.push({ body });
            return { statusCode: 201, body: '', headers: {} };
        }),
    },
}));

const sentDMs: Array<{ userId: string; content: string }> = [];

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        sendDirectMessage: vi.fn(async (userId: string, content: string) => {
            sentDMs.push({ userId, content });
            return true;
        }),
        isDiscordEnabledForRoom: async () => true,
        // The engine announces to a channel on this branch; there is no gateway
        // client in tests, so keep it an explicit no-op rather than relying on
        // the real one failing quietly.
        sendChannelEmbed: async () => undefined,
        sendChannelMessage: async () => undefined,
    };
});

import { NotificationService } from '../services/NotificationService.js';
import { WebPushService } from '../services/WebPushService.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

const WINNER = '555555555555555555';

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

async function setPrefs(discordUserId: string, prefs: Record<string, unknown>) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_preferences (discord_user_id, notification_prefs)
         VALUES (?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET notification_prefs = excluded.notification_prefs`,
        discordUserId, JSON.stringify(prefs),
    );
}

async function seedWinningSubmission(gameId: string, discordUserId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        `${gameId}-winner`, gameId, discordUserId, 'Winner', 99999, new Date().toISOString(),
    );
}

/** The dispatch is fire-and-forget — wait for it rather than assume. */
async function waitForPushCount(count: number) {
    await vi.waitFor(() => expect(pushSends.length).toBeGreaterThanOrEqual(count), { timeout: 3000 });
}

/** For NEGATIVE assertions: let the fire-and-forget chain settle first. */
async function settle(ms = 500) {
    await new Promise((r) => setTimeout(r, ms));
}

/** Drive the real rotation into the manual-pick branch. */
async function runManualPickBranch(slug: string, tournamentName: string) {
    const roomId = await createTestRoom(slug, slug);
    await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
    const tId = await createTestTournament(roomId, { name: tournamentName });
    const gameId = await createTestGame(tId, { name: `${tournamentName} Game`, status: 'ACTIVE' });
    await seedWinningSubmission(gameId, WINNER);
    await TournamentEngine.getInstance().runMaintenance(tId);
    return { roomId, tId };
}

beforeEach(async () => {
    await setupTestDb();
    pushSends.length = 0;
    sentDMs.length = 0;
    NotificationService._resetForTesting();
    WebPushService._resetForTesting();
    PickAwardGate.invalidate();
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    delete process.env.PUBLIC_URL;
    delete process.env.SECRETS_KEY;
    vi.clearAllMocks();
});

afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    NotificationService._resetForTesting();
});

describe('pickPromptPushBody — copy', () => {
    const deadline = new Date('2026-08-01T13:00:00.000Z');
    const now = new Date('2026-08-01T12:15:00.000Z');

    it('leads with the time left and names the honest consequence', () => {
        expect(pickPromptPushBody('Daily Grind', deadline, 'runner_up', now))
            .toBe('Daily Grind — 45 minutes before the runner-up gets the pick');
        expect(pickPromptPushBody('Daily Grind', deadline, 'autopick', now))
            .toBe('Daily Grind — 45 minutes before autopick');
    });

    it('derives the minutes from the deadline, not from the configured window', () => {
        // Same 60-minute window, composed 50 minutes in — the push must say 10,
        // which is what a player checking the clock would see.
        const designatedAt = new Date('2026-08-01T12:00:00.000Z');
        const late = new Date('2026-08-01T12:50:00.000Z');
        expect(pickPromptPushBody('DG', computePickDeadline(designatedAt, 60), 'runner_up', late))
            .toContain('10 minutes');
    });

    it('never renders a negative countdown for an already-closed window', () => {
        expect(pickPromptPushBody('DG', deadline, 'autopick', new Date('2026-08-01T14:00:00.000Z')))
            .toContain('less than a minute');
    });

    it('drops the tournament prefix when there is no name to give', () => {
        expect(pickPromptPushBody(null, deadline, 'autopick', now))
            .toBe('45 minutes before autopick');
    });

    it('matches the lobby countdown\'s formatting rules', () => {
        // Same rule as FeedItem.tsx's formatRemaining — the player sees both.
        expect(formatPickRemaining(30_000)).toBe('less than a minute');
        expect(formatPickRemaining(60_000)).toBe('1 minute');
        expect(formatPickRemaining(45 * 60_000)).toBe('45 minutes');
        expect(formatPickRemaining(60 * 60_000)).toBe('1h');
        expect(formatPickRemaining(80 * 60_000)).toBe('1h 20m');
    });

    it('phrases the two fallbacks the way the lobby does', () => {
        expect(pickFallbackPhrase('runner_up')).toBe('the runner-up gets the pick');
        expect(pickFallbackPhrase('autopick')).toBe('autopick');
    });
});

describe('turnToPick web push — engine manual-pick branch', () => {
    it('pushes to an opted-in winner, with deadline-derived minutes in the body', async () => {
        await seedVapid();
        await setPrefs(WINNER, { turnToPick: true, webPush: true });
        await seedSubscription(WINNER);

        await runManualPickBranch('pp-push-in', 'Push In T');

        await waitForPushCount(1);
        const payload = JSON.parse(pushSends[0]!.body);

        expect(payload.title).toContain('turn to pick');
        expect(payload.tag).toBe('arcaid-turnToPick');
        // Whole-body shape, because every part of it is load-bearing.
        //
        // Note the countdown is "59 minutes", NOT the configured 60: the body
        // is composed from the deadline a beat after the row is written, so it
        // reports what is left. That one-minute gap is the proof the value is
        // derived rather than echoed — an implementation that passed
        // `winnerPickWindowMin` through would read "1h" here forever, including
        // on a retry an hour later.
        expect(payload.body).toMatch(/^Push In T — (\d+ minutes|1h( \d+m)?) before the runner-up gets the pick$/);
        // The honest consequence: a WINNER window pivots to the runner-up.
        expect(payload.body).not.toContain('autopick');
    });

    it('pushes NOTHING to a winner who never opted in (default-off holds)', async () => {
        await seedVapid();
        // Subscription present but no prefs row at all — the S15 default is off,
        // and a subscribed browser is not itself an opt-in.
        await seedSubscription(WINNER);

        await runManualPickBranch('pp-push-out', 'Push Out T');

        await settle();
        expect(pushSends).toHaveLength(0);
    });

    it('pushes NOTHING when turnToPick is on but the webPush channel is off', async () => {
        await seedVapid();
        await setPrefs(WINNER, { turnToPick: true });
        await seedSubscription(WINNER);

        await runManualPickBranch('pp-push-nochan', 'Push NoChan T');

        await settle();
        expect(pushSends).toHaveLength(0);
        // The DM channel is unaffected by the push gate.
        expect(sentDMs.some(d => d.userId === WINNER)).toBe(true);
    });

    it('leaves the DM carrying the full message while the push stays compact', async () => {
        await seedVapid();
        await setPrefs(WINNER, { turnToPick: true, webPush: true });
        await seedSubscription(WINNER);

        await runManualPickBranch('pp-push-both', 'Push Both T');
        await waitForPushCount(1);

        const dm = sentDMs.find(d => d.userId === WINNER);
        expect(dm).toBeTruthy();
        // The DM still opens with the win — that context is useful in a chat
        // log and useless in a notification tray, which is the whole reason
        // `pushBody` exists rather than reusing the DM's first line.
        expect(dm!.content).toContain('You won');
        const payload = JSON.parse(pushSends[0]!.body);
        expect(payload.body).not.toContain('You won');
    });
});
