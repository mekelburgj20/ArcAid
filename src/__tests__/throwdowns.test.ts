import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { ThrowdownService, ThrowdownError } from '../services/ThrowdownService.js';
import { EventService } from '../services/EventService.js';
import { EventResultService } from '../services/EventResultService.js';
import { checkThrowdownSubmission } from '../services/EventSubmissionGate.js';

/**
 * Throwdowns — room-less player challenges (v2.136.0, ADR 0018).
 *
 * The claim this file has to defend is that a Throwdown really is the SAME
 * object as a hosted Tournament Event, just without a room: the same round
 * clock, the same submission gate, the same standings. If that stops being
 * true, the design has quietly forked into two systems and the reuse argument
 * for going room-less collapses.
 */

const MINUTE = 60_000;

async function createOne(user = 'u-1', overrides: Record<string, unknown> = {}) {
    return ThrowdownService.create(user, {
        gameName: 'Medieval Madness',
        durationMinutes: 60,
        ...overrides,
    });
}

beforeEach(async () => { await setupTestDb(); });

describe('creating a Throwdown', () => {
    it('creates a room-less, check-in-free, single-round event that is live immediately', async () => {
        const td = await createOne();
        const db = await getDatabase();

        const row = await db.get<{
            game_room_id: string | null; format: string; checkin_required: number;
            throwdown_code: string; created_by_user_id: string; cadence: string;
        }>('SELECT * FROM tournaments WHERE id = ?', td.tournamentId);

        expect(row!.game_room_id).toBeNull();
        expect(row!.format).toBe('event');
        expect(row!.checkin_required).toBe(0);
        expect(row!.throwdown_code).toBe(td.code);
        expect(row!.created_by_user_id).toBe('u-1');
        // No cron — the same rule that keeps runMaintenance away from a hosted event.
        expect(JSON.parse(row!.cadence).cron).toBeUndefined();

        const rounds = await EventService.getRounds(td.tournamentId);
        expect(rounds).toHaveLength(1);
        // Live on creation: the creator is about to play, not schedule.
        expect(rounds[0]!.status).toBe('ACTIVE');
        expect(rounds[0]!.name).toBe('Medieval Madness');
        expect(rounds[0]!.game_room_id).toBeNull();
    });

    it('mints an unambiguous code and resolves by it, case-insensitively', async () => {
        const td = await createOne();
        expect(td.code).toHaveLength(8);
        // No characters that are ambiguous when read aloud or retyped.
        expect(td.code).not.toMatch(/[0O1Il]/);

        expect((await ThrowdownService.getByCode(td.code))!.id).toBe(td.tournamentId);
        expect((await ThrowdownService.getByCode(td.code.toLowerCase()))!.id).toBe(td.tournamentId);
        expect(await ThrowdownService.getByCode('NOTREAL9')).toBeNull();
        expect(await ThrowdownService.getByCode('')).toBeNull();
    });

    it('gives every Throwdown a distinct code', async () => {
        const codes = new Set<string>();
        for (let i = 0; i < 25; i++) codes.add((await createOne(`u-${i}`)).code);
        expect(codes.size).toBe(25);
    });

    it('refuses a missing game or an absurd duration', async () => {
        await expect(createOne('u-1', { gameName: '   ' }))
            .rejects.toMatchObject({ code: 'INVALID_GAME' });
        await expect(createOne('u-1', { durationMinutes: 1 }))
            .rejects.toMatchObject({ code: 'INVALID_DURATION' });
        await expect(createOne('u-1', { durationMinutes: 60 * 24 * 30 }))
            .rejects.toMatchObject({ code: 'INVALID_DURATION' });
    });

    it('keys the creator on their canonical identity', async () => {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)',
            'google:abc', 'discord-1',
        );
        const td = await ThrowdownService.create('google:abc', { gameName: 'X', durationMinutes: 30 });
        const row = await db.get<{ created_by_user_id: string }>(
            'SELECT created_by_user_id FROM tournaments WHERE id = ?', td.tournamentId,
        );
        // Otherwise the same person's Throwdowns split across their two logins.
        expect(row!.created_by_user_id).toBe('discord-1');
    });

    it('lists a creator\'s Throwdowns, and nobody else\'s', async () => {
        const mine = await createOne('u-1');
        await createOne('u-2');
        const list = await ThrowdownService.listForCreator('u-1');
        expect(list.map(t => t.id)).toEqual([mine.tournamentId]);
    });
});

describe('rematch — first click wins', () => {
    it('hands the second clicker the first one\'s link instead of making a duplicate', async () => {
        const original = await createOne('u-1');
        const first = await ThrowdownService.create('u-2', {
            gameName: 'Medieval Madness', durationMinutes: 60, rematchOf: original.tournamentId,
        });

        let err: ThrowdownError | undefined;
        try {
            await ThrowdownService.create('u-3', {
                gameName: 'Medieval Madness', durationMinutes: 60, rematchOf: original.tournamentId,
            });
        } catch (e) { err = e as ThrowdownError; }

        expect(err?.code).toBe('REMATCH_EXISTS');
        expect(err?.existingCode).toBe(first.code);

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM tournaments WHERE rematch_of_tournament_id = ?', original.tournamentId,
        );
        expect(count!.n).toBe(1);
    });

    it('is enforced by a UNIQUE index, not just the pre-flight check', async () => {
        const original = await createOne('u-1');
        const first = await ThrowdownService.create('u-2', {
            gameName: 'X', durationMinutes: 30, rematchOf: original.tournamentId,
        });
        const db = await getDatabase();
        // Bypass the service entirely — the database must still refuse.
        await expect(db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, format, rematch_of_tournament_id)
             VALUES ('dupe', 'X', 'TD', 'pinball', '{}', 1, 'event', ?)`,
            original.tournamentId,
        )).rejects.toThrow();
        expect(first.code).toBeTruthy();
    });
});

describe('the Throwdown submission gate', () => {
    it('accepts inside the window and hands back the round to stamp', async () => {
        const td = await createOne();
        const res = await checkThrowdownSubmission({ tournamentId: td.tournamentId, userId: 'u-2' });
        expect(res.ok).toBe(true);
        expect(res.event?.tournamentId).toBe(td.tournamentId);
        expect(res.event?.roundNo).toBe(1);
    });

    it('refuses after the buzzer plus grace, using the same 60s default as a hosted event', async () => {
        const td = await createOne();
        const end = Date.parse(td.endsAt);

        expect((await checkThrowdownSubmission({
            tournamentId: td.tournamentId, userId: 'u-2', now: new Date(end + 59_000),
        })).ok).toBe(true);

        const late = await checkThrowdownSubmission({
            tournamentId: td.tournamentId, userId: 'u-2', now: new Date(end + 61_000),
        });
        expect(late).toMatchObject({ ok: false, code: 'EVENT_ROUND_ENDED' });
        expect(late.message).toContain('Throwdown');
    });

    it('refuses an unknown id and refuses a ROOM-scoped event', async () => {
        expect((await checkThrowdownSubmission({ tournamentId: 'nope', userId: 'u-1' })).ok).toBe(false);

        // A hosted event must not be reachable through the room-less entry
        // point — that would skip its check-in requirement entirely.
        const db = await getDatabase();
        const roomId = 'room-x';
        await db.run(`INSERT INTO game_rooms (id, name, slug, description, is_public) VALUES (?, 'R', 'r', '', 1)`, roomId);
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_required)
             VALUES ('hosted', 'Hosted', 'EV', 'pinball', '{}', 1, ?, 'event', 1)`,
            roomId,
        );
        await EventService.createOrUpdateEvent('hosted', {
            rounds: [{
                roundNo: 1, gameName: 'Y',
                scheduledStartAt: new Date(Date.now() - MINUTE).toISOString(),
                scheduledEndAt: new Date(Date.now() + 30 * MINUTE).toISOString(),
            }],
        });
        const res = await checkThrowdownSubmission({ tournamentId: 'hosted', userId: 'u-1' });
        expect(res.ok).toBe(false);
    });
});

describe('a Throwdown reuses the event standings machinery', () => {
    it('ranks room-less scores with no room anywhere in the row', async () => {
        const td = await createOne();
        const rounds = await EventService.getRounds(td.tournamentId);
        const db = await getDatabase();

        for (const [player, score] of [['Wyo', 5000], ['Ann', 9000], ['Bob', 7000]] as const) {
            await db.run(
                `INSERT INTO score_history
                    (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                     submitted_during_tournament_id, submitted_by_user_id, created_at)
                 VALUES ('Medieval Madness', NULL, ?, ?, ?, ?, 'community', ?, ?, ?)`,
                rounds[0]!.id, player, `u-${player}`, score, td.tournamentId, `u-${player}`,
                new Date().toISOString().replace('T', ' ').slice(0, 19),
            );
        }

        const standings = await EventResultService.computeStandings(td.tournamentId);
        expect(standings!.standings.map(r => r.iscored_username)).toEqual(['Ann', 'Bob', 'Wyo']);
        // checkin_required = 0, so nobody is filtered out for not being on a roster.
        expect(standings!.standings.every(r => r.roundsPlayed === 1)).toBe(true);
    });
});
