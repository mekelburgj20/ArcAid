import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { HERO_MIN_WEEKLY_SCORES } from '../services/GlobalLeaderboardService.js';

/**
 * v2.57.0 (Track A, phase A5a) — the Global Scoreboard hero card
 * (tmp/global-scoreboard-a5a-contract.md).
 *
 * The interesting behaviour under test is the DELIBERATE deviation from the
 * design handoff: the hero only claims `HOT` when the trailing-7-day leader
 * clears `HERO_MIN_WEEKLY_SCORES`. Below that it degrades to a neutral hero
 * (top game by total score_count, no HOT, no weekly delta) rather than stamping
 * a one-score game as trending.
 *
 * Bootstrap follows global-pins.test.ts: global.ts declares its routes WITHOUT
 * a '/global' prefix on the router itself, so it mounts at bare '/api'.
 */
async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

const playerToken = (discordId: string, username = 'Tester') =>
    signToken({ role: 'player', discordId, username, gameRoomIds: [] });

async function makeGame(name: string, platforms: string[] = ['vpx']): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, status, platforms, manufacturer, year)
         VALUES (?, ?, 'pinball', 'approved', ?, 'Williams', 1997)`,
        id, name, JSON.stringify(platforms),
    );
    return id;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function addScore(gameId: string, opts: {
    username: string;
    score: number;
    submittedBy?: string | null;
    at?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_scores (id, global_game_id, player_id, submitted_by_user_id, iscored_username, score, origin_type, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'global', ?)`,
        crypto.randomUUID(), gameId,
        opts.submittedBy ?? `anon:${opts.username}`,
        opts.submittedBy ?? null,
        opts.username, opts.score,
        opts.at ?? new Date().toISOString(),
    );
}

/** N distinct players on `gameId`, all submitted `ageDays` ago. */
async function addScores(gameId: string, count: number, opts: { ageDays: number; top?: number; prefix?: string }) {
    const top = opts.top ?? 100_000;
    const prefix = opts.prefix ?? 'P';
    for (let i = 0; i < count; i++) {
        await addScore(gameId, {
            username: `${prefix}${i + 1}`,
            score: top - i * 1000,
            submittedBy: `disc-${prefix}${i + 1}`,
            at: daysAgo(opts.ageDays),
        });
    }
}

describe('GET /api/global/scoreboard — hero card selection', () => {
    it('(a) crowns the trailing-7-day leader with HOT + the weekly delta once it clears the floor', async () => {
        const app = await createTestApp();
        // `hot` has fewer scores overall but 4 of them landed this week.
        const hot = await makeGame('Hot This Week');
        await addScores(hot, HERO_MIN_WEEKLY_SCORES + 1, { ageDays: 2, top: 50_000, prefix: 'H' });
        // `deep` has more total scores, but every one of them is stale.
        const deep = await makeGame('Deep But Stale');
        await addScores(deep, 12, { ageDays: 40, top: 900_000, prefix: 'D' });

        const res = await request(app).get('/api/global/scoreboard');
        expect(res.status).toBe(200);
        expect(res.body.hero.global_game_id).toBe(hot);
        expect(res.body.hero.is_hot).toBe(true);
        expect(res.body.hero.weekly_score_count).toBe(HERO_MIN_WEEKLY_SCORES + 1);
        // The card renders a champion, so the rows have to be on the payload.
        expect(res.body.hero.top_scores[0].score).toBe(50_000);
        expect(res.body.hero.score_count).toBe(HERO_MIN_WEEKLY_SCORES + 1);
    });

    it('(b) below the floor: falls back to the top score_count game, NOT hot, no weekly claim', async () => {
        const app = await createTestApp();
        // The quiet-week shape verified on prod: one game with a couple of
        // scores this week, others with one each. Nothing clears the floor.
        const trickle = await makeGame('One Score This Week');
        await addScores(trickle, HERO_MIN_WEEKLY_SCORES - 1, { ageDays: 1, top: 10_000, prefix: 'T' });
        const biggest = await makeGame('Most Scores Overall');
        await addScores(biggest, 9, { ageDays: 60, top: 800_000, prefix: 'B' });

        const res = await request(app).get('/api/global/scoreboard');
        expect(res.status).toBe(200);
        expect(res.body.hero.global_game_id).toBe(biggest);
        expect(res.body.hero.is_hot).toBe(false);
        expect(res.body.hero.score_count).toBe(9);
        // The weekly figure is still reported (it is honest data); what changes
        // is that `is_hot` is false, which is what gates the badge + "+n this
        // week" line on the client.
        expect(res.body.hero.weekly_score_count).toBe(0);
    });

    it('(c) no hero at all when nothing in the view has a score', async () => {
        const app = await createTestApp();
        await makeGame('Catalogue Only A');
        await makeGame('Catalogue Only B');

        const res = await request(app).get('/api/global/scoreboard');
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(2); // the grid still lists them
        expect(res.body.hero).toBeNull();
    });

    it('(c2) no hero when the filters match no games at all', async () => {
        const app = await createTestApp();
        const g = await makeGame('Medieval Madness');
        await addScores(g, 5, { ageDays: 1 });

        const res = await request(app).get('/api/global/scoreboard?search=nothingmatchesthis');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.hero).toBeNull();
    });

    it('(d) the hero respects an active platform filter (a filtered grid gets a filtered hero)', async () => {
        const app = await createTestApp();
        // Globally hottest, but not on the filtered platform.
        const vpxHot = await makeGame('VPX Blockbuster', ['vpx']);
        await addScores(vpxHot, 20, { ageDays: 1, top: 900_000, prefix: 'V' });
        // Quieter, but the only physical game — so it must win the physical view.
        const physical = await makeGame('Real Machine', ['real']);
        await addScores(physical, HERO_MIN_WEEKLY_SCORES, { ageDays: 2, top: 5_000, prefix: 'R' });

        const unfiltered = await request(app).get('/api/global/scoreboard');
        expect(unfiltered.body.hero.global_game_id).toBe(vpxHot);

        const filtered = await request(app).get('/api/global/scoreboard?platforms=real');
        expect(filtered.status).toBe(200);
        expect(filtered.body.data.map((g: any) => g.global_game_id)).toEqual([physical]);
        expect(filtered.body.hero.global_game_id).toBe(physical);
        expect(filtered.body.hero.is_hot).toBe(true);
    });

    it('(d2) the hero respects an active search filter', async () => {
        const app = await createTestApp();
        const loud = await makeGame('Attack from Mars');
        await addScores(loud, 15, { ageDays: 1, top: 900_000, prefix: 'A' });
        const quiet = await makeGame('Twilight Zone');
        await addScores(quiet, 1, { ageDays: 1, top: 100, prefix: 'Q' });

        const res = await request(app).get('/api/global/scoreboard?search=twilight');
        expect(res.body.hero.global_game_id).toBe(quiet);
        expect(res.body.hero.is_hot).toBe(false);
    });

    it('(e) hero is ABSENT (not null) on any page past the first', async () => {
        const app = await createTestApp();
        for (let i = 0; i < 4; i++) {
            const g = await makeGame(`Game ${i}`);
            await addScores(g, 3, { ageDays: 1, top: 1_000 * (i + 1), prefix: `G${i}` });
        }

        const first = await request(app).get('/api/global/scoreboard?limit=2&offset=0');
        expect('hero' in first.body).toBe(true);
        expect(first.body.hero).toBeTruthy();

        const second = await request(app).get('/api/global/scoreboard?limit=2&offset=2');
        expect(second.status).toBe(200);
        expect('hero' in second.body).toBe(false);
    });

    it('(f) `hero` is the ONLY addition to the anonymous payload — rows are untouched', async () => {
        // Mirrors PRE_A4_KEYS in global-pins.test.ts: the per-game key set an
        // anonymous /scoreboard response ships. A5a adds a top-level key and
        // must not leak anything into the rows.
        const PRE_A5_ROW_KEYS = [
            'global_game_id', 'name', 'display_name', 'manufacturer', 'year', 'type',
            'image_url', 'local_image_path', 'wheel_image_path', 'platforms',
            'score_count', 'top_score', 'last_submitted_at', 'popularity',
            'avg_rating', 'rating_count', 'top_scores',
        ].sort();

        const app = await createTestApp();
        const g = await makeGame('Medieval Madness');
        await addScores(g, 4, { ageDays: 1 });

        const res = await request(app).get('/api/global/scoreboard');
        expect(Object.keys(res.body).sort()).toEqual(['data', 'hasMore', 'hero', 'total']);
        expect(Object.keys(res.body.data[0]).sort()).toEqual(PRE_A5_ROW_KEYS);

        // The hero itself carries no per-viewer context for an anonymous viewer.
        for (const key of ['is_pinned', 'my_rank', 'my_score', 'neighbors', 'pinned_at']) {
            expect(key in res.body.hero).toBe(false);
        }
        expect(Object.keys(res.body.hero).sort()).toEqual(
            [...PRE_A5_ROW_KEYS, 'is_hot', 'weekly_score_count'].sort(),
        );
    });

    it('(g) an authenticated hero carries is_pinned / my_rank / my_score / neighbors', async () => {
        const app = await createTestApp();
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        const hero = await makeGame('Hero Game');
        await addScores(hero, 8, { ageDays: 1, top: 100_000, prefix: 'H' });
        await addScore(hero, { username: 'Me', score: 5_000, submittedBy: 'disc-me', at: daysAgo(1) });
        await request(app).post(`/api/global/games/${hero}/pin`).set(auth);

        const res = await request(app).get('/api/global/scoreboard').set(auth);
        expect(res.status).toBe(200);
        expect(res.body.hero.global_game_id).toBe(hero);
        expect(res.body.hero.is_pinned).toBe(true);
        expect(res.body.hero.my_rank).toBe(9);
        expect(res.body.hero.my_score).toBe(5_000);
        expect(res.body.hero.neighbors.map((n: any) => n.rank)).toEqual([8, 9]);
    });

    it('(g2) the hero gets viewer context even when it is not on the requested page', async () => {
        const app = await createTestApp();
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        // `quiet` is alphabetically first, so `sort=name_asc&limit=1` returns it
        // and the hero (the busy game) falls off the page.
        const quiet = await makeGame('AAA Quiet');
        await addScore(quiet, { username: 'Somebody', score: 1, submittedBy: 'disc-x', at: daysAgo(1) });
        const busy = await makeGame('ZZZ Busy');
        await addScores(busy, 6, { ageDays: 1, top: 100_000, prefix: 'B' });
        await addScore(busy, { username: 'Me', score: 10, submittedBy: 'disc-me', at: daysAgo(1) });

        const res = await request(app).get('/api/global/scoreboard?sort=name_asc&limit=1').set(auth);
        expect(res.body.data.map((g: any) => g.global_game_id)).toEqual([quiet]);
        expect(res.body.hero.global_game_id).toBe(busy);
        expect(res.body.hero.my_rank).toBe(7);
        expect(res.body.hero.is_pinned).toBe(false);
        expect(res.body.hero.top_scores.length).toBe(7);
    });

    it('(h) room scope selects the hero from that room\'s scores only', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_rooms (id, slug, name) VALUES ('room-1', 'rtx', 'RTX Pinball')`,
        );
        const globalHot = await makeGame('Global Only');
        await addScores(globalHot, 10, { ageDays: 1, top: 900_000, prefix: 'G' });

        const roomGame = await makeGame('Room Favourite');
        for (let i = 0; i < HERO_MIN_WEEKLY_SCORES; i++) {
            const db2 = await getDatabase();
            await db2.run(
                `INSERT INTO global_scores (id, global_game_id, player_id, submitted_by_user_id, iscored_username, score, origin_type, origin_game_room_id, submitted_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'room', 'room-1', ?)`,
                crypto.randomUUID(), roomGame, `disc-r${i}`, `disc-r${i}`, `R${i}`, 700 - i, daysAgo(1),
            );
        }

        const res = await request(app).get('/api/global/scoreboard?scope=room-1');
        expect(res.status).toBe(200);
        expect(res.body.hero.global_game_id).toBe(roomGame);
        expect(res.body.hero.is_hot).toBe(true);
    });
});
