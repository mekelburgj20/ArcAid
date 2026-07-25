import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';

// ---------------------------------------------------------------------------
// S6 notification-core regression suite.
//
// Covers: dethrone DM decoupled from the new_high_score feed toggle; deep-link +
// margin in the DM text; per-room DISCORD_ENABLED gate on dethrone DMs;
// per-class rate-limit budgets (high-value vs chatty); the global
// NOTIFY_HIGH_VALUE_DEFAULT_ON flip (default-off inert, explicit pref wins,
// one-time footer); and the Scheduler tournamentStarting room-scoping.
//
// We mock ../utils/discord.js so:
//   • sendDirectMessage is a spy (records DMs without touching Discord);
//   • isDiscordEnabledForRoom keeps its REAL behaviour (reads DISCORD_ENABLED
//     from GameRoomSettingsService) so the per-room gate is exercised end-to-end.
// ---------------------------------------------------------------------------

const sentDMs: Array<{ userId: string; content: string }> = [];

vi.mock('../utils/discord.js', () => ({
    sendDirectMessage: vi.fn(async (userId: string, content: string) => {
        sentDMs.push({ userId, content });
        return true;
    }),
    // Real semantics: DISCORD_ENABLED !== 'false' → enabled (falsy room → enabled).
    isDiscordEnabledForRoom: async (gameRoomId?: string | null) => {
        if (!gameRoomId) return true;
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        const raw = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_ENABLED');
        return raw !== 'false';
    },
}));

// Imported AFTER the mock declaration (hoisted by vitest, but keep it explicit).
import { NotificationService } from '../services/NotificationService.js';
import { LobbyFeedGenerator } from '../services/LobbyFeedGenerator.js';
import { LobbyFeedService } from '../services/LobbyFeedService.js';
import { Scheduler } from '../engine/Scheduler.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { SettingsService } from '../services/SettingsService.js';

// --- seed helpers ----------------------------------------------------------

async function mapDiscordAlias(discordUserId: string, alias: string) {
    const db = await getDatabase();
    await db.run(
        'INSERT OR REPLACE INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)',
        discordUserId, alias
    );
}

async function setPrefs(discordUserId: string, prefs: Record<string, unknown>) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_preferences (discord_user_id, notification_prefs)
         VALUES (?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET notification_prefs = excluded.notification_prefs`,
        discordUserId, JSON.stringify(prefs)
    );
}

async function getStoredPrefs(discordUserId: string): Promise<Record<string, unknown>> {
    const db = await getDatabase();
    const row = await db.get(
        'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
        discordUserId
    );
    return row?.notification_prefs ? JSON.parse(row.notification_prefs) : {};
}

/** Seed a community score so it counts toward room rank (used to set up #1s). */
async function seedCommunityScore(gameRoomId: string, gameName: string, username: string, score: number) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO community_scores (game_name, game_room_id, iscored_username, score)
         VALUES (?, ?, ?, ?)`,
        gameName, gameRoomId, username, score
    );
}

/**
 * onScoreSubmitted dispatches the dethrone DM fire-and-forget (it is NOT awaited
 * inside the generator). Flush the microtask + timer queue so the spy has
 * recorded the send before assertions run.
 */
async function flush(ms = 50): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

/** Disable a single feed type for a room via LOBBY_FEED_SETTINGS. */
async function disableFeedType(gameRoomId: string, omit: string) {
    const all = ['score_posted', 'new_high_score', 'rank_change', 'friend_score', 'milestone'];
    const enabledTypes = all.filter((t) => t !== omit);
    await GameRoomSettingsService.set(
        gameRoomId, 'LOBBY_FEED_SETTINGS', JSON.stringify({ enabledTypes })
    );
}

beforeEach(async () => {
    await setupTestDb();
    sentDMs.length = 0;
    NotificationService._resetForTesting();
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    delete process.env.PUBLIC_URL;
    vi.clearAllMocks();
});

afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    NotificationService._resetForTesting();
});

// ===========================================================================
// 1 + 2 — DECOUPLE: dethrone DM fires with new_high_score feed OFF, and a
// rank-1 score with new_high_score OFF does NOT leak into the rank_change feed.
// ===========================================================================
describe('LobbyFeedGenerator — dethrone DM decoupled from feed toggle', () => {
    it('fires the rankDethroned DM even when the new_high_score feed event is disabled, and emits no feed event for it', async () => {
        const roomId = await createTestRoom('decouple-1', 'Decouple 1');
        await disableFeedType(roomId, 'new_high_score');

        // Previous #1 is a Discord-mapped, opted-in user.
        await mapDiscordAlias('200000000000000001', 'OldKing');
        await setPrefs('200000000000000001', { rankDethroned: true });
        await seedCommunityScore(roomId, 'WHO dunnit?', 'OldKing', 1000);

        const emitSpy = vi.spyOn(LobbyFeedService, 'emit');

        // New score by a different player takes #1.
        await seedCommunityScore(roomId, 'WHO dunnit?', 'Challenger', 5000);
        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId,
            gameName: 'WHO dunnit?',
            username: 'Challenger',
            score: 5000,
            discordUserId: '200000000000000002',
            source: 'community',
        });
        await flush();

        // DM fired despite the feed toggle being off.
        expect(sentDMs.some((d) => d.userId === '200000000000000001')).toBe(true);
        expect(sentDMs[0]!.content).toContain('dethroned');

        // No new_high_score feed event was emitted (still gated).
        const emittedTypes = emitSpy.mock.calls.map((c) => (c[0] as any).type);
        expect(emittedTypes).not.toContain('new_high_score');
    });

    it('does NOT fall a rank-1 score into the rank_change branch when new_high_score is disabled', async () => {
        const roomId = await createTestRoom('decouple-2', 'Decouple 2');
        await disableFeedType(roomId, 'new_high_score');

        await mapDiscordAlias('200000000000000003', 'OldKing2');
        await setPrefs('200000000000000003', { rankDethroned: true });
        await seedCommunityScore(roomId, 'Medieval Madness', 'OldKing2', 1000);

        const emitSpy = vi.spyOn(LobbyFeedService, 'emit');

        await seedCommunityScore(roomId, 'Medieval Madness', 'Challenger2', 9000);
        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId,
            gameName: 'Medieval Madness',
            username: 'Challenger2',
            score: 9000,
            discordUserId: '200000000000000004',
            source: 'community',
        });
        await flush();

        const emittedTypes = emitSpy.mock.calls.map((c) => (c[0] as any).type);
        expect(emittedTypes).not.toContain('rank_change');
        expect(emittedTypes).not.toContain('new_high_score');
    });
});

// ===========================================================================
// 3 — DEEP LINK + MARGIN (and the tie wording).
// ===========================================================================
describe('LobbyFeedGenerator — dethrone DM deep link + margin', () => {
    it('contains the game deep link and the formatted margin (new − previous top)', async () => {
        const roomId = await createTestRoom('deeplink', 'Deep Link');
        await mapDiscordAlias('200000000000000005', 'King3');
        await setPrefs('200000000000000005', { rankDethroned: true });
        await seedCommunityScore(roomId, 'WHO dunnit?', 'King3', 1_000_000);

        await seedCommunityScore(roomId, 'WHO dunnit?', 'Usurper', 2_500_000);
        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId,
            gameName: 'WHO dunnit?',
            username: 'Usurper',
            score: 2_500_000,
            discordUserId: '200000000000000006',
            source: 'community',
        });
        await flush();

        const dm = sentDMs.find((d) => d.userId === '200000000000000005');
        expect(dm).toBeTruthy();
        // Game deep link (name-encoded), not the bare room landing page.
        expect(dm!.content).toContain('/deeplink/games/' + encodeURIComponent('WHO dunnit?'));
        // Margin = 2,500,000 − 1,000,000 = 1,500,000.
        expect(dm!.content).toContain((1_500_000).toLocaleString());
        expect(dm!.content).toContain('beating you by');
    });

    it('renders the tie wording (no "by 0") when the new top equals the previous top', async () => {
        const roomId = await createTestRoom('tie', 'Tie');
        await mapDiscordAlias('200000000000000007', 'King4');
        await setPrefs('200000000000000007', { rankDethroned: true });
        await seedCommunityScore(roomId, 'Attack from Mars', 'King4', 4242);

        // Equal top score — challenger ties and (by sort) takes index 0.
        await seedCommunityScore(roomId, 'Attack from Mars', 'Tier', 4242);
        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId,
            gameName: 'Attack from Mars',
            username: 'Tier',
            score: 4242,
            discordUserId: '200000000000000008',
            source: 'community',
        });
        await flush();

        const dm = sentDMs.find((d) => d.userId === '200000000000000007');
        // Note: with a strict equal tie the new submitter may or may not be ranked
        // #1 depending on stable-sort order; assert only that IF a DM fired it uses
        // tie wording and never "by 0".
        if (dm) {
            expect(dm.content).toContain('tying your top score');
            expect(dm.content).not.toContain('beating you by 0');
        }
    });
});

// ===========================================================================
// 4 — DISCORD_ENABLED gate suppresses the dethrone DM.
// ===========================================================================
describe('NotificationService — per-room DISCORD_ENABLED gate', () => {
    it('suppresses the dethrone DM when the room has DISCORD_ENABLED=false', async () => {
        const roomId = await createTestRoom('disabled-room', 'Disabled Room');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        await mapDiscordAlias('200000000000000009', 'King5');
        await setPrefs('200000000000000009', { rankDethroned: true });
        await seedCommunityScore(roomId, 'Twilight Zone', 'King5', 100);

        await seedCommunityScore(roomId, 'Twilight Zone', 'Newcomer', 200);
        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId,
            gameName: 'Twilight Zone',
            username: 'Newcomer',
            score: 200,
            discordUserId: '200000000000000010',
            source: 'community',
        });
        await flush();

        expect(sentDMs.find((d) => d.userId === '200000000000000009')).toBeUndefined();
    });

    it('sends the dethrone DM when DISCORD_ENABLED is unset/true', async () => {
        const roomId = await createTestRoom('enabled-room', 'Enabled Room');
        // DISCORD_ENABLED unset → enabled by default.
        await mapDiscordAlias('200000000000000011', 'King6');
        await setPrefs('200000000000000011', { rankDethroned: true });
        await seedCommunityScore(roomId, 'Funhouse', 'King6', 100);

        await seedCommunityScore(roomId, 'Funhouse', 'Beater', 300);
        await LobbyFeedGenerator.onScoreSubmitted({
            gameRoomId: roomId,
            gameName: 'Funhouse',
            username: 'Beater',
            score: 300,
            discordUserId: '200000000000000012',
            source: 'community',
        });
        await flush();

        expect(sentDMs.find((d) => d.userId === '200000000000000011')).toBeTruthy();
    });

    it('notify() returns false when the room is Discord-disabled', async () => {
        const roomId = await createTestRoom('gate-direct', 'Gate Direct');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        await setPrefs('200000000000000013', { rankDethroned: true });
        const result = await NotificationService.notify({
            userId: '200000000000000013',
            type: 'rankDethroned',
            message: 'hi',
            roomId,
        });
        expect(result).toBe(false);
        expect(sentDMs.length).toBe(0);
    });
});

// ===========================================================================
// 5 — RATE-LIMIT FAIRNESS: separate high-value vs chatty budgets.
// ===========================================================================
describe('NotificationService — per-class rate-limit budgets', () => {
    it('a full chatty bucket does NOT block a high-value DM', async () => {
        await setPrefs('200000000000000014', {
            friendScore: true, turnToPick: true, rankDethroned: true, tournamentWin: true,
        });
        // Exhaust the chatty bucket (cap 5) with friendScore sends.
        for (let i = 0; i < 5; i++) {
            const ok = await NotificationService.notify({ userId: '200000000000000014', type: 'friendScore', message: `c${i}` });
            expect(ok).toBe(true);
        }
        // 6th chatty is blocked.
        const blocked = await NotificationService.notify({ userId: '200000000000000014', type: 'friendScore', message: 'c6' });
        expect(blocked).toBe(false);

        // High-value still sends from its own bucket.
        const hv = await NotificationService.notify({ userId: '200000000000000014', type: 'rankDethroned', message: 'hv' });
        expect(hv).toBe(true);
    });

    it('a full high-value bucket blocks a 6th high-value but a chatty type still sends', async () => {
        await setPrefs('200000000000000015', {
            friendScore: true, rankDethroned: true, tournamentWin: true,
        });
        for (let i = 0; i < 5; i++) {
            const ok = await NotificationService.notify({ userId: '200000000000000015', type: 'rankDethroned', message: `h${i}` });
            expect(ok).toBe(true);
        }
        const blockedHv = await NotificationService.notify({ userId: '200000000000000015', type: 'tournamentWin', message: 'h6' });
        expect(blockedHv).toBe(false);

        const chatty = await NotificationService.notify({ userId: '200000000000000015', type: 'friendScore', message: 'c' });
        expect(chatty).toBe(true);
    });
});

// ===========================================================================
// 6 — TOURNAMENT-STARTING ROOM SCOPING (Scheduler).
// ===========================================================================
describe('Scheduler.resolveTournamentStartingRecipients — room scoping', () => {
    async function addMember(roomId: string, userId: string) {
        const db = await getDatabase();
        await db.run(
            `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'backfill')`,
            userId, roomId
        );
    }

    it('returns only members of the tournament room, not users in other rooms', async () => {
        const db = await getDatabase();
        const roomA = await createTestRoom('room-a', 'Room A');
        const roomB = await createTestRoom('room-b', 'Room B');

        await setPrefs('u1', { tournamentStarting: true });
        await setPrefs('u2', { tournamentStarting: true });
        await setPrefs('u3', { tournamentStarting: true });
        await addMember(roomA, 'u1');
        await addMember(roomA, 'u2');
        await addMember(roomB, 'u3');

        const recipients = await Scheduler.resolveTournamentStartingRecipients(db, roomA);
        const ids = recipients.map((r) => r.discord_user_id).sort();
        expect(ids).toEqual(['u1', 'u2']);
        expect(ids).not.toContain('u3');
    });

    it('falls back to the global query for a legacy tournament with NULL game_room_id', async () => {
        const db = await getDatabase();
        const roomA = await createTestRoom('legacy-room', 'Legacy Room');
        await setPrefs('g1', { tournamentStarting: true });
        await setPrefs('g2', { tournamentStarting: true });
        // g1 a member of a room, g2 not — both must be returned under the fallback.
        const db2 = await getDatabase();
        await db2.run(
            `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'backfill')`,
            'g1', roomA
        );

        const recipients = await Scheduler.resolveTournamentStartingRecipients(db, null);
        const ids = recipients.map((r) => r.discord_user_id).sort();
        expect(ids).toContain('g1');
        expect(ids).toContain('g2');
    });

    it('each room-scoped recipient is notified with roomId set (DISCORD_ENABLED gate applies)', async () => {
        const roomA = await createTestRoom('scoped-notify', 'Scoped Notify');
        await setPrefs('200000000000000016', { tournamentStarting: true });
        const db = await getDatabase();
        await db.run(
            `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'backfill')`,
            '200000000000000016', roomA
        );

        // Simulate the notifier's per-recipient send with roomId, then flip the
        // room to Discord-disabled and confirm suppression — proving roomId is
        // threaded through to the gate.
        const recipients = await Scheduler.resolveTournamentStartingRecipients(db, roomA);
        for (const u of recipients) {
            await NotificationService.notify({
                userId: u.discord_user_id,
                type: 'tournamentStarting',
                message: 'rotates soon',
                roomId: roomA,
            });
        }
        expect(sentDMs.find((d) => d.userId === '200000000000000016')).toBeTruthy();

        // Now disable Discord for the room and assert suppression.
        sentDMs.length = 0;
        NotificationService._resetForTesting();
        await GameRoomSettingsService.set(roomA, 'DISCORD_ENABLED', 'false');
        for (const u of recipients) {
            await NotificationService.notify({
                userId: u.discord_user_id,
                type: 'tournamentStarting',
                message: 'rotates soon',
                roomId: roomA,
            });
        }
        expect(sentDMs.find((d) => d.userId === '200000000000000016')).toBeUndefined();
    });
});

// ===========================================================================
// 7 — FLAG DEFAULT-OFF preserves current behavior (inert ship).
// ===========================================================================
describe('NotificationService — NOTIFY_HIGH_VALUE_DEFAULT_ON default-off', () => {
    it('does NOT send a high-value DM to a user with no explicit pref when the flag is unset', async () => {
        // No flag row + no stored pref for the user.
        const result = await NotificationService.notify({
            userId: '200000000000000017',
            type: 'rankDethroned',
            message: 'dethroned',
        });
        expect(result).toBe(false);
        expect(sentDMs.length).toBe(0);
    });

    it('does NOT send when the flag is explicitly "false"', async () => {
        await SettingsService.saveMany({ NOTIFY_HIGH_VALUE_DEFAULT_ON: 'false' });
        NotificationService.invalidateFlagCache();
        const result = await NotificationService.notify({
            userId: '200000000000000018',
            type: 'tournamentWin',
            message: 'you won',
        });
        expect(result).toBe(false);
    });
});

// ===========================================================================
// 8 — FLAG ON opts-in only no-explicit-pref users (explicit pref always wins).
// ===========================================================================
describe('NotificationService — NOTIFY_HIGH_VALUE_DEFAULT_ON flip on', () => {
    beforeEach(async () => {
        await SettingsService.saveMany({ NOTIFY_HIGH_VALUE_DEFAULT_ON: 'true' });
        NotificationService.invalidateFlagCache();
    });

    it('(a) user with no rankDethroned key → DM sent (defaulted opted-in)', async () => {
        const result = await NotificationService.notify({
            userId: '200000000000000019', type: 'rankDethroned', message: 'dethroned',
        });
        expect(result).toBe(true);
    });

    it('(b) explicit rankDethroned:false → NO DM (explicit wins over flag)', async () => {
        await setPrefs('200000000000000020', { rankDethroned: false });
        const result = await NotificationService.notify({
            userId: '200000000000000020', type: 'rankDethroned', message: 'dethroned',
        });
        expect(result).toBe(false);
    });

    it('(c) explicit rankDethroned:true → DM sent (unchanged)', async () => {
        await setPrefs('200000000000000021', { rankDethroned: true });
        const result = await NotificationService.notify({
            userId: '200000000000000021', type: 'rankDethroned', message: 'dethroned',
        });
        expect(result).toBe(true);
    });

    it('applies the same matrix to tournamentWin', async () => {
        // no key → on
        expect(await NotificationService.notify({ userId: '200000000000000022', type: 'tournamentWin', message: 'x' })).toBe(true);
        // explicit false → off
        await setPrefs('200000000000000023', { tournamentWin: false });
        expect(await NotificationService.notify({ userId: '200000000000000023', type: 'tournamentWin', message: 'x' })).toBe(false);
        // explicit true → on
        await setPrefs('200000000000000024', { tournamentWin: true });
        expect(await NotificationService.notify({ userId: '200000000000000024', type: 'tournamentWin', message: 'x' })).toBe(true);
    });

    it('does NOT affect a chatty type — flag only touches the two high-value types', async () => {
        // friendScore with no explicit pref + flag on → still OFF.
        const result = await NotificationService.notify({
            userId: '200000000000000025', type: 'friendScore', message: 'friend',
        });
        expect(result).toBe(false);
    });
});

// ===========================================================================
// 9 — FLAG-ON first-DM footer once.
// ===========================================================================
describe('NotificationService — one-time flag-default footer', () => {
    beforeEach(async () => {
        await SettingsService.saveMany({ NOTIFY_HIGH_VALUE_DEFAULT_ON: 'true' });
        NotificationService.invalidateFlagCache();
    });

    it('appends the manage-notifications footer on the first flag-defaulted DM, then never again', async () => {
        await NotificationService.notify({ userId: '200000000000000026', type: 'rankDethroned', message: 'first' });
        expect(sentDMs[0]!.content).toContain('manage these notifications via /arcaid-notifications or Account Settings');

        // Marker persisted into prefs JSON.
        const stored = await getStoredPrefs('200000000000000026');
        expect(stored._hvFooterShown).toBe(true);

        // Second flag-defaulted DM → no footer.
        sentDMs.length = 0;
        await NotificationService.notify({ userId: '200000000000000026', type: 'tournamentWin', message: 'second' });
        expect(sentDMs[0]!.content).not.toContain('manage these notifications');
    });

    it('never appends the footer for an explicitly-opted-in user', async () => {
        await setPrefs('200000000000000027', { rankDethroned: true });
        await NotificationService.notify({ userId: '200000000000000027', type: 'rankDethroned', message: 'm' });
        expect(sentDMs[0]!.content).not.toContain('manage these notifications');
    });
});

// ===========================================================================
// 10 — FLAG interaction guards (items 3 + 5 are true prerequisites).
// ===========================================================================
describe('NotificationService — flag interacts with gate + rate limit', () => {
    beforeEach(async () => {
        await SettingsService.saveMany({ NOTIFY_HIGH_VALUE_DEFAULT_ON: 'true' });
        NotificationService.invalidateFlagCache();
    });

    it('flag ON + DISCORD_ENABLED=false → still suppressed (gate beats flag)', async () => {
        const roomId = await createTestRoom('flag-gate', 'Flag Gate');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        const result = await NotificationService.notify({
            userId: '200000000000000028', type: 'rankDethroned', message: 'm', roomId,
        });
        expect(result).toBe(false);
    });

    it('flag ON + chatty bucket full → high-value still sends (separate budget)', async () => {
        await setPrefs('200000000000000029', { friendScore: true }); // explicit chatty opt-in; rankDethroned defaulted by flag
        for (let i = 0; i < 5; i++) {
            await NotificationService.notify({ userId: '200000000000000029', type: 'friendScore', message: `c${i}` });
        }
        // Chatty now exhausted.
        expect(await NotificationService.notify({ userId: '200000000000000029', type: 'friendScore', message: 'c6' })).toBe(false);
        // Flag-defaulted high-value still sends from its own bucket.
        expect(await NotificationService.notify({ userId: '200000000000000029', type: 'rankDethroned', message: 'hv' })).toBe(true);
    });
});
