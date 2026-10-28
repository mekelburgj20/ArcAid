import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

/**
 * W30 (v2.192.0) - the Discord event posts lead with the TOURNAMENT and name the
 * ROOM beneath it. TomatoGrass (WWS test event, 2026-10-23) took the room name
 * "Arcaid Witness Demo" for the tournament.
 *
 * Pinned: the title still names the tournament / round exactly as before, and
 * the room rides the embed footer ("<tournament> - in <Room>"). Pick prompts are
 * untouched (they have their own test, pick-prompts-name-tournament).
 */

const sent: Array<{ channelId: string; embed: any }> = [];

vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return {
        ...actual,
        resolveAnnouncementChannelId: async () => 'announce-channel',
        sendChannelEmbed: async (channelId: string, embed: any) => {
            sent.push({ channelId, embed: embed.data ?? embed });
        },
    };
});

const { setupTestDb, createTestRoom } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { EventService } = await import('../services/EventService.js');
const { EventScheduler } = await import('../engine/EventScheduler.js');

const MINUTE = 60_000;
const base = Date.parse('2026-09-01T20:00:00.000Z');

describe('W30 - event Discord posts name the room', () => {
    let roomId: string;
    let tid: string;

    beforeEach(async () => {
        sent.length = 0;
        await setupTestDb();
        roomId = await createTestRoom(`w30-${crypto.randomUUID().slice(0, 8)}`, 'Arcaid Witness Demo');
        const db = await getDatabase();
        // iScored OFF so round start never reaches the real service.
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        tid = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Friday Night Flip', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
            tid, roomId,
        );
        await EventService.createOrUpdateEvent(tid, {
            rounds: [{
                roundNo: 1, gameName: 'Medieval Madness',
                scheduledStartAt: new Date(base).toISOString(),
                scheduledEndAt: new Date(base + 20 * MINUTE).toISOString(),
            }],
            checkinOpensAt: new Date(base - 30 * MINUTE).toISOString(),
            checkinRequired: false,
        });
    });

    const footer = (e: any) => e.footer?.text as string;

    it('check-in, round start, round results and final standings keep their titles and add the room to the footer', async () => {
        const scheduler = EventScheduler.getInstance();

        await scheduler.tick(new Date(base - 20 * MINUTE));
        const checkin = sent.find(s => s.embed.title?.startsWith('Check-in open'))!;
        expect(checkin.embed.title).toBe('Check-in open: Friday Night Flip');
        expect(footer(checkin.embed)).toBe('1 round · in Arcaid Witness Demo');

        await scheduler.tick(new Date(base + 10_000));
        const live = sent.find(s => s.embed.title?.includes('is LIVE'))!;
        expect(live.embed.title).toBe('Round 1 is LIVE: Medieval Madness');
        expect(footer(live.embed)).toBe('Friday Night Flip · in Arcaid Witness Demo');

        await scheduler.tick(new Date(base + 22 * MINUTE));
        const results = sent.find(s => s.embed.title?.includes('results'))!;
        expect(results.embed.title).toBe('Round 1 results: Medieval Madness');
        expect(footer(results.embed)).toBe('Friday Night Flip · in Arcaid Witness Demo');

        const final = sent.find(s => s.embed.title?.includes('final standings'))!;
        expect(final.embed.title).toBe('Friday Night Flip — final standings');
        expect(footer(final.embed)).toMatch(/^Aggregate: .+ · in Arcaid Witness Demo$/);
    });
});
