import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { EventResultService } from '../services/EventResultService.js';
import { RoomActiveTablesService, ROOM_ACTIVE_TABLES_MAX } from '../services/RoomActiveTablesService.js';
import { __clearRoomListCache } from '../api/routes/global.js';

/**
 * G35b (v2.279.0) — `GET /api/rooms` carries each listed room's `activeTables`:
 * the board's live tables (at most 3, newest score first, no-score boards
 * last), each with its art, its #1's label (resolved at read, never a raw id)
 * and the #1 score; `[]` for an approval room.
 *
 * G35d (v2.283.0) — a live EVENT ROUND is listed too, its #1 read from its
 * round board exactly as the room board shows it (under `witness_flag_mode =
 * 'prevent'` a flagged best does not lead), ordered by its own rows' newest
 * score; and the whole answer is remembered for 30 seconds.
 */

// The answer is cached for 30 s: no test may see another's.
beforeEach(() => { __clearRoomListCache(); });
afterEach(() => { vi.restoreAllMocks(); });

const START = '2026-11-20T00:00:00.000Z';

async function appWithGlobalRouter() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

async function addGame(tournamentId: string, roomId: string, name: string, opts: {
    status?: string; startDate?: string; displayName?: string; roundNo?: number;
} = {}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, game_room_id, name, display_name, status, start_date, round_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, tournamentId, roomId, name, opts.displayName ?? null, opts.status ?? 'ACTIVE',
        opts.startDate ?? START, opts.roundNo ?? null,
    );
    return id;
}

async function addArt(name: string, art: { local?: string; wheel?: string; remote?: string }) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, status, local_image_path, wheel_image_path, image_url)
         VALUES (?, ?, 'pinball', 'approved', ?, ?, ?)`,
        crypto.randomUUID(), name, art.local ?? null, art.wheel ?? null, art.remote ?? null,
    );
}

/**
 * A score on a game's board. `ownerId` = an attributed (logged-in) player;
 * without it the row is an unowned synced alias (`iscored:<name>`).
 */
async function addScore(gameId: string, opts: { username: string; score: number; createdAt: string; ownerId?: string }) {
    const db = await getDatabase();
    const game = await db.get<{ name: string; tournament_id: string; game_room_id: string }>(
        `SELECT g.name, g.tournament_id, t.game_room_id FROM games g JOIN tournaments t ON t.id = g.tournament_id WHERE g.id = ?`,
        gameId,
    );
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id,
            submitted_by_user_id, score, source, submitted_from_room_id, submitted_during_tournament_id, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'tournament', ?, ?, ?)`,
        game!.name, game!.game_room_id, opts.username, opts.ownerId ?? `iscored:${opts.username}`,
        opts.ownerId ?? null, opts.score, game!.game_room_id, game!.tournament_id, opts.createdAt,
    );
}

async function addProfile(discordUserId: string, displayName: string | null) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`,
        discordUserId, displayName,
    );
}

/** SQLite's own UTC shape, what `score_history.created_at` holds. */
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const MINUTE = 60_000;

/** A Live Event tournament in a room (`format = 'event'`). */
async function addEvent(roomId: string, flagMode: 'prevent' | 'flag' = 'prevent') {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, witness_flag_mode)
         VALUES (?, 'Wizard Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', ?)`,
        id, roomId, flagMode,
    );
    return id;
}

interface Round { id: string; eventId: string; roomId: string; name: string }

/** One round of an event: a `games` row with a `round_no` and its window (what EventService writes, started). */
async function addRound(eventId: string, roomId: string, name: string, roundNo: number, startMs: number, endMs: number, status = 'ACTIVE'): Promise<Round> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, game_room_id, name, status, start_date, round_no, scheduled_start_at, scheduled_end_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, eventId, roomId, name, status, new Date(startMs).toISOString(), roundNo,
        new Date(startMs).toISOString(), new Date(endMs).toISOString(),
    );
    return { id, eventId, roomId, name };
}

/**
 * A score on a round. Stamped with the round's `game_id` (what the event gate
 * and the witness ingest write) unless `stamped: false` (a synced row, which
 * the round board places by name + window). `launchMs` files the witness game
 * observation for a `vpx` score: a launch before the round opened is `flagged`.
 */
async function addRoundScore(round: Round, opts: {
    username: string; score: number; atMs: number; ownerId?: string;
    source?: 'tournament' | 'vpx'; stamped?: boolean; launchMs?: number;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id,
            submitted_by_user_id, score, source, submitted_from_room_id, submitted_during_tournament_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        round.name, round.roomId, opts.stamped === false ? null : round.id, opts.username,
        opts.ownerId ?? `iscored:${opts.username}`, opts.ownerId ?? null, opts.score, opts.source ?? 'tournament',
        round.roomId, round.eventId, sqliteTs(opts.atMs),
    );
    if (opts.launchMs !== undefined) {
        const launch = Math.floor(opts.launchMs / 1000);
        const exit = Math.floor(opts.atMs / 1000);
        await db.run(
            `INSERT INTO witness_observations
                (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via, kind)
             VALUES (?, ?, 'table_rom', ?, ?, ?, 'live', 'game')`,
            `dev-${opts.ownerId}`, opts.ownerId, launch, exit, exit - launch,
        );
    }
}

/** A raw id in any of the shapes a player label must never be. */
function looksLikeRawId(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return /^\d{15,20}$/.test(value) || /^(iscored|atgames|system):/i.test(value) || value === 'SYSTEM';
}

async function roomFrom(app: express.Express, roomId: string) {
    const res = await request(app).get('/api/rooms');
    expect(res.status).toBe(200);
    const room = res.body.find((r: any) => r.id === roomId);
    expect(room).toBeDefined();
    return room;
}

describe('GET /api/rooms — activeTables (G35b)', () => {
    it('an open room with 5 live boards lists 3, newest score first, with name, art, the board #1 and its score', async () => {
        const app = await appWithGlobalRouter();
        const roomId = await createTestRoom('whats-on', 'Whats On');
        const tId = await createTestTournament(roomId);

        const afm = await addGame(tId, roomId, 'Attack From Mars');
        const mm = await addGame(tId, roomId, 'Medieval Madness');
        const tz = await addGame(tId, roomId, 'Twilight Zone', { displayName: 'TZ (house rules)' });
        const mb = await addGame(tId, roomId, 'Monster Bash');
        const tom = await addGame(tId, roomId, 'Theatre of Magic');

        await addArt('Attack From Mars', { local: 'data/catalogue-images/afm.png', remote: 'https://img.example/afm-remote.jpg' });
        await addArt('Medieval Madness', { wheel: 'data/catalogue-images/mm-wheel.png' });
        await addArt('Twilight Zone', { remote: 'https://img.example/tz.jpg' });
        await addArt('Theatre of Magic', { local: 'data/catalogue-images/tom.png' });
        // Monster Bash has no catalogue row: imageUrl null (not listed anyway).

        await addProfile('111111111111111111', 'Wizard Wendy');
        await addScore(afm, { username: 'Ace', score: 5_000_000, createdAt: '2026-11-24 10:00:00' });
        await addScore(afm, { username: 'Bo', score: 7_000_000, createdAt: '2026-11-25 10:00:00' });
        await addScore(mm, { username: 'Cy', score: 9_000_000, createdAt: '2026-11-21 10:00:00' });
        await addScore(tz, { username: 'wendy_alias', ownerId: '111111111111111111', score: 90_000_000, createdAt: '2026-11-22 09:00:00' });
        await addScore(tz, { username: 'Dee', score: 40_000_000, createdAt: '2026-11-26 09:00:00' });
        await addScore(mb, { username: 'Eli', score: 1_000_000, createdAt: '2026-11-22 10:00:00' });
        await addScore(tom, { username: 'Fay', score: 3_000_000, createdAt: '2026-11-25 12:00:00' });
        await addScore(tom, { username: 'Gus', score: 2_000_000, createdAt: '2026-11-23 12:00:00' });

        const room = await roomFrom(app, roomId);
        const tables = room.activeTables as any[];
        expect(tables).toHaveLength(ROOM_ACTIVE_TABLES_MAX);
        // TZ (newest score 11-26), Theatre (11-25 12:00), Attack (11-25 10:00).
        expect(tables.map(t => t.gameId)).toEqual([tz, tom, afm]);
        expect(tables.map(t => t.name)).toEqual(['TZ (house rules)', 'Theatre of Magic', 'Attack From Mars']);
        expect(tables.map(t => t.imageUrl)).toEqual([
            'https://img.example/tz.jpg',
            '/api/catalogue-images/tom.png',
            '/api/catalogue-images/afm.png',
        ]);
        expect(tables.map(t => [t.leaderName, t.topScore])).toEqual([
            ['Wizard Wendy', 90_000_000],
            ['Fay', 3_000_000],
            ['Bo', 7_000_000],
        ]);

        // The #1 is the room board's #1: same player label, same score.
        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        for (const table of tables) {
            const board = boards.find(b => b.gameId === table.gameId)!;
            expect(board).toBeDefined();
            const top = board.rankings[0]!;
            expect(table.leaderName).toBe(top.display_name ?? top.iscored_username);
            expect(table.topScore).toBe(top.score);
        }
        // Every key the contract names, and nothing else.
        expect(Object.keys(tables[0]).sort()).toEqual(['gameId', 'imageUrl', 'leaderName', 'name', 'topScore']);
    });

    it('shows a display name, else the alias; never a raw id', async () => {
        const app = await appWithGlobalRouter();
        const db = await getDatabase();

        const roomA = await createTestRoom('labels-a', 'Labels A');
        const tA = await createTestTournament(roomA);
        const named = await addGame(tA, roomA, 'Named Board');
        const alias = await addGame(tA, roomA, 'Alias Board');
        const noProfile = await addGame(tA, roomA, 'No Profile Board');
        await addProfile('222222222222222222', 'Pinball Pat');
        await addScore(named, { username: 'pat_typed', ownerId: '222222222222222222', score: 500, createdAt: '2026-11-25 10:00:00' });
        await addScore(alias, { username: 'SyncedSam', score: 400, createdAt: '2026-11-24 10:00:00' });
        // A logged-in player with no profile row: the board shows the name they
        // submitted under, never their snowflake.
        await addScore(noProfile, { username: 'QuietQuinn', ownerId: '333333333333333333', score: 300, createdAt: '2026-11-23 10:00:00' });

        // Room B: a synced alias that a player has since linked resolves
        // through user_mappings to that player's display name.
        const roomB = await createTestRoom('labels-b', 'Labels B');
        const tB = await createTestTournament(roomB);
        const linked = await addGame(tB, roomB, 'Linked Board');
        await addProfile('444444444444444444', 'Linked Lou');
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`,
            '444444444444444444', 'LOU_ISCORED',
        );
        await addScore(linked, { username: 'LOU_ISCORED', score: 999, createdAt: '2026-11-25 10:00:00' });

        const res = await request(app).get('/api/rooms');
        expect(res.status).toBe(200);
        const a = res.body.find((r: any) => r.id === roomA);
        const b = res.body.find((r: any) => r.id === roomB);
        expect(a.activeTables.map((t: any) => [t.gameId, t.leaderName])).toEqual([
            [named, 'Pinball Pat'],
            [alias, 'SyncedSam'],
            [noProfile, 'QuietQuinn'],
        ]);
        expect(b.activeTables.map((t: any) => t.leaderName)).toEqual(['Linked Lou']);

        for (const room of res.body) {
            for (const table of room.activeTables) {
                expect(looksLikeRawId(table.leaderName)).toBe(false);
                expect(looksLikeRawId(table.name)).toBe(false);
            }
        }
    });

    it('a board with no score yet has a null leader and score and sorts last, in board order', async () => {
        const app = await appWithGlobalRouter();
        const roomId = await createTestRoom('quiet-room', 'Quiet Room');
        const tId = await createTestTournament(roomId);
        const empty1 = await addGame(tId, roomId, 'Empty One', { startDate: '2026-11-20T01:00:00.000Z' });
        const scored = await addGame(tId, roomId, 'Scored', { startDate: '2026-11-20T02:00:00.000Z' });
        // A table back for a second run: its first run's score belongs to the
        // first run (gameRunWindow), so the live run has no score yet.
        await addGame(tId, roomId, 'Empty Two', { status: 'COMPLETED', startDate: '2026-11-10T00:00:00.000Z' });
        const empty2 = await addGame(tId, roomId, 'Empty Two', { startDate: '2026-11-20T03:00:00.000Z' });
        await addScore(scored, { username: 'Solo', score: 1234, createdAt: '2026-11-21 10:00:00' });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id, created_at)
             VALUES ('Empty Two', ?, 'OldRun', 'iscored:OldRun', 77777, 'tournament', ?, ?, '2026-11-12 10:00:00')`,
            roomId, roomId, tId,
        );

        const room = await roomFrom(app, roomId);
        expect(room.activeTables.map((t: any) => t.gameId)).toEqual([scored, empty1, empty2]);
        expect(room.activeTables[0]).toMatchObject({ leaderName: 'Solo', topScore: 1234 });
        expect(room.activeTables[1]).toMatchObject({ name: 'Empty One', leaderName: null, topScore: null, imageUrl: null });
        expect(room.activeTables[2]).toMatchObject({ name: 'Empty Two', leaderName: null, topScore: null });

        // The board agrees: the live Empty Two card has no rows.
        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(boards.find(b => b.gameId === empty2)!.rankings).toEqual([]);
    });

    it('an approval room lists activeTables: [] with its counts still 0; an open room beside it lists its tables', async () => {
        const app = await appWithGlobalRouter();
        const hidden = await createTestRoom('approval-tables', 'Approval Tables');
        await GameRoomSettingsService.set(hidden, 'JOIN_POLICY', 'approval');
        const tHidden = await createTestTournament(hidden);
        const hiddenGame = await addGame(tHidden, hidden, 'Hidden Table');
        await addScore(hiddenGame, { username: 'Secret', score: 42, createdAt: '2026-11-25 10:00:00' });

        const open = await createTestRoom('open-tables', 'Open Tables');
        await GameRoomSettingsService.set(open, 'JOIN_POLICY', 'discord_role');
        const tOpen = await createTestTournament(open);
        const openGame = await addGame(tOpen, open, 'Open Table');
        await addScore(openGame, { username: 'Public', score: 43, createdAt: '2026-11-25 10:00:00' });

        const res = await request(app).get('/api/rooms');
        const h = res.body.find((r: any) => r.id === hidden);
        const o = res.body.find((r: any) => r.id === open);
        expect(h).toMatchObject({ join_policy: 'approval', activeGames: 0, activePlayers: 0, discordInviteUrl: null, activeTables: [] });
        // A discord_role room views like an open one.
        expect(o.join_policy).toBe('discord_role');
        expect(o.activeTables).toEqual([
            { gameId: openGame, name: 'Open Table', imageUrl: null, leaderName: 'Public', topScore: 43 },
        ]);
    });

    // G35d changed this test: before it, the live event round was left OUT
    // (G35b); now it is listed like any other live card (owner 2026-11-27).
    it('lists live cards only: no retained COMPLETED card, nothing for an unlisted room; a live event round IS listed', async () => {
        const app = await appWithGlobalRouter();
        const db = await getDatabase();
        const roomId = await createTestRoom('live-only', 'Live Only');
        const tId = await createTestTournament(roomId);
        await db.run(`UPDATE tournaments SET cleanup_rule = ? WHERE id = ?`, JSON.stringify({ mode: 'retain', count: 3 }), tId);
        const live = await addGame(tId, roomId, 'Live Table');
        const done = await addGame(tId, roomId, 'Finished Table', { status: 'COMPLETED', startDate: '2026-11-19T00:00:00.000Z' });
        await addScore(live, { username: 'Now', score: 10, createdAt: '2026-11-21 10:00:00' });
        await addScore(done, { username: 'Then', score: 20, createdAt: '2026-11-25 10:00:00' });

        const eventId = await addEvent(roomId);
        const round = await addRound(eventId, roomId, 'Event Round Table', 1, Date.parse('2026-11-26T09:00:00.000Z'), Date.parse('2026-11-26T12:00:00.000Z'));
        await addRoundScore(round, { username: 'Eventful', score: 30, atMs: Date.parse('2026-11-26T10:00:00.000Z') });

        const unlisted = await createTestRoom('unlisted-tables', 'Unlisted Tables');
        await GameRoomSettingsService.set(unlisted, 'ROOM_LISTED', 'false');
        const tU = await createTestTournament(unlisted);
        await addGame(tU, unlisted, 'Unlisted Table');

        const res = await request(app).get('/api/rooms');
        const room = res.body.find((r: any) => r.id === roomId);
        // The round's score (11-26) is newer than the live table's (11-21).
        expect(room.activeTables.map((t: any) => t.gameId)).toEqual([round.id, live]);
        expect(room.activeTables[0]).toMatchObject({ name: 'Event Round Table', leaderName: 'Eventful', topScore: 30 });
        expect(res.body.find((r: any) => r.id === unlisted)).toBeUndefined();

        // The retained card IS on the board; it is just not being played.
        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(boards.map(b => b.gameId)).toEqual(expect.arrayContaining([live, done, round.id]));
    });

    it('costs the same number of queries for 2 boards or 8, and one batch however many rooms', async () => {
        await setupTestDb();
        const makeRoom = async (slug: string, boards: number) => {
            const roomId = await createTestRoom(slug, slug);
            const tId = await createTestTournament(roomId);
            for (const s of [0, 2, 4]) await addProfile(`${slug}-owner-${s}`, `${slug} player ${s}`);
            for (let b = 0; b < boards; b++) {
                const gameId = await addGame(tId, roomId, `${slug} table ${b}`);
                await addArt(`${slug} table ${b}`, { local: `data/catalogue-images/${slug}-${b}.png` });
                for (let s = 0; s < 5; s++) {
                    await addScore(gameId, {
                        username: `${slug}-p${s}`,
                        score: 100 * (s + 1) + b,
                        createdAt: `2026-11-2${1 + s} 1${b}:00:00`,
                        ...(s % 2 === 0 ? { ownerId: `${slug}-owner-${s}` } : {}),
                    });
                }
            }
            return roomId;
        };
        const small = await makeRoom('small', 2);
        const big = await makeRoom('big', 8);
        const other = await makeRoom('other', 4);

        const db = await getDatabase();
        const count = async (roomIds: string[]) => {
            await RoomActiveTablesService.forRooms(roomIds); // warm the board cache
            let n = 0;
            const spies = (['all', 'get'] as const).map(m => {
                const original = (db as any)[m].bind(db);
                return vi.spyOn(db as any, m).mockImplementation((async (...args: any[]) => { n++; return original(...args); }) as any);
            });
            try {
                await RoomActiveTablesService.forRooms(roomIds);
            } finally {
                spies.forEach(s => s.mockRestore());
            }
            return n;
        };

        const oneSmall = await count([small]);
        const oneBig = await count([big]);
        const two = await count([small, big]);
        const three = await count([small, big, other]);
        expect(oneBig).toBe(oneSmall);
        // Each further room adds only its own card reads; the batch is shared.
        expect(three - two).toBe(two - oneSmall);
        expect(two - oneSmall).toBeLessThanOrEqual(4);
    });
});

describe('GET /api/rooms — event rounds in activeTables (G35d)', () => {
    const BASE = Date.parse('2026-11-26T20:00:00.000Z');
    const BEE = '222222222222222201';
    const ACE = '222222222222222202';

    /** The room board's #1 for a game, as the board renders it. */
    async function boardTop(roomId: string, gameId: string) {
        const board = (await LeaderboardService.getActiveLeaderboards(roomId)).find(b => b.gameId === gameId);
        expect(board).toBeDefined();
        const top = board!.rankings[0];
        return top ? { leaderName: top.display_name ?? top.iscored_username, topScore: top.score } : { leaderName: null, topScore: null };
    }

    it("lists a live round with its round board's #1 and score, the room board's #1; under prevent a flagged best does not lead", async () => {
        const app = await appWithGlobalRouter();
        const db = await getDatabase();
        const roomId = await createTestRoom('wizard-room', 'The Wizard Room');
        const eventId = await addEvent(roomId, 'prevent');
        const round = await addRound(eventId, roomId, 'Cactus Canyon', 1, BASE, BASE + 30 * MINUTE);
        await addProfile(ACE, 'Ace Display');
        await addProfile(BEE, 'Bee Display');
        // Ace geared up (launched 5 minutes before the round opened) for 900: flagged.
        await addRoundScore(round, { username: 'ace_cab', ownerId: ACE, source: 'vpx', score: 900, atMs: BASE + 10 * MINUTE, launchMs: BASE - 5 * MINUTE });
        // Bee's clean 700, launched inside the round.
        await addRoundScore(round, { username: 'bee_cab', ownerId: BEE, source: 'vpx', score: 700, atMs: BASE + 12 * MINUTE, launchMs: BASE + 8 * MINUTE });
        // A rotation table in the same room, last scored before the round.
        const tId = await createTestTournament(roomId);
        const afm = await addGame(tId, roomId, 'Attack From Mars');
        await addScore(afm, { username: 'Rotator', score: 5000, createdAt: sqliteTs(BASE - 60 * MINUTE) });

        const room = await roomFrom(app, roomId);
        expect(room.activeTables.map((t: any) => t.gameId)).toEqual([round.id, afm]);
        expect(room.activeTables[0]).toEqual({ gameId: round.id, name: 'Cactus Canyon', imageUrl: null, leaderName: 'Bee Display', topScore: 700 });
        expect(room.activeTables[0]).toMatchObject(await boardTop(roomId, round.id));
        for (const table of room.activeTables) expect(looksLikeRawId(table.leaderName)).toBe(false);

        // The same rows under 'flag': the flagged 900 is a badge, not a gate, and leads.
        await db.run(`UPDATE tournaments SET witness_flag_mode = 'flag' WHERE id = ?`, eventId);
        __clearRoomListCache();
        const flagged = await roomFrom(app, roomId);
        expect(flagged.activeTables[0]).toMatchObject({ gameId: round.id, leaderName: 'Ace Display', topScore: 900 });
        expect(flagged.activeTables[0]).toMatchObject(await boardTop(roomId, round.id));
    });

    it("orders a round by its own rows: an earlier round's late score does not count; a synced row in its window does", async () => {
        const app = await appWithGlobalRouter();
        const roomId = await createTestRoom('two-rounds', 'Two Rounds');
        const eventId = await addEvent(roomId);
        // Back to back, one table: round 1 ended at +30 min, round 2 runs now.
        const round1 = await addRound(eventId, roomId, 'Congo', 1, BASE, BASE + 30 * MINUTE, 'COMPLETED');
        const round2 = await addRound(eventId, roomId, 'Congo', 2, BASE + 30 * MINUTE, BASE + 60 * MINUTE);
        // Round 1's last score landed inside its end grace, after round 2 opened.
        await addRoundScore(round1, { username: 'Late', score: 999, atMs: BASE + 30 * MINUTE + 45_000 });
        const tId = await createTestTournament(roomId);
        const afm = await addGame(tId, roomId, 'Attack From Mars');
        await addScore(afm, { username: 'Rotator', score: 5000, createdAt: sqliteTs(BASE + 20 * MINUTE) });

        let room = await roomFrom(app, roomId);
        // Round 2 has no score of its own: last, with no leader.
        expect(room.activeTables.map((t: any) => t.gameId)).toEqual([afm, round2.id]);
        expect(room.activeTables[1]).toMatchObject({ name: 'Congo', leaderName: null, topScore: null });
        expect(room.activeTables[1]).toMatchObject(await boardTop(roomId, round2.id));

        // A synced row (no game_id) inside round 2's window is on its board, and is its newest score.
        await addRoundScore(round2, { username: 'Synced', score: 321, atMs: BASE + 40 * MINUTE, stamped: false });
        __clearRoomListCache();
        room = await roomFrom(app, roomId);
        expect(room.activeTables.map((t: any) => t.gameId)).toEqual([round2.id, afm]);
        expect(room.activeTables[0]).toMatchObject({ leaderName: 'Synced', topScore: 321 });
        expect(room.activeTables[0]).toMatchObject(await boardTop(roomId, round2.id));
    });

    it('reads a round board only for the round cards picked: five live rounds, three boards', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('many-rounds', 'Many Rounds');
        const eventId = await addEvent(roomId);
        const rounds: Round[] = [];
        for (let n = 0; n < 5; n++) {
            const round = await addRound(eventId, roomId, `Round Table ${n}`, n + 1, BASE, BASE + 60 * MINUTE);
            await addRoundScore(round, { username: `p${n}`, score: 100 + n, atMs: BASE + (n + 1) * MINUTE });
            rounds.push(round);
        }
        const spy = vi.spyOn(EventResultService, 'getRoundBoardDetail');
        const tables = (await RoomActiveTablesService.forRooms([roomId])).get(roomId)!;
        // Newest score first: rounds 4, 3, 2.
        expect(tables.map(t => t.gameId)).toEqual([rounds[4]!.id, rounds[3]!.id, rounds[2]!.id]);
        expect(tables.map(t => [t.leaderName, t.topScore])).toEqual([['p4', 104], ['p3', 103], ['p2', 102]]);
        expect(spy).toHaveBeenCalledTimes(3);
        expect(spy.mock.calls.map(([, round]) => round.id).sort()).toEqual([rounds[2]!.id, rounds[3]!.id, rounds[4]!.id].sort());
    });
});

describe('GET /api/rooms — the 30-second cache (G35d)', () => {
    it('two calls inside 30 s build the answer once; after the clear hook, or 30 s later, it is built again', async () => {
        const app = await appWithGlobalRouter();
        const roomId = await createTestRoom('cached-room', 'Cached Room');
        const getPublic = vi.spyOn(GameRoomService, 'getPublic');
        const forRooms = vi.spyOn(RoomActiveTablesService, 'forRooms');

        const first = await request(app).get('/api/rooms');
        expect(first.status).toBe(200);
        expect(getPublic).toHaveBeenCalledTimes(1);
        expect(forRooms).toHaveBeenCalledTimes(1);

        // A room listed after the answer was built is not in the remembered answer.
        const later = await createTestRoom('later-room', 'Later Room');
        const db = await getDatabase();
        let queries = 0;
        for (const m of ['all', 'get'] as const) {
            const original = (db as any)[m].bind(db);
            vi.spyOn(db as any, m).mockImplementation((async (...args: any[]) => { queries++; return original(...args); }) as any);
        }
        const second = await request(app).get('/api/rooms');
        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(second.body.map((r: any) => r.id)).toContain(roomId);
        expect(second.body.map((r: any) => r.id)).not.toContain(later);
        expect(queries).toBe(0);
        expect(getPublic).toHaveBeenCalledTimes(1);
        expect(forRooms).toHaveBeenCalledTimes(1);

        __clearRoomListCache();
        const third = await request(app).get('/api/rooms');
        expect(third.body.map((r: any) => r.id)).toContain(later);
        expect(queries).toBeGreaterThan(0);
        expect(getPublic).toHaveBeenCalledTimes(2);

        // 30 seconds on, the answer is built again.
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 29_000);
        await request(app).get('/api/rooms');
        expect(getPublic).toHaveBeenCalledTimes(2);
        vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
        await request(app).get('/api/rooms');
        expect(getPublic).toHaveBeenCalledTimes(3);
    });

    it('requests that arrive while the answer is being built share that one build', async () => {
        const app = await appWithGlobalRouter();
        await createTestRoom('shared-build', 'Shared Build');
        const getPublic = vi.spyOn(GameRoomService, 'getPublic');
        const answers = await Promise.all([1, 2, 3].map(() => request(app).get('/api/rooms')));
        expect(answers.map(a => a.status)).toEqual([200, 200, 200]);
        expect(getPublic).toHaveBeenCalledTimes(1);
        expect(answers[1]!.body).toEqual(answers[0]!.body);
        expect(answers[2]!.body).toEqual(answers[0]!.body);
    });

    it('a failed build is not remembered: the next request builds again', async () => {
        const app = await appWithGlobalRouter();
        const roomId = await createTestRoom('after-failure', 'After Failure');
        const getPublic = vi.spyOn(GameRoomService, 'getPublic').mockRejectedValueOnce(new Error('database is locked'));
        const failed = await request(app).get('/api/rooms');
        expect(failed.status).toBe(500);
        const ok = await request(app).get('/api/rooms');
        expect(ok.status).toBe(200);
        expect(ok.body.map((r: any) => r.id)).toContain(roomId);
        expect(getPublic).toHaveBeenCalledTimes(2);
    });
});
