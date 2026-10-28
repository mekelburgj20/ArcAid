import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';

/**
 * W24 (v2.194.0) - the Room Admin dashboard reads an EVENT as rounds.
 *
 * WWS test event, 2026-10-23: the dashboard's tournament fields stayed empty for
 * an event while the public room page showed everything. The dashboard joined
 * `games` on `status = 'ACTIVE'`, but an event's rounds sit SCHEDULED until the
 * clock opens them, so the "current game" was a hole.
 *
 * Pinned here:
 *   1. a live event shows its ACTIVE round, the window, the state, and the
 *      leader from the ROUND BOARD (so a prevented flagged score is not it);
 *   2. an event with only SCHEDULED rounds shows the NEXT round + its state;
 *   3. a finished event shows its LAST round + 'finished';
 *   4. an event with no rounds still yields an honest row;
 *   5. a rotation tournament's row is unchanged - no event keys at all.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { EventService } = await import('../services/EventService.js');
const { getDashboardData } = await import('../services/DashboardService.js');

const MINUTE = 60_000;
const USER_A = '111111111111111111';
const USER_B = '222222222222222222';

const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function makeEvent(roomId: string, name: string, extra = ''): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, witness_flag_mode${extra ? ', ' + extra.split('=')[0] : ''})
         VALUES (?, ?, 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 'prevent'${extra ? ', ' + extra.split('=')[1] : ''})`,
        id, name, roomId,
    );
    return id;
}

function round(roundNo: number, gameName: string, startMs: number, minutes: number) {
    return {
        roundNo,
        gameName,
        scheduledStartAt: new Date(startMs).toISOString(),
        scheduledEndAt: new Date(startMs + minutes * MINUTE).toISOString(),
    };
}

/** A `source='vpx'` score plus the game observation the witness filed for it. */
async function witnessedScore(opts: {
    roomId: string; tournamentId: string; gameId: string; gameName: string;
    username: string; userId: string; score: number; launchMs: number; exitMs: number;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            platform, engine, device, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'vpx', ?, ?, ?, 'vpxs', 'vpx', 'atgames', ?)`,
        opts.gameName, opts.roomId, opts.gameId, opts.username, opts.userId, opts.score,
        opts.roomId, opts.tournamentId, opts.userId, sqliteTs(opts.exitMs),
    );
    const launch = Math.floor(opts.launchMs / 1000);
    const exit = Math.floor(opts.exitMs / 1000);
    await db.run(
        `INSERT INTO witness_observations
            (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via, kind)
         VALUES (?, ?, 'tbl', ?, ?, ?, 'live', 'game')`,
        `dev-${opts.userId}`, opts.userId, launch, exit, exit - launch,
    );
}

async function typedScore(roomId: string, tournamentId: string, gameId: string, gameName: string,
    username: string, userId: string, score: number, atMs: number) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_during_tournament_id, submitted_by_user_id, platform, engine, device, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'tournament', ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        gameName, roomId, gameId, username, userId, score, tournamentId, userId, sqliteTs(atMs),
    );
}

describe('W24 - dashboard reads events as rounds', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom(`w24-${crypto.randomUUID().slice(0, 8)}`);
    });

    it('a live event shows the ACTIVE round, its window, the state and the round-board leader (never a flagged score)', async () => {
        const db = await getDatabase();
        const now = Date.now();
        const tid = await makeEvent(roomId, 'WWS Night');
        const r1Start = now - 120 * MINUTE;
        const r2Start = now - 10 * MINUTE;
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [
                round(1, 'Medieval Madness', r1Start, 30),
                round(2, 'Attack from Mars', r2Start, 30),
                round(3, 'Twilight Zone', now + 60 * MINUTE, 30),
            ],
            checkinRequired: false,
        });
        const [r1, r2] = rounds;
        await db.run(`UPDATE games SET status = 'COMPLETED', start_date = ?, end_date = ? WHERE id = ?`,
            sqliteTs(r1Start), sqliteTs(r1Start + 30 * MINUTE), r1!.id);
        await db.run(`UPDATE games SET status = 'ACTIVE', start_date = ? WHERE id = ?`, sqliteTs(r2Start), r2!.id);

        // Round 1 (finished): Cat scored 9999 - must NOT be the leader of round 2.
        await typedScore(roomId, tid, r1!.id, 'Medieval Madness', 'Cat', '333333333333333333', 9999, r1Start + 5 * MINUTE);
        // Round 2: A geared up (launched before the round) for 900, B clean 700.
        await witnessedScore({
            roomId, tournamentId: tid, gameId: r2!.id, gameName: 'Attack from Mars',
            username: 'TomatoGrass', userId: USER_A, score: 900,
            launchMs: r2Start - 5 * MINUTE, exitMs: r2Start + 4 * MINUTE,
        });
        await witnessedScore({
            roomId, tournamentId: tid, gameId: r2!.id, gameName: 'Attack from Mars',
            username: 'Bee', userId: USER_B, score: 700,
            launchMs: r2Start + 2 * MINUTE, exitMs: r2Start + 6 * MINUTE,
        });

        const data = await getDashboardData(roomId);
        expect(data.activeTournaments).toHaveLength(1);
        const row = data.activeTournaments[0]!;
        expect(row.format).toBe('event');
        expect(row.event_state).toBe('live');
        expect(row.game_name).toBe('Attack from Mars');
        expect(row.game_id).toBe(r2!.id);
        expect(row.round_no).toBe(2);
        expect(row.round_count).toBe(3);
        expect(row.round_status).toBe('ACTIVE');
        expect(row.round_start_at).toBe(new Date(r2Start).toISOString());
        expect(row.round_end_at).toBe(new Date(r2Start + 30 * MINUTE).toISOString());
        // Under 'prevent' the flagged 900 is left out of the round board.
        expect(row.leader_name).toBe('Bee');
        expect(row.leader_score).toBe(700);
        expect(row.participants).toBe(3);
        expect(row.next_rotation_at).toBeNull();
    });

    it('an event with only SCHEDULED rounds shows the NEXT round and its state', async () => {
        const now = Date.now();
        const tid = await makeEvent(roomId, 'Friday Night', `checkin_opens_at='${new Date(now - 30 * MINUTE).toISOString()}'`);
        await EventService.createOrUpdateEvent(tid, {
            rounds: [
                round(1, 'Medieval Madness', now + 60 * MINUTE, 30),
                round(2, 'Attack from Mars', now + 120 * MINUTE, 30),
            ],
            checkinOpensAt: new Date(now - 30 * MINUTE).toISOString(),
            checkinRequired: false,
        });

        const row = (await getDashboardData(roomId)).activeTournaments[0]!;
        expect(row.format).toBe('event');
        expect(row.event_state).toBe('checkin');
        expect(row.round_no).toBe(1);
        expect(row.round_status).toBe('SCHEDULED');
        expect(row.game_name).toBe('Medieval Madness');
        expect(row.round_start_at).toBe(new Date(now + 60 * MINUTE).toISOString());
        expect(row.leader_name).toBeNull();
        expect(row.leader_score).toBeNull();
    });

    it('a not-yet-open event reads upcoming', async () => {
        const now = Date.now();
        const tid = await makeEvent(roomId, 'Next Week');
        await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'Medieval Madness', now + 7 * 24 * 60 * MINUTE, 30)],
            checkinOpensAt: new Date(now + 6 * 24 * 60 * MINUTE).toISOString(),
            checkinRequired: false,
        });
        const row = (await getDashboardData(roomId)).activeTournaments[0]!;
        expect(row.event_state).toBe('upcoming');
        expect(row.round_status).toBe('SCHEDULED');
    });

    it('a finished event shows its LAST round and finished', async () => {
        const db = await getDatabase();
        const now = Date.now();
        const tid = await makeEvent(roomId, 'Done Night');
        const r1Start = now - 300 * MINUTE;
        const r2Start = now - 200 * MINUTE;
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [round(1, 'Medieval Madness', r1Start, 30), round(2, 'Attack from Mars', r2Start, 30)],
            checkinRequired: false,
        });
        for (const [i, r] of rounds.entries()) {
            const start = i === 0 ? r1Start : r2Start;
            await db.run(`UPDATE games SET status = 'COMPLETED', start_date = ?, end_date = ? WHERE id = ?`,
                sqliteTs(start), sqliteTs(start + 30 * MINUTE), r.id);
        }
        await typedScore(roomId, tid, rounds[0]!.id, 'Medieval Madness', 'Ann', USER_A, 111, r1Start + 5 * MINUTE);
        await typedScore(roomId, tid, rounds[1]!.id, 'Attack from Mars', 'Ann', USER_A, 222, r2Start + 5 * MINUTE);
        await db.run(`UPDATE tournaments SET event_finished_at = ? WHERE id = ?`, new Date(now - 100 * MINUTE).toISOString(), tid);

        const row = (await getDashboardData(roomId)).activeTournaments[0]!;
        expect(row.event_state).toBe('finished');
        expect(row.round_no).toBe(2);
        expect(row.round_status).toBe('COMPLETED');
        expect(row.game_name).toBe('Attack from Mars');
        expect(row.leader_name).toBe('Ann');
        expect(row.leader_score).toBe(222);
    });

    it('an event with no rounds still yields an honest row', async () => {
        await makeEvent(roomId, 'Empty');
        const row = (await getDashboardData(roomId)).activeTournaments[0]!;
        expect(row.format).toBe('event');
        expect(row.event_state).toBe('upcoming');
        expect(row.round_no).toBeNull();
        expect(row.round_count).toBe(0);
        expect(row.game_name).toBeNull();
        expect(row.round_start_at).toBeNull();
    });

    it('a rotation tournament produces exactly the pre-change row (no event keys)', async () => {
        const db = await getDatabase();
        const tid = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gid = await createTestGame(tid, { name: 'Twilight Zone' });
        await db.run(
            `INSERT INTO submissions (id, game_id, iscored_username, discord_user_id, score, timestamp)
             VALUES (?, ?, 'Rob', 'u-rob', 5000, ?), (?, ?, 'Sue', 'u-sue', 7000, ?)`,
            `${gid}-rob`, gid, new Date().toISOString(),
            `${gid}-sue`, gid, new Date().toISOString(),
        );

        const data = await getDashboardData(roomId);
        expect(data.activeTournaments).toHaveLength(1);
        const row = data.activeTournaments[0]! as unknown as Record<string, unknown>;
        expect(row).toEqual({
            tournament_id: tid,
            tournament_name: 'Daily Grind',
            tournament_type: 'DG',
            cadence: '{}',
            game_id: gid,
            game_name: 'Twilight Zone',
            game_start_date: expect.any(String),
            game_image_url: null,
            leader_name: 'Sue',
            leader_score: 7000,
            participants: 2,
            next_rotation_at: null,
        });
        for (const k of ['format', 'event_state', 'round_no', 'round_count', 'round_status', 'round_start_at', 'round_end_at']) {
            expect(row).not.toHaveProperty(k);
        }
    });
});
