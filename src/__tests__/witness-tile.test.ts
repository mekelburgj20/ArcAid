import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { WitnessService, cabinetAccountLabel } from '../services/WitnessService.js';
import { WitnessReleaseService } from '../services/WitnessReleaseService.js';
import { VpxScoreIngestService } from '../services/VpxScoreIngestService.js';
import { cabinetText } from '../utils/witnessCabinetText.js';
import { compareTileCards, scoreWithCommas, boardLabel } from '../services/WitnessTileService.js';

/**
 * W105 (v2.249.0, ADR 0040 addendum) - `GET /api/witness/tile`, the cabinet
 * tile's player screen (cabinet 1.1.1).
 *
 * Pinned, worst-bug-first:
 *   1. Auth is the device routes' own: a bare 401 for every refusal, and the
 *      read writes nothing (no check-in, no last-seen, no stored `v`).
 *   2. Every value is a flat string the cabinet's naive reader can take: one
 *      sanitizer for free text, a field that does not apply is OMITTED.
 *   3. The open cards are the ingest's own filters (routing, entry, window,
 *      device exclusion), ordered soonest close first, capped at 6 with a
 *      true `openCount`; attempts and `needsStart` match what
 *      `/witness/attempt-start` would press.
 *   4. `update` is the one offer rule; `lastScore*` is all four or none.
 */

const USER = '123456789012345678';
const OTHER = '876543210987654321';
const CABINET = 'CAB0000000000105';
const MINUTE = 60;

let app: express.Express;
let token: string;

async function pair(user: string, deviceId: string, type: 'atgames' | 'desktop' = 'atgames'): Promise<string> {
    const { code } = await WitnessService.createPairingCode(user);
    return (await WitnessService.redeemPairingCode(code, deviceId, null, type)).token;
}

const tile = (q: Record<string, string> = {}, device = CABINET, tok: string | null = token) =>
    request(app).get('/api/witness/tile').query({ device, ...(tok !== null ? { token: tok } : {}), ...q });

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

async function member(roomId: string, user = USER) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, user, roomId);
}

/** A rotation tournament with one ACTIVE game that went up an hour ago. */
async function rotation(roomId: string, name: string, table: string, opts: { maxAttempts?: number; requireStart?: boolean } = {}) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, max_attempts, require_attempt_start)
         VALUES (?, ?, 'DG', 'pinball', '{}', 1, ?, 'rotation', ?, ?)`,
        tournamentId, name, roomId, opts.maxAttempts ?? null, opts.requireStart ? 1 : 0,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, table, roomId, iso(nowSec() - 60 * MINUTE),
    );
    return { tournamentId, gameId };
}

/** An event (no check-in) with one round from `startOffset` to `endOffset` seconds from now. */
async function eventRound(roomId: string | null, name: string, table: string, startOffset: number, endOffset: number) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_required)
         VALUES (?, ?, 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 0)`,
        tournamentId, name, roomId,
    );
    const gameId = crypto.randomUUID();
    const endSec = nowSec() + endOffset;
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, 1, ?, ?)`,
        gameId, tournamentId, table, roomId, iso(nowSec() + startOffset), iso(endSec),
    );
    return { tournamentId, gameId, endSec };
}

async function evidence(row: {
    outcome: string; table?: string; score?: number; createdAt: string; playedAt?: string;
    tournamentId?: string | null; roomId?: string | null; globalScoreId?: string | null; user?: string; device?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_evidence (device_id, canonical_user_id, outcome, tournament_id, game_room_id, global_score_id,
                                       table_name, score, played_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.device ?? CABINET, row.user ?? USER, row.outcome, row.tournamentId ?? null, row.roomId ?? null,
        row.globalScoreId ?? null, row.table ?? 'Medieval Madness', row.score ?? 135930,
        row.playedAt ?? row.createdAt, row.createdAt,
    );
}

/** Every field but `ok`: a string of printable ASCII with no quote or backslash. */
function expectFlatStrings(body: Record<string, unknown>) {
    for (const [key, value] of Object.entries(body)) {
        if (key === 'ok') continue;
        expect(typeof value, key).toBe('string');
        expect(value as string, key).toMatch(/^[\x20-\x7E]+$/);
        expect(value as string, key).not.toMatch(/["\\]/);
    }
}

const OPEN_KEYS = /^open\d+(Name|Table|Closes|Attempts)$/;

beforeEach(async () => {
    await setupTestDb();
    app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    token = await pair(USER, CABINET);
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('auth and the read-only rule', () => {
    it('a bare 401 for no token, a wrong token, an unknown device and an unpaired one', async () => {
        for (const res of [
            await tile({}, CABINET, null),
            await tile({}, CABINET, 'wrong-token'),
            await tile({}, 'NOT-A-DEVICE'),
        ]) {
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ ok: false });
        }
        await WitnessService.revokeDevice(USER, CABINET);
        const revoked = await tile();
        expect(revoked.status).toBe(401);
        expect(revoked.body).toEqual({ ok: false });
    });

    it('the token is also taken from the x-witness-token header', async () => {
        const res = await request(app).get('/api/witness/tile').query({ device: CABINET }).set('x-witness-token', token);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('writes nothing: no check-in, no last-seen, no heartbeat, no stored build', async () => {
        const db = await getDatabase();
        const before = await db.get(`SELECT last_seen_at, heartbeat_at, app_version, app_version_at FROM witness_devices WHERE atgames_unique_id = ?`, CABINET);
        const res = await tile({ v: '1.1.1' });
        expect(res.status).toBe(200);
        const after = await db.get(`SELECT last_seen_at, heartbeat_at, app_version, app_version_at FROM witness_devices WHERE atgames_unique_id = ?`, CABINET);
        expect(after).toEqual(before);
        expect((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM witness_checkins`))!.n).toBe(0);
        expect(res.headers['cache-control']).toBe('no-store');
    });
});

describe('the answer shape', () => {
    it('`now` is always there as unix seconds; nothing that does not apply is sent', async () => {
        const t0 = nowSec();
        const res = await tile();
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.now).toMatch(/^\d+$/);
        expect(Number(res.body.now)).toBeGreaterThanOrEqual(t0);
        expect(Number(res.body.now)).toBeLessThanOrEqual(nowSec() + 1);
        // Nothing open, no score, no release, no label: only now + openCount.
        expect(res.body).toEqual({ ok: true, now: res.body.now, openCount: '0' });
        expectFlatStrings(res.body);
    });

    it('a failing block omits only its own fields', async () => {
        const roomId = await createTestRoom('fail-room', 'Fail Room');
        await member(roomId);
        await rotation(roomId, 'Weekly', 'Attack from Mars');
        await evidence({ outcome: 'global', createdAt: '2026-11-14 10:00:00' });
        vi.spyOn(VpxScoreIngestService, 'openGamesForDevice').mockRejectedValue(new Error('boom'));
        const res = await tile();
        expect(res.status).toBe(200);
        expect(res.body.now).toMatch(/^\d+$/);
        expect(res.body.lastScoreTable).toBe('Medieval Madness');
        expect(res.body.openCount).toBeUndefined();
        expect(Object.keys(res.body).filter(k => OPEN_KEYS.test(k) || k === 'needsStart')).toEqual([]);
    });
});

describe('the one cabinet sanitizer', () => {
    it('keeps printable ASCII minus quote and backslash, drops the rest, collapses spaces, trims, cuts at max', () => {
        expect(cabinetText('Krobs "the" \\Great\\', 60)).toBe('Krobs the Great');
        expect(cabinetText('Café 🎯 Night\tOwls\n', 60)).toBe('Caf NightOwls'); // a tab is dropped, not a space
        expect(cabinetText('  a    b  ', 60)).toBe('a b');
        expect(cabinetText('x'.repeat(100), 48)).toBe('x'.repeat(48));
        expect(cabinetText(`${'y'.repeat(47)} z`, 48)).toBe('y'.repeat(47)); // a space left at the cut is trimmed
        expect(cabinetText('🎯🎯', 10)).toBeNull();
        expect(cabinetText(null, 10)).toBeNull();
        expect(cabinetText(42, 10)).toBeNull();
        expect(cabinetText("O'Brien's #1 (2026) & co.", 60)).toBe("O'Brien's #1 (2026) & co.");
    });

    it('cabinetAccountLabel keeps its narrower W103 rule on top of it', () => {
        expect(cabinetAccountLabel("O'Brien \"Krobs\" 🎯")).toBe('OBrien Krobs');
        expect(cabinetAccountLabel('a'.repeat(30))).toBe('a'.repeat(24));
        expect(cabinetAccountLabel('  spaced   out  ')).toBe('spaced out');
        expect(cabinetAccountLabel('🎯')).toBeNull();
        expect(cabinetAccountLabel(null)).toBeNull();
    });

    it('scores carry thousands separators; names join as room / tournament', () => {
        expect(scoreWithCommas(135930)).toBe('135,930');
        expect(scoreWithCommas(1234567890)).toBe('1,234,567,890');
        expect(scoreWithCommas(999)).toBe('999');
        expect(scoreWithCommas(0)).toBe('0');
        expect(scoreWithCommas(-5)).toBeNull();
        expect(boardLabel('Room', 'Weekly')).toBe('Room / Weekly');
        expect(boardLabel(null, 'Throwdown')).toBe('Throwdown');
        expect(boardLabel(null, null)).toBeNull();
    });

    it('names on the wire go through it, at their max lengths', async () => {
        const roomId = await createTestRoom('quote-room', 'The "Arcade" \\ Café 🎯');
        await member(roomId);
        await rotation(roomId, 'W'.repeat(80), 'T'.repeat(70));
        const res = await tile();
        expect(res.body.openCount).toBe('1');
        expect(res.body.open1Name).toBe(`The Arcade Caf / ${'W'.repeat(60 - 'The Arcade Caf / '.length)}`);
        expect(res.body.open1Name).toHaveLength(60);
        expect(res.body.open1Table).toBe('T'.repeat(48));
        expectFlatStrings(res.body);
    });
});

describe('account', () => {
    it('is the paired player label through cabinetAccountLabel (max 24)', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`, USER, 'Krobs "the" Magnificent Pinballer 🎯');
        const res = await tile();
        expect(res.body.account).toBe(cabinetAccountLabel('Krobs "the" Magnificent Pinballer 🎯'));
        expect(res.body.account).toBe('Krobs the Magnificent Pi');
        expect(res.body.account).not.toContain(USER);
    });

    it('omitted when the player has no label (never the raw id)', async () => {
        const res = await tile();
        expect(res.body.account).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain(USER);
    });
});

describe('update follows the one offer rule', () => {
    async function release(version: string, channel: 'draft' | 'beta' | 'stable') {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO witness_app_releases (version, channel, size, sha256, sig) VALUES (?, ?, 1, 'x', 'x')`,
            version, channel,
        );
    }

    it('the highest eligible build above the tile\'s own `v`, and nothing otherwise', async () => {
        await release('1.1.3', 'stable');
        await release('1.1.4', 'beta');
        await release('1.2.0', 'draft');
        expect((await tile({ v: '1.1.1' })).body.update).toBe('1.1.3');
        expect((await tile({ v: '1.1.3' })).body.update).toBeUndefined();
        expect((await tile()).body.update).toBeUndefined(); // no `v`, no offer
        expect((await tile({ v: 'garbage"' })).body.update).toBeUndefined();

        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET test_builds = 1 WHERE atgames_unique_id = ?`, CABINET);
        expect((await tile({ v: '1.1.1' })).body.update).toBe('1.1.4');
        await db.run(`UPDATE witness_devices SET auto_update = 0 WHERE atgames_unique_id = ?`, CABINET);
        expect((await tile({ v: '1.1.1' })).body.update).toBeUndefined();
    });

    it('agrees with WitnessReleaseService.offeredFor, and a desktop is never offered a build', async () => {
        await release('1.1.3', 'stable');
        const res = await tile({ v: '1.1.0' });
        expect(res.body.update).toBe(await WitnessReleaseService.offeredFor(CABINET, '1.1.0'));
        const desk = await pair(USER, 'desk-uuid-105', 'desktop');
        expect((await tile({ v: '1.1.0' }, 'desk-uuid-105', desk)).body.update).toBeUndefined();
    });
});

describe('lastScore*', () => {
    const LAST = ['lastScoreTable', 'lastScoreValue', 'lastScoreAt', 'lastScoreBoard'];
    const lastKeys = (body: Record<string, unknown>) => Object.keys(body).filter(k => LAST.includes(k)).sort();

    it('none of the four with no kept score', async () => {
        await evidence({ outcome: 'no_match', createdAt: '2026-11-14 10:00:00' });
        await evidence({ outcome: 'invalid', createdAt: '2026-11-14 10:01:00' });
        await evidence({ outcome: 'attempt_refused', createdAt: '2026-11-14 10:02:00' }); // refused, not kept on Global
        expect(lastKeys((await tile()).body)).toEqual([]);
    });

    it('the newest kept score of this device on this account: table, value, received-at and board', async () => {
        const roomId = await createTestRoom('last-room', 'Last Room');
        const { tournamentId } = await rotation(roomId, 'Weekly Grind', 'Attack from Mars');
        await evidence({ outcome: 'global', table: 'Old Table', score: 5, createdAt: '2026-11-13 10:00:00' });
        await evidence({ outcome: 'ingested', table: 'Attack from Mars', score: 135930, createdAt: '2026-11-14 10:00:00', tournamentId, roomId });
        // Newer, but not kept / a repeat / another account / another device.
        await evidence({ outcome: 'no_match', table: 'Nope', createdAt: '2026-11-14 11:00:00' });
        await evidence({ outcome: 'duplicate', table: 'Attack from Mars', createdAt: '2026-11-14 11:05:00', tournamentId, roomId });
        await evidence({ outcome: 'ingested', table: 'Not Mine', createdAt: '2026-11-14 12:00:00', user: OTHER });
        await evidence({ outcome: 'ingested', table: 'Other Device', createdAt: '2026-11-14 12:30:00', device: 'CAB-OTHER' });

        const res = await tile();
        expect(res.body).toMatchObject({
            lastScoreTable: 'Attack from Mars',
            lastScoreValue: '135,930',
            lastScoreAt: String(Date.parse('2026-11-14T10:00:00Z') / 1000),
            lastScoreBoard: 'Last Room / Weekly Grind',
        });
        expectFlatStrings(res.body);
    });

    it('a Global landing, and a refusal kept on Global, read Global Scoreboard', async () => {
        await evidence({ outcome: 'global', table: 'Bad Cats', score: 1000, createdAt: '2026-11-14 10:00:00' });
        expect((await tile()).body).toMatchObject({ lastScoreTable: 'Bad Cats', lastScoreValue: '1,000', lastScoreBoard: 'Global Scoreboard' });
        await evidence({ outcome: 'not_sanctioned', table: 'Fish Tales', score: 22, createdAt: '2026-11-14 11:00:00', globalScoreId: 'gs-1' });
        expect((await tile()).body).toMatchObject({ lastScoreTable: 'Fish Tales', lastScoreValue: '22', lastScoreBoard: 'Global Scoreboard' });
    });

    it('one play that landed in a tournament and fell to Global elsewhere names the board', async () => {
        const roomId = await createTestRoom('multi-room', 'Multi Room');
        const { tournamentId } = await rotation(roomId, 'Weekly', 'Funhouse');
        const play = { table: 'Funhouse', score: 777, playedAt: '2026-11-14 09:59:00' };
        await evidence({ ...play, outcome: 'ingested', createdAt: '2026-11-14 10:00:00', tournamentId, roomId });
        await evidence({ ...play, outcome: 'attempt_refused', createdAt: '2026-11-14 10:00:01', globalScoreId: 'gs-2' });
        expect((await tile()).body.lastScoreBoard).toBe('Multi Room / Weekly');
    });

    it('all four or none: a table name with nothing printable sends none of them', async () => {
        await evidence({ outcome: 'global', table: '🎯🎯', createdAt: '2026-11-14 10:00:00' });
        expect(lastKeys((await tile()).body)).toEqual([]);
        await evidence({ outcome: 'global', table: 'Real Table', createdAt: '2026-11-14 11:00:00' });
        expect(lastKeys((await tile()).body)).toEqual([...LAST].sort());
    });
});

describe('the open cards', () => {
    let roomId: string;
    beforeEach(async () => {
        roomId = await createTestRoom('open-room', 'Open Room');
        await member(roomId);
    });

    it('soonest close first, cards with no end last, ties by name; a round Closes at its end with no grace', async () => {
        await rotation(roomId, 'B Rotation', 'Twilight Zone');
        await rotation(roomId, 'A Rotation', 'Medieval Madness');
        const late = await eventRound(roomId, 'Late Event', 'Fish Tales', -30 * MINUTE, 90 * MINUTE);
        const soon = await eventRound(roomId, 'Soon Event', 'Funhouse', -30 * MINUTE, 10 * MINUTE);
        // Not open yet: not a card.
        await eventRound(roomId, 'Future Event', 'Taxi', 30 * MINUTE, 90 * MINUTE);

        const res = await tile();
        expect(res.body.openCount).toBe('4');
        expect([1, 2, 3, 4].map(n => res.body[`open${n}Name`])).toEqual([
            'Open Room / Soon Event', 'Open Room / Late Event', 'Open Room / A Rotation', 'Open Room / B Rotation',
        ]);
        expect([1, 2, 3, 4].map(n => res.body[`open${n}Table`])).toEqual(['Funhouse', 'Fish Tales', 'Medieval Madness', 'Twilight Zone']);
        expect(res.body.open1Closes).toBe(String(soon.endSec));
        expect(res.body.open2Closes).toBe(String(late.endSec));
        expect(res.body.open3Closes).toBeUndefined();
        expect(res.body.open4Closes).toBeUndefined();
        expect(res.body.open1Attempts).toBeUndefined(); // unlimited
        expectFlatStrings(res.body);
    });

    it('a round inside its end grace is still a card (the ingest would still take the play), Closes in the past', async () => {
        const db = await getDatabase();
        const ended = await eventRound(roomId, 'Grace Event', 'Funhouse', -60 * MINUTE, -30);
        await db.run(`UPDATE tournaments SET end_grace_sec = 300 WHERE id = ?`, ended.tournamentId);
        const res = await tile();
        expect(res.body.openCount).toBe('1');
        expect(res.body.open1Closes).toBe(String(ended.endSec));
        expect(Number(res.body.open1Closes)).toBeLessThan(Number(res.body.now));
    });

    it('at most 6 cards, openCount is the true total', async () => {
        for (let i = 1; i <= 8; i++) await rotation(roomId, `Rotation ${i}`, `Table ${i}`);
        const res = await tile();
        expect(res.body.openCount).toBe('8');
        expect(res.body.open6Name).toBe('Open Room / Rotation 6');
        expect(res.body.open7Name).toBeUndefined();
        expect(res.body.open7Table).toBeUndefined();
        expect(Object.keys(res.body).filter(k => OPEN_KEYS.test(k))).toHaveLength(12); // 6 x Name + Table
    });

    it('a Global-only device, a room it is not pointed at, and a room the player is not in send openCount 0', async () => {
        await rotation(roomId, 'Weekly', 'Attack from Mars');
        const strange = await createTestRoom('strange-room', 'Strange Room');
        await rotation(strange, 'Not Mine', 'Taxi'); // not a member
        expect((await tile()).body.openCount).toBe('1');

        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET global_only = 1 WHERE atgames_unique_id = ?`, CABINET);
        const res = await tile();
        expect(res.body.openCount).toBe('0');
        expect(Object.keys(res.body).filter(k => OPEN_KEYS.test(k))).toEqual([]);

        const other = await createTestRoom('other-room', 'Other Room');
        await member(other);
        await db.run(`UPDATE witness_devices SET global_only = 0, target_room_id = ? WHERE atgames_unique_id = ?`, other, CABINET);
        expect((await tile()).body.openCount).toBe('0');
    });

    it('a tournament that excludes cabinet scores is not a card', async () => {
        const { tournamentId } = await rotation(roomId, 'PC Only', 'Taxi');
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET platform_rules = ? WHERE id = ?`,
            JSON.stringify({ engines: { required: [], excluded: [] }, devices: { required: [], excluded: ['atgames'] } }), tournamentId,
        );
        expect((await tile()).body.openCount).toBe('0');
    });

    it('a Throwdown round the player joined is named by the Throwdown alone', async () => {
        const td = await eventRound(null, 'Friday Throwdown', 'Funhouse', -10 * MINUTE, 20 * MINUTE);
        const db = await getDatabase();
        expect((await tile()).body.openCount).toBe('0'); // not joined
        await db.run(`INSERT INTO tournament_participants (tournament_id, user_id, checked_in_at) VALUES (?, ?, datetime('now'))`, td.tournamentId, USER);
        const res = await tile();
        expect(res.body).toMatchObject({ openCount: '1', open1Name: 'Friday Throwdown', open1Table: 'Funhouse', open1Closes: String(td.endSec) });
    });

    it('limited attempts: `<left> of <limit> left`, and `press start` + needsStart until the press', async () => {
        const limited = await rotation(roomId, 'Five Shots', 'Bad Cats', { maxAttempts: 5 });
        const startFirst = await rotation(roomId, 'Press First', 'Funhouse', { maxAttempts: 3, requireStart: true });
        const db = await getDatabase();
        for (const [i, status] of (['scored', 'counted', 'void', 'over_limit'] as const).entries()) {
            await db.run(
                `INSERT INTO attempts (tournament_id, game_id, canonical_user_id, device_id, attempt_key, attempt_no, status, started_ts)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                limited.tournamentId, limited.gameId, USER, CABINET, `cab:${i}`, i + 1, status, nowSec() - 100 + i,
            );
        }

        let res = await tile();
        const card = (body: Record<string, string>, table: string) => {
            const n = [1, 2, 3, 4, 5, 6].find(i => body[`open${i}Table`] === table);
            return n ? { name: body[`open${n}Name`], attempts: body[`open${n}Attempts`] } : null;
        };
        expect(card(res.body, 'Bad Cats')!.attempts).toBe('3 of 5 left'); // void and over_limit used no slot
        expect(card(res.body, 'Funhouse')!.attempts).toBe('press start');
        expect(res.body.needsStart).toBe('1');

        // The device's own Start attempts press clears both.
        const pressed = await request(app).get('/api/witness/attempt-start').query({ device: CABINET, token });
        expect(pressed.body.status).toBe('started');
        expect(pressed.body.started.map((s: { gameId: string }) => s.gameId)).toEqual([startFirst.gameId]);
        res = await tile();
        expect(card(res.body, 'Funhouse')!.attempts).toBe('3 of 3 left');
        expect(res.body.needsStart).toBeUndefined();
    });

    it('needsStart is absent when no table needs the press', async () => {
        await rotation(roomId, 'Five Shots', 'Bad Cats', { maxAttempts: 5 });
        const res = await tile();
        expect(res.body.open1Attempts).toBe('5 of 5 left');
        expect(res.body.needsStart).toBeUndefined();
    });
});

describe('compareTileCards', () => {
    it('orders by close, then no-end last, then name', () => {
        const cards = [
            { name: 'B', table: 'x', closes: null, gameId: '1' },
            { name: 'Z', table: 'x', closes: 200, gameId: '2' },
            { name: 'A', table: 'x', closes: null, gameId: '3' },
            { name: 'C', table: 'x', closes: 100, gameId: '4' },
            { name: 'A', table: 'x', closes: 200, gameId: '5' },
        ];
        expect([...cards].sort(compareTileCards).map(c => c.gameId)).toEqual(['4', '5', '2', '3', '1']);
    });
});
