import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessService } from '../services/WitnessService.js';
import {
    CabinetFrameService, cabinetFrameId, isPairingCode, boardName, ordinal, compactAmount, endsText,
    makeScreen, UNKNOWN_PLAYER, CABINET_DMD_RECT_TEXT,
} from '../services/CabinetFrameService.js';
import { CabinetFrameRenderer, isCabinetFrameId, type CabinetFrameCapture } from '../services/CabinetFrameRenderer.js';
import { dotText, dotsString } from '../utils/cabinetDots.js';
import { parseCabinetScreens, normalizeCabinetScreens } from '../utils/cabinetScreens.js';
import {
    CABINET_SCREEN_CHOICES, CABINET_FRAME_STYLE_VERSION, type CabinetCardData, type CabinetAttractData,
    type CabinetFrameInput, type CabinetStandingsData, type CabinetActivityData,
} from '../services/cabinetFrameTypes.js';

/**
 * W132.2 (ADR 0046, docs/cabinet-frames-plan.md "Server") - the cabinet's
 * backglass + DMD screens: the data each picture is drawn from, the manifest
 * the tile reads, the public pair screen, the player's choices + preview,
 * and the renderer's queue and cache (browser stubbed).
 *
 * Pinned, worst-bug-first:
 *   1. Auth: the device routes are the device's (bare 401); the pair routes
 *      take only a well-formed code (400) and serve only pair pictures; the
 *      player routes are for people on the device (404 otherwise).
 *   2. Never a raw id in a picture's data ("A PLAYER").
 *   3. The manifest is flat strings with no URL, no quote, no backslash.
 *   4. Same data, same id, rendered once.
 */

const USER = '123456789012345678';
const RIVAL = '234567890123456789';
const PARTNER = '345678901234567890';
const STRANGER = '456789012345678901';
const CABINET = 'CAB0000000000132';
const MINUTE = 60;

let app: express.Express;
let token: string;
let root: string;
let captured: CabinetFrameInput[];

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const playerToken = (discordId: string) => signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const asPlayer = (id: string) => ({ Authorization: `Bearer ${playerToken(id)}` });

async function pair(user: string, deviceId: string): Promise<string> {
    const { code } = await WitnessService.createPairingCode(user);
    return (await WitnessService.redeemPairingCode(code, deviceId, null, 'atgames')).token;
}

async function member(roomId: string, user = USER) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, user, roomId);
}

async function profile(user: string, name: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR REPLACE INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`, user, name);
}

/** A rotation tournament with one ACTIVE game that went up an hour ago. */
async function rotation(roomId: string, name: string, table: string, opts: { maxAttempts?: number } = {}) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, max_attempts)
         VALUES (?, ?, 'DG', 'pinball', '{}', 1, ?, 'rotation', ?)`,
        tournamentId, name, roomId, opts.maxAttempts ?? null,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, table, roomId, iso(nowSec() - 60 * MINUTE),
    );
    return { tournamentId, gameId };
}

/** Every value but `ok`: a printable flat string, no quote/backslash, no URL. */
function expectFlatManifest(body: Record<string, unknown>) {
    expect(body.ok).toBe(true);
    for (const [key, value] of Object.entries(body)) {
        if (key === 'ok') continue;
        expect(typeof value, key).toBe('string');
        expect(value as string, key).not.toMatch(/["\\]/);
        expect(value as string, key).not.toMatch(/https?:|\/api\//i);
        expect(value as string, key).toMatch(/^[\x20-\x7E\u00B7]*$/);
    }
}

const frames = (q: Record<string, string> = {}, tok: string | null = token) =>
    request(app).get('/api/witness/frames').query({ device: CABINET, ...(tok !== null ? { token: tok } : {}), ...q });

/** The stub "browser": records the input and writes a few bytes as the picture. */
const stubCapture: CabinetFrameCapture = async (input, file) => {
    captured.push(input);
    await fs.promises.writeFile(file, Buffer.from(`JPEG ${input.kind} ${input.screen}`));
};

beforeEach(async () => {
    await setupTestDb();
    app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    token = await pair(USER, CABINET);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cabinet-frames-'));
    captured = [];
    CabinetFrameRenderer.setForTests({ root, capture: stubCapture });
});
afterEach(async () => {
    await CabinetFrameRenderer.whenIdle();
    CabinetFrameRenderer.setForTests({ root: null, capture: null, maxBytes: null, maxAgeMs: null });
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('pure helpers', () => {
    it('dots: upper case, allowed characters only, reserved separators dropped', () => {
        expect(dotText('to take 2nd on AC/DC', 48)).toBe('TO TAKE 2ND ON AC/DC');
        expect(dotText('a|b;c"d\\e', 48)).toBe('ABCDE');
        expect(dotText('Café — “quoted” 💥 #1 & co.', 48)).toBe('CAFE QUOTED #1 & CO.');
        expect(dotText('x'.repeat(100), 10)).toBe('XXXXXXXXXX');
        expect(dotsString([
            { type: 'text', small: 'to take 2nd on ac/dc', big: '+210,450' },
            { type: 'count', small: 'mox weekly ends in', endTs: 1796012345.7 },
            { type: 'ticker', small: 'latest', text: 'a · b' },
            { type: 'logo' },
        ])).toBe('text|TO TAKE 2ND ON AC/DC|+210,450;count|MOX WEEKLY ENDS IN|1796012345;ticker|LATEST|A · B;logo');
        // Nothing printable left = no line; a bad end time = no countdown.
        expect(dotsString([{ type: 'text', small: '💥', big: '"' }, { type: 'count', small: 'X', endTs: NaN }])).toBe('');
    });

    it('preferences: NULL and junk read as every screen at 10 s; seconds clamp; unknown keys drop', () => {
        expect(parseCabinetScreens(null)).toEqual({ screens: [...CABINET_SCREEN_CHOICES], seconds: 10 });
        expect(parseCabinetScreens('not json')).toEqual({ screens: [...CABINET_SCREEN_CHOICES], seconds: 10 });
        expect(parseCabinetScreens('[1,2]')).toEqual({ screens: [...CABINET_SCREEN_CHOICES], seconds: 10 });
        expect(parseCabinetScreens(JSON.stringify({ screens: ['event', 'pair', 'nope', 'card', 'card'], seconds: 99, extra: 1 })))
            .toEqual({ screens: ['card', 'event'], seconds: 30 });
        expect(parseCabinetScreens(JSON.stringify({ screens: [], seconds: 1 }))).toEqual({ screens: [], seconds: 6 });
        expect(normalizeCabinetScreens({ seconds: 12.4 })).toEqual({ screens: [...CABINET_SCREEN_CHOICES], seconds: 12 });
    });

    it('frame id: 32 hex, stable for the same data, different for another kind, screen, value or style', () => {
        const input: CabinetFrameInput = { kind: 'backglass', screen: 'pair', data: { code: 'K7Q4MX', url: 'https://arcaid.app/pair/K7Q4MX' } };
        const id = cabinetFrameId(input);
        expect(isCabinetFrameId(id)).toBe(true);
        expect(cabinetFrameId(JSON.parse(JSON.stringify(input)))).toBe(id);
        const expected = crypto.createHash('sha256')
            .update(['backglass', 'pair', JSON.stringify(input.data), String(CABINET_FRAME_STYLE_VERSION)].join('\n'))
            .digest('hex').slice(0, 32);
        expect(id).toBe(expected);
        expect(cabinetFrameId({ ...input, kind: 'dmd' })).not.toBe(id);
        expect(cabinetFrameId({ ...input, data: { ...input.data, code: 'K7Q4MY' } } as CabinetFrameInput)).not.toBe(id);
    });

    it('a screen: both panels, the dot window only when there are dots', () => {
        const withDots = makeScreen('pair', { code: 'AAAAAA', url: 'u' }, 10, [{ type: 'logo' }]);
        expect(withDots.rect).toBe(CABINET_DMD_RECT_TEXT);
        expect(withDots.rect).toBe('64,318,1792,448');
        expect(withDots.backglass!.id).not.toBe(withDots.dmd!.id);
        expect(makeScreen('pair', { code: 'AAAAAA', url: 'u' }, 10, null)).toMatchObject({ rect: '', dots: '' });
    });

    it('names, ordinals, amounts and coarse end times', () => {
        expect(boardName('Justin', 'jm')).toBe('JUSTIN');
        expect(boardName(null, 'jm')).toBe('JM');
        expect(boardName(null, USER)).toBe(UNKNOWN_PLAYER);
        expect(boardName('', 'iscored:bob')).toBe(UNKNOWN_PLAYER);
        expect(boardName(null, null)).toBe(UNKNOWN_PLAYER);
        expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal))
            .toEqual(['1ST', '2ND', '3RD', '4TH', '11TH', '12TH', '13TH', '21ST', '22ND', '103RD']);
        expect(compactAmount(210450)).toBe('210,450');
        expect(compactAmount(1_234_000_000)).toBe('1.2 BILLION');
        expect(compactAmount(5_000_000)).toBe('5 MILLION');
        const now = Date.UTC(2026, 10, 28, 12, 0, 0) / 1000;
        expect(endsText(null, now, 'UTC')).toBeNull();
        expect(endsText(now + 2 * 86_400 + 4 * 3_600 + 59 * 60, now, 'UTC')).toBe('ENDS IN 2D 4H');
        expect(endsText(now + 12 * 86_400, now, 'UTC')).toBe('ENDS IN 12D');
        expect(endsText(now + 9 * 3_600, now, 'UTC')).toBe('ENDS TODAY 9:00 PM');
        expect(endsText(now + 13 * 3_600, now, 'UTC')).toBe('ENDS TOMORROW 1:00 AM');
        // No running clock: the text is the same through the hour.
        expect(endsText(now + 3 * 86_400 + 30 * 60, now, 'UTC')).toBe(endsText(now + 3 * 86_400 + 50 * 60, now + 10 * 60, 'UTC'));
        expect(isPairingCode('K7Q4MX')).toBe(true);
        for (const bad of ['k7q4mx', 'K7Q4M', 'K7Q4MXX', 'K7Q4M0', 'O7Q4MX', 'I7Q4MX', '', null, 123456]) expect(isPairingCode(bad)).toBe(false);
    });
});

describe('data per screen', () => {
    it('attract + a card: the current player, the board with your row, attempts and art; never a raw id', async () => {
        const db = await getDatabase();
        const room = await createTestRoom('mox', 'Mox Game Room');
        await member(room);
        await profile(USER, 'Justin');
        await profile(RIVAL, 'Mike');
        const { gameId } = await rotation(room, 'Weekly', 'AC/DC', { maxAttempts: 3 });
        await createTestSubmission(gameId, { username: 'mike', discordUserId: RIVAL, score: 2_940_110 });
        await createTestSubmission(gameId, { username: 'sam', discordUserId: 'SYSTEM', score: 1_445_010 });
        await createTestSubmission(gameId, { username: 'justin', discordUserId: USER, score: 1_234_560 });
        // A row whose only name is a bare snowflake must never be drawn as one.
        await createTestSubmission(gameId, { username: STRANGER, discordUserId: STRANGER, score: 5 });
        await db.run(`INSERT INTO global_games (id, name, type, status, local_image_path) VALUES (?, 'AC/DC', 'pinball', 'approved', 'data/catalogue-images/acdc.png')`, crypto.randomUUID());

        const { playerId, screens } = await CabinetFrameService.screensFor(CABINET);
        expect(playerId).toBe(USER);
        expect(screens.map(s => s.key)).toEqual(['attract', 'card']);

        const attract = screens[0]!.backglass!.input.data as CabinetAttractData;
        expect(attract).toMatchObject({ player: 'JUSTIN', sendingTo: 'Mox Game Room', openCount: 1, lastScore: null });
        expect(screens[0]!.dots).toBe('logo;text|PLAYING AS|JUSTIN;text|OPEN TABLES|1');

        const card = screens[1]!;
        const data = card.backglass!.input.data as CabinetCardData;
        expect(card.dmd!.input.data).toEqual(data);
        expect(data).toMatchObject({
            roomName: 'MOX GAME ROOM', kindLabel: 'WEEKLY', table: 'AC/DC',
            artUrl: '/api/catalogue-images/acdc.png', endsText: null,
            attemptsText: '3 OF 3 ATTEMPTS LEFT', practice: false,
            playersText: '4 PLAYERS', footerRight: 'YOU NEED 210,450 FOR 2ND',
        });
        expect(data.rows.map(r => [r.rank, r.name, r.score, r.me])).toEqual([
            ['1', 'MIKE', '2,940,110', false],
            ['2', 'SAM', '1,445,010', false],
            ['3', 'JUSTIN', '1,234,560', true],
            ['4', UNKNOWN_PLAYER, '5', false],
        ]);
        expect(card.dots).toBe('text|TO TAKE 2ND ON AC/DC|+210,450;text|ATTEMPTS LEFT|3 OF 3');
        expect(card.rect).toBe(CABINET_DMD_RECT_TEXT);

        const everything = JSON.stringify(screens);
        for (const id of [USER, RIVAL, STRANGER]) expect(everything).not.toContain(id);
    });

    it('frames are for whoever is playing now, not the account that paired', async () => {
        const db = await getDatabase();
        const room = await createTestRoom('fam', 'Family Room');
        await member(room, PARTNER);
        await profile(USER, 'Justin');
        await profile(PARTNER, 'Dana');
        await rotation(room, 'Weekly', 'Medieval Madness');
        await db.run(`UPDATE witness_devices SET clock_offset_at = datetime('now') WHERE atgames_unique_id = ?`, CABINET);
        const { WitnessDevicePlayersService } = await import('../services/WitnessDevicePlayersService.js');
        const { code } = await WitnessDevicePlayersService.createInvite(USER, CABINET);
        await WitnessDevicePlayersService.acceptInvite(PARTNER, code);

        // USER (the pairer, not in the room) plays: no card.
        let set = await CabinetFrameService.screensFor(CABINET);
        expect(set.playerId).toBe(USER);
        expect(set.screens.filter(s => s.key === 'card')).toHaveLength(0);

        const { WitnessPlaySessionService } = await import('../services/WitnessPlaySessionService.js');
        await WitnessPlaySessionService.switchTo({ deviceId: CABINET, targetUserId: PARTNER, actorId: USER, via: 'web' });
        set = await CabinetFrameService.screensFor(CABINET);
        expect(set.playerId).toBe(PARTNER);
        expect((set.screens[0]!.backglass!.input.data as CabinetAttractData).player).toBe('DANA');
        expect(set.screens.filter(s => s.key === 'card')).toHaveLength(1);
    });

    it('standings and activity come from the routed rooms', async () => {
        const db = await getDatabase();
        const room = await createTestRoom('mox', 'Mox Game Room');
        await member(room);
        await profile(USER, 'Justin');
        await profile(RIVAL, 'Mike');
        const { tournamentId, gameId } = await rotation(room, 'Weekly', 'AC/DC');
        await createTestSubmission(gameId, { username: 'mike', discordUserId: RIVAL, score: 3000 });
        await createTestSubmission(gameId, { username: 'justin', discordUserId: USER, score: 1000 });
        const { RankingService } = await import('../services/RankingService.js');
        await RankingService.create({
            id: crypto.randomUUID(), name: 'Season 6', rank_method: 'max_10', best_n: 5, min_games: 0,
            tournament_ids: [tournamentId], game_room_id: room,
        });
        await db.run(
            `INSERT INTO lobby_feed_events (game_room_id, type, title, player_id, game_name, created_at)
             VALUES (?, 'score_posted', 'Mike took 1st on AC/DC', ?, 'AC/DC', datetime('now', '-1 minute')),
                    (?, 'admin_message', 'Old news', NULL, NULL, datetime('now', '-3 days'))`,
            room, RIVAL, room,
        );

        const { screens } = await CabinetFrameService.screensFor(CABINET);
        const standings = screens.find(s => s.key === 'standings')!.backglass!.input.data as CabinetStandingsData;
        expect(standings).toMatchObject({ roomName: 'MOX GAME ROOM', title: 'SEASON 6', footerLeft: 'POINTS FROM 1 TABLE' });
        expect(standings.rows.map(r => [r.name, r.me])).toEqual([['MIKE', false], ['JUSTIN', true]]);
        expect(standings.footerRight).toMatch(/^YOU: 2ND, \d+ BEHIND MIKE$/);

        const activity = screens.find(s => s.key === 'activity')!;
        const feed = activity.backglass!.input.data as CabinetActivityData;
        expect(feed.roomCountText).toBe('1 ROOM');
        expect(feed.items.map(i => [i.text, i.hot])).toEqual([['Mike took 1st on AC/DC', true], ['Old news', false]]);
        expect(activity.dots).toBe('ticker|LATEST|MIKE TOOK 1ST ON AC/DC · OLD NEWS');
    });

    it('a live event: LIVE, the round in play, clock times, no check-in written', async () => {
        const db = await getDatabase();
        const room = await createTestRoom('mox', 'Mox Game Room');
        await member(room);
        const tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_required)
             VALUES (?, 'Friday Night', 'DG', 'pinball', '{}', 1, ?, 'event', 0)`,
            tournamentId, room,
        );
        const end = nowSec() + 20 * MINUTE;
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Twilight Zone', 'ACTIVE', ?, 2, ?, ?)`,
            crypto.randomUUID(), tournamentId, room, iso(nowSec() - 10 * MINUTE), iso(end),
        );
        const { screens } = await CabinetFrameService.screensFor(CABINET);
        const event = screens.find(s => s.key === 'event')!;
        expect(event.backglass!.input.data).toMatchObject({
            eventName: 'FRIDAY NIGHT', stateLabel: 'LIVE', roundLabel: 'ROUND 2', table: 'TWILIGHT ZONE',
            checkedIn: false, footerLeft: '', footerRight: '',
        });
        expect((event.backglass!.input.data as { endText: string }).endText).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
        expect(event.dots).toBe(`text|LIVE|FRIDAY NIGHT;count|ROUND 2 ENDS IN|${end}`);
        expect(await db.get('SELECT COUNT(*) AS n FROM tournament_participants')).toEqual({ n: 0 });
    });

    it('honours the player\'s choices; all off is nothing', async () => {
        const room = await createTestRoom('mox', 'Mox Game Room');
        await member(room);
        await rotation(room, 'Weekly', 'AC/DC');
        expect(await CabinetFrameService.setPreferences(CABINET, USER, { screens: ['card'], seconds: 20 }))
            .toEqual({ screens: ['card'], seconds: 20 });
        let { screens } = await CabinetFrameService.screensFor(CABINET);
        expect(screens.map(s => [s.key, s.secs])).toEqual([['card', 20]]);
        await CabinetFrameService.setPreferences(CABINET, USER, { screens: [] });
        ({ screens } = await CabinetFrameService.screensFor(CABINET));
        expect(screens).toEqual([]);
        // Someone not on the device stores nothing.
        expect(await CabinetFrameService.setPreferences(CABINET, STRANGER, { screens: [] })).toBeNull();
    });
});

describe('the device manifest', () => {
    it('bare 401 for no token, a wrong one, an unknown or unpaired device', async () => {
        for (const res of [await frames({}, null), await frames({}, 'wrong'), await frames({ device: 'NOPE' })]) {
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ ok: false });
        }
        await WitnessService.revokeDevice(USER, CABINET);
        expect((await frames()).status).toBe(401);
        const pic = await request(app).get(`/api/witness/frames/${'a'.repeat(32)}.jpg`).query({ device: CABINET, token: 'wrong' });
        expect(pic.status).toBe(401);
    });

    it('flat strings, Ready 0 until drawn, then 1; each picture rendered once; the read writes nothing else', async () => {
        const room = await createTestRoom('mox', 'Mox "Quoted" Room\\');
        await member(room);
        await rotation(room, 'Weekly "Cup"', 'AC/DC');
        const db = await getDatabase();
        const before = await db.get(`SELECT last_seen_at, heartbeat_at, clock_offset_at FROM witness_devices WHERE atgames_unique_id = ?`, CABINET);

        const first = await frames();
        expect(first.status).toBe(200);
        expectFlatManifest(first.body);
        expect(first.body).toMatchObject({ refresh: '60', count: '2', s1Kind: 'attract', s2Kind: 'card', s1Secs: '10', s1Ready: '0' });
        expect(first.body.s1Bg).toMatch(/^[0-9a-f]{32}$/);
        expect(first.body.s2Rect).toBe('64,318,1792,448');
        expect(Math.abs(Number(first.body.now) - nowSec())).toBeLessThan(5);

        // A second manifest while the first renders queues nothing new.
        await frames();
        await CabinetFrameRenderer.whenIdle();
        expect(captured).toHaveLength(4);
        expect(new Set(captured.map(c => `${c.kind}:${c.screen}`))).toEqual(new Set(['backglass:attract', 'dmd:attract', 'backglass:card', 'dmd:card']));

        const second = await frames();
        expect(second.body).toMatchObject({ s1Ready: '1', s2Ready: '1', s1Bg: first.body.s1Bg });
        await CabinetFrameRenderer.whenIdle();
        expect(captured).toHaveLength(4);

        const pic = await request(app).get(`/api/witness/frames/${second.body.s2Dmd}.jpg`).query({ device: CABINET, token });
        expect(pic.status).toBe(200);
        expect(pic.headers['content-type']).toBe('image/jpeg');
        expect(pic.headers['cache-control']).toBe('private, max-age=86400');
        expect(Number(pic.headers['content-length'])).toBe(pic.body.length);
        expect(pic.body.toString()).toBe('JPEG dmd card');

        const missing = await request(app).get(`/api/witness/frames/${'0'.repeat(32)}.jpg`).query({ device: CABINET, token });
        expect(missing.status).toBe(404);
        const bad = await request(app).get('/api/witness/frames/..%2F..%2Fsecret.jpg').query({ device: CABINET, token });
        expect(bad.status).toBe(404);

        const after = await db.get(`SELECT last_seen_at, heartbeat_at, clock_offset_at FROM witness_devices WHERE atgames_unique_id = ?`, CABINET);
        expect(after).toEqual(before);
    });
});

describe('the public pair screen', () => {
    it('400 for a code the tile could not show; one pair screen with only the code', async () => {
        for (const code of ['', 'abcdef', 'K7Q4M', 'K7Q4M0', 'K7Q4MX1']) {
            const res = await request(app).get('/api/witness/pair-frames').query({ code });
            expect(res.status, code).toBe(400);
        }
        expect((await request(app).get('/api/witness/pair-frames')).status).toBe(400);

        const res = await request(app).get('/api/witness/pair-frames').query({ code: 'K7Q4MX' });
        expect(res.status).toBe(200);
        expectFlatManifest(res.body);
        expect(res.body).toMatchObject({ count: '1', s1Kind: 'pair', s1Rect: '', s1Dots: '', s1Ready: '0' });
        await CabinetFrameRenderer.whenIdle();
        expect(captured.map(c => c.data)).toEqual([
            { code: 'K7Q4MX', url: 'https://arcaid.app/pair/K7Q4MX' },
            { code: 'K7Q4MX', url: 'https://arcaid.app/pair/K7Q4MX' },
        ]);
        const pic = await request(app).get(`/api/witness/pair-frames/${res.body.s1Bg}.jpg`);
        expect(pic.status).toBe(200);
        expect(pic.headers['content-type']).toBe('image/jpeg');
    });

    it('never serves a player\'s picture', async () => {
        await frames();
        await CabinetFrameRenderer.whenIdle();
        const manifest = await frames();
        expect(manifest.body.s1Ready).toBe('1');
        expect((await request(app).get(`/api/witness/pair-frames/${manifest.body.s1Bg}.jpg`)).status).toBe(404);
    });
});

describe('the player\'s choices and preview', () => {
    const base = `/api/me/witness-devices/${CABINET}`;

    it('401 without auth, 404 for someone not on the device', async () => {
        for (const res of [
            await request(app).get(`${base}/cabinet-screens`),
            await request(app).put(`${base}/cabinet-screens`).send({ screens: [], seconds: 10 }),
            await request(app).get(`${base}/cabinet-frames`),
            await request(app).get(`${base}/cabinet-frames/${'a'.repeat(32)}.jpg`),
        ]) expect(res.status).toBe(401);
        for (const res of [
            await request(app).get(`${base}/cabinet-screens`).set(asPlayer(STRANGER)),
            await request(app).put(`${base}/cabinet-screens`).set(asPlayer(STRANGER)).send({ screens: [], seconds: 10 }),
            await request(app).get(`${base}/cabinet-frames`).set(asPlayer(STRANGER)),
            await request(app).get(`${base}/cabinet-frames/${'a'.repeat(32)}.jpg`).set(asPlayer(STRANGER)),
        ]) expect(res.status).toBe(404);
    });

    it('reads defaults, stores a clean choice, refuses a malformed body', async () => {
        const got = await request(app).get(`${base}/cabinet-screens`).set(asPlayer(USER));
        expect(got.status).toBe(200);
        expect(got.body).toEqual({
            screens: [...CABINET_SCREEN_CHOICES], seconds: 10,
            defaults: { screens: [...CABINET_SCREEN_CHOICES], seconds: 10 },
        });

        const put = await request(app).put(`${base}/cabinet-screens`).set(asPlayer(USER))
            .send({ screens: ['activity', 'attract', 'pair', 'bogus'], seconds: 45 });
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ screens: ['attract', 'activity'], seconds: 30 });
        expect((await request(app).get(`${base}/cabinet-screens`).set(asPlayer(USER))).body)
            .toMatchObject({ screens: ['attract', 'activity'], seconds: 30 });

        // An empty list is a real choice (all off).
        const off = await request(app).put(`${base}/cabinet-screens`).set(asPlayer(USER)).send({ screens: [], seconds: 10 });
        expect(off.body).toEqual({ screens: [], seconds: 10 });

        for (const body of [{ screens: 'attract', seconds: 10 }, { screens: [], seconds: '10' }, { screens: [1], seconds: 10 }, { seconds: 10 }, { screens: [] }, [1]]) {
            expect((await request(app).put(`${base}/cabinet-screens`).set(asPlayer(USER)).send(body)).status).toBe(400);
        }
    });

    it('previews the pictures as player-auth URLs', async () => {
        const res = await request(app).get(`${base}/cabinet-frames`).set(asPlayer(USER));
        expect(res.status).toBe(200);
        expect(res.body.screens).toHaveLength(1);
        const [attract] = res.body.screens;
        expect(Object.keys(attract).sort()).toEqual(['backglassUrl', 'dmdUrl', 'key', 'label', 'ready', 'secs']);
        expect(attract).toMatchObject({ key: 'attract', label: 'Attract', secs: 10, ready: false });
        expect(attract.backglassUrl).toMatch(new RegExp(`^${base}/cabinet-frames/[0-9a-f]{32}\\.jpg$`));
        expect(attract.dmdUrl).toMatch(new RegExp(`^${base}/cabinet-frames/[0-9a-f]{32}\\.jpg$`));
        expect((await request(app).get(attract.backglassUrl).set(asPlayer(USER))).status).toBe(404);
        await CabinetFrameRenderer.whenIdle();
        expect((await request(app).get(`${base}/cabinet-frames`).set(asPlayer(USER))).body.screens[0].ready).toBe(true);
        const pic = await request(app).get(attract.backglassUrl).set(asPlayer(USER));
        expect(pic.status).toBe(200);
        expect(pic.headers['content-type']).toBe('image/jpeg');
    });
});

describe('the renderer', () => {
    const input = (n: number): CabinetFrameInput => ({ kind: 'dmd', screen: 'pair', data: { code: `AAAAA${n}`, url: 'u' } });

    it('is inert under vitest without a capture stub', async () => {
        CabinetFrameRenderer.setForTests({ capture: null });
        const id = cabinetFrameId(input(2));
        CabinetFrameRenderer.enqueue(id, input(2), 'device');
        await CabinetFrameRenderer.whenIdle();
        expect(CabinetFrameRenderer.queuedCount()).toBe(0);
        expect(await CabinetFrameRenderer.has(id, 'device')).toBe(false);
    });

    it('de-duplicates: the same id queued many times is drawn once; one render at a time', async () => {
        let running = 0;
        let peak = 0;
        CabinetFrameRenderer.setForTests({
            capture: async (inp, file) => {
                running += 1;
                peak = Math.max(peak, running);
                await new Promise(r => setTimeout(r, 5));
                await stubCapture(inp, file);
                running -= 1;
            },
        });
        const a = cabinetFrameId(input(2));
        const b = cabinetFrameId(input(3));
        for (let i = 0; i < 5; i++) {
            CabinetFrameRenderer.enqueue(a, input(2), 'device');
            CabinetFrameRenderer.enqueue(b, input(3), 'device');
        }
        await CabinetFrameRenderer.whenIdle();
        expect(captured).toHaveLength(2);
        expect(peak).toBe(1);
        CabinetFrameRenderer.enqueue(a, input(2), 'device');
        await CabinetFrameRenderer.whenIdle();
        expect(captured).toHaveLength(2);
        // A failed render leaves no file and does not stop the queue.
        CabinetFrameRenderer.setForTests({ capture: async () => { throw new Error('boom'); } });
        CabinetFrameRenderer.enqueue(cabinetFrameId(input(4)), input(4), 'device');
        await CabinetFrameRenderer.whenIdle();
        expect(await CabinetFrameRenderer.has(cabinetFrameId(input(4)), 'device')).toBe(false);
        expect(fs.readdirSync(root).filter(n => n.includes('.tmp-'))).toEqual([]);
    });

    it('prunes pictures not read for 7 days, then the oldest-read over the cap; a read touches', async () => {
        const write = (dir: string, n: number, ageDays: number, bytes = 100) => {
            const id = crypto.createHash('md5').update(`f${n}`).digest('hex');
            const file = path.join(dir, `${id}.jpg`);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, Buffer.alloc(bytes));
            const t = new Date(Date.now() - ageDays * 86_400_000);
            fs.utimesSync(file, t, t);
            return { id, file };
        };
        const stale = write(root, 1, 8);
        const stalePair = write(path.join(root, 'pair'), 2, 9);
        const oldest = write(root, 3, 3);
        const middle = write(root, 4, 2);
        const newest = write(root, 5, 1);
        const other = path.join(root, 'notes.txt');
        fs.writeFileSync(other, 'keep');

        // Reading the oldest makes it the newest.
        expect(await CabinetFrameRenderer.open(oldest.id, 'device')).not.toBeNull();
        CabinetFrameRenderer.setForTests({ maxBytes: 250 });
        const result = await CabinetFrameRenderer.prune();
        expect(result.removed).toBe(3);
        expect(fs.existsSync(stale.file)).toBe(false);
        expect(fs.existsSync(stalePair.file)).toBe(false);
        expect(fs.existsSync(middle.file)).toBe(false);
        expect(fs.existsSync(newest.file)).toBe(true);
        expect(fs.existsSync(oldest.file)).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
        expect(await CabinetFrameRenderer.open('../../etc/passwd', 'device')).toBeNull();
    });
});
