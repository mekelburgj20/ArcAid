import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { EventService } from '../services/EventService.js';
import { checkEventSubmission, eventEndGraceSec, DEFAULT_EVENT_END_GRACE_SEC } from '../services/EventSubmissionGate.js';
import { EventResultService } from '../services/EventResultService.js';
import { EventScheduler } from '../engine/EventScheduler.js';

/**
 * Live Event format (v2.135.0, ADR 0017) — Arc 1, Phase 1.
 *
 * The three properties the whole feature rests on, and which every test here
 * exists to pin:
 *
 *   1. **Rotation is untouched.** A game that is not an event round must go
 *      through the gate and come out the other side with the pre-v2.135.0
 *      behaviour, byte for byte. That includes the awkward case where a
 *      rotation tournament activates the same table an event has scheduled for
 *      later.
 *   2. **The window is the server's clock, not the client's.** Nothing is
 *      accepted before a round opens or after it closes plus its grace, and the
 *      gate and the scheduler resolve that grace through the SAME helper.
 *   3. **The tick is safe to replay.** A restart mid-minute must not double
 *      start a round, double close it, or freeze a second result.
 */

const MINUTE = 60_000;

/**
 * Turn iScored OFF for the fixture room.
 *
 * `src/utils/terminology.ts` calls `dotenv.config()` at import, so the repo's
 * `.env` — which holds PRODUCTION iScored credentials — is live inside vitest,
 * and `getIScoredCredsForRoom` falls back to it for a room with no settings.
 * Without this, `EventScheduler`'s round-start step launches a real Playwright
 * browser and tries to log in to iScored for real (~40s per round, and a write
 * attempt against production if the creds ever match). Same hazard class as the
 * `setRootForTests` guard on iScored snapshots.
 */
async function disableIScored(roomId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
        roomId,
    );
}

async function makeEventTournament(roomId: string, name = 'Stream Night') {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    // `cadence` deliberately carries NO cron — that is what keeps
    // Scheduler/TournamentEngine/TimeoutManager away from event rounds.
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, ?, 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
        id, name, roomId,
    );
    return id;
}

/** A rotation tournament with one ACTIVE game — the "don't break rotation" fixture. */
async function makeRotationGame(roomId: string, gameName: string) {
    const db = await getDatabase();
    const tid = crypto.randomUUID();
    const gid = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, 'Daily Grind', 'DG', 'pinball', '{"cron":"0 22 * * *"}', 1, ?)`,
        tid, roomId,
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gid, tid, gameName, roomId, new Date().toISOString(),
    );
    return { tournamentId: tid, gameId: gid };
}

function round(no: number, gameName: string, startMs: number, lengthMin: number) {
    return {
        roundNo: no,
        gameName,
        scheduledStartAt: new Date(startMs).toISOString(),
        scheduledEndAt: new Date(startMs + lengthMin * MINUTE).toISOString(),
    };
}

/** Write a score exactly as the event submit path does: stamped with the round. */
async function submitToRound(opts: {
    roomId: string; tournamentId: string; gameId: string; gameName: string;
    username: string; userId?: string; score: number; at: Date;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'community', ?, ?, ?, ?)`,
        opts.gameName, opts.roomId, opts.gameId, opts.username,
        opts.userId ?? 'COMMUNITY', opts.score, opts.roomId, opts.tournamentId,
        opts.userId ?? null,
        // score_history.created_at is SQLite datetime('now') shape: UTC, no T/Z.
        opts.at.toISOString().replace('T', ' ').slice(0, 19),
    );
}

describe('Live Event — configuration', () => {
    let roomId: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
    });

    it('creates one SCHEDULED games row per round and stamps the tournament window', async () => {
        const tid = await makeEventTournament(roomId);
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'Medieval Madness', base, 25), round(2, 'Attack from Mars', base + 30 * MINUTE, 25)],
            checkinOpensAt: new Date(base - 30 * MINUTE).toISOString(),
        });

        expect(rounds).toHaveLength(2);
        expect(rounds.every(r => r.status === 'SCHEDULED')).toBe(true);
        expect(rounds.every(r => r.game_room_id === roomId)).toBe(true);

        const db = await getDatabase();
        const t = await db.get<{ start_date: string; end_date: string; checkin_required: number; aggregate_method: string }>(
            'SELECT start_date, end_date, checkin_required, aggregate_method FROM tournaments WHERE id = ?', tid,
        );
        expect(t!.start_date).toBe(new Date(base).toISOString());
        expect(t!.end_date).toBe(new Date(base + 55 * MINUTE).toISOString());
        expect(t!.checkin_required).toBe(1);
        expect(t!.aggregate_method).toBe('best');
    });

    it('keeps rounds out of every QUEUED consumer', async () => {
        const tid = await makeEventTournament(roomId);
        await EventService.createOrUpdateEvent(tid, { rounds: [round(1, 'Twilight Zone', base, 20)] });
        const db = await getDatabase();
        const queued = await db.all(`SELECT id FROM games WHERE status = 'QUEUED'`);
        expect(queued).toHaveLength(0);
    });

    it('rejects overlapping rounds, backwards windows and late check-in openings', async () => {
        const tid = await makeEventTournament(roomId);

        await expect(EventService.createOrUpdateEvent(tid, { rounds: [] }))
            .rejects.toMatchObject({ code: 'NO_ROUNDS' });

        await expect(EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'A', base, 30), round(2, 'B', base + 10 * MINUTE, 30)],
        })).rejects.toMatchObject({ code: 'ROUNDS_OVERLAP' });

        await expect(EventService.createOrUpdateEvent(tid, {
            rounds: [{ roundNo: 1, gameName: 'A', scheduledStartAt: new Date(base).toISOString(), scheduledEndAt: new Date(base).toISOString() }],
        })).rejects.toMatchObject({ code: 'INVALID_ROUND_WINDOW' });

        await expect(EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'A', base, 30)],
            checkinOpensAt: new Date(base + MINUTE).toISOString(),
        })).rejects.toMatchObject({ code: 'CHECKIN_AFTER_START' });
    });

    it('refuses a round whose table a rotation tournament currently has ACTIVE', async () => {
        await makeRotationGame(roomId, 'Medieval Madness');
        const tid = await makeEventTournament(roomId);
        await expect(EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'medieval madness', base, 20)],
        })).rejects.toMatchObject({ code: 'GAME_NAME_IN_ROTATION' });
    });

    it('locks a round once it has started, but still allows editing the ones after it', async () => {
        const tid = await makeEventTournament(roomId);
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'A', base, 20), round(2, 'B', base + 30 * MINUTE, 20)],
        });
        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE id = ?`, rounds[0]!.id);

        await expect(EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'A', base, 45), round(2, 'B', base + 60 * MINUTE, 20)],
        })).rejects.toMatchObject({ code: 'ROUND_LOCKED' });

        // Round 1 unchanged + round 2 moved = fine, and round 2 keeps its id
        // (so an admin who reschedules an upcoming round doesn't lose its scores).
        const after = await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'A', base, 20), round(2, 'C', base + 40 * MINUTE, 15)],
        });
        expect(after[1]!.id).toBe(rounds[1]!.id);
        expect(after[1]!.name).toBe('C');

        // Dropping a still-SCHEDULED round mid-event is allowed — cancelling a
        // later round of a live event is a real thing hosts do.
        const trimmed = await EventService.createOrUpdateEvent(tid, { rounds: [round(1, 'A', base, 20)] });
        expect(trimmed).toHaveLength(1);
    });

    it('walks the state machine from the schedule alone', async () => {
        const tid = await makeEventTournament(roomId);
        await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'A', base, 20), round(2, 'B', base + 40 * MINUTE, 20)],
            checkinOpensAt: new Date(base - 30 * MINUTE).toISOString(),
        });
        const at = (ms: number) => EventService.getState(tid, new Date(ms));

        expect(await at(base - 45 * MINUTE)).toBe('upcoming');
        expect(await at(base - 5 * MINUTE)).toBe('checkin');
        expect(await at(base + 5 * MINUTE)).toBe('live');
        expect(await at(base + 30 * MINUTE)).toBe('between_rounds');
        expect(await at(base + 45 * MINUTE)).toBe('live');
        expect(await at(base + 90 * MINUTE)).toBe('finished');
    });
});

describe('Live Event — check-in roster', () => {
    let roomId: string;
    let tid: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        tid = await makeEventTournament(roomId);
        await EventService.createOrUpdateEvent(tid, { rounds: [round(1, 'A', base, 20)] });
    });

    it('is idempotent and keeps the original check-in time', async () => {
        const first = await EventService.checkIn(tid, 'user-1');
        const second = await EventService.checkIn(tid, 'user-1');
        expect(second.checked_in_at).toBe(first.checked_in_at);
        expect(await EventService.participantCount(tid)).toBe(1);
    });

    it('lets an admin add upgrade an existing self-check-in', async () => {
        await EventService.checkIn(tid, 'user-1');
        const upgraded = await EventService.checkIn(tid, 'user-1', 'admin', 'admin-9');
        expect(upgraded.source).toBe('admin');
        expect(upgraded.added_by).toBe('admin-9');
    });

    it('collapses linked identities onto one participant row', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            'google:abc', 'discord-1',
        );
        await EventService.checkIn(tid, 'google:abc');
        expect(await EventService.participantCount(tid)).toBe(1);
        // The Discord side of the same person is already checked in.
        expect(await EventService.isParticipant(tid, 'discord-1')).not.toBeNull();
    });

    it('withdraws', async () => {
        await EventService.checkIn(tid, 'user-1');
        expect(await EventService.withdraw(tid, 'user-1')).toBe(true);
        expect(await EventService.withdraw(tid, 'user-1')).toBe(false);
    });
});

describe('Live Event — submission gate', () => {
    let roomId: string;
    let tid: string;
    let roundId: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');
    const endMs = base + 20 * MINUTE;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        tid = await makeEventTournament(roomId);
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'Medieval Madness', base, 20)],
            checkinRequired: false,
        });
        roundId = rounds[0]!.id;
        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE id = ?`, roundId);
    });

    it('resolves the grace through one helper with a 60s default', () => {
        expect(eventEndGraceSec({})).toBe(DEFAULT_EVENT_END_GRACE_SEC);
        expect(eventEndGraceSec({ end_grace_sec: null })).toBe(60);
        expect(eventEndGraceSec({ end_grace_sec: 180 })).toBe(180);
        expect(eventEndGraceSec({ end_grace_sec: 0 })).toBe(0);
    });

    it('passes a game that is not an event round straight through', async () => {
        const result = await checkEventSubmission({ roomId, gameName: 'Some Other Table', userId: 'u1' });
        expect(result).toEqual({ ok: true });
        expect(result.event).toBeUndefined();
    });

    it('refuses before the round opens and after it closes plus grace', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'SCHEDULED' WHERE id = ?`, roundId);
        const before = await checkEventSubmission({
            roomId, gameName: 'Medieval Madness', userId: 'u1', now: new Date(base - MINUTE),
        });
        expect(before).toMatchObject({ ok: false, code: 'EVENT_NOT_STARTED' });

        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE id = ?`, roundId);
        for (const [offsetSec, expected] of [[0, true], [59, true], [60, true], [61, false]] as const) {
            const res = await checkEventSubmission({
                roomId, gameName: 'Medieval Madness', userId: 'u1', now: new Date(endMs + offsetSec * 1000),
            });
            expect(res.ok, `end+${offsetSec}s`).toBe(expected);
            if (!expected) expect(res.code).toBe('EVENT_ROUND_ENDED');
        }
    });

    it('hands the round back so the caller can stamp the score with it', async () => {
        const res = await checkEventSubmission({
            roomId, gameName: 'medieval madness', userId: 'u1', now: new Date(base + MINUTE),
        });
        expect(res.ok).toBe(true);
        expect(res.event).toMatchObject({ tournamentId: tid, gameId: roundId, roundNo: 1 });
    });

    it('honours a per-event grace override on both sides of the buzzer', async () => {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET end_grace_sec = 180 WHERE id = ?', tid);
        const ok = await checkEventSubmission({
            roomId, gameName: 'Medieval Madness', userId: 'u1', now: new Date(endMs + 150_000),
        });
        expect(ok.ok).toBe(true);
        const late = await checkEventSubmission({
            roomId, gameName: 'Medieval Madness', userId: 'u1', now: new Date(endMs + 200_000),
        });
        expect(late).toMatchObject({ ok: false, code: 'EVENT_ROUND_ENDED' });
    });

    it('requires check-in when the event says so, and lets an admin add a straggler', async () => {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET checkin_required = 1 WHERE id = ?', tid);
        const now = new Date(base + MINUTE);

        expect(await checkEventSubmission({ roomId, gameName: 'Medieval Madness', userId: 'u1', now }))
            .toMatchObject({ ok: false, code: 'EVENT_NOT_CHECKED_IN' });

        // A self-check-in stamped after round 1 started is refused …
        await db.run(
            `INSERT INTO tournament_participants (tournament_id, user_id, checked_in_at, source)
             VALUES (?, 'u1', ?, 'checkin')`,
            tid, new Date(base + 30_000).toISOString(),
        );
        expect(await checkEventSubmission({ roomId, gameName: 'Medieval Madness', userId: 'u1', now }))
            .toMatchObject({ ok: false, code: 'EVENT_CHECKIN_LATE' });

        // … but the admin override is exactly how a straggler gets in.
        await EventService.checkIn(tid, 'u1', 'admin', 'admin-9');
        expect((await checkEventSubmission({ roomId, gameName: 'Medieval Madness', userId: 'u1', now })).ok).toBe(true);
    });

    it('never shadows a rotation game that is live on the same table', async () => {
        const db = await getDatabase();
        // The event round is SCHEDULED for tomorrow …
        await db.run(
            `UPDATE games SET status = 'SCHEDULED', scheduled_start_at = ?, scheduled_end_at = ? WHERE id = ?`,
            new Date(base + 24 * 60 * MINUTE).toISOString(),
            new Date(base + 25 * 60 * MINUTE).toISOString(),
            roundId,
        );
        // … while a rotation tournament has the same table ACTIVE today.
        await makeRotationGame(roomId, 'Medieval Madness');

        const res = await checkEventSubmission({
            roomId, gameName: 'Medieval Madness', userId: 'u1', now: new Date(base),
        });
        expect(res).toEqual({ ok: true });

        // With no rotation game live, the scheduled round DOES gate.
        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND round_no IS NULL`);
        expect(await checkEventSubmission({
            roomId, gameName: 'Medieval Madness', userId: 'u1', now: new Date(base),
        })).toMatchObject({ ok: false, code: 'EVENT_NOT_STARTED' });
    });

    it('prefers a LIVE round over a scheduled one on the same table', async () => {
        const db = await getDatabase();
        await EventService.createOrUpdateEvent(tid, {
            rounds: [
                round(1, 'Medieval Madness', base, 20),
                round(2, 'Medieval Madness', base + 40 * MINUTE, 20),
            ],
            checkinRequired: false,
        });
        await db.run(`UPDATE games SET status = 'ACTIVE' WHERE tournament_id = ? AND round_no = 1`, tid);
        const res = await checkEventSubmission({
            roomId, gameName: 'Medieval Madness', userId: 'u1', now: new Date(base + MINUTE),
        });
        expect(res.event?.roundNo).toBe(1);
    });
});

describe('Live Event — boards and standings', () => {
    let roomId: string;
    let tid: string;
    let r1: string;
    let r2: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        tid = await makeEventTournament(roomId);
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'Medieval Madness', base, 20), round(2, 'Attack from Mars', base + 30 * MINUTE, 20)],
            checkinRequired: false,
            minElapsedSec: 120,
        });
        r1 = rounds[0]!.id;
        r2 = rounds[1]!.id;
    });

    it('ranks a round, times each score against the round start and flags the impossible ones', async () => {
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Ann', userId: 'u-ann', score: 500, at: new Date(base + 30_000) });
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Bob', userId: 'u-bob', score: 900, at: new Date(base + 10 * MINUTE) });

        const event = (await EventService.getEvent(tid))!;
        const rounds = await EventService.getRounds(tid);
        const board = await EventResultService.getRoundBoard(event, rounds[0]!);

        expect(board.scores.map(s => s.iscored_username)).toEqual(['Bob', 'Ann']);
        expect(board.scores[0]!.elapsed_sec).toBe(600);
        expect(board.scores[0]!.flagged).toBe(false);
        // 30s into a round with min_elapsed_sec=120 — too fast to be plausible.
        expect(board.scores[1]!.elapsed_sec).toBe(30);
        expect(board.scores[1]!.flagged).toBe(true);
    });

    it('keeps two rounds of the SAME table apart by game_id', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE games SET name = 'Medieval Madness' WHERE id = ?`, r2);
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Ann', userId: 'u-ann', score: 500, at: new Date(base + 5 * MINUTE) });
        await submitToRound({ roomId, tournamentId: tid, gameId: r2, gameName: 'Medieval Madness', username: 'Ann', userId: 'u-ann', score: 700, at: new Date(base + 35 * MINUTE) });

        const boards = (await EventResultService.getBoards(tid))!;
        expect(boards[0]!.scores.map(s => s.score)).toEqual([500]);
        expect(boards[1]!.scores.map(s => s.score)).toEqual([700]);
    });

    it('finds a game_id-less row by its game name and window', async () => {
        const db = await getDatabase();
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Ann', userId: 'u-ann', score: 500, at: new Date(base + 5 * MINUTE) });
        await db.run(`UPDATE score_history SET game_id = NULL`);
        const boards = (await EventResultService.getBoards(tid))!;
        expect(boards[0]!.scores).toHaveLength(1);
        // The same row must NOT also land on round 2's board.
        expect(boards[1]!.scores).toHaveLength(0);
    });

    it('aggregates best, sum and average, quarantining partial players only under average', async () => {
        const db = await getDatabase();
        // Ann plays both rounds, Bob only the first.
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Ann', userId: 'u-ann', score: 400, at: new Date(base + 5 * MINUTE) });
        await submitToRound({ roomId, tournamentId: tid, gameId: r2, gameName: 'Attack from Mars', username: 'Ann', userId: 'u-ann', score: 600, at: new Date(base + 35 * MINUTE) });
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Bob', userId: 'u-bob', score: 900, at: new Date(base + 6 * MINUTE) });

        await db.run(`UPDATE tournaments SET aggregate_method = 'best' WHERE id = ?`, tid);
        let s = (await EventResultService.computeStandings(tid))!;
        expect(s.standings.map(r => [r.iscored_username, r.total])).toEqual([['Bob', 900], ['Ann', 600]]);
        expect(s.incomplete).toHaveLength(0);

        await db.run(`UPDATE tournaments SET aggregate_method = 'sum' WHERE id = ?`, tid);
        s = (await EventResultService.computeStandings(tid))!;
        expect(s.standings.map(r => [r.iscored_username, r.total])).toEqual([['Ann', 1000], ['Bob', 900]]);

        await db.run(`UPDATE tournaments SET aggregate_method = 'average' WHERE id = ?`, tid);
        s = (await EventResultService.computeStandings(tid))!;
        expect(s.standings.map(r => r.iscored_username)).toEqual(['Ann']);
        expect(s.standings[0]!.total).toBe(500);
        expect(s.incomplete.map(r => r.iscored_username)).toEqual(['Bob']);
    });

    it('drops non-participants from the standings but keeps them on the round board', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET checkin_required = 1 WHERE id = ?`, tid);
        await EventService.checkIn(tid, 'u-ann');
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Ann', userId: 'u-ann', score: 400, at: new Date(base + 5 * MINUTE) });
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Ghost', userId: 'u-ghost', score: 9999, at: new Date(base + 6 * MINUTE) });

        const boards = (await EventResultService.getBoards(tid))!;
        expect(boards[0]!.scores.map(s => [s.iscored_username, s.participant])).toEqual([['Ghost', false], ['Ann', true]]);

        const standings = (await EventResultService.computeStandings(tid))!;
        expect(standings.standings.map(r => r.iscored_username)).toEqual(['Ann']);
    });
});

describe('Live Event — scheduler', () => {
    let roomId: string;
    let tid: string;
    let r1: string;
    let r2: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        await disableIScored(roomId);
        tid = await makeEventTournament(roomId);
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'Medieval Madness', base, 20), round(2, 'Attack from Mars', base + 30 * MINUTE, 20)],
            checkinOpensAt: new Date(base - 30 * MINUTE).toISOString(),
            checkinRequired: false,
        });
        r1 = rounds[0]!.id;
        r2 = rounds[1]!.id;
    });

    const status = async (id: string) => {
        const db = await getDatabase();
        return (await db.get<{ status: string }>('SELECT status FROM games WHERE id = ?', id))!.status;
    };

    it('opens check-in exactly once', async () => {
        const scheduler = EventScheduler.getInstance();
        await scheduler.tick(new Date(base - 20 * MINUTE));
        const db = await getDatabase();
        const first = await db.get<{ checkin_announced_at: string }>('SELECT checkin_announced_at FROM tournaments WHERE id = ?', tid);
        expect(first!.checkin_announced_at).not.toBeNull();

        await scheduler.tick(new Date(base - 10 * MINUTE));
        const second = await db.get<{ checkin_announced_at: string }>('SELECT checkin_announced_at FROM tournaments WHERE id = ?', tid);
        expect(second!.checkin_announced_at).toBe(first!.checkin_announced_at);
    });

    it('starts a round once, even when the same minute is replayed', async () => {
        const scheduler = EventScheduler.getInstance();
        await scheduler.tick(new Date(base + 10_000));
        expect(await status(r1)).toBe('ACTIVE');
        expect(await status(r2)).toBe('SCHEDULED');

        const db = await getDatabase();
        const started = await db.get<{ start_date: string }>('SELECT start_date FROM games WHERE id = ?', r1);
        // A restart replaying this minute must not rewrite the start.
        await scheduler.tick(new Date(base + 20_000));
        const again = await db.get<{ start_date: string }>('SELECT start_date FROM games WHERE id = ?', r1);
        expect(again!.start_date).toBe(started!.start_date);
        // start_date is the SCHEDULED time, not the tick time — the window a
        // score is measured against must be the advertised one.
        expect(started!.start_date).toBe(new Date(base).toISOString());
    });

    it('closes a round only after the end plus its grace', async () => {
        const scheduler = EventScheduler.getInstance();
        await scheduler.tick(new Date(base + 10_000));

        await scheduler.tick(new Date(base + 20 * MINUTE + 30_000));
        expect(await status(r1)).toBe('ACTIVE');

        await scheduler.tick(new Date(base + 20 * MINUTE + 61_000));
        expect(await status(r1)).toBe('COMPLETED');
    });

    it('freezes the result once, with identity-stable rows only, and deactivates the event', async () => {
        const scheduler = EventScheduler.getInstance();
        await scheduler.tick(new Date(base + 10_000));
        await submitToRound({ roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness', username: 'Ann', userId: 'u-ann', score: 400, at: new Date(base + 5 * MINUTE) });
        await scheduler.tick(new Date(base + 22 * MINUTE));

        await scheduler.tick(new Date(base + 30 * MINUTE + 10_000));
        await submitToRound({ roomId, tournamentId: tid, gameId: r2, gameName: 'Attack from Mars', username: 'Ann', userId: 'u-ann', score: 600, at: new Date(base + 35 * MINUTE) });
        await scheduler.tick(new Date(base + 55 * MINUTE));

        const db = await getDatabase();
        const t = await db.get<{ event_result: string; event_finished_at: string; is_active: number }>(
            'SELECT event_result, event_finished_at, is_active FROM tournaments WHERE id = ?', tid,
        );
        expect(t!.is_active).toBe(0);
        expect(t!.event_finished_at).not.toBeNull();

        const frozen = JSON.parse(t!.event_result);
        expect(frozen.v).toBe(1);
        expect(frozen.standings[0].iscored_username).toBe('Ann');
        expect(frozen.standings[0].total).toBe(600);
        // Never bake a name or an avatar into a frozen blob — same doctrine as
        // leaderboard_cache. They are resolved at read time.
        expect(frozen.standings[0]).not.toHaveProperty('display_name');
        expect(frozen.standings[0]).not.toHaveProperty('avatar_hash');
        expect(frozen.standings[0]).not.toHaveProperty('avatar_url');

        const finishedAt = t!.event_finished_at;
        await scheduler.tick(new Date(base + 90 * MINUTE));
        const after = await db.get<{ event_finished_at: string }>('SELECT event_finished_at FROM tournaments WHERE id = ?', tid);
        expect(after!.event_finished_at).toBe(finishedAt);
    });

    it('recovers an event whose rounds elapsed entirely while the app was down', async () => {
        // No tick ever ran during either window. Both rounds must still be
        // closed out, or `finishCompletedEvents` waits forever on rows that can
        // never leave SCHEDULED and the event is stuck.
        await EventScheduler.getInstance().tick(new Date(base + 3 * 60 * MINUTE));

        expect(await status(r1)).toBe('COMPLETED');
        expect(await status(r2)).toBe('COMPLETED');

        const db = await getDatabase();
        const t = await db.get<{ event_finished_at: string | null; is_active: number }>(
            'SELECT event_finished_at, is_active FROM tournaments WHERE id = ?', tid,
        );
        expect(t!.event_finished_at).not.toBeNull();
        expect(t!.is_active).toBe(0);
    });

    it('leaves rotation tournaments completely alone', async () => {
        const { gameId } = await makeRotationGame(roomId, 'Twilight Zone');
        await EventScheduler.getInstance().tick(new Date(base + 90 * MINUTE));
        expect(await status(gameId)).toBe('ACTIVE');
        const db = await getDatabase();
        const rotation = await db.get<{ is_active: number }>(
            `SELECT is_active FROM tournaments WHERE COALESCE(format,'rotation') = 'rotation' LIMIT 1`,
        );
        expect(rotation!.is_active).toBe(1);
    });
});
