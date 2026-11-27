import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { RoomActiveTablesService, ROOM_ACTIVE_TABLES_MAX } from '../services/RoomActiveTablesService.js';

/**
 * G35b (v2.279.0) — `GET /api/rooms` carries each listed room's `activeTables`:
 * the board's live tables (at most 3, newest score first, no-score boards
 * last), each with its art, its #1's label (resolved at read, never a raw id)
 * and the #1 score; `[]` for an approval room.
 */

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

    it('lists live cards only: no retained COMPLETED card, no event round, nothing for an unlisted room', async () => {
        const app = await appWithGlobalRouter();
        const db = await getDatabase();
        const roomId = await createTestRoom('live-only', 'Live Only');
        const tId = await createTestTournament(roomId);
        await db.run(`UPDATE tournaments SET cleanup_rule = ? WHERE id = ?`, JSON.stringify({ mode: 'retain', count: 3 }), tId);
        const live = await addGame(tId, roomId, 'Live Table');
        const done = await addGame(tId, roomId, 'Finished Table', { status: 'COMPLETED', startDate: '2026-11-19T00:00:00.000Z' });
        await addScore(live, { username: 'Now', score: 10, createdAt: '2026-11-21 10:00:00' });
        await addScore(done, { username: 'Then', score: 20, createdAt: '2026-11-25 10:00:00' });

        const eventId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Live Event', 'DG', 'pinball', '{}', 1, ?, 'event')`,
            eventId, roomId,
        );
        const round = await addGame(eventId, roomId, 'Event Round Table', { roundNo: 1 });
        await addScore(round, { username: 'Eventful', score: 30, createdAt: '2026-11-26 10:00:00' });

        const unlisted = await createTestRoom('unlisted-tables', 'Unlisted Tables');
        await GameRoomSettingsService.set(unlisted, 'ROOM_LISTED', 'false');
        const tU = await createTestTournament(unlisted);
        await addGame(tU, unlisted, 'Unlisted Table');

        const res = await request(app).get('/api/rooms');
        const room = res.body.find((r: any) => r.id === roomId);
        expect(room.activeTables.map((t: any) => t.gameId)).toEqual([live]);
        expect(res.body.find((r: any) => r.id === unlisted)).toBeUndefined();

        // The retained card IS on the board; it is just not being played.
        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(boards.map(b => b.gameId)).toEqual(expect.arrayContaining([live, done]));
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
