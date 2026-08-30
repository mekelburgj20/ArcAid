import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { EventService } from '../services/EventService.js';
import { EventResultService } from '../services/EventResultService.js';
import {
    WitnessVerifyService, JOIN_TOLERANCE_SEC, LAUNCH_GRACE_SEC,
} from '../services/WitnessVerifyService.js';

/**
 * P8 — the Arcaid Witness verify-join (v2.145.0, ADR 0020).
 *
 * The join exists because AtGames is exit-to-submit: their timestamp proves a
 * score LANDED inside the round window and says nothing about when the table
 * was launched, and AtGames does not filter gear-up (owner-tested on hardware,
 * 2026-08-25). What these tests pin, worst-bug-first:
 *
 *   1. **A false `verified` is the expensive bug.** An observation belonging to
 *      somebody else, or landing minutes away from the score, must never be
 *      joined to it.
 *   2. **`unwitnessed` is neutral, and it is the common case.** No paired
 *      cabinet must read as "no verdict applies", never as suspicion, and never
 *      as a mark on the standings.
 *   3. **The verdict is a badge, not a gate.** Nothing here removes a score
 *      from a board or changes a rank.
 */

const MINUTE = 60_000;
const BASE = Date.parse('2026-09-01T20:00:00.000Z');
const BASE_EPOCH = Math.floor(BASE / 1000);
const USER = '123456789012345678';
const OTHER = '999999999999999999';
const DEVICE = 'fp-device-0001';

async function makeEventTournament(roomId: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
        id, roomId,
    );
    return id;
}

function round(no: number, gameName: string, startMs: number, lengthMin: number) {
    return {
        roundNo: no,
        gameName,
        scheduledStartAt: new Date(startMs).toISOString(),
        scheduledEndAt: new Date(startMs + lengthMin * MINUTE).toISOString(),
    };
}

/** An AtGames-sourced score row, stamped exactly as `AtGamesEventSyncService` writes one. */
async function atgamesScore(opts: {
    roomId: string; tournamentId: string; gameId: string; gameName: string;
    username: string; userId: string | null; atgamesAccount?: number;
    score: number; at: Date; source?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            platform, engine, device, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'atgames', 'atgames_native', 'atgames', ?)`,
        opts.gameName, opts.roomId, opts.gameId, opts.username,
        opts.userId ?? `atgames:${opts.atgamesAccount ?? 11}`,
        opts.score, opts.source ?? 'atgames',
        opts.roomId, opts.tournamentId, opts.userId,
        opts.at.toISOString().replace('T', ' ').slice(0, 19),
    );
}

/** A cabinet observation, as the Witness app reports one. */
async function observe(opts: {
    userId: string; table?: string; launchMs: number; exitMs: number; device?: string;
    via?: 'live' | 'retro';
}) {
    const db = await getDatabase();
    const launch = Math.floor(opts.launchMs / 1000);
    const exit = Math.floor(opts.exitMs / 1000);
    await db.run(
        `INSERT INTO witness_observations
            (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        opts.device ?? DEVICE, opts.userId, opts.table ?? 'aerobatics', launch, exit, exit - launch,
        opts.via ?? 'live',
    );
}

/** A round-start check-in — tier 2. The stored time is the SERVER's, so tests set it explicitly. */
async function checkin(opts: { userId: string; atMs: number; device?: string }) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_checkins (atgames_unique_id, canonical_user_id, server_ts)
         VALUES (?, ?, ?)`,
        opts.device ?? DEVICE, opts.userId,
        new Date(opts.atMs).toISOString().replace('T', ' ').slice(0, 19),
    );
}

describe('WitnessVerifyService — verdicts', () => {
    beforeEach(async () => { await setupTestDb(); });

    const verdict = (rows: Array<{ identityKey: string; createdEpoch: number | null; source: string | null }>) =>
        WitnessVerifyService.verdictsForRound({ roundStartEpoch: BASE_EPOCH, rows });

    it('verifies a score whose session launched inside the round and exited at the score', async () => {
        await observe({
            userId: USER,
            launchMs: BASE + 2 * MINUTE,
            exitMs: BASE + 10 * MINUTE,
        });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'atgames' },
        ]);

        expect(v).toMatchObject({
            status: 'verified',
            launchTs: Math.floor((BASE + 2 * MINUTE) / 1000),
            exitTs: Math.floor((BASE + 10 * MINUTE) / 1000),
            durationSec: 8 * 60,
            // The engine-internal id, surfaced for a human — never matched.
            table: 'aerobatics',
        });
    });

    it('flags a session launched minutes BEFORE the round opened — the gear-up case', async () => {
        await observe({
            userId: USER,
            launchMs: BASE - 10 * MINUTE,
            exitMs: BASE + 5 * MINUTE,
        });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 5 * MINUTE) / 1000), source: 'atgames' },
        ]);

        expect(v?.status).toBe('flagged');
        expect(v?.launchTs).toBe(Math.floor((BASE - 10 * MINUTE) / 1000));
    });

    it('treats a launch inside the grace window as on time — that is clock slop, not gear-up', async () => {
        await observe({
            userId: USER,
            launchMs: BASE - (LAUNCH_GRACE_SEC - 5) * 1000,
            exitMs: BASE + 4 * MINUTE,
        });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 4 * MINUTE) / 1000), source: 'atgames' },
        ]);

        expect(v?.status).toBe('verified');
    });

    it('is unwitnessed when the player has no observation at all', async () => {
        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 5 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v).toEqual({
            status: 'unwitnessed', method: null, launchTs: null, exitTs: null,
            durationSec: null, table: null, via: null, checkinTs: null,
        });
    });

    it('is unwitnessed when the only observation exits well outside the tolerance', async () => {
        // 3 minutes off, with a 2-minute tolerance — a cabinet whose clock has
        // drifted that far cannot be joined honestly, so it reads as neutral.
        await observe({
            userId: USER,
            launchMs: BASE + 1 * MINUTE,
            exitMs: BASE + 8 * MINUTE,
        });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 11 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('unwitnessed');
    });

    it('never joins an observation owned by a DIFFERENT user', async () => {
        // The expensive bug: someone else's perfectly good session verifying
        // this player's score.
        await observe({
            userId: OTHER,
            launchMs: BASE + 2 * MINUTE,
            exitMs: BASE + 10 * MINUTE,
        });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('unwitnessed');
    });

    it('picks the NEAREST exit when two sessions of the same table both fit', async () => {
        await observe({
            userId: USER, launchMs: BASE + 1 * MINUTE, exitMs: BASE + 10 * MINUTE - 90_000,
        });
        await observe({
            userId: USER, launchMs: BASE + 8 * MINUTE, exitMs: BASE + 10 * MINUTE - 5_000,
        });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.launchTs).toBe(Math.floor((BASE + 8 * MINUTE) / 1000));
    });

    it('gives no verdict at all to a row that is not AtGames-sourced', async () => {
        await observe({ userId: USER, launchMs: BASE + 2 * MINUTE, exitMs: BASE + 10 * MINUTE });

        const verdicts = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'community' },
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'sync' },
            { identityKey: USER, createdEpoch: null, source: 'atgames' },
        ]);
        // A phone submit keeps its own min-elapsed heuristic; a timestamp-less
        // row has no join key. Neither is "unwitnessed" — no verdict applies.
        expect(verdicts).toEqual([null, null, null]);
    });

    it('resolves the observation through the identity link graph', async () => {
        const db = await getDatabase();
        // The player paired their cabinet under their Google identity and their
        // score is attributed to the linked Discord account.
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES ('google:abc', ?)`,
            USER,
        );
        await observe({ userId: 'google:abc', launchMs: BASE + 2 * MINUTE, exitMs: BASE + 10 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('verified');
    });

    it('leaves an unlinked atgames:* synthetic identity unwitnessed', async () => {
        // A synthetic key owns no devices — it falls out naturally, with no
        // special-casing, and must never pick up somebody else's session.
        await observe({ userId: USER, launchMs: BASE + 2 * MINUTE, exitMs: BASE + 10 * MINUTE });

        const [v] = await verdict([
            { identityKey: 'atgames:50177', createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('unwitnessed');
    });

    it('exposes its tolerances as the constants the rest of the system reads', () => {
        expect(JOIN_TOLERANCE_SEC).toBe(120);
        expect(LAUNCH_GRACE_SEC).toBe(15);
    });

    it('carries method:session and the observation`s via tag on a tier-1 verdict', async () => {
        await observe({ userId: USER, launchMs: BASE + 2 * MINUTE, exitMs: BASE + 10 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v).toMatchObject({ status: 'verified', method: 'session', via: 'live', checkinTs: null });
    });

    it('treats a RETRO observation exactly like a live one, tagging it only', async () => {
        // Owner ruling 2026-08-29: same trust, tagged. A retro-derived session
        // describes the same play, read from the same device — downgrading it
        // would throw away real evidence for a distinction that changes nothing.
        await observe({
            userId: USER, launchMs: BASE + 2 * MINUTE, exitMs: BASE + 10 * MINUTE, via: 'retro',
        });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 10 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v).toMatchObject({ status: 'verified', method: 'session', via: 'retro' });
    });
});

describe('WitnessVerifyService — tier 2, the check-in attestation', () => {
    beforeEach(async () => { await setupTestDb(); });

    const verdict = (rows: Array<{ identityKey: string; createdEpoch: number | null; source: string | null }>) =>
        WitnessVerifyService.verdictsForRound({ roundStartEpoch: BASE_EPOCH, rows });

    it('verifies on a check-in inside the window when no session was observed', async () => {
        // The cabinet runs one thing at a time: the Witness being open at
        // BASE+1m proves no table was mid-session then, so a score that exited
        // at BASE+9m was necessarily launched inside the round.
        await checkin({ userId: USER, atMs: BASE + 1 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v).toEqual({
            status: 'verified',
            method: 'checkin',
            // A check-in dates the play; it does not measure it.
            launchTs: null, exitTs: null, durationSec: null, table: null, via: null,
            checkinTs: Math.floor((BASE + 1 * MINUTE) / 1000),
        });
    });

    it('accepts a check-in inside the launch grace, exactly as tier 1 does', async () => {
        await checkin({ userId: USER, atMs: BASE - (LAUNCH_GRACE_SEC - 5) * 1000 });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 6 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('verified');
        expect(v?.method).toBe('checkin');
    });

    it('proves nothing from a check-in BEFORE the round opened', async () => {
        // The cabinet could have been idle then and busy with a geared-up table
        // by the time the round started.
        await checkin({ userId: USER, atMs: BASE - 20 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('unwitnessed');
        expect(v?.method).toBeNull();
    });

    it('proves nothing from a check-in AFTER the score exited', async () => {
        await checkin({ userId: USER, atMs: BASE + 15 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('unwitnessed');
    });

    it('never joins a check-in owned by a DIFFERENT user', async () => {
        await checkin({ userId: OTHER, atMs: BASE + 1 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('unwitnessed');
    });

    it('resolves a check-in through the identity link graph', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES ('google:abc', ?)`,
            USER,
        );
        await checkin({ userId: 'google:abc', atMs: BASE + 1 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.method).toBe('checkin');
    });

    it('lets tier 1 win when a session AND a check-in could both fire', async () => {
        await observe({ userId: USER, launchMs: BASE + 2 * MINUTE, exitMs: BASE + 9 * MINUTE });
        await checkin({ userId: USER, atMs: BASE + 1 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.method).toBe('session');
        expect(v?.durationSec).toBe(7 * 60);
    });

    it('leaves a FLAGGED row flagged — a check-in never talks a verdict down', async () => {
        // The expensive regression: gear-up evidenced by a real session, then
        // excused by opening the app. Tier 2 only ever upgrades an
        // `unwitnessed`, and never revisits tier 1.
        await observe({ userId: USER, launchMs: BASE - 12 * MINUTE, exitMs: BASE + 9 * MINUTE });
        await checkin({ userId: USER, atMs: BASE + 1 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.status).toBe('flagged');
        expect(v?.method).toBe('session');
    });

    it('gives a check-in verdict to no row that is not AtGames-sourced', async () => {
        await checkin({ userId: USER, atMs: BASE + 1 * MINUTE });

        const verdicts = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'community' },
            { identityKey: USER, createdEpoch: null, source: 'atgames' },
        ]);
        expect(verdicts).toEqual([null, null]);
    });

    it('picks the LATEST qualifying check-in when several are in the window', async () => {
        // More check-ins can only ever help, and the tightest gap between
        // "cabinet was free" and "score landed" is the strongest claim.
        await checkin({ userId: USER, atMs: BASE + 1 * MINUTE });
        await checkin({ userId: USER, atMs: BASE + 7 * MINUTE });

        const [v] = await verdict([
            { identityKey: USER, createdEpoch: Math.floor((BASE + 9 * MINUTE) / 1000), source: 'atgames' },
        ]);
        expect(v?.checkinTs).toBe(Math.floor((BASE + 7 * MINUTE) / 1000));
    });
});

describe('Live Event boards — witness verdicts', () => {
    let roomId: string;
    let tid: string;
    let r1: string;
    let r2: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        tid = await makeEventTournament(roomId);
        const rounds = await EventService.createOrUpdateEvent(tid, {
            rounds: [
                round(1, 'Medieval Madness', BASE, 20),
                round(2, 'Attack from Mars', BASE + 30 * MINUTE, 20),
            ],
            checkinRequired: false,
        });
        r1 = rounds[0]!.id;
        r2 = rounds[1]!.id;
    });

    it('attaches a verdict to each AtGames row and nothing to the rest', async () => {
        await atgamesScore({
            roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness',
            username: 'Ann', userId: USER, score: 900, at: new Date(BASE + 10 * MINUTE),
        });
        await atgamesScore({
            roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness',
            username: 'Bob', userId: OTHER, score: 500, at: new Date(BASE + 12 * MINUTE),
            source: 'community',
        });
        await observe({ userId: USER, launchMs: BASE + 2 * MINUTE, exitMs: BASE + 10 * MINUTE });

        const event = (await EventService.getEvent(tid))!;
        const rounds = await EventService.getRounds(tid);
        const board = await EventResultService.getRoundBoard(event, rounds[0]!);

        expect(board.scores.map(s => s.iscored_username)).toEqual(['Ann', 'Bob']);
        expect(board.scores[0]!.witness?.status).toBe('verified');
        expect(board.scores[0]!.witness?.durationSec).toBe(8 * 60);
        // A community (phone) submit gets no witness verdict at all.
        expect(board.scores[1]!.witness).toBeNull();
    });

    it('marks a flagged score on the board without removing it or changing the ranks', async () => {
        await atgamesScore({
            roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness',
            username: 'Ann', userId: USER, score: 900, at: new Date(BASE + 10 * MINUTE),
        });
        await observe({ userId: USER, launchMs: BASE - 15 * MINUTE, exitMs: BASE + 10 * MINUTE });

        const event = (await EventService.getEvent(tid))!;
        const rounds = await EventService.getRounds(tid);
        const board = await EventResultService.getRoundBoard(event, rounds[0]!);

        // A badge, never a gate: the score is still there, still rank 1.
        expect(board.scores).toHaveLength(1);
        expect(board.scores[0]!.rank).toBe(1);
        expect(board.scores[0]!.witness?.status).toBe('flagged');
    });

    it('propagates witnessFlagged into the standings, and only from flagged rounds', async () => {
        // Ann is flagged in round 1 and clean in round 2; Bob is unwitnessed
        // throughout, which must never mark him.
        await atgamesScore({
            roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness',
            username: 'Ann', userId: USER, score: 400, at: new Date(BASE + 10 * MINUTE),
        });
        await atgamesScore({
            roomId, tournamentId: tid, gameId: r2, gameName: 'Attack from Mars',
            username: 'Ann', userId: USER, score: 600, at: new Date(BASE + 40 * MINUTE),
        });
        await atgamesScore({
            roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness',
            username: 'Bob', userId: OTHER, score: 900, at: new Date(BASE + 11 * MINUTE),
        });
        await observe({ userId: USER, launchMs: BASE - 15 * MINUTE, exitMs: BASE + 10 * MINUTE });
        await observe({
            userId: USER, table: 'afm', device: 'fp-device-0002',
            launchMs: BASE + 32 * MINUTE, exitMs: BASE + 40 * MINUTE,
        });

        const standings = (await EventResultService.computeStandings(tid))!;
        const ann = standings.standings.find(r => r.iscored_username === 'Ann')!;
        const bob = standings.standings.find(r => r.iscored_username === 'Bob')!;

        expect(ann.witnessFlagged).toBe(true);
        expect(bob.witnessFlagged).toBe(false);
        // The flag changes nothing about the ranking itself.
        expect(standings.standings.map(r => r.iscored_username)).toEqual(['Bob', 'Ann']);
    });

    it('freezes witnessFlagged into the result blob without any display fields', async () => {
        await atgamesScore({
            roomId, tournamentId: tid, gameId: r1, gameName: 'Medieval Madness',
            username: 'Ann', userId: USER, score: 400, at: new Date(BASE + 10 * MINUTE),
        });
        await observe({ userId: USER, launchMs: BASE - 15 * MINUTE, exitMs: BASE + 10 * MINUTE });

        const frozen = (await EventResultService.compute(tid, new Date(BASE + 60 * MINUTE).toISOString()))!;
        const row = frozen.standings[0]! as Record<string, unknown>;
        expect(row.witnessFlagged).toBe(true);
        // Identity-stable only — the doctrine `event_result` shares with
        // `leaderboard_cache`.
        expect(row).not.toHaveProperty('display_name');
        expect(row).not.toHaveProperty('avatar_hash');
    });
});
