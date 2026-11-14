import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import {
    NotificationService,
    PREF_TYPE_KEYS,
    playReminderHoursOf,
} from '../services/NotificationService.js';
import { EngagementReminderService } from '../services/EngagementReminderService.js';

// ---------------------------------------------------------------------------
// Opt-in engagement reminders. The clock is the `now` argument of `sweep`;
// `NotificationService.notify` is spied so the assertions read the DMs that
// would have been sent, and `engagement_reminders` is read for the dedupe /
// supersede rows. Rotations close on a weekly UTC cron: E = Wed 2026-11-18
// 12:00Z, the previous close (and the game's start) = Wed 2026-11-11 12:00Z.
// ---------------------------------------------------------------------------

const H = 3_600_000;
const S = Date.UTC(2026, 10, 11, 12);
const E = Date.UTC(2026, 10, 18, 12);
const WEEKLY = '0 12 * * 3';
const DAILY = '0 12 * * *';

const notifySpy = vi.spyOn(NotificationService, 'notify');

let counter = 0;

interface World { roomId: string; tournamentId: string; gameId: string }

async function world(opts: { cron?: string; start?: number; entryMode?: string; format?: string; active?: number } = {}): Promise<World> {
    counter += 1;
    const roomId = await createTestRoom(`er-room-${counter}`, `ER Room ${counter}`);
    const tournamentId = await createTestTournament(roomId, { name: `ER Tournament ${counter}` });
    const db = await getDatabase();
    await db.run(
        `UPDATE tournaments SET cadence = ?, entry_mode = ?, format = ?, is_active = ? WHERE id = ?`,
        JSON.stringify({ cron: opts.cron ?? WEEKLY, timezone: 'UTC' }),
        opts.entryMode ?? 'members', opts.format ?? 'rotation', opts.active ?? 1, tournamentId,
    );
    const gameId = await createTestGame(tournamentId, {
        name: 'Medieval Madness',
        status: 'ACTIVE',
        startDate: new Date(opts.start ?? S).toISOString(),
    });
    return { roomId, tournamentId, gameId };
}

async function member(w: World, userId: string, prefs: Record<string, unknown>, joinedMs = S - 1000 * H) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO room_members (user_id, room_id, joined_at, source) VALUES (?, ?, ?, 'claim')`,
        userId, w.roomId, new Date(joinedMs).toISOString().slice(0, 19).replace('T', ' '),
    );
    await NotificationService.mergePrefs(userId, prefs);
}

async function score(w: World, userId: string, points: number, atMs = S + H) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR REPLACE INTO submissions (id, game_id, discord_user_id, submitted_by_user_id, iscored_username, score, timestamp)
         VALUES (?, ?, 'COMMUNITY', ?, ?, ?, ?)`,
        `${w.gameId}-${userId}`, w.gameId, userId, userId, points, new Date(atMs).toISOString(),
    );
}

const at = (ms: number) => new Date(ms);

function dmsTo(userId: string) {
    return notifySpy.mock.calls.map(c => c[0]).filter(p => p.userId === userId);
}

async function rows(userId: string) {
    const db = await getDatabase();
    return db.all('SELECT kind, dedupe_key FROM engagement_reminders WHERE user_id = ? ORDER BY id', userId);
}

beforeEach(async () => {
    await setupTestDb();
    notifySpy.mockReset();
    notifySpy.mockResolvedValue(true);
});

describe('playReminder', () => {
    it('fires at 24h for a member with no score, not before, not for scorers or opted-out members', async () => {
        const w = await world();
        await member(w, 'u-a', { playReminder: true });
        await member(w, 'u-b', { playReminder: true });
        await member(w, 'u-c', { playReminder: false });
        await score(w, 'u-b', 1000);

        await EngagementReminderService.sweep(at(S + 23 * H));
        expect(notifySpy).not.toHaveBeenCalled();

        await EngagementReminderService.sweep(at(S + 25 * H));
        expect(dmsTo('u-a')).toHaveLength(1);
        expect(dmsTo('u-a')[0]!.type).toBe('playReminder');
        expect(dmsTo('u-a')[0]!.message).toContain('**Medieval Madness**');
        expect(dmsTo('u-a')[0]!.message).toContain(`<t:${E / 1000}:R>`);
        expect(dmsTo('u-b')).toHaveLength(0);
        expect(dmsTo('u-c')).toHaveLength(0);
    });

    it('respects a 48 hour delay', async () => {
        const w = await world();
        await member(w, 'u-a', { playReminder: true, playReminderHours: 48 });
        await EngagementReminderService.sweep(at(S + 25 * H));
        expect(notifySpy).not.toHaveBeenCalled();
        await EngagementReminderService.sweep(at(S + 49 * H));
        expect(dmsTo('u-a')).toHaveLength(1);
    });

    it('is skipped when under two hours remain', async () => {
        const w = await world();
        await member(w, 'u-a', { playReminder: true });
        await EngagementReminderService.sweep(at(E - 1.5 * H));
        expect(notifySpy).not.toHaveBeenCalled();
    });

    it('sends one DM, not two, across repeated sweeps', async () => {
        const w = await world();
        await member(w, 'u-a', { playReminder: true });
        await EngagementReminderService.sweep(at(S + 25 * H));
        await EngagementReminderService.sweep(at(S + 26 * H));
        await EngagementReminderService.sweep(at(S + 60 * H));
        expect(dmsTo('u-a')).toHaveLength(1);
    });
});

describe('halfwayReminder', () => {
    it('fires at the midpoint and marks playReminder as spent', async () => {
        const w = await world();
        await member(w, 'u-a', { halfwayReminder: true, playReminder: true });
        await EngagementReminderService.sweep(at(S + 83 * H - 0.5 * H));
        // playReminder was due from 24h on; this first sweep is before the midpoint.
        expect(dmsTo('u-a').map(p => p.type)).toEqual(['playReminder']);

        const w2 = await world();
        await member(w2, 'u-b', { halfwayReminder: true, playReminder: true }, S + 80 * H);
        // Joined late enough that nothing was sent earlier; at the midpoint both are due.
        await EngagementReminderService.sweep(at(S + 85 * H));
        expect(dmsTo('u-b').map(p => p.type)).toEqual(['halfwayReminder']);
        expect(dmsTo('u-b')[0]!.message).toContain('Halfway point');
        expect((await rows('u-b')).map(r => r.kind).sort()).toEqual(['halfwayReminder', 'playReminder']);

        await EngagementReminderService.sweep(at(S + 120 * H));
        expect(dmsTo('u-b')).toHaveLength(1);
    });

    it('is skipped for a window shorter than 20 hours', async () => {
        const w = await world({ cron: DAILY, start: Date.UTC(2026, 10, 13, 0) }); // closes 12:00, 12h window
        await member(w, 'u-a', { halfwayReminder: true });
        await EngagementReminderService.sweep(at(Date.UTC(2026, 10, 13, 7)));
        expect(notifySpy).not.toHaveBeenCalled();
    });
});

describe('endingSoon', () => {
    it('sends both text variants', async () => {
        const w = await world();
        await member(w, 'u-a', { endingSoon: true });
        await member(w, 'u-b', { endingSoon: true });
        await score(w, 'u-a', 900);
        await score(w, 'u-b', 1234567);

        await EngagementReminderService.sweep(at(E - 73 * H));
        expect(notifySpy).not.toHaveBeenCalled();

        await EngagementReminderService.sweep(at(E - 71 * H));
        expect(dmsTo('u-a')[0]!.message).toContain("You're #2 of 2 with 900.");
        expect(dmsTo('u-b')[0]!.message).toContain("You're #1 of 2 with 1,234,567.");

        const w2 = await world();
        await member(w2, 'u-c', { endingSoon: true });
        await EngagementReminderService.sweep(at(E - 70 * H));
        expect(dmsTo('u-c')[0]!.message).toContain("You haven't posted a score yet.");
        expect(dmsTo('u-c')[0]!.message).toContain('3 days left');
    });

    it('is skipped on a window shorter than 96 hours and marks earlier stages spent', async () => {
        const w = await world({ cron: DAILY, start: Date.UTC(2026, 10, 12, 12) });
        await member(w, 'u-a', { endingSoon: true });
        await EngagementReminderService.sweep(at(Date.UTC(2026, 10, 13, 1)));
        expect(notifySpy).not.toHaveBeenCalled();

        const w2 = await world();
        await member(w2, 'u-b', { endingSoon: true });
        await EngagementReminderService.sweep(at(E - 60 * H));
        expect((await rows('u-b')).map(r => r.kind).sort()).toEqual(['endingSoon', 'halfwayReminder', 'playReminder']);
    });
});

describe('podiumLost', () => {
    async function podiumWorld() {
        const w = await world();
        await member(w, 'u-me', { podiumLost: true });
        await score(w, 'u-1', 900);
        await score(w, 'u-2', 800);
        await score(w, 'u-me', 700);
        const t0 = S + 10 * H;
        await EngagementReminderService.sweep(at(t0)); // sightings: u-1, u-2, u-me
        await score(w, 'u-4', 750, t0 + H); // pushes u-me to 4th
        return { w, t0 };
    }

    it('fires 24h after the last sighting when pushed to 4th', async () => {
        const { t0 } = await podiumWorld();
        await EngagementReminderService.sweep(at(t0 + 12 * H));
        expect(dmsTo('u-me')).toHaveLength(0);
        await EngagementReminderService.sweep(at(t0 + 25 * H));
        expect(dmsTo('u-me')).toHaveLength(1);
        expect(dmsTo('u-me')[0]!.type).toBe('podiumLost');
        expect(dmsTo('u-me')[0]!.message).toContain("You're now #4");
    });

    it('does not fire when the player is back on the podium', async () => {
        const { w, t0 } = await podiumWorld();
        await score(w, 'u-me', 950, t0 + 2 * H);
        await EngagementReminderService.sweep(at(t0 + 25 * H));
        expect(dmsTo('u-me')).toHaveLength(0);
    });

    it('does not fire when the player improved since', async () => {
        const { w, t0 } = await podiumWorld();
        await score(w, 'u-me', 710, t0 + 2 * H); // better, still 4th
        await EngagementReminderService.sweep(at(t0 + 25 * H));
        expect(dmsTo('u-me')).toHaveLength(0);
    });
});

describe('inactiveReminder', () => {
    it('fires once per lapse and again after a new score and a new lapse', async () => {
        const T0 = Date.UTC(2026, 10, 12, 0);
        const w = await world({ cron: DAILY, start: T0 - 24 * H });
        await member(w, 'u-a', { inactiveReminder: true }, T0);

        await EngagementReminderService.sweep(at(T0 + 71 * H));
        expect(notifySpy).not.toHaveBeenCalled();
        await EngagementReminderService.sweep(at(T0 + 73 * H));
        expect(dmsTo('u-a')).toHaveLength(1);
        expect(dmsTo('u-a')[0]!.message).toContain("You haven't posted a score in **ER Room");
        expect(dmsTo('u-a')[0]!.message).toContain('Open now: **Medieval Madness**');
        await EngagementReminderService.sweep(at(T0 + 74 * H));
        await EngagementReminderService.sweep(at(T0 + 100 * H));
        expect(dmsTo('u-a')).toHaveLength(1);

        const db = await getDatabase();
        const scoredAt = T0 + 101 * H;
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source, submitted_by_user_id, created_at)
             VALUES ('Medieval Madness', ?, ?, 'u-a', 'COMMUNITY', 500, 'community', 'u-a', ?)`,
            w.roomId, w.gameId, new Date(scoredAt).toISOString(),
        );
        // The score also puts u-a on the board; keep the other kinds off.
        await EngagementReminderService.sweep(at(scoredAt + 71 * H));
        expect(dmsTo('u-a')).toHaveLength(1);
        await EngagementReminderService.sweep(at(scoredAt + 73 * H));
        expect(dmsTo('u-a')).toHaveLength(2);
        expect(dmsTo('u-a')[1]!.message).toContain('3 days since your last score');
    });
});

describe('spacing and scope', () => {
    it('sends one DM now and the other 20h+ later', async () => {
        const w = await world();
        const now = E - 71 * H;
        await member(w, 'u-a', { endingSoon: true, inactiveReminder: true }, now - 100 * H);

        await EngagementReminderService.sweep(at(now));
        expect(dmsTo('u-a').map(p => p.type)).toEqual(['endingSoon']);
        await EngagementReminderService.sweep(at(now + H));
        expect(dmsTo('u-a')).toHaveLength(1);
        await EngagementReminderService.sweep(at(now + 21 * H));
        expect(dmsTo('u-a').map(p => p.type)).toEqual(['endingSoon', 'inactiveReminder']);
    });

    it('does not DM a room member who is not on an invited tournament roster', async () => {
        const w = await world({ entryMode: 'invited' });
        await member(w, 'u-in', { playReminder: true });
        await member(w, 'u-out', { playReminder: true });
        const db = await getDatabase();
        await db.run(`INSERT INTO tournament_roster (tournament_id, user_id, source) VALUES (?, 'u-in', 'host')`, w.tournamentId);
        await EngagementReminderService.sweep(at(S + 25 * H));
        expect(dmsTo('u-in')).toHaveLength(1);
        expect(dmsTo('u-out')).toHaveLength(0);
    });

    it('produces nothing for an event tournament or a paused rotation', async () => {
        const ev = await world({ format: 'event' });
        await member(ev, 'u-e', { playReminder: true });
        const paused = await world({ active: 0 });
        await member(paused, 'u-p', { playReminder: true });
        await EngagementReminderService.sweep(at(S + 25 * H));
        expect(notifySpy).not.toHaveBeenCalled();
    });
});

describe('preference plumbing', () => {
    it('playReminderHoursUpdate accepts 24, 48 and 72 only', () => {
        expect(NotificationService.playReminderHoursUpdate({ playReminderHours: 24 })).toEqual({ playReminderHours: 24 });
        expect(NotificationService.playReminderHoursUpdate({ playReminderHours: 48 })).toEqual({ playReminderHours: 48 });
        expect(NotificationService.playReminderHoursUpdate({ playReminderHours: 72 })).toEqual({ playReminderHours: 72 });
        expect(NotificationService.playReminderHoursUpdate({ playReminderHours: 36 })).toEqual({});
        expect(NotificationService.playReminderHoursUpdate({ playReminderHours: '24' })).toEqual({});
        expect(NotificationService.playReminderHoursUpdate(null)).toEqual({});
        expect(playReminderHoursOf({ playReminderHours: 72 })).toBe(72);
        expect(playReminderHoursOf({ playReminderHours: 5 })).toBe(24);
        expect(playReminderHoursOf(undefined)).toBe(24);
    });

    it('typedPrefUpdates accepts the five new keys and PREF_TYPE_KEYS has twelve', () => {
        const body = { playReminder: true, halfwayReminder: false, endingSoon: true, inactiveReminder: true, podiumLost: false, playReminderHours: 48 };
        expect(NotificationService.typedPrefUpdates(body)).toEqual({
            playReminder: true, halfwayReminder: false, endingSoon: true, inactiveReminder: true, podiumLost: false,
        });
        expect(PREF_TYPE_KEYS).toHaveLength(12);
        expect(PREF_TYPE_KEYS).not.toContain('playReminderHours');
    });
});
