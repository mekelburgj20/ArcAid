import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * W131.3 (ADR 0045, docs/shared-device-plan.md §7) - "Plays on this device":
 * `GET /api/me/witness/devices/:id/plays` lists every play on a shared device
 * since the viewer joined it, whoever it went to (ruling 6), in sittings, with
 * the session that decided each one. `GET .../players` names the default player.
 */
const WIFE = '111111111111111111';
const HUSBAND = '222222222222222222';
const STRANGER = '333333333333333333';
const CAB = 'cab-family-plays';

let app: express.Express;
let token: string;

const bearer = (id: string) => `Bearer ${signToken({ role: 'player', gameRoomIds: [], discordId: id, username: id })}`;

async function svc() {
    const { WitnessService } = await import('../services/WitnessService.js');
    const { WitnessDevicePlayersService } = await import('../services/WitnessDevicePlayersService.js');
    const { WitnessPlaySessionService } = await import('../services/WitnessPlaySessionService.js');
    return { W: WitnessService, P: WitnessDevicePlayersService, S: WitnessPlaySessionService };
}

/** A trail row at an explicit SERVER time (epoch seconds). */
async function trail(userId: string, at: number, table: string, score: number, opts: {
    attribution?: string | null; sessionId?: number | null; outcome?: string;
} = {}): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_evidence (device_id, canonical_user_id, outcome, table_name, score, played_at,
                                       attribution, play_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'))`,
        CAB, userId, opts.outcome ?? 'global', table, score, String(at),
        opts.attribution ?? null, opts.sessionId ?? null, at,
    );
}

async function sessionAt(userId: string, startedBy: string, start: number, end: number | null, via = 'web'): Promise<number> {
    const db = await getDatabase();
    const res = await db.run(
        `INSERT INTO witness_play_sessions (device_id, canonical_user_id, started_at, ended_at, started_by, started_via)
         VALUES (?, ?, datetime(?, 'unixepoch'), ${end == null ? 'NULL' : `datetime(${end}, 'unixepoch')`}, ?, ?)`,
        CAB, userId, start, startedBy, via,
    );
    return res.lastID as number;
}

beforeEach(async () => {
    await setupTestDb();
    app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    const { W } = await svc();
    const { code } = await W.createPairingCode(WIFE);
    token = (await W.redeemPairingCode(code, CAB, null, 'atgames')).token;
});

/** When someone joined the device (SERVER epoch seconds). */
async function joinedAt(userId: string, at: number): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `UPDATE witness_device_players SET added_at = datetime(?, 'unixepoch') WHERE device_id = ? AND canonical_user_id = ?`,
        at, CAB, userId,
    );
}

/** Both on the device for the last day, unless a test says otherwise. */
async function household(): Promise<void> {
    await request(app).get('/api/witness/heartbeat').query({ device: CAB, token, clock_offset: '0' });
    const { P } = await svc();
    const { code } = await P.createInvite(WIFE, CAB);
    await P.acceptInvite(HUSBAND, code);
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    await joinedAt(WIFE, dayAgo);
    await joinedAt(HUSBAND, dayAgo);
}

describe('W131.3 plays on this device', () => {
    it('lists everyone\'s plays by sitting, with the session that decided them', async () => {
        await household();
        const now = Math.floor(Date.now() / 1000);
        const hers = await sessionAt(WIFE, WIFE, now - 3000, now - 1500, 'cabinet');
        const his = await sessionAt(HUSBAND, WIFE, now - 1500, null);
        await trail(WIFE, now - 2800, 'Medieval Madness', 1_000_000, { attribution: 'session', sessionId: hers });
        await trail(WIFE, now - 2500, 'Attack from Mars', 2_000_000, { attribution: 'session', sessionId: hers });
        // She switched to him from the web; his two games.
        await trail(HUSBAND, now - 1200, 'Medieval Madness', 3_000_000, { attribution: 'session', sessionId: his });
        await trail(HUSBAND, now - 900, 'Twilight Zone', 4_000_000, { attribution: 'session', sessionId: his });
        // A play counted in two places is ONE play.
        await trail(HUSBAND, now - 900, 'Twilight Zone', 4_000_000, { attribution: 'session', sessionId: his, outcome: 'ingested' });

        const res = await request(app).get(`/api/me/witness/devices/${CAB}/plays`).set('Authorization', bearer(WIFE));
        expect(res.status).toBe(200);
        const sittings = res.body.sittings as Array<{ userId: string; isYou: boolean; session: Record<string, unknown> | null; plays: Array<Record<string, unknown>> }>;
        expect(sittings.map(s => [s.userId, s.plays.length])).toEqual([[HUSBAND, 2], [WIFE, 2]]);
        expect(sittings[0]!.isYou).toBe(false);
        expect(sittings[0]!.session).toMatchObject({ id: his, via: 'web', startedByYou: true, endedAt: null });
        expect(sittings[1]!.session).toMatchObject({ id: hers, via: 'cabinet', startedByYou: true });
        expect(sittings[0]!.plays[0]).toMatchObject({ tableName: 'Twilight Zone', userId: HUSBAND, attribution: 'session', isYou: false });
        expect((sittings[0]!.plays[0]!.destinations as unknown[]).length).toBe(2);

        // He sees the same plays, from his side.
        const his_ = await request(app).get(`/api/me/witness/devices/${CAB}/plays`).set('Authorization', bearer(HUSBAND));
        expect(his_.body.sittings[0]).toMatchObject({ userId: HUSBAND, isYou: true });
    });

    it('a long gap starts a new sitting for the same player', async () => {
        await household();
        const now = Math.floor(Date.now() / 1000);
        await trail(WIFE, now - 5000, 'Medieval Madness', 1, { attribution: 'fallback' });
        await trail(WIFE, now - 100, 'Medieval Madness', 2, { attribution: 'fallback' });
        const res = await request(app).get(`/api/me/witness/devices/${CAB}/plays`).set('Authorization', bearer(WIFE));
        expect(res.body.sittings).toHaveLength(2);
        expect(res.body.sittings[0].session).toBeNull();
    });

    it('a player sees only plays since they joined; a stranger sees nothing', async () => {
        const now = Math.floor(Date.now() / 1000);
        await household();
        await joinedAt(WIFE, now - 7 * 86400);
        await joinedAt(HUSBAND, now - 3600);
        await trail(WIFE, now - 3 * 86400, 'Medieval Madness', 1);  // before he was on the device
        await trail(WIFE, now - 60, 'Attack from Mars', 2, { attribution: 'fallback' });

        const hers = await request(app).get(`/api/me/witness/devices/${CAB}/plays`).set('Authorization', bearer(WIFE));
        expect(hers.body.sittings.flatMap((s: { plays: unknown[] }) => s.plays)).toHaveLength(2);
        const his = await request(app).get(`/api/me/witness/devices/${CAB}/plays`).set('Authorization', bearer(HUSBAND));
        expect(his.body.sittings.flatMap((s: { plays: Array<{ tableName: string }> }) => s.plays).map((p: { tableName: string }) => p.tableName))
            .toEqual(['Attack from Mars']);
        const stranger = await request(app).get(`/api/me/witness/devices/${CAB}/plays`).set('Authorization', bearer(STRANGER));
        expect(stranger.status).toBe(404);
    });

    it('the players list names who plays when nobody chose', async () => {
        await household();
        const res = await request(app).get(`/api/me/witness/devices/${CAB}/players`).set('Authorization', bearer(HUSBAND));
        expect(res.status).toBe(200);
        expect(res.body.defaultPlayerId).toBe(WIFE);
        const { S } = await svc();
        await S.setDefaultPlayer(WIFE, CAB, HUSBAND);
        const after = await request(app).get(`/api/me/witness/devices/${CAB}/players`).set('Authorization', bearer(WIFE));
        expect(after.body.defaultPlayerId).toBe(HUSBAND);
    });
});
