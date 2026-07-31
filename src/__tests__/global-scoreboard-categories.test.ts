import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GlobalLeaderboardService, cardId } from '../services/GlobalLeaderboardService.js';
import { buildEngineCategoryExpr } from '../utils/engineCategorySql.js';
import {
    CANONICAL_ENGINES,
    CARD_CATEGORY_ORDER,
    UNKNOWN,
    UNSPECIFIED_CATEGORY,
    engineCardCategory,
} from '../utils/scoreProvenance.js';

/**
 * ADR 0016 Phase 4 (v2.59.0) — one Global Scoreboard card per
 * `(game, fidelity category)`.
 *
 * The load-bearing test in this file is the COVERAGE INVARIANT: the union of a
 * game's cards must contain every one of its scores, exactly once. 38 of 67
 * production global scores carry `engine='unknown'`, and P3 established that
 * `unknown` has no fidelity category — so a card model that only builds cards
 * for the three known bands would drop the MAJORITY of the site's scores off
 * the page with no error anywhere. Everything else here is secondary to that.
 *
 * Bootstrap follows global-hero.test.ts: global.ts declares its routes WITHOUT
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
        `INSERT INTO global_games (id, name, type, status, global_leaderboard, platforms, manufacturer, year)
         VALUES (?, ?, 'pinball', 'approved', 1, ?, 'Williams', 1997)`,
        id, name, JSON.stringify(platforms),
    );
    return id;
}

async function addScore(gameId: string, opts: {
    username: string;
    score: number;
    engine: string;
    device?: string;
    /** Sets `player_id`, which is also what `getViewerCardRanks` resolves as owner. */
    playerId?: string;
}): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_scores (
            id, global_game_id, player_id, iscored_username, score, submitted_at,
            origin_type, exclude_from_global, platform, engine, device
         ) VALUES (?, ?, ?, ?, ?, ?, 'room', 0, NULL, ?, ?)`,
        crypto.randomUUID(), gameId, opts.playerId ?? `anon-${opts.username}`,
        opts.username, opts.score, new Date().toISOString(),
        opts.engine, opts.device ?? UNKNOWN,
    );
}

/** Every card the scoreboard returns for one game, keyed by category. */
async function cardsFor(gameId: string): Promise<Record<string, any>> {
    const { data } = await GlobalLeaderboardService.getTopGames({ limit: 200 });
    const out: Record<string, any> = {};
    for (const row of data as any[]) {
        if (row.global_game_id === gameId) out[row.category ?? 'none'] = row;
    }
    return out;
}

/**
 * The mixed-provenance game the invariant is proved against. Every player is
 * distinct so a score and a leaderboard row are one-to-one — otherwise the
 * best-per-player collapse would make "every score appears once" untestable.
 */
async function seedMixedGame(): Promise<{ gameId: string; usernames: string[] }> {
    const gameId = await makeGame('WHO dunnit', ['vpx', 'real', 'pinball_fx', 'atgames']);
    const rows: Array<[string, number, string, string]> = [
        ['PcPlayer', 900, 'vpx', 'pc'],               // simulation
        ['CabPlayer', 880, 'vpx', 'atgames'],         // simulation (same band, other device)
        ['NinePlayer', 860, 'vp9', 'pc'],             // simulation (different engine, same band)
        ['FxPlayer', 700, 'fx', 'pc'],                // arcade_style
        ['ZacPlayer', 690, 'zaccaria', 'pc'],         // arcade_style
        ['RealPlayer', 500, 'real', 'real_cabinet'],  // real
        ['NesPlayer', 400, 'nes', 'console'],         // video
        ['AtgPlayer', 600, UNKNOWN, 'atgames'],       // unspecified — the irreducible case
        ['LegacyPlayer', 300, UNKNOWN, UNKNOWN],      // unspecified
    ];
    for (const [username, score, engine, device] of rows) {
        await addScore(gameId, { username, score, engine, device });
    }
    return { gameId, usernames: rows.map(r => r[0]) };
}

describe('P4 coverage invariant — no score may fall off the site', () => {
    it('the union of a game\'s cards contains every one of its scores, exactly once', async () => {
        await setupTestDb();
        const { gameId, usernames } = await seedMixedGame();

        const cards = await cardsFor(gameId);
        const gameIds = [gameId];
        const topScores = await GlobalLeaderboardService.getTopScoresForCards(gameIds, 50);

        const seen: string[] = [];
        let countedScores = 0;
        for (const [category, card] of Object.entries(cards)) {
            countedScores += card.score_count;
            const rows = topScores[cardId(gameId, category === 'none' ? null : category)] ?? [];
            for (const row of rows) seen.push(row.iscored_username);
        }

        // (a) every player is on exactly one card…
        expect(seen.sort()).toEqual([...usernames].sort());
        // (b) …no duplicates across cards…
        expect(new Set(seen).size).toBe(seen.length);
        // (c) …and the per-card counts add back up to the game's total.
        expect(countedScores).toBe(usernames.length);
    });

    it('gives the unknown-engine scores their own visible bucket', async () => {
        await setupTestDb();
        const { gameId } = await seedMixedGame();
        const cards = await cardsFor(gameId);

        // The trap: without this card, AtgPlayer and LegacyPlayer have nowhere
        // to render and simply vanish.
        expect(Object.keys(cards)).toContain(UNSPECIFIED_CATEGORY);
        expect(cards[UNSPECIFIED_CATEGORY].score_count).toBe(2);

        const topScores = await GlobalLeaderboardService.getTopScoresForCards([gameId], 50);
        const rows = topScores[cardId(gameId, UNSPECIFIED_CATEGORY)] ?? [];
        expect(rows.map(r => r.iscored_username).sort()).toEqual(['AtgPlayer', 'LegacyPlayer']);
    });

    it('renders an unknown-ONLY game as a single Unspecified card, not as nothing', async () => {
        await setupTestDb();
        const gameId = await makeGame('AtGames Only', ['atgames']);
        await addScore(gameId, { username: 'Solo', score: 1000, engine: UNKNOWN, device: 'atgames' });

        const cards = await cardsFor(gameId);
        expect(Object.keys(cards)).toEqual([UNSPECIFIED_CATEGORY]);
        expect(cards[UNSPECIFIED_CATEGORY].score_count).toBe(1);
        expect(cards[UNSPECIFIED_CATEGORY].top_score).toBe(1000);
    });
});

describe('P4 grouping rules', () => {
    it('collapses two engines in the SAME band into one card', async () => {
        await setupTestDb();
        const gameId = await makeGame('Sim Only');
        await addScore(gameId, { username: 'A', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'B', score: 800, engine: 'vp9' });
        await addScore(gameId, { username: 'C', score: 700, engine: 'fp' });

        const cards = await cardsFor(gameId);
        expect(Object.keys(cards)).toEqual(['simulation']);
        expect(cards.simulation.score_count).toBe(3);
    });

    it('splits two engines in DIFFERENT bands into two cards', async () => {
        await setupTestDb();
        const gameId = await makeGame('Split');
        await addScore(gameId, { username: 'A', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'B', score: 800, engine: 'fx' });

        const cards = await cardsFor(gameId);
        expect(Object.keys(cards).sort()).toEqual(['arcade_style', 'simulation']);
    });

    it('gives a game with NO scores exactly one uncategorised card', async () => {
        await setupTestDb();
        const gameId = await makeGame('Untouched');

        const cards = await cardsFor(gameId);
        // A null category, straight out of the LEFT JOIN — not a special case,
        // and NOT "Unspecified" (which would claim scores that don't exist).
        expect(Object.keys(cards)).toEqual(['none']);
        expect(cards.none.category).toBeNull();
        expect(cards.none.score_count).toBe(0);
        expect(cards.none.card_id).toBe(cardId(gameId, null));
    });

    it('reports per-CATEGORY aggregates, never the game total', async () => {
        await setupTestDb();
        const gameId = await makeGame('Aggregates');
        await addScore(gameId, { username: 'S1', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'S2', score: 850, engine: 'vpx' });
        await addScore(gameId, { username: 'S3', score: 800, engine: 'vpx' });
        await addScore(gameId, { username: 'F1', score: 5_000, engine: 'fx' });

        const cards = await cardsFor(gameId);
        expect(cards.simulation.score_count).toBe(3);
        expect(cards.simulation.top_score).toBe(900);
        expect(cards.arcade_style.score_count).toBe(1);
        // The FX score is the game's highest — a Simulation card reporting it
        // would be the exact mixed-engine claim ADR 0016 forbids.
        expect(cards.arcade_style.top_score).toBe(5_000);
        expect(cards.simulation.popularity).toBeGreaterThan(cards.arcade_style.popularity);
    });
});

describe('P4 — the SQL category expression is derived from the TS taxonomy', () => {
    it('buckets every canonical engine exactly where the taxonomy says', async () => {
        await setupTestDb();
        const gameId = await makeGame('Every Engine');
        const engines = Object.keys(CANONICAL_ENGINES);
        for (const [i, engine] of engines.entries()) {
            await addScore(gameId, { username: `p_${engine}`, score: 1000 - i, engine });
        }

        const cards = await cardsFor(gameId);
        // Group the engines by what the TypeScript helper says, then check the
        // SQL produced the same partition sizes. A hand-written CASE that fell
        // behind the taxonomy fails here.
        const expected: Record<string, number> = {};
        for (const engine of engines) {
            const category = engineCardCategory(engine);
            expected[category] = (expected[category] ?? 0) + 1;
        }
        for (const [category, count] of Object.entries(expected)) {
            expect(cards[category], `no card for ${category}`).toBeTruthy();
            expect(cards[category].score_count, category).toBe(count);
        }
        expect(Object.keys(cards).sort()).toEqual(Object.keys(expected).sort());
    });

    it('only ever interpolates plain lowercase ids', () => {
        // Interpolating literals instead of binding parameters is only
        // defensible because the guard makes anything else impossible. This is
        // the assertion that keeps that true as the taxonomy grows.
        const expr = buildEngineCategoryExpr('gs.engine', 'gs.id');
        expect(expr).toContain('IS NULL THEN NULL');
        expect(expr).toContain(`'${UNSPECIFIED_CATEGORY}'`);

        const literals = [...expr.matchAll(/'([^']*)'/g)].map(m => m[1]);
        expect(literals.length).toBeGreaterThan(Object.keys(CANONICAL_ENGINES).length);
        for (const literal of literals) {
            expect(literal, literal).toMatch(/^[a-z0-9_]+$/);
        }
        // Every canonical engine reached the SQL — a taxonomy addition that the
        // expression missed would leave its scores in the Unspecified bucket
        // with nothing to say so.
        for (const engine of Object.keys(CANONICAL_ENGINES)) {
            expect(literals, engine).toContain(engine);
        }
    });

    it('treats an unrecognised engine token as Unspecified, not as a dropped row', async () => {
        await setupTestDb();
        const gameId = await makeGame('Junk Engine');
        await addScore(gameId, { username: 'Junk', score: 10, engine: 'not_a_real_engine' });

        const cards = await cardsFor(gameId);
        expect(Object.keys(cards)).toEqual([UNSPECIFIED_CATEGORY]);
    });
});

describe('P4 — per-viewer context is scoped to the card', () => {
    it('gives one viewer DIFFERENT ranks on two cards of the same game', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Two Boards');
        // Simulation: two players above the viewer → viewer is 3rd.
        await addScore(gameId, { username: 'S1', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'S2', score: 800, engine: 'vpx' });
        await addScore(gameId, { username: 'Me', score: 700, engine: 'vpx', playerId: 'disc-me' });
        // Arcade-Style: eight players above the viewer → viewer is 9th.
        for (let i = 0; i < 8; i++) {
            await addScore(gameId, { username: `A${i}`, score: 9000 - i, engine: 'fx' });
        }
        await addScore(gameId, { username: 'Me', score: 10, engine: 'fx', playerId: 'disc-me' });

        const res = await request(app)
            .get('/api/global/scoreboard')
            .set('Authorization', `Bearer ${playerToken('disc-me')}`);
        expect(res.status).toBe(200);

        const byCategory = Object.fromEntries(
            (res.body.data as any[]).map(row => [row.category, row]),
        );
        expect(byCategory.simulation.my_rank).toBe(3);
        expect(byCategory.simulation.my_score).toBe(700);
        expect(byCategory.arcade_style.my_rank).toBe(9);
        expect(byCategory.arcade_style.my_score).toBe(10);
        // Neighbours come from the card's own board, so their ranks bracket the
        // card's rank — not some game-wide position.
        expect(byCategory.arcade_style.neighbors.map((n: any) => n.rank)).toEqual([8, 9]);
    });

    it('ranks a player on a board even when their OTHER board score is higher', async () => {
        await setupTestDb();
        const gameId = await makeGame('Cross Board');
        await addScore(gameId, { username: 'Me', score: 10_000, engine: 'vpx', playerId: 'disc-me' });
        await addScore(gameId, { username: 'Me', score: 50, engine: 'fx', playerId: 'disc-me' });
        await addScore(gameId, { username: 'Rival', score: 100, engine: 'fx' });

        const ranks = await GlobalLeaderboardService.getViewerCardRanks([gameId], 'disc-me');
        // A game-level best-per-player collapse would have kept only the 10,000
        // and left the Arcade-Style card showing no rank at all.
        expect(ranks[cardId(gameId, 'simulation')]).toEqual({ rank: 1, score: 10_000 });
        expect(ranks[cardId(gameId, 'arcade_style')]).toEqual({ rank: 2, score: 50 });
    });

    it('reports is_pinned on EVERY card of a pinned game (pins key on the game)', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Pinned Both');
        await addScore(gameId, { username: 'A', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'B', score: 800, engine: 'fx' });
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        await request(app).post(`/api/global/games/${gameId}/pin`).set(auth);

        const res = await request(app).get('/api/global/scoreboard').set(auth);
        const rows = (res.body.data as any[]).filter(r => r.global_game_id === gameId);
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.is_pinned === true)).toBe(true);
    });

    it('keeps ONE rail entry per pinned game, on its biggest category', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Rail Game');
        await addScore(gameId, { username: 'S1', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'S2', score: 800, engine: 'vpx' });
        await addScore(gameId, { username: 'S3', score: 700, engine: 'vpx' });
        await addScore(gameId, { username: 'F1', score: 99_000, engine: 'fx' });
        const auth = { Authorization: `Bearer ${playerToken('disc-me')}` };
        await request(app).post(`/api/global/games/${gameId}/pin`).set(auth);

        const res = await request(app).get('/api/global/pins').set(auth);
        expect(res.status).toBe(200);
        expect(res.body.pins).toHaveLength(1);
        const pin = res.body.pins[0];
        expect(pin.category).toBe('simulation');
        // Scoped to that board: 3 Simulation scores, not the game's 4.
        expect(pin.score_count).toBe(3);
        expect(pin.top_score).toBe(900);
        expect(pin.top_scores.map((s: any) => s.iscored_username)).toEqual(['S1', 'S2', 'S3']);
    });
});

describe('P4 — the category chips', () => {
    it('returns only the chosen band\'s cards', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Chip Game');
        await addScore(gameId, { username: 'S', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'F', score: 800, engine: 'fx' });
        await addScore(gameId, { username: 'U', score: 700, engine: UNKNOWN });

        const res = await request(app).get('/api/global/scoreboard?category=simulation');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].category).toBe('simulation');
        expect(res.body.data[0].score_count).toBe(1);
        expect(res.body.total).toBe(1);
    });

    it('makes Unspecified selectable like any other chip', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Chip Unspec');
        await addScore(gameId, { username: 'S', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'U', score: 700, engine: UNKNOWN });

        const res = await request(app).get(`/api/global/scoreboard?category=${UNSPECIFIED_CATEGORY}`);
        expect(res.status).toBe(200);
        expect(res.body.data.map((r: any) => r.category)).toEqual([UNSPECIFIED_CATEGORY]);
        expect(res.body.data[0].global_game_id).toBe(gameId);
    });

    it('drops zero-score games from a filtered view but keeps them under All', async () => {
        const app = await createTestApp();
        await makeGame('Empty Game');

        const all = await request(app).get('/api/global/scoreboard');
        expect(all.body.data.map((r: any) => r.name)).toContain('Empty Game');

        const filtered = await request(app).get('/api/global/scoreboard?category=simulation');
        expect(filtered.body.data.map((r: any) => r.name)).not.toContain('Empty Game');
    });

    it('ignores an unrecognised category rather than erroring', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Bookmarked');
        await addScore(gameId, { username: 'S', score: 900, engine: 'vpx' });

        // A stale bookmark from the old platform-group chips.
        const res = await request(app).get('/api/global/scoreboard?category=vpin');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });

    it('offers exactly the categories the shared taxonomy declares', () => {
        expect(CARD_CATEGORY_ORDER).toEqual([
            'real', 'simulation', 'arcade_style', 'video', 'unspecified',
        ]);
    });
});

describe('P4 — total and pagination count CARDS', () => {
    /** Three games × three bands each = nine cards, from three catalogue rows. */
    async function seedNineCards(): Promise<void> {
        for (const name of ['Alpha', 'Beta', 'Gamma']) {
            const gameId = await makeGame(name);
            await addScore(gameId, { username: `${name}-s`, score: 900, engine: 'vpx' });
            await addScore(gameId, { username: `${name}-a`, score: 800, engine: 'fx' });
            await addScore(gameId, { username: `${name}-u`, score: 700, engine: UNKNOWN });
        }
    }

    it('reports the card count, not the game count', async () => {
        const app = await createTestApp();
        await seedNineCards();

        const res = await request(app).get('/api/global/scoreboard');
        expect(res.body.total).toBe(9);
        expect(res.body.data).toHaveLength(9);
    });

    it('walks every card exactly once across page boundaries', async () => {
        const app = await createTestApp();
        await seedNineCards();

        // A page size that does NOT divide the card count, so a page boundary
        // lands mid-game — the case an unstable sort would break.
        const seen: string[] = [];
        for (const offset of [0, 2, 4, 6, 8]) {
            const res = await request(app).get(`/api/global/scoreboard?limit=2&offset=${offset}`);
            expect(res.status).toBe(200);
            expect(res.body.total).toBe(9);
            seen.push(...(res.body.data as any[]).map(r => r.card_id));
        }

        expect(seen).toHaveLength(9);
        expect(new Set(seen).size).toBe(9); // no card repeated, none skipped
    });

    it('holds under a sort whose keys are all tied', async () => {
        const app = await createTestApp();
        await seedNineCards();

        // `name_asc` ties every card of a game with every other, and the three
        // games are seeded in one batch — nothing but the stable tail
        // distinguishes them.
        const seen: string[] = [];
        for (const offset of [0, 3, 6]) {
            const res = await request(app).get(`/api/global/scoreboard?sort=name_asc&limit=3&offset=${offset}`);
            seen.push(...(res.body.data as any[]).map(r => r.card_id));
        }
        expect(new Set(seen).size).toBe(9);
    });

    it('collapses back to one row per GAME for the palette', async () => {
        const app = await createTestApp();
        await seedNineCards();

        const res = await request(app).get('/api/global/scoreboard?groupBy=game');
        expect(res.body.total).toBe(3);
        expect(res.body.data).toHaveLength(3);
        // The game-level row reports the game's real total, and names no board.
        expect(res.body.data.every((r: any) => r.score_count === 3)).toBe(true);
        expect(res.body.data.every((r: any) => r.category === null)).toBe(true);
    });

    it('keeps a game in the palette when ANY of its cards matches the chip', async () => {
        const app = await createTestApp();
        await seedNineCards();
        const quiet = await makeGame('Delta');
        await addScore(quiet, { username: 'd', score: 1, engine: UNKNOWN });

        const res = await request(app).get('/api/global/scoreboard?groupBy=game&category=simulation');
        const names = (res.body.data as any[]).map(r => r.name).sort();
        expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(names).not.toContain('Delta');
    });
});

describe('P4 — the hero stays game-level', () => {
    it('names its highest-scoring category and shows that board', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Hero Game');
        for (let i = 0; i < 5; i++) {
            await addScore(gameId, { username: `S${i}`, score: 900 - i, engine: 'vpx' });
        }
        await addScore(gameId, { username: 'F1', score: 100_000, engine: 'fx' });

        const res = await request(app).get('/api/global/scoreboard');
        const hero = res.body.hero;
        expect(hero.global_game_id).toBe(gameId);
        expect(hero.category).toBe('simulation');
        expect(hero.card_id).toBe(cardId(gameId, 'simulation'));
        // Rows are the named board's…
        expect(hero.top_scores.map((s: any) => s.iscored_username)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4']);
        // …while the hero's own count stays the GAME's total, because the hero
        // represents a game (A5a's threshold logic is untouched).
        expect(hero.score_count).toBe(6);
        expect(hero.is_hot).toBe(true);
    });

    it('carries a null category when nothing in view has a score', async () => {
        const app = await createTestApp();
        await makeGame('Silent');

        const res = await request(app).get('/api/global/scoreboard');
        // No score anywhere → no hero at all, unchanged from A5a.
        expect(res.body.hero).toBeNull();
    });
});
