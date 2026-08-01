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

    it('drops a zero-score game from a band its CATALOGUE does not claim', async () => {
        const app = await createTestApp();
        // Engines: vpx (simulation) only. Arcade-Style is a band this game
        // cannot produce a board in, so the chip must not surface it.
        await makeGame('Empty Game', ['vpx']);

        const all = await request(app).get('/api/global/scoreboard');
        expect(all.body.data.map((r: any) => r.name)).toContain('Empty Game');

        const filtered = await request(app).get('/api/global/scoreboard?category=arcade_style');
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

/**
 * v2.63.0 — a zero-score game reaches a category filter through its CATALOGUE.
 *
 * The defect: a game nobody has scored yet has a NULL card category, and
 * `NULL = 'simulation'` is NULL, so it fell out of every category chip. The one
 * surface where a `Claim 1st →` CTA is worth the most was the one place it
 * could not be found. Since v2.62.0 `global_games.platforms` holds canonical
 * ENGINE ids, so the band such a game WOULD produce a board in is derivable
 * without inventing anything.
 *
 * The boundary these lock is that the derivation applies to zero-score games
 * ONLY. A scored game's boards are what its scores say they are; letting the
 * catalogue vote there would conjure cards for engines nobody has played.
 */
describe('v2.63.0 — zero-score games match a category via the catalogue', () => {
    it('shows a VPX-only empty game under Simulation, and not under Arcade-Style', async () => {
        const app = await createTestApp();
        await makeGame('Unplayed Sim', ['vpx']);

        const sim = await request(app).get('/api/global/scoreboard?category=simulation');
        expect(sim.body.data.map((r: any) => r.name)).toContain('Unplayed Sim');
        // …and the card is still the uncategorised one: no board exists yet.
        const card = (sim.body.data as any[]).find(r => r.name === 'Unplayed Sim');
        expect(card.category).toBeNull();
        expect(card.score_count).toBe(0);

        const arcade = await request(app).get('/api/global/scoreboard?category=arcade_style');
        expect(arcade.body.data.map((r: any) => r.name)).not.toContain('Unplayed Sim');
    });

    it('shows a multi-band empty game under BOTH of its bands', async () => {
        const app = await createTestApp();
        await makeGame('Unplayed Both', ['vpx', 'fx']);

        for (const category of ['simulation', 'arcade_style']) {
            const res = await request(app).get(`/api/global/scoreboard?category=${category}`);
            expect(res.body.data.map((r: any) => r.name), category).toContain('Unplayed Both');
        }
        const real = await request(app).get('/api/global/scoreboard?category=real');
        expect(real.body.data.map((r: any) => r.name)).not.toContain('Unplayed Both');
    });

    it('leaves a SCORED game\'s filter behaviour exactly as it was', async () => {
        const app = await createTestApp();
        // Catalogue says vpx + fx, but the only score is an FX one. The game
        // must appear under Arcade-Style and NOT under Simulation: a catalogue
        // engine nobody has scored on is not a board.
        const gameId = await makeGame('Scored FX Only', ['vpx', 'fx']);
        await addScore(gameId, { username: 'F', score: 900, engine: 'fx' });

        const arcade = await request(app).get('/api/global/scoreboard?category=arcade_style');
        expect(arcade.body.data.map((r: any) => r.name)).toContain('Scored FX Only');

        const sim = await request(app).get('/api/global/scoreboard?category=simulation');
        expect(sim.body.data.map((r: any) => r.name)).not.toContain('Scored FX Only');
    });

    it('matches no band when the catalogue engines are empty or all unknown', async () => {
        const app = await createTestApp();
        await makeGame('No Engines', []);
        // `atgames` is a legacy DEVICE token, not a canonical engine — it
        // yields no band, so it must vote for nothing (least of all
        // `unspecified`, which describes scores whose provenance was lost).
        await makeGame('Device Only', ['atgames']);

        for (const category of CARD_CATEGORY_ORDER) {
            const res = await request(app).get(`/api/global/scoreboard?category=${category}`);
            const names = (res.body.data as any[]).map(r => r.name);
            expect(names, category).not.toContain('No Engines');
            expect(names, category).not.toContain('Device Only');
        }

        // Both still reachable under All — dropped from chips, not from the site.
        const all = await request(app).get('/api/global/scoreboard');
        expect(all.body.data.map((r: any) => r.name)).toEqual(
            expect.arrayContaining(['No Engines', 'Device Only']),
        );
    });

    it('keeps zero-score games out of the Unspecified chip', async () => {
        const app = await createTestApp();
        await makeGame('Unplayed Sim', ['vpx']);

        // `unspecified` is the bucket for scores whose engine was never
        // recorded. A game with no scores has no provenance to have lost, so no
        // catalogue engine can imply it.
        const res = await request(app).get(`/api/global/scoreboard?category=${UNSPECIFIED_CATEGORY}`);
        expect(res.body.data.map((r: any) => r.name)).not.toContain('Unplayed Sim');
    });

    it('survives a NULL or malformed platforms column', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const good = await makeGame('Unplayed Sim', ['vpx']);
        // `platforms` is `TEXT DEFAULT '[]'` but nullable, and seven importers
        // write it independently. SQLite's `json_each` THROWS on a non-JSON
        // value, so without the `json_valid` guard ONE bad row would 500 every
        // category-filtered scoreboard request rather than just excluding that
        // game.
        await db.run(
            `INSERT INTO global_games (id, name, type, status, global_leaderboard, platforms)
             VALUES ('null-plat', 'Null Platforms', 'pinball', 'approved', 1, NULL)`);
        await db.run(
            `INSERT INTO global_games (id, name, type, status, global_leaderboard, platforms)
             VALUES ('bad-plat', 'Bad Platforms', 'pinball', 'approved', 1, 'not json')`);

        const res = await request(app).get('/api/global/scoreboard?category=simulation');
        expect(res.status).toBe(200);
        const names = (res.body.data as any[]).map(r => r.name);
        expect(names).toContain('Unplayed Sim');
        expect(names).not.toContain('Null Platforms');
        expect(names).not.toContain('Bad Platforms');
        expect(good).toBeTruthy();
    });

    it('counts the rescued card in `total` so pagination still walks it', async () => {
        const app = await createTestApp();
        await makeGame('Unplayed Sim', ['vpx']);

        const res = await request(app).get('/api/global/scoreboard?category=simulation');
        expect(res.body.total).toBe(1);
        expect(res.body.data).toHaveLength(1);
    });
});

describe('v2.63.0 — the zero-score card names the band it would open', () => {
    it('carries a prospective_category when the catalogue is unambiguous', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Unplayed Sim', ['vpx', 'vp9']);

        const res = await request(app).get('/api/global/scoreboard');
        const card = (res.body.data as any[]).find(r => r.global_game_id === gameId);
        expect(card.prospective_category).toBe('simulation');
        // Display only. The card identity is untouched — it is still the
        // uncategorised card, and `card_id` is what P4's invariants key on.
        expect(card.category).toBeNull();
        expect(card.card_id).toBe(cardId(gameId, null));
    });

    it('carries none when two bands are possible', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Unplayed Both', ['vpx', 'fx']);

        const res = await request(app).get('/api/global/scoreboard');
        const card = (res.body.data as any[]).find(r => r.global_game_id === gameId);
        // Both boards are genuinely possible; advertising one would be a claim
        // the catalogue does not support.
        expect(card.prospective_category ?? null).toBeNull();
    });

    it('carries none for a game that HAS scores — `category` is the answer there', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Scored', ['vpx']);
        await addScore(gameId, { username: 'S', score: 900, engine: 'vpx' });

        const res = await request(app).get('/api/global/scoreboard');
        const card = (res.body.data as any[]).find(r => r.global_game_id === gameId);
        expect(card.category).toBe('simulation');
        expect(card.prospective_category ?? null).toBeNull();
    });

    it('never labels a palette (groupBy=game) row', async () => {
        const app = await createTestApp();
        await makeGame('Unplayed Sim', ['vpx']);

        // A `game` row's null category means "this row names no single board",
        // not "this game has no scores" — deriving one would label every result.
        const res = await request(app).get('/api/global/scoreboard?groupBy=game');
        expect((res.body.data as any[]).every(r => (r.prospective_category ?? null) === null)).toBe(true);
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

/**
 * v2.63.0 — the GAME DETAIL page serves one board per category.
 *
 * `GET /api/global/scoreboard/:id` returned a single COMBINED list per game.
 * That was ADR 0016's comparability defect surviving in the most visible place
 * on the site: the grid had already split a mixed game into a Simulation card
 * and an Arcade-Style card, and clicking either landed on a table that mixed
 * them back together, ranking a VPX run against a Pinball FX run 1..n.
 */
describe('v2.63.0 — per-category boards on the game detail endpoint', () => {
    /** Two bands, and one player holding a score on each. */
    async function seedTwoBoards(): Promise<string> {
        const gameId = await makeGame('Two Boards', ['vpx', 'fx']);
        await addScore(gameId, { username: 'SimAce', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'SimTwo', score: 800, engine: 'vpx' });
        await addScore(gameId, { username: 'SimAce', score: 50, engine: 'fx' });
        await addScore(gameId, { username: 'FxAce', score: 100, engine: 'fx' });
        return gameId;
    }

    it('never puts a score on two boards, and never mixes bands in one', async () => {
        const app = await createTestApp();
        const gameId = await seedTwoBoards();

        const sim = await request(app).get(`/api/global/scoreboard/${gameId}?category=simulation`);
        const arcade = await request(app).get(`/api/global/scoreboard/${gameId}?category=arcade_style`);
        expect(sim.status).toBe(200);
        expect(arcade.status).toBe(200);

        // Each board holds only its own band's engines…
        expect((sim.body.data as any[]).every(r => r.engine === 'vpx')).toBe(true);
        expect((arcade.body.data as any[]).every(r => r.engine === 'fx')).toBe(true);
        // …and no score id appears on both.
        const simIds = (sim.body.data as any[]).map(r => r.score_id);
        const arcadeIds = (arcade.body.data as any[]).map(r => r.score_id);
        expect(simIds.filter(id => arcadeIds.includes(id))).toEqual([]);
        // Ranks restart per board — that is what makes a rank mean something.
        expect(simIds).toHaveLength(2);
        expect((sim.body.data as any[]).map(r => r.rank)).toEqual([1, 2]);
        expect((arcade.body.data as any[]).map(r => r.rank)).toEqual([1, 2]);
    });

    it('ranks a player on a board even when their OTHER board score is higher', async () => {
        const app = await createTestApp();
        const gameId = await seedTwoBoards();

        // SimAce's 900 must not swallow their 50: a game-level best-per-player
        // collapse would have left the Arcade-Style board a player short.
        const arcade = await request(app).get(`/api/global/scoreboard/${gameId}?category=arcade_style`);
        expect((arcade.body.data as any[]).map(r => r.iscored_username)).toEqual(['FxAce', 'SimAce']);
    });

    it('advertises every board, biggest first', async () => {
        const app = await createTestApp();
        const gameId = await seedTwoBoards();

        const res = await request(app).get(`/api/global/scoreboard/${gameId}`);
        expect(res.body.categories).toEqual([
            { category: 'simulation', score_count: 2 },
            { category: 'arcade_style', score_count: 2 },
        ]);
    });

    it('preselects the deep-linked board', async () => {
        const app = await createTestApp();
        const gameId = await seedTwoBoards();

        const res = await request(app).get(`/api/global/scoreboard/${gameId}?category=arcade_style`);
        expect(res.body.category).toBe('arcade_style');
        expect((res.body.data as any[]).map(r => r.iscored_username)).toEqual(['FxAce', 'SimAce']);
    });

    it('falls back to the biggest board when the param is absent or bogus', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Lopsided', ['vpx', 'fx']);
        await addScore(gameId, { username: 'F', score: 100_000, engine: 'fx' });
        for (const [i, name] of ['S1', 'S2', 'S3'].entries()) {
            await addScore(gameId, { username: name, score: 900 - i, engine: 'vpx' });
        }

        for (const query of ['', '?category=', '?category=not_a_band', '?category=real']) {
            const res = await request(app).get(`/api/global/scoreboard/${gameId}${query}`);
            // `real` is a real taxonomy id the GAME has no board in — it must
            // fall back too, or the page renders an empty table under a tab
            // that isn't in the strip.
            expect(res.body.category, query).toBe('simulation');
            expect(res.body.data, query).toHaveLength(3);
        }
    });

    it('renders Unspecified like any other board where it has scores', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Mixed Unknown', ['vpx']);
        await addScore(gameId, { username: 'S', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'U1', score: 800, engine: UNKNOWN });
        await addScore(gameId, { username: 'U2', score: 700, engine: UNKNOWN });

        const res = await request(app).get(`/api/global/scoreboard/${gameId}?category=${UNSPECIFIED_CATEGORY}`);
        expect(res.body.category).toBe(UNSPECIFIED_CATEGORY);
        expect((res.body.data as any[]).map(r => r.iscored_username)).toEqual(['U1', 'U2']);
        // It is the bigger board here, so it also leads the strip.
        expect(res.body.categories[0].category).toBe(UNSPECIFIED_CATEGORY);
    });

    it('is unchanged for a single-category game', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('One Board', ['vpx']);
        await addScore(gameId, { username: 'A', score: 900, engine: 'vpx' });
        await addScore(gameId, { username: 'B', score: 800, engine: 'vpx' });

        const res = await request(app).get(`/api/global/scoreboard/${gameId}`);
        expect(res.body.categories).toEqual([{ category: 'simulation', score_count: 2 }]);
        expect(res.body.category).toBe('simulation');
        expect(res.body.total).toBe(2);
        expect((res.body.data as any[]).map(r => r.iscored_username)).toEqual(['A', 'B']);
    });

    it('keeps the zero-score claim state', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Untouched', ['vpx']);

        const res = await request(app).get(`/api/global/scoreboard/${gameId}`);
        expect(res.status).toBe(200);
        expect(res.body.categories).toEqual([]);
        expect(res.body.category).toBeNull();
        expect(res.body.data).toEqual([]);
        expect(res.body.total).toBe(0);
    });

    it('pages within the selected board, not across the game', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Paged', ['vpx', 'fx']);
        for (let i = 0; i < 5; i++) {
            await addScore(gameId, { username: `S${i}`, score: 900 - i, engine: 'vpx' });
        }
        await addScore(gameId, { username: 'F', score: 10, engine: 'fx' });

        const res = await request(app).get(`/api/global/scoreboard/${gameId}?category=simulation&limit=2&offset=0`);
        expect(res.body.total).toBe(5);      // the BOARD's size, not the game's 6
        expect(res.body.hasMore).toBe(true);
        expect(res.body.data).toHaveLength(2);
    });

    it('still 404s an unknown game', async () => {
        const app = await createTestApp();
        const res = await request(app).get('/api/global/scoreboard/nope?category=simulation');
        expect(res.status).toBe(404);
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
