import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { parseShareRoute } from '../api/ogMeta.js';
import { EventService } from '../services/EventService.js';

/**
 * P4 — the shareable surfaces (v2.135.0, ADR 0017).
 *
 * `parseShareRoute` is the gate in front of OG injection. It runs on EVERY
 * request that reaches the SPA catch-all, so anything it wrongly accepts
 * becomes a request that tries to build a link preview for a page that is not
 * shareable — and anything it wrongly rejects silently loses the unfurl.
 */

const MINUTE = 60_000;

describe('parseShareRoute', () => {
    it('recognises the three shareable sections', () => {
        expect(parseShareRoute('/rtx/games/Medieval%20Madness'))
            .toEqual({ kind: 'game', slug: 'rtx', name: 'Medieval Madness' });
        expect(parseShareRoute('/rtx/players/Wyo'))
            .toEqual({ kind: 'player', slug: 'rtx', name: 'Wyo' });
        expect(parseShareRoute('/rtx/events/abc-123'))
            .toEqual({ kind: 'event', slug: 'rtx', name: 'abc-123' });
    });

    it('rejects everything else, including near-misses', () => {
        for (const path of [
            '/rtx/lobby',                    // two segments
            '/rtx/events',                   // section with no id
            '/rtx/events/abc/extra',         // too deep
            '/rtx/tournaments/abc',          // a real route, but not shareable
            '/rtx/eventss/abc',              // typo must not fall through
            '/',
            '',
        ]) {
            expect(parseShareRoute(path), path).toBeNull();
        }
    });

    it('rejects malformed percent-encoding rather than throwing', () => {
        expect(parseShareRoute('/rtx/events/%E0%A4%A')).toBeNull();
    });

    it('rejects blank segments', () => {
        expect(parseShareRoute('/rtx/events/%20')).toBeNull();
    });
});

describe('/check-in command — event resolution', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom('rtx', 'RTX');
    });

    async function makeEvent(name: string, opts: {
        checkinOffsetMin?: number; startOffsetMin?: number; finished?: boolean;
    } = {}) {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, ?, 'EV', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
            id, name, roomId,
        );
        const start = Date.now() + (opts.startOffsetMin ?? 60) * MINUTE;
        await EventService.createOrUpdateEvent(id, {
            rounds: [{
                roundNo: 1, gameName: 'Medieval Madness',
                scheduledStartAt: new Date(start).toISOString(),
                scheduledEndAt: new Date(start + 25 * MINUTE).toISOString(),
            }],
            checkinOpensAt: new Date(Date.now() + (opts.checkinOffsetMin ?? -30) * MINUTE).toISOString(),
        });
        if (opts.finished) {
            await db.run('UPDATE tournaments SET event_finished_at = ?, is_active = 0 WHERE id = ?',
                new Date().toISOString(), id);
        }
        return id;
    }

    /**
     * The command's own query, mirrored here. It is the piece that must stay
     * guild-scoped — a bare `FROM tournaments` would list other rooms' events
     * to anyone who typed the command.
     */
    async function openEvents(roomIds: string[]) {
        const db = await getDatabase();
        if (roomIds.length === 0) return [];
        const ph = roomIds.map(() => '?').join(',');
        const rows = await db.all<Array<{ id: string; name: string; checkin_opens_at: string | null; first_start: string | null }>>(
            `SELECT t.id, t.name, t.checkin_opens_at,
                    (SELECT MIN(g.scheduled_start_at) FROM games g
                      WHERE g.tournament_id = t.id AND g.round_no IS NOT NULL) AS first_start
               FROM tournaments t
              WHERE t.game_room_id IN (${ph}) AND t.format = 'event'
                AND t.is_active = 1 AND t.event_finished_at IS NULL
              ORDER BY first_start ASC`,
            ...roomIds,
        );
        const now = Date.now();
        return rows.filter(e =>
            (!e.checkin_opens_at || now >= Date.parse(e.checkin_opens_at))
            && (!e.first_start || now < Date.parse(e.first_start)));
    }

    it('lists an event whose check-in window is open', async () => {
        await makeEvent('Friday Night');
        const open = await openEvents([roomId]);
        expect(open.map(e => e.name)).toEqual(['Friday Night']);
    });

    it('hides an event whose check-in has not opened yet', async () => {
        await makeEvent('Later', { checkinOffsetMin: 30, startOffsetMin: 120 });
        expect(await openEvents([roomId])).toHaveLength(0);
    });

    it('hides an event whose round 1 has already started', async () => {
        await makeEvent('Already Going', { checkinOffsetMin: -120, startOffsetMin: -10 });
        expect(await openEvents([roomId])).toHaveLength(0);
    });

    it('hides a finished event', async () => {
        await makeEvent('Done', { finished: true });
        expect(await openEvents([roomId])).toHaveLength(0);
    });

    it('never lists another room\'s events', async () => {
        const otherRoom = await createTestRoom('other', 'Other');
        await makeEvent('Mine');
        const db = await getDatabase();
        const foreign = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Theirs', 'EV', 'pinball', '{}', 1, ?, 'event')`,
            foreign, otherRoom,
        );
        await EventService.createOrUpdateEvent(foreign, {
            rounds: [{
                roundNo: 1, gameName: 'X',
                scheduledStartAt: new Date(Date.now() + 60 * MINUTE).toISOString(),
                scheduledEndAt: new Date(Date.now() + 85 * MINUTE).toISOString(),
            }],
        });

        expect((await openEvents([roomId])).map(e => e.name)).toEqual(['Mine']);
        expect(await openEvents([])).toHaveLength(0);
    });

    it('orders soonest-first so the single-event case picks the right one', async () => {
        await makeEvent('Later Tonight', { startOffsetMin: 180 });
        await makeEvent('Starting Soon', { startOffsetMin: 30 });
        expect((await openEvents([roomId])).map(e => e.name)).toEqual(['Starting Soon', 'Later Tonight']);
    });

    it('is idempotent on repeat check-in, matching the web route', async () => {
        const id = await makeEvent('Friday Night');
        await EventService.checkIn(id, 'user-1');
        await EventService.checkIn(id, 'user-1');
        expect(await EventService.participantCount(id)).toBe(1);
    });
});
