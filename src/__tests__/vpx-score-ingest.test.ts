import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessVerifyService } from '../services/WitnessVerifyService.js';

/**
 * P9 — VPXS auto score collection.
 *
 * The Witness reads the VPX launcher's own per-game records off the cabinet
 * stick and posts them here. Nobody typed these scores, so every guard is the
 * only thing between a stray file write and somebody's tournament standing.
 *
 * What these tests pin, worst-bug-first:
 *
 *   1. **A score never lands on a game the player is not actually in.** Room
 *      membership scopes the candidates; an ambiguous name is refused rather
 *      than assigned.
 *   2. **The round window decides**, on the same rule the AtGames path uses
 *      (the game's END time), so two sources on one board cannot disagree
 *      about what "inside the round" means.
 *   3. **An unmatched score is a 200, not a 401** — the device must not retry
 *      forever because the player played something untracked.
 *   4. **Ingest files the GAME as an observation**, which is what lets the
 *      existing verify join answer gear-up correctly: a VPX sitting contains
 *      several games, so verifying against the SESSION's launch would flag
 *      every game after the first.
 *   5. **A device token is still a device token**: wrong token writes nothing
 *      and reveals nothing.
 */

const USER = '123456789012345678';
const OTHER = '999999999999999999';
const DEVICE = 'fp-device-uuid-vpx';
const MINUTE = 60_000;

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

async function pairDevice(app: express.Express, user = USER, device = DEVICE) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(user)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device, username: 'CabinetOwner' });
    return pairRes.body.token as string;
}

/** The shape the cabinet sends: one completed game out of the launcher's jsonl. */
function scoreQuery(overrides: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Bad Cats (Williams 1989)',
        rom: 'bcats_l5',
        slug: 'vpx-badcats',
        score: 8366650,
        started: Math.floor((endedMs - 5 * MINUTE) / 1000),
        ended: Math.floor(endedMs / 1000),
        dur: 300,
        reason: 'game_over',
        ...overrides,
    };
}

async function addMember(roomId: string, userId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`,
        userId, roomId,
    );
}

async function createRotationGame(roomId: string, name: string, startDateMs = Date.now() - 60 * MINUTE) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Weekly VPXS', 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(startDateMs).toISOString(),
    );
    return { tournamentId, gameId };
}

async function createEventRound(roomId: string, name: string, startMs: number, endMs: number) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, end_grace_sec)
         VALUES (?, 'Stream Night', 'DG', 'pinball', '{}', 1, ?, 'event', 60)`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no,
                            scheduled_start_at, scheduled_end_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, 1, ?, ?)`,
        gameId, tournamentId, name, roomId,
        new Date(startMs).toISOString(), new Date(endMs).toISOString(),
    );
    return { tournamentId, gameId };
}

describe('VPXS auto score collection — ingest', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairDevice(app);
        await addMember(roomId, USER);
    });

    it('lands a launcher-recorded score on the active rotation game', async () => {
        const { gameId, tournamentId } = await createRotationGame(roomId, 'Bad Cats');

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });

        const db = await getDatabase();
        const row = await db.get<{ score: number; source: string; engine: string; device: string;
                                  game_id: string; submitted_during_tournament_id: string;
                                  submitted_by_user_id: string }>(
            `SELECT score, source, engine, device, game_id, submitted_during_tournament_id,
                    submitted_by_user_id
               FROM score_history ORDER BY id DESC LIMIT 1`,
        );
        expect(row).toMatchObject({
            score: 8366650,
            source: 'vpx',
            // Provenance is KNOWN, unlike an iScored sync: it came out of the
            // VPX launcher on a paired cabinet.
            engine: 'vpx',
            device: 'atgames',
            game_id: gameId,
            submitted_during_tournament_id: tournamentId,
            submitted_by_user_id: USER,
        });
    });

    it('stamps the launcher\'s own timestamp, not the moment we received it', async () => {
        await createRotationGame(roomId, 'Bad Cats');
        const endedSec = Math.floor((Date.now() - 40 * MINUTE) / 1000);

        await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery({
                started: endedSec - 300, ended: endedSec,
            }) });

        const db = await getDatabase();
        const row = await db.get<{ created_at: string }>(
            `SELECT created_at FROM score_history ORDER BY id DESC LIMIT 1`,
        );
        // Stored SQLite-UTC ('YYYY-MM-DD HH:MM:SS'), and it must be the game's
        // end — the witness join keys on it.
        const storedSec = Math.floor(Date.parse(`${row!.created_at}Z`) / 1000);
        expect(storedSec).toBe(endedSec);
    });

    it('files the GAME as a witness observation so the verify join can use it', async () => {
        await createRotationGame(roomId, 'Bad Cats');
        const q = scoreQuery();

        await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...q });

        const db = await getDatabase();
        const obs = await db.get<{ launch_ts: number; exit_ts: number; canonical_user_id: string }>(
            `SELECT launch_ts, exit_ts, canonical_user_id FROM witness_observations
              ORDER BY id DESC LIMIT 1`,
        );
        expect(obs).toMatchObject({
            launch_ts: q.started, exit_ts: q.ended, canonical_user_id: USER,
        });
    });

    it('verifies a game launched inside the round, and flags one launched before it', async () => {
        // The point of filing the GAME (not the session): one VPX sitting holds
        // several games, so the second game of a legitimate sitting must not be
        // flagged for a session that began before the round.
        const roundStart = Math.floor(Date.now() / 1000) - 10 * 60;

        const inside = await WitnessVerifyService.verdictsForRound({
            roundStartEpoch: roundStart,
            rows: [{ identityKey: USER, createdEpoch: roundStart + 400, source: 'vpx' }],
        });
        // Eligible, but nothing seen yet: `unwitnessed` is the NEUTRAL default
        // (ADR 0020) — `null` would mean "no verdict applies to this row at all".
        expect(inside[0]).toMatchObject({ status: 'unwitnessed' });

        const db = await getDatabase();
        await db.run(
            `INSERT INTO witness_observations
                (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via)
             VALUES (?, ?, 'Bad Cats (Williams 1989)', ?, ?, 300, 'live')`,
            DEVICE, USER, roundStart + 100, roundStart + 400,
        );
        const verified = await WitnessVerifyService.verdictsForRound({
            roundStartEpoch: roundStart,
            rows: [{ identityKey: USER, createdEpoch: roundStart + 400, source: 'vpx' }],
        });
        expect(verified[0]).toMatchObject({ status: 'verified', method: 'session' });

        await db.run(
            `INSERT INTO witness_observations
                (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via)
             VALUES (?, ?, 'Bad Cats (Williams 1989)', ?, ?, 900, 'live')`,
            DEVICE, USER, roundStart - 600, roundStart + 900,
        );
        const flagged = await WitnessVerifyService.verdictsForRound({
            roundStartEpoch: roundStart,
            rows: [{ identityKey: USER, createdEpoch: roundStart + 900, source: 'vpx' }],
        });
        expect(flagged[0]).toMatchObject({ status: 'flagged' });
    });

    it('matches on the rom or the slug when the display name is not what the room called it', async () => {
        // FINDINGS-0s: `rom` is a PinMAME id for real machines and free text for
        // originals, and the session journal's name carries a manufacturer/year
        // parenthetical the room almost never types.
        await createRotationGame(roomId, 'Bad Cats');
        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery({ table: '', rom: '', slug: 'vpx-badcats' }) });
        expect(res.body).toMatchObject({ status: 'ingested' });
    });

    it('answers 200/no_match — never 401 — for a table no open game covers', async () => {
        await createRotationGame(roomId, 'Attack from Mars');

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, status: 'no_match' });
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_history`);
        expect(count!.n).toBe(0);
    });

    it('refuses to guess when two open games share the name', async () => {
        const otherRoom = await createTestRoom('other-room', 'Other Room');
        await addMember(otherRoom, USER);
        await createRotationGame(roomId, 'Bad Cats');
        await createRotationGame(otherRoom, 'Bad Cats');

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'no_match' });
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_history`);
        expect(count!.n).toBe(0);
    });

    it('prefers an event round over a rotation game of the same name', async () => {
        const now = Date.now();
        await createRotationGame(roomId, 'Bad Cats');
        const round = await createEventRound(roomId, 'Bad Cats', now - 10 * MINUTE, now + 10 * MINUTE);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'ingested' });
        const db = await getDatabase();
        const row = await db.get<{ game_id: string }>(
            `SELECT game_id FROM score_history ORDER BY id DESC LIMIT 1`,
        );
        expect(row!.game_id).toBe(round.gameId);
    });

    it('keeps a score out of a round it ended outside of, grace included', async () => {
        const now = Date.now();
        await createEventRound(roomId, 'Bad Cats', now - 60 * MINUTE, now - 30 * MINUTE);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'no_match' });
    });

    it('respects a tournament that excludes VPX', async () => {
        const { tournamentId } = await createRotationGame(roomId, 'Bad Cats');
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET platform_rules = ? WHERE id = ?`,
            JSON.stringify({ engines: { required: [], excluded: ['vpx'] },
                             devices: { required: [], excluded: [] } }),
            tournamentId,
        );

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'no_match' });
    });

    it('ignores rooms the cabinet owner is not a member of', async () => {
        const strangersRoom = await createTestRoom('strangers', 'Strangers');
        await addMember(strangersRoom, OTHER);
        await createRotationGame(strangersRoom, 'Bad Cats');

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'no_match' });
    });

    it('is idempotent — a re-sent record adds nothing', async () => {
        await createRotationGame(roomId, 'Bad Cats');
        const q = scoreQuery();

        const first = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...q });
        const second = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...q });

        expect(first.body.status).toBe('ingested');
        expect(second.body.status).toBe('duplicate');
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_history`);
        expect(count!.n).toBe(1);
    });

    it('writes nothing for a wrong token, and says only 401', async () => {
        await createRotationGame(roomId, 'Bad Cats');

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token: 'not-the-token', ...scoreQuery() });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false });
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_history`);
        expect(count!.n).toBe(0);
    });

    it('rejects a non-positive score rather than storing it', async () => {
        await createRotationGame(roomId, 'Bad Cats');
        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery({ score: 0 }) });
        expect(res.body).toMatchObject({ status: 'invalid' });
    });
});
