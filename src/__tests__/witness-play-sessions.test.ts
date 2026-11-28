import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * W131.2 (ADR 0045, docs/shared-device-plan.md §4-§5) - who is playing on a
 * shared Witness device, and whose each play is. A device with one person on
 * it is unchanged; a shared one credits each play by device slot, then the
 * game's own attempt, then the session open at the game's start on the
 * server's clock (via `clock_offset`), then the session open on arrival.
 */
const WIFE = '111111111111111111';
const HUSBAND = '222222222222222222';
const CAB = 'cab-family';

let app: express.Express;
let token: string;

async function svc() {
    const { WitnessService } = await import('../services/WitnessService.js');
    const { WitnessDevicePlayersService } = await import('../services/WitnessDevicePlayersService.js');
    const { WitnessPlaySessionService } = await import('../services/WitnessPlaySessionService.js');
    return { W: WitnessService, P: WitnessDevicePlayersService, S: WitnessPlaySessionService };
}

async function pair(user: string, deviceId = CAB): Promise<string> {
    const { W } = await svc();
    const { code } = await W.createPairingCode(user);
    return (await W.redeemPairingCode(code, deviceId, null, 'atgames')).token;
}

/** The device has sent a clock offset (ruling 5), then the husband joins. */
async function household(): Promise<void> {
    const res = await request(app).get('/api/witness/heartbeat').query({ device: CAB, token, clock_offset: '0' });
    expect(res.status).toBe(200);
    const { P } = await svc();
    const { code } = await P.createInvite(WIFE, CAB);
    await P.acceptInvite(HUSBAND, code);
}

/** A session row at explicit SERVER times (epoch seconds). */
async function sessionAt(userId: string, startEpoch: number, endEpoch: number | null): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_play_sessions (device_id, canonical_user_id, started_at, ended_at, started_via)
         VALUES (?, ?, datetime(?, 'unixepoch'), ${endEpoch == null ? 'NULL' : `datetime(${endEpoch}, 'unixepoch')`}, 'web')`,
        CAB, userId, startEpoch,
    );
}

async function slotOf(userId: string): Promise<string> {
    const db = await getDatabase();
    return (await db.get<{ slot: string }>(
        `SELECT slot FROM witness_device_players WHERE device_id = ? AND canonical_user_id = ?`, CAB, userId,
    ))!.slot;
}

beforeEach(async () => {
    await setupTestDb();
    app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    token = await pair(WIFE);
});

describe('W131.2 play sessions', () => {
    it('a device with one person on it credits that person, as before', async () => {
        const { S } = await svc();
        expect(await S.resolve(CAB, { clockOffset: 0, startedTs: 1_800_000_000 })).toEqual({ userId: WIFE, kind: 'only', sessionId: null });
        const res = await request(app).get('/api/witness/heartbeat').query({ device: CAB, token });
        expect(res.body.now).toMatch(/^\d+$/);
        // Nothing that does not apply is sent: an unshared device names no player.
        expect(res.body.playerSlot).toBeUndefined();
        expect(res.body.playingAs).toBeUndefined();
    });

    it('a second player waits for a build that sends a clock offset (ruling 5)', async () => {
        const { P } = await svc();
        await expect(P.createInvite(WIFE, CAB)).rejects.toMatchObject({ code: 'DEVICE_NOT_READY' });
        // Any device call carrying a valid offset marks the build as able; garbage does not.
        await request(app).get('/api/witness/heartbeat').query({ device: CAB, token, clock_offset: 'soon' });
        await expect(P.createInvite(WIFE, CAB)).rejects.toMatchObject({ code: 'DEVICE_NOT_READY' });
        await request(app).get('/api/witness/heartbeat').query({ device: CAB, token, clock_offset: '-143734' });
        await expect(P.createInvite(WIFE, CAB)).resolves.toMatchObject({ code: expect.any(String) });
    });

    it('with nobody chosen, the default player plays; a switch on the web reaches the device', async () => {
        await household();
        const { S, W } = await svc();
        expect((await S.playingAs(CAB))).toMatchObject({ userId: WIFE, isDefault: true });

        const res = await request(app).get('/api/witness/heartbeat').query({ device: CAB, token });
        expect(res.body.playerSlot).toBe(await slotOf(WIFE));

        await S.switchTo({ deviceId: CAB, targetUserId: HUSBAND, actorId: WIFE, via: 'web' });
        const after = await request(app).get('/api/witness/heartbeat').query({ device: CAB, token });
        expect(after.body.playerSlot).toBe(await slotOf(HUSBAND));
        expect((await W.listDevices(WIFE))[0]).toMatchObject({
            playerCount: 2, householdReady: true, playingAs: { userId: HUSBAND, isDefault: false, isYou: false },
        });

        // Switching to whoever is playing writes nothing new.
        await S.switchTo({ deviceId: CAB, targetUserId: HUSBAND, actorId: HUSBAND, via: 'web' });
        const db = await getDatabase();
        expect((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM witness_play_sessions WHERE device_id = ?`, CAB))!.n).toBe(1);
    });

    it('a play belongs to the session open at its START on the server clock', async () => {
        await household();
        const { S } = await svc();
        const now = Math.floor(Date.now() / 1000);
        await sessionAt(WIFE, now - 7200, now - 3600);   // she played until an hour ago
        await sessionAt(HUSBAND, now - 3600, null);      // he has played since

        // The device clock runs 40 h behind: +144000 s turns its times into the server's.
        const offset = 144_000;
        const herGame = (now - 5400) - offset;
        const hisGame = (now - 600) - offset;
        expect(await S.resolve(CAB, { startedTs: herGame, clockOffset: offset })).toMatchObject({ userId: WIFE, kind: 'session' });
        expect(await S.resolve(CAB, { startedTs: hisGame, clockOffset: offset })).toMatchObject({ userId: HUSBAND, kind: 'session' });
        // Before any session: the default player.
        expect(await S.resolve(CAB, { startedTs: now - 99_999 - offset, clockOffset: offset }))
            .toEqual({ userId: WIFE, kind: 'session', sessionId: null });
        // No offset: whoever is playing when the report arrives, marked as such.
        expect(await S.resolve(CAB, { startedTs: herGame })).toMatchObject({ userId: HUSBAND, kind: 'fallback' });
    });

    it('the slot the device held wins; a score follows its own attempt', async () => {
        await household();
        const { S } = await svc();
        await S.switchTo({ deviceId: CAB, targetUserId: HUSBAND, actorId: WIFE, via: 'web' });
        expect(await S.resolve(CAB, { slot: await slotOf(WIFE), clockOffset: 0, startedTs: Math.floor(Date.now() / 1000) }))
            .toEqual({ userId: WIFE, kind: 'device', sessionId: null });
        // An unknown slot is ignored, not trusted.
        expect(await S.resolve(CAB, { slot: 'deadbeef' })).toMatchObject({ userId: HUSBAND, kind: 'fallback' });

        const db = await getDatabase();
        await db.run(
            `INSERT INTO attempts (tournament_id, game_id, canonical_user_id, device_id, attempt_key, attempt_no, status, started_ts)
             VALUES ('t', 'g', ?, ?, 'k-1', 1, 'counted', 1)`,
            WIFE, CAB,
        );
        expect(await S.resolve(CAB, { attemptKey: 'k-1' })).toEqual({ userId: WIFE, kind: 'attempt', sessionId: null });
    });

    it('the cabinet lists its players and switches who is playing', async () => {
        await household();
        const list = await request(app).get('/api/witness/players').query({ device: CAB, token });
        expect(list.body).toMatchObject({ ok: true, playerCount: '2', player1Playing: '1', player2Playing: '0' });
        expect(list.body.player2Slot).toBe(await slotOf(HUSBAND));

        const play = await request(app).get('/api/witness/play-as').query({ device: CAB, token, slot: list.body.player2Slot });
        expect(play.body).toMatchObject({ ok: true, playerSlot: await slotOf(HUSBAND) });
        const { S } = await svc();
        expect(await S.playingAs(CAB)).toMatchObject({ userId: HUSBAND, via: 'cabinet' });

        expect((await request(app).get('/api/witness/play-as').query({ device: CAB, token, slot: 'deadbeef' })).status).toBe(400);
        expect((await request(app).get('/api/witness/players').query({ device: CAB, token: 'wrong' })).status).toBe(401);
    });

    it('observations and check-ins are filed under the player; the verify join credits everyone on the device', async () => {
        await household();
        const { W } = await svc();
        // He has been playing for an hour (a session started before the table opened).
        await sessionAt(HUSBAND, Math.floor(Date.now() / 1000) - 3600, null);
        const launch = Math.floor(Date.now() / 1000) - 600;
        const exit = launch + 300;
        expect(await W.recordObservation({ atgamesUniqueId: CAB, token, tableName: 'Medieval Madness', launchTs: launch, exitTs: exit, clockOffset: '0' })).toBe(true);
        const db = await getDatabase();
        expect((await db.get<{ canonical_user_id: string }>(`SELECT canonical_user_id FROM witness_observations WHERE atgames_unique_id = ?`, CAB))!.canonical_user_id).toBe(HUSBAND);

        // An AtGames-native score is the family AtGames account's (here, the
        // wife's): the husband's session must not cost it the ✓.
        const { WitnessVerifyService } = await import('../services/WitnessVerifyService.js');
        const [verdict] = await WitnessVerifyService.verdictsForRound({
            roundStartEpoch: launch - 60,
            rows: [{ identityKey: WIFE, createdEpoch: exit + 5, source: 'atgames' }],
        });
        expect(verdict).toMatchObject({ status: 'verified', method: 'session' });
        // A stranger's score at the same moment does not borrow the cabinet.
        const [stranger] = await WitnessVerifyService.verdictsForRound({
            roundStartEpoch: launch - 60,
            rows: [{ identityKey: '999999999999999999', createdEpoch: exit + 5, source: 'atgames' }],
        });
        expect(stranger).toMatchObject({ status: 'unwitnessed' });

        await W.recordCheckin(CAB, token);
        expect((await db.get<{ canonical_user_id: string }>(`SELECT canonical_user_id FROM witness_checkins WHERE atgames_unique_id = ?`, CAB))!.canonical_user_id).toBe(HUSBAND);
    });

    it('a score on a shared device is the player\'s, and its trail row says how that was decided', async () => {
        await household();
        const { W } = await svc();
        const now = Math.floor(Date.now() / 1000);
        await sessionAt(HUSBAND, now - 3600, null);
        const result = await W.recordVpxScore({
            atgamesUniqueId: CAB, token, tableName: 'No Such Table', score: 1234560,
            startedTs: now - 300, endedTs: now - 10, clockOffset: '0',
        });
        expect(result).not.toBeNull();
        const db = await getDatabase();
        const trail = await db.get<{ canonical_user_id: string; attribution: string; play_session_id: number | null }>(
            `SELECT canonical_user_id, attribution, play_session_id FROM witness_evidence WHERE device_id = ? ORDER BY id DESC LIMIT 1`, CAB,
        );
        expect(trail).toMatchObject({ canonical_user_id: HUSBAND, attribution: 'session' });
        expect(trail!.play_session_id).toBeTypeOf('number');
    });

    it('leaving ends your session; the pairing account may leave once another owner stays', async () => {
        await household();
        const { P, S } = await svc();
        await S.switchTo({ deviceId: CAB, targetUserId: HUSBAND, actorId: HUSBAND, via: 'web' });
        await P.removePlayer(HUSBAND, CAB, HUSBAND);
        expect(await S.playingAs(CAB)).toMatchObject({ userId: WIFE, isDefault: true });

        const { code } = await P.createInvite(WIFE, CAB);
        await P.acceptInvite(HUSBAND, code);
        await P.setRole(WIFE, CAB, HUSBAND, 'owner');
        await P.removePlayer(WIFE, CAB, WIFE);
        // She paired it, but plays now default to the owner who stayed.
        expect(await S.playingAs(CAB)).toMatchObject({ userId: HUSBAND, isDefault: true });
        expect(await S.resolve(CAB)).toEqual({ userId: HUSBAND, kind: 'only', sessionId: null });
    });

    it('an owner chooses the default player; a player cannot', async () => {
        await household();
        const { S } = await svc();
        await expect(S.setDefaultPlayer(HUSBAND, CAB, HUSBAND)).rejects.toMatchObject({ code: 'NOT_OWNER' });
        await S.setDefaultPlayer(WIFE, CAB, HUSBAND);
        expect(await S.playingAs(CAB)).toMatchObject({ userId: HUSBAND, isDefault: true });
    });

    it('a co-owner\'s log request reaches the cabinet', async () => {
        await household();
        const { P } = await svc();
        await P.setRole(WIFE, CAB, HUSBAND, 'owner');
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET app_version = '1.1.0' WHERE atgames_unique_id = ?`, CAB);
        const { WitnessLogService } = await import('../services/WitnessLogService.js');
        const { request: asked } = await WitnessLogService.request(HUSBAND, CAB);
        expect(await WitnessLogService.pendingForDevice(CAB)).toBe(asked.id);
    });
});
