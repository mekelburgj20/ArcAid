import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { entryAllowed, entryRefusal, type EntryFacts } from '../utils/tournamentEntry.js';

/**
 * W27.1 (ADR 0033 §5) — a play that counts in NO tournament says why.
 *
 * When an open game of that name exists for the player, the play goes to
 * Global (or nowhere) with a reason naming the step it missed — the device
 * target, the window, the tournament's device rules, or entry — on the wire
 * (`notCounted`) and first on its trail row. Ordinary play at home (nothing of
 * that name open to the player) carries no reason.
 */

const USER = '123456789012345678';
const CABINET = 'fp-device-uuid-why';
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

async function pairCabinet(app: express.Express) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: CABINET, username: 'Owner' });
    return pairRes.body.token as string;
}

async function join(roomId: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
}

/** The Global Scoreboard needs the table in the catalogue to record it. */
async function catalogue(name: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, status) VALUES (?, ?, 'pinball', 'Williams', 1997, 'approved')`,
        crypto.randomUUID(), name,
    );
}

async function eventRound(roomId: string, opts: {
    name?: string; checkinRequired?: boolean; startOffsetMin?: number; endOffsetMin?: number;
    entryMode?: 'members' | 'invited'; platformRules?: Record<string, unknown>;
} = {}) {
    const db = await getDatabase();
    const now = Date.now();
    const eventId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_required, entry_mode, platform_rules)
         VALUES (?, ?, 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', ?, ?, ?)`,
        eventId, opts.name ?? 'Friday Night', roomId, opts.checkinRequired ? 1 : 0, opts.entryMode ?? 'members',
        opts.platformRules ? JSON.stringify(opts.platformRules) : null,
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
         VALUES (?, ?, 'Medieval Madness', 'ACTIVE', ?, 1, ?, ?)`,
        crypto.randomUUID(), eventId, roomId,
        new Date(now + (opts.startOffsetMin ?? -30) * MINUTE).toISOString(),
        new Date(now + (opts.endOffsetMin ?? 30) * MINUTE).toISOString(),
    );
    return eventId;
}

function play(over: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Medieval Madness (Williams 1997)', rom: 'mm_109c', slug: 'vpx-medievalmadness',
        score: 41234560, started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 300, reason: 'game_over', ...over,
    };
}

async function lastTrailReasons(): Promise<{ outcome: string; reasons: string[] }> {
    const db = await getDatabase();
    const row = await db.get<{ outcome: string; reasons: string }>(
        `SELECT outcome, reasons FROM witness_evidence WHERE device_id = ? ORDER BY id DESC LIMIT 1`, CABINET,
    );
    return { outcome: row!.outcome, reasons: JSON.parse(row!.reasons) };
}

describe('entryRefusal — the same rule as entryAllowed, with the why', () => {
    it('agrees with entryAllowed on every combination', () => {
        const bools = [false, true];
        for (const format of ['rotation', 'event'] as const)
        for (const roomless of bools) for (const checkinRequired of bools) for (const isMember of bools)
        for (const isParticipant of bools) for (const entryMode of ['members', 'invited'] as const) for (const onRoster of bools) {
            const f: EntryFacts = { format, roomless, checkinRequired, isMember, isParticipant, entryMode, onRoster };
            expect(entryRefusal(f) === null).toBe(entryAllowed(f));
        }
    });

    it('names the step', () => {
        const base: EntryFacts = { format: 'event', roomless: false, checkinRequired: true, isMember: true, isParticipant: false };
        expect(entryRefusal(base)).toBe('not_checked_in');
        expect(entryRefusal({ ...base, roomless: true })).toBe('not_joined');
        expect(entryRefusal({ ...base, entryMode: 'invited', onRoster: false })).toBe('not_on_roster');
        expect(entryRefusal({ ...base, format: 'rotation', checkinRequired: false, isMember: false })).toBe('not_member');
    });
});

describe('W27.1 — a play that counts nowhere says why', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom('wizard-room', 'The Wizard Room');
        token = await pairCabinet(app);
        await join(roomId);
        await catalogue('Medieval Madness');
    }, 30_000); // the first run imports the whole API router cold

    it('not checked in: goes to Global, says so on the wire and on the trail', async () => {
        await eventRound(roomId, { checkinRequired: true });
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        const why = 'you are not checked in to "Friday Night" round 1 in The Wizard Room';
        expect(res.body).toMatchObject({ ok: true, status: 'global', notCounted: why });
        expect(await lastTrailReasons()).toEqual({ outcome: 'global', reasons: [why] });
    });

    it('played after the round closed', async () => {
        await eventRound(roomId, { startOffsetMin: -90, endOffsetMin: -60 });
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body).toMatchObject({ status: 'global', notCounted: 'played after "Friday Night" round 1 in The Wizard Room closed' });
    });

    it('played before the round opened', async () => {
        await eventRound(roomId, { startOffsetMin: 60, endOffsetMin: 90 });
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body.notCounted).toBe('played before "Friday Night" round 1 in The Wizard Room opened');
    });

    it('a device set to Global Scoreboard only', async () => {
        await eventRound(roomId);
        await request(app).patch(`/api/me/witness/devices/${CABINET}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({ globalOnly: true });
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body.notCounted).toBe(
            'your device is set to send to the Global Scoreboard only, so it did not count in "Friday Night" round 1 in The Wizard Room',
        );
    });

    it('an invite-only tournament the player is not on the roster of', async () => {
        await eventRound(roomId, { entryMode: 'invited', name: 'Invitational' });
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body.notCounted).toBe('"Invitational" round 1 in The Wizard Room is invite-only and you are not on its roster');
    });

    it('a tournament that excludes cabinet scores', async () => {
        await eventRound(roomId, { platformRules: { engines: { required: [], excluded: [] }, devices: { required: [], excluded: ['atgames'] } } });
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body.notCounted).toBe('"Friday Night" round 1 in The Wizard Room does not accept AtGames cabinet scores');
    });

    it('with the Global fallback off it answers no_match with the same reason', async () => {
        await eventRound(roomId, { checkinRequired: true });
        await request(app).patch(`/api/me/witness/devices/${CABINET}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({ globalFallback: false });
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        const why = 'you are not checked in to "Friday Night" round 1 in The Wizard Room';
        expect(res.body).toMatchObject({ status: 'no_match', notCounted: why });
        expect(await lastTrailReasons()).toEqual({ outcome: 'no_match', reasons: [why] });
    });

    it('ordinary play at home (nothing of that name open) carries no reason', async () => {
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body.status).toBe('global');
        expect(res.body.notCounted).toBeUndefined();
        expect(await lastTrailReasons()).toEqual({ outcome: 'global', reasons: [] });
    });

    it('a play that lands says nothing extra', async () => {
        await eventRound(roomId);
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body.status).toBe('ingested');
        expect(res.body.notCounted).toBeUndefined();
    });
});
