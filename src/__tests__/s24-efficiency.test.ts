import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { signToken } from '../api/auth.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { GlobalLeaderboardService } from '../services/GlobalLeaderboardService.js';
import { RoomScoresService } from '../services/RoomScoresService.js';
import { getDatabase } from '../database/database.js';
import {
    setupTestDb,
    createTestRoom,
    createTestTournament,
    createTestGame,
    createTestSubmission,
} from './helpers.js';

/**
 * S24 — backend efficiency round 2.
 *
 * The cache-correctness half of this file is the important part: S24.1 moved
 * `display_name` / `avatar_hash` / `avatar_url` OUT of the cached JSON and onto
 * a read-time join, which is what makes the `invalidateAll()` calls on rename
 * and avatar-change deletable. These tests are the contract that keeps them
 * out — if someone re-bakes a name into the cache, "rename is visible with the
 * cache row untouched" fails immediately rather than in production six months
 * later.
 */

/** Wrap `db.all` so a test can count the queries a code path issues. */
async function withQuerySpy<T>(fn: (queries: string[]) => Promise<T>): Promise<T> {
    const db = await getDatabase();
    const queries: string[] = [];
    const original = db.all.bind(db);
    const spy = vi.spyOn(db, 'all').mockImplementation((async (sql: any, ...params: any[]) => {
        queries.push(String(sql));
        return original(sql, ...params);
    }) as any);
    try {
        return await fn(queries);
    } finally {
        spy.mockRestore();
    }
}

/** Insert a score attributed to a real Discord user (submitted_by_user_id set). */
async function createAttributedScore(gameId: string, opts: {
    username: string;
    discordUserId: string;
    score: number;
}) {
    const db = await getDatabase();
    const game = await db.get<{ name: string; tournament_id: string | null }>(
        'SELECT name, tournament_id FROM games WHERE id = ?', gameId,
    );
    const tournament = game?.tournament_id
        ? await db.get<{ game_room_id: string | null }>(
            'SELECT game_room_id FROM tournaments WHERE id = ?', game.tournament_id)
        : null;
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id,
            submitted_by_user_id, score, source, submitted_from_room_id,
            submitted_during_tournament_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'tournament', ?, ?)`,
        game!.name, tournament?.game_room_id ?? null, gameId,
        opts.username, opts.discordUserId, opts.discordUserId, opts.score,
        tournament?.game_room_id ?? null, game!.tournament_id,
    );
}

async function upsertProfile(discordUserId: string, fields: {
    display_name?: string | null;
    avatar_hash?: string | null;
    avatar_url?: string | null;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash, avatar_url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET
            display_name = excluded.display_name,
            avatar_hash = excluded.avatar_hash,
            avatar_url = excluded.avatar_url`,
        discordUserId, fields.display_name ?? null, fields.avatar_hash ?? null, fields.avatar_url ?? null,
    );
}

describe('S24.1 — read-time profile join', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('caches identity-stable rows only — no name or avatar in the cached JSON', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await createAttributedScore(gameId, { username: 'Alice', discordUserId: 'discord-1', score: 5000 });
        await upsertProfile('discord-1', { display_name: 'Ace', avatar_hash: 'hash-a', avatar_url: null });

        await LeaderboardService.recalculate(gameId);

        const db = await getDatabase();
        const cached = await db.get('SELECT rankings FROM leaderboard_cache WHERE game_id = ?', gameId);
        const blob = String(cached.rankings);
        expect(blob).not.toContain('Ace');
        expect(blob).not.toContain('hash-a');
        expect(blob).not.toContain('display_name');
        expect(blob).not.toContain('avatar_hash');
        // ...but the identity keys that let the read-time join work ARE there.
        const parsed = JSON.parse(blob);
        expect(parsed.rows[0].submitted_by_user_id).toBe('discord-1');
        expect(parsed.rows[0].iscored_username).toBe('Alice');
    });

    it('a rename is visible on the next read WITHOUT touching the cache row', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await createAttributedScore(gameId, { username: 'Alice', discordUserId: 'discord-1', score: 5000 });
        await upsertProfile('discord-1', { display_name: 'Ace' });

        const before = await LeaderboardService.getForGame(gameId);
        expect(before[0]!.display_name).toBe('Ace');

        const db = await getDatabase();
        const cachedBefore = await db.get('SELECT rankings, generated_at FROM leaderboard_cache WHERE game_id = ?', gameId);

        // Rename. NOTE: no invalidation of any kind — that is the point.
        await upsertProfile('discord-1', { display_name: 'Renamed' });

        const after = await LeaderboardService.getForGame(gameId);
        expect(after[0]!.display_name).toBe('Renamed');

        const cachedAfter = await db.get('SELECT rankings, generated_at FROM leaderboard_cache WHERE game_id = ?', gameId);
        expect(cachedAfter.generated_at).toBe(cachedBefore.generated_at);
        expect(cachedAfter.rankings).toBe(cachedBefore.rankings);
    });

    it('REGRESSION: an avatar change reaches the GLOBAL scoreboard with no invalidation', async () => {
        // Pre-S24.1 this was a live bug: the avatar-change path in auth.ts called
        // `LeaderboardService.invalidateAll()` only, so `global_leaderboard_cache`
        // kept serving the OLD avatar hash forever.
        const db = await getDatabase();
        const roomId = await createTestRoom();
        await db.run(
            `INSERT INTO global_games (id, name, type, status, global_leaderboard)
             VALUES ('gg-1', 'Test Game', 'pinball', 'approved', 1)`,
        );
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, submitted_by_user_id,
                iscored_username, score, origin_type, origin_game_room_id, submitted_at)
             VALUES ('gs-1', 'gg-1', 'discord-1', 'discord-1', 'Alice', 5000, 'room', ?, datetime('now'))`,
            roomId,
        );
        await upsertProfile('discord-1', { avatar_hash: 'old-hash' });

        const before = await GlobalLeaderboardService.getForGame('gg-1');
        expect(before[0]!.avatar_hash).toBe('old-hash');

        await upsertProfile('discord-1', { avatar_hash: 'new-hash' });

        const after = await GlobalLeaderboardService.getForGame('gg-1');
        expect(after[0]!.avatar_hash).toBe('new-hash');
    });

    it('ships avatar_url on room, global and room-scores read paths', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId, { name: 'Medieval Madness' });
        await createAttributedScore(gameId, { username: 'Alice', discordUserId: 'google:abc', score: 5000 });
        await upsertProfile('google:abc', { avatar_url: 'https://lh3.example/pic.jpg' });

        const room = await LeaderboardService.getForGame(gameId);
        expect(room[0]!.avatar_url).toBe('https://lh3.example/pic.jpg');

        await db.run(
            `INSERT INTO global_games (id, name, type, status, global_leaderboard)
             VALUES ('gg-2', 'Medieval Madness', 'pinball', 'approved', 1)`,
        );
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, submitted_by_user_id,
                iscored_username, score, origin_type, origin_game_room_id, submitted_at)
             VALUES ('gs-2', 'gg-2', 'google:abc', 'google:abc', 'Alice', 5000, 'room', ?, datetime('now'))`,
            roomId,
        );
        const global = await GlobalLeaderboardService.getForGame('gg-2');
        expect(global[0]!.avatar_url).toBe('https://lh3.example/pic.jpg');

        const roomScores = await RoomScoresService.getRoomScores(roomId);
        expect(roomScores.data[0]!.rankings[0]!.avatar_url).toBe('https://lh3.example/pic.jpg');
    });

    it('resolves an iscored:* synthetic id through user_mappings at read time', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        // A synced row: no submitted_by_user_id, synthetic player id.
        await createTestSubmission(gameId, {
            username: 'SyncedAlias', score: 4200, discordUserId: 'iscored:syncedalias',
        });
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`,
            'discord-9', 'SyncedAlias',
        );
        await upsertProfile('discord-9', { display_name: 'Mapped Name', avatar_hash: 'h9' });

        const rankings = await LeaderboardService.getForGame(gameId);
        expect(rankings[0]!.discord_user_id).toBe('discord-9');
        expect(rankings[0]!.display_name).toBe('Mapped Name');
        expect(rankings[0]!.avatar_hash).toBe('h9');
    });

    it('does NOT leak a profile onto an unattributed sentinel row', async () => {
        // COMMUNITY/ANON/SYSTEM rows must never borrow a real user's profile
        // just because the typed name matches somebody's alias.
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await createTestSubmission(gameId, { username: 'Alice', score: 4200, discordUserId: 'COMMUNITY' });
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`,
            'discord-1', 'Alice',
        );
        await upsertProfile('discord-1', { display_name: 'Real Person', avatar_hash: 'secret' });

        const rankings = await LeaderboardService.getForGame(gameId);
        expect(rankings[0]!.discord_user_id).toBe('COMMUNITY');
        expect(rankings[0]!.display_name).toBeNull();
        expect(rankings[0]!.avatar_hash).toBeNull();
    });

    it('treats a pre-S24.1 cache blob (bare array) as a miss and rewrites it', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await createAttributedScore(gameId, { username: 'Alice', discordUserId: 'discord-1', score: 5000 });
        await upsertProfile('discord-1', { display_name: 'Ace' });

        const db = await getDatabase();
        // Simulate a blob written by the pre-S24.1 build.
        await db.run(
            `INSERT OR REPLACE INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, ?, ?)`,
            gameId,
            JSON.stringify([{ rank: 1, discord_user_id: 'discord-1', iscored_username: 'Stale', score: 1, display_name: 'Stale' }]),
            new Date().toISOString(),
        );

        const rankings = await LeaderboardService.getForGame(gameId);
        expect(rankings[0]!.iscored_username).toBe('Alice');
        expect(rankings[0]!.display_name).toBe('Ace');

        const cached = await db.get('SELECT rankings FROM leaderboard_cache WHERE game_id = ?', gameId);
        expect(JSON.parse(cached.rankings).v).toBe(2);
    });
});

describe('S24.3 — in-flight dedup', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('two concurrent cold getForGame reads perform ONE recalculate', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await createTestSubmission(gameId, { username: 'Alice', score: 5000 });

        const writes = await withQuerySpy(async () => {
            const db = await getDatabase();
            let cacheWrites = 0;
            const originalRun = db.run.bind(db);
            const runSpy = vi.spyOn(db, 'run').mockImplementation((async (sql: any, ...p: any[]) => {
                if (String(sql).includes('leaderboard_cache')) cacheWrites++;
                return originalRun(sql, ...p);
            }) as any);
            try {
                const [a, b] = await Promise.all([
                    LeaderboardService.getForGame(gameId),
                    LeaderboardService.getForGame(gameId),
                ]);
                expect(a).toEqual(b);
                expect(a).toHaveLength(1);
            } finally {
                runSpy.mockRestore();
            }
            return cacheWrites;
        });

        expect(writes).toBe(1);
    });

    it('two concurrent getForGameByProvenance reads run the query once', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await createTestSubmission(gameId, { username: 'Alice', score: 5000 });

        await withQuerySpy(async (queries) => {
            const [a, b] = await Promise.all([
                LeaderboardService.getForGameByProvenance(gameId, { engine: 'unknown' }),
                LeaderboardService.getForGameByProvenance(gameId, { engine: 'unknown' }),
            ]);
            expect(a).toEqual(b);
            const rankingQueries = queries.filter(q => q.includes('PARTITION BY COALESCE(submitted_by_user_id'));
            expect(rankingQueries).toHaveLength(1);
        });
    });

    it('different provenance filters are NOT deduped together', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await createTestSubmission(gameId, { username: 'Alice', score: 5000 });

        await withQuerySpy(async (queries) => {
            await Promise.all([
                LeaderboardService.getForGameByProvenance(gameId, { engine: 'vpx' }),
                LeaderboardService.getForGameByProvenance(gameId, { engine: 'fx_classic' }),
            ]);
            const rankingQueries = queries.filter(q => q.includes('PARTITION BY COALESCE(submitted_by_user_id'));
            expect(rankingQueries).toHaveLength(2);
        });
    });
});

describe('S24.4 — getActiveLeaderboards has no per-tournament N+1', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('issues no per-tournament cadence lookup and no per-room TIMEZONE lookup', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tournamentIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const tid = await createTestTournament(roomId, { name: `T${i}` });
            await db.run(
                `UPDATE tournaments SET cadence = ? WHERE id = ?`,
                JSON.stringify({ cron: '0 22 * * *', timezone: 'America/Chicago' }), tid,
            );
            const gid = await createTestGame(tid, { name: `Game ${i}` });
            await createTestSubmission(gid, { username: 'Alice', score: 1000 + i });
            tournamentIds.push(tid);
        }

        const boards = await withQuerySpy(async (queries) => {
            const result = await LeaderboardService.getActiveLeaderboards(roomId);
            // The pre-S24.4 shape: one `SELECT cadence, game_room_id FROM tournaments
            // WHERE id = ?` per tournament (via db.get) plus one TIMEZONE lookup each.
            const tzQueries = queries.filter(q => q.includes("key = 'TIMEZONE'"));
            expect(tzQueries.length).toBeLessThanOrEqual(1);
            return result;
        });

        expect(boards).toHaveLength(3);
        for (const board of boards) {
            expect(board.rankings).toHaveLength(1);
            expect(board.nextMaintenanceAt).toBeTruthy();
        }
    });

    it('respects the per-tournament retain count in the folded COMPLETED query', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tid = await createTestTournament(roomId, { name: 'Retainer' });
        await db.run(`UPDATE tournaments SET cleanup_rule = ? WHERE id = ?`,
            JSON.stringify({ mode: 'retain', count: 2 }), tid);
        for (let i = 0; i < 4; i++) {
            const gid = await createTestGame(tid, { name: `Old ${i}`, status: 'COMPLETED' });
            await db.run(`UPDATE games SET end_date = ? WHERE id = ?`,
                new Date(2026, 0, i + 1).toISOString(), gid);
        }

        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        // Two most-recently-ended COMPLETED games, newest first.
        expect(boards.map(b => b.gameName)).toEqual(['Old 3', 'Old 2']);
    });
});

describe('S24.6 — /room-scores rankings are batched', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('one windowed query covers every card on the page', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        for (let i = 0; i < 4; i++) {
            const gid = await createTestGame(tournamentId, { name: `Game ${i}` });
            await createTestSubmission(gid, { username: `Player${i}`, score: 1000 + i });
        }

        const result = await withQuerySpy(async (queries) => {
            const r = await RoomScoresService.getRoomScores(roomId);
            const rankingQueries = queries.filter(q => q.includes('PARTITION BY LOWER(game_name)'));
            expect(rankingQueries).toHaveLength(1);
            return r;
        });

        expect(result.data).toHaveLength(4);
        for (const card of result.data) {
            expect(card.rankings).toHaveLength(1);
        }
    });

    it('caps each card at 10 rows and ranks them within the game', async () => {
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId);
        const gid = await createTestGame(tournamentId, { name: 'Crowded' });
        for (let i = 0; i < 13; i++) {
            await createTestSubmission(gid, { username: `P${i}`, score: 100 + i });
        }

        const result = await RoomScoresService.getRoomScores(roomId);
        const card = result.data.find(c => c.gameName === 'Crowded')!;
        expect(card.rankings).toHaveLength(10);
        expect(card.rankings[0]!.rank).toBe(1);
        expect(card.rankings[0]!.score).toBe(112);
        expect(card.rankings[9]!.rank).toBe(10);
    });
});

describe('S24.2 — poller tick churn', () => {
    const originalEnv = { ...process.env };

    beforeEach(async () => { await setupTestDb(); });
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('resolves creds for every room in ONE settings query', async () => {
        const db = await getDatabase();
        const rooms: string[] = [];
        for (let i = 0; i < 5; i++) rooms.push(await createTestRoom(`room-${i}`, `Room ${i}`));
        // One room opts out entirely; pre-S24 it still cost 4 reads.
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            rooms[0],
        );

        const { getIScoredCredsForRooms } = await import('../utils/iscoredCreds.js');
        await withQuerySpy(async (queries) => {
            await getIScoredCredsForRooms(rooms);
            const settingsQueries = queries.filter(q => q.includes('game_room_settings'));
            expect(settingsQueries).toHaveLength(1);
        });
    });

    it('batched creds agree with the per-room resolver', async () => {
        const db = await getDatabase();
        const enabledRoom = await createTestRoom('enabled', 'Enabled');
        const disabledRoom = await createTestRoom('disabled', 'Disabled');
        const partialRoom = await createTestRoom('partial', 'Partial');

        for (const [key, value] of Object.entries({
            ISCORED_USERNAME: 'u', ISCORED_PASSWORD: 'p',
            ISCORED_PUBLIC_URL: 'https://iscored.info/myroom',
        })) {
            await db.run(
                `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                enabledRoom, key, value,
            );
        }
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            disabledRoom,
        );
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_USERNAME', 'only-one')`,
            partialRoom,
        );

        const { getIScoredCredsForRoom, getIScoredCredsForRooms } = await import('../utils/iscoredCreds.js');
        const ids = [enabledRoom, disabledRoom, partialRoom];
        const batched = await getIScoredCredsForRooms(ids);
        for (const id of ids) {
            const single = await getIScoredCredsForRoom(id);
            expect(batched.get(id) ?? null).toEqual(single);
        }
        expect(batched.get(enabledRoom)?.gameroomName).toBe('myroom');
        expect(batched.has(disabledRoom)).toBe(false);
        expect(batched.has(partialRoom)).toBe(false);
    });

    it('an all-skip tick performs ZERO user_mappings / player_aliases queries', async () => {
        await createTestRoom('poll-room', 'Poll Room');
        process.env.ISCORED_USERNAME = 'u';
        process.env.ISCORED_PASSWORD = 'p';
        process.env.ISCORED_PUBLIC_URL = 'https://iscored.info/envroom';

        const { ScoreSyncPoller } = await import('../engine/ScoreSyncPoller.js');
        const poller = ScoreSyncPoller.getInstance() as any;
        const originalGate = poller.gate;
        // Gate says "nothing changed" for every account — the common case by
        // far, and the case that used to scan both global identity tables.
        poller.gate = {
            resolveRoomId: async () => '123',
            fetchNotification: async () => 'unchanged',
            shouldSync: () => ({ run: false, reason: 'test-skip' }),
            markSynced: () => {},
        };

        try {
            await withQuerySpy(async (queries) => {
                await poller.poll();
                expect(queries.filter(q => q.includes('user_mappings'))).toHaveLength(0);
                expect(queries.filter(q => q.includes('player_aliases'))).toHaveLength(0);
            });
        } finally {
            poller.gate = originalGate;
        }
    });
});

describe('S24.7 — TTL cache on GET /api/global/scoreboard', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        // global.ts declares its routes WITHOUT a '/global' prefix on the
        // router itself, so it mounts at bare '/api' (same as global-hero).
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    async function makeCatalogueGame(name: string): Promise<string> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_games (id, name, type, status, platforms, manufacturer, year)
             VALUES (?, ?, 'pinball', 'approved', '["vpx"]', 'Williams', 1997)`,
            id, name,
        );
        return id;
    }

    it('serves a second anonymous request from cache (no repeated grid queries)', async () => {
        const app = await createTestApp();
        await makeCatalogueGame('Medieval Madness');

        const first = await request(app).get('/api/global/scoreboard');
        expect(first.status).toBe(200);

        const second = await withQuerySpy(async (queries) => {
            const res = await request(app).get('/api/global/scoreboard');
            // A cache hit does no catalogue work at all.
            expect(queries.filter(q => q.includes('global_games'))).toHaveLength(0);
            return res;
        });
        expect(second.body).toEqual(first.body);
    });

    it('never caches an authenticated request (per-viewer keys must not be shared)', async () => {
        const app = await createTestApp();
        await makeCatalogueGame('Attack From Mars');
        const auth = { Authorization: `Bearer ${signToken({ role: 'player', discordId: 'disc-1', username: 'Me', gameRoomIds: [] })}` };

        const anon = await request(app).get('/api/global/scoreboard');
        expect(anon.body.data[0]).not.toHaveProperty('my_rank');

        const authed = await request(app).get('/api/global/scoreboard').set(auth);
        // If the anonymous payload had been served from cache to a logged-in
        // viewer, the per-viewer keys would be missing.
        expect(authed.body.data[0]).toHaveProperty('my_rank');
        expect(authed.body.data[0]).toHaveProperty('is_pinned');

        // ...and the authenticated payload must not poison the anonymous entry.
        const anonAgain = await request(app).get('/api/global/scoreboard');
        expect(anonAgain.body.data[0]).not.toHaveProperty('my_rank');
    });

    it('bypasses the cache for searches (unbounded key space, ~zero hit rate)', async () => {
        const app = await createTestApp();
        await makeCatalogueGame('Twilight Zone');

        await request(app).get('/api/global/scoreboard?search=twilight');
        await withQuerySpy(async (queries) => {
            const res = await request(app).get('/api/global/scoreboard?search=twilight');
            expect(res.status).toBe(200);
            expect(queries.filter(q => q.includes('global_games')).length).toBeGreaterThan(0);
        });
    });

    it('keys on the full query tuple — a different page is a different entry', async () => {
        const app = await createTestApp();
        for (let i = 0; i < 3; i++) await makeCatalogueGame(`Game ${i}`);

        const page1 = await request(app).get('/api/global/scoreboard?limit=2&offset=0');
        const page2 = await request(app).get('/api/global/scoreboard?limit=2&offset=2');
        expect(page1.body.data).toHaveLength(2);
        expect(page2.body.data).toHaveLength(1);
        expect(page1.body.data[0].global_game_id).not.toBe(page2.body.data[0].global_game_id);
    });
});
