import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

/**
 * A32 (v2.231.0): the event clock reads a live AtGames-linked event from
 * AtGames on its own, every 2 minutes, and always once more just before a
 * round closes, so the host never has to press "Pull scores". Owner,
 * 2026-11-08: "It needs to happen automatically."
 *
 * Pinned:
 *   - a linked event with a live round is read; an unlinked one never is;
 *   - reads are spaced by the interval, not every minute;
 *   - the tick that closes the round reads first, even right after a read;
 *   - a failure backs off and leaves one "problem" activity row.
 */

const syncCalls: string[] = [];
let syncImpl: (id: string) => Promise<unknown> = async () => ({ affectedGameIds: [] });

vi.mock('../services/AtGamesEventSyncService.js', () => ({
    AtGamesEventSyncService: {
        syncTournament: async (id: string) => { syncCalls.push(id); return syncImpl(id); },
    },
}));
vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return { ...actual, resolveAnnouncementChannelId: async () => null, sendChannelEmbed: async () => {} };
});

const { setupTestDb, createTestRoom } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { EventService } = await import('../services/EventService.js');
const { EventScheduler, atgamesPullDue, ATGAMES_AUTO_PULL_INTERVAL_MS, ATGAMES_AUTO_PULL_BACKOFF_MS } =
    await import('../engine/EventScheduler.js');
const { drainBackgroundTasks } = await import('../utils/backgroundTasks.js');

const MINUTE = 60_000;

describe('atgamesPullDue', () => {
    const now = 10_000_000;
    it('reads the first time, then once per interval', () => {
        expect(atgamesPullDue(now, false, undefined, false)).toBe(true);
        expect(atgamesPullDue(now, false, now - MINUTE, false)).toBe(false);
        expect(atgamesPullDue(now, false, now - ATGAMES_AUTO_PULL_INTERVAL_MS, false)).toBe(true);
    });
    it('backs off after a failure', () => {
        expect(atgamesPullDue(now, false, now - ATGAMES_AUTO_PULL_INTERVAL_MS, true)).toBe(false);
        expect(atgamesPullDue(now, false, now - ATGAMES_AUTO_PULL_BACKOFF_MS, true)).toBe(true);
    });
    it('always reads on the tick that closes a round', () => {
        expect(atgamesPullDue(now, true, now, false)).toBe(true);
        expect(atgamesPullDue(now, true, now, true)).toBe(true);
    });
});

describe('EventScheduler AtGames auto-pull', () => {
    let roomId: string;
    let linked: string;
    let unlinked: string;
    let base: number;

    async function makeEvent(id: string, name: string, game: string, atgamesId: string | null) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, end_grace_sec, atgames_tournament_id)
             VALUES (?, ?, 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 120, ?)`,
            id, name, roomId, atgamesId,
        );
        await EventService.createOrUpdateEvent(id, {
            rounds: [{
                roundNo: 1, gameName: game,
                scheduledStartAt: new Date(base).toISOString(),
                scheduledEndAt: new Date(base + 30 * MINUTE).toISOString(),
            }],
            checkinRequired: false,
        });
    }

    beforeEach(async () => {
        syncCalls.length = 0;
        syncImpl = async () => ({ affectedGameIds: [] });
        // A fresh instance each test: the read history lives on the singleton.
        (EventScheduler as unknown as { instance?: unknown }).instance = undefined;
        await setupTestDb();
        // Round windows must be in the future at save time.
        base = Date.now() + 10 * MINUTE;
        roomId = await createTestRoom(`atg-${crypto.randomUUID().slice(0, 8)}`, 'ATG Room');
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        linked = crypto.randomUUID();
        unlinked = crypto.randomUUID();
        await makeEvent(linked, 'Linked Night', 'Soccer Kings Deluxe', '1260');
        await makeEvent(unlinked, 'Plain Night', 'Medieval Madness', null);
    });

    it('reads only the linked event, spaced by the interval, and once more as the round closes', async () => {
        const s = EventScheduler.getInstance();
        await s.tick(new Date(base - 5 * MINUTE));          // not live yet
        expect(syncCalls).toEqual([]);

        await s.tick(new Date(base + 10_000));              // round goes live, first read
        expect(syncCalls).toEqual([linked]);

        await s.tick(new Date(base + MINUTE + 10_000));     // 1 min later: too soon
        expect(syncCalls).toHaveLength(1);

        await s.tick(new Date(base + 2 * MINUTE + 10_000)); // interval reached
        expect(syncCalls).toHaveLength(2);

        await s.tick(new Date(base + 31 * MINUTE + 50_000)); // inside the grace: a normal read
        const before = syncCalls.length;
        await s.tick(new Date(base + 32 * MINUTE + 10_000)); // end + 120 s grace: round closes
        expect(syncCalls.length).toBe(before + 1);

        const db = await getDatabase();
        const round = await db.get<{ status: string }>(
            'SELECT status FROM games WHERE tournament_id = ? AND round_no = 1', linked,
        );
        expect(round!.status).not.toBe('ACTIVE');

        await s.tick(new Date(base + 40 * MINUTE));          // closed: no more reads
        expect(syncCalls.length).toBe(before + 1);
        expect(syncCalls).not.toContain(unlinked);
    });

    it('backs off after a failure and logs one problem row', async () => {
        syncImpl = async () => { throw new Error('AtGames login failed for m***@gmail.com (HTTP 500)'); };
        const s = EventScheduler.getInstance();
        await s.tick(new Date(base + 10_000));
        await s.tick(new Date(base + 2 * MINUTE + 10_000));  // inside the backoff
        expect(syncCalls).toHaveLength(1);
        await s.tick(new Date(base + 15 * MINUTE + 10_000)); // backoff over
        expect(syncCalls).toHaveLength(2);

        await drainBackgroundTasks();
        const db = await getDatabase();
        const rows = await db.all<Array<{ severity: string }>>(
            `SELECT severity FROM activity_log WHERE event_type = 'atgames_pull_failed' AND tournament_id = ?`, linked,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.severity).toBe('problem');
    });
});
