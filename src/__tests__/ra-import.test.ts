import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { RAImportService } from '../services/RAImportService.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { GlobalLeaderboardService } from '../services/GlobalLeaderboardService.js';
import { raImportHandler } from '../api/raCatalogueHandlers.js';
import {
    classifyBoard, classifyGame, TIME_FORMATS, NUMERIC_FORMATS, ScoreEligibility,
} from '../utils/raClassifier.js';

/**
 * RA on-demand import §3 — classifier, import service, dedup, acceptance.
 *
 * The acceptance test at the bottom is the contract's own: import a game, then
 * prove it is reachable BOTH from the room add-game read path AND from the
 * Global Scoreboard's category-filtered response as a claim card. It goes
 * through the real services rather than mocks, because the claim being made is
 * about those services' behaviour, not about this test's fixtures.
 */

const TEST_KEY = 'test-ra-key';

interface RAMockState {
    extended: Record<number, unknown>;
    leaderboards: Record<number, unknown>;
    /** RA game ids whose leaderboard call should fail. */
    failLeaderboards: Set<number>;
    imageStatus: number;
    calls: { extended: number; leaderboards: number; images: number };
}

let raMock: RAMockState;

function installFetchMock() {
    raMock = {
        extended: {}, leaderboards: {}, failLeaderboards: new Set(),
        imageStatus: 200,
        calls: { extended: 0, leaderboards: 0, images: 0 },
    };

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const ok = (body: unknown) => ({
            ok: true, status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify(body),
        } as unknown as Response);

        if (url.includes('media.retroachievements.org')) {
            raMock.calls.images++;
            if (raMock.imageStatus !== 200) {
                return {
                    ok: false, status: raMock.imageStatus,
                    headers: { get: () => null },
                    text: async () => 'nope',
                } as unknown as Response;
            }
            return {
                ok: true, status: 200,
                headers: { get: () => null },
                arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
            } as unknown as Response;
        }

        const id = Number(new URL(url).searchParams.get('i'));

        if (url.includes('API_GetGameExtended')) {
            raMock.calls.extended++;
            return ok(raMock.extended[id] ?? { ID: null });
        }
        if (url.includes('API_GetGameLeaderboards')) {
            raMock.calls.leaderboards++;
            if (raMock.failLeaderboards.has(id)) {
                return {
                    ok: false, status: 503,
                    headers: { get: () => null },
                    text: async () => 'down',
                } as unknown as Response;
            }
            return ok({ Total: 0, Results: raMock.leaderboards[id] ?? [] });
        }
        return ok([]);
    }));
}

function extendedFixture(overrides: Record<string, unknown> = {}) {
    return {
        ID: 1447, Title: 'Donkey Kong', ConsoleID: 7, ConsoleName: 'NES/Famicom',
        Publisher: 'Nintendo', Developer: 'Nintendo', Genre: 'Platformer',
        Released: '1986-06-01',
        ImageIcon: '/Images/060003.png', ImageBoxArt: '/Images/060005.png',
        ImageTitle: '/Images/060006.png', ImageIngame: '/Images/060007.png',
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────────────────────────

describe('RA score-eligibility classifier (contract §3)', () => {
    it('calls every TIME format a time board', () => {
        for (const format of TIME_FORMATS) {
            expect(classifyBoard({ Format: format, RankAsc: false }), format).toBe('time');
        }
    });

    it('calls a TIME board with RankAsc a time board, not a novelty', () => {
        // Rule order is the spec: an ascending time board is the ordinary
        // speedrun shape. `novelty` is reserved for ascending boards measuring
        // something that is NOT a time (deaths, damage taken).
        for (const format of TIME_FORMATS) {
            expect(classifyBoard({ Format: format, RankAsc: true }), format).toBe('time');
        }
    });

    it('calls an ascending non-time board a novelty', () => {
        for (const format of NUMERIC_FORMATS) {
            expect(classifyBoard({ Format: format, RankAsc: true, Title: 'High Score' }), format)
                .toBe('novelty');
        }
    });

    it('calls every numeric format score_maybe without a keyword', () => {
        for (const format of NUMERIC_FORMATS) {
            expect(classifyBoard({ Format: format, RankAsc: false, Title: 'Coins Collected' }), format)
                .toBe('score_maybe');
        }
    });

    it('promotes a numeric board to score on each keyword', () => {
        const keyworded = [
            'High Score', 'high score', 'HIGH SCORE',
            'Hiscore', 'Hi-Score', 'Hi Score',
            'Total Points', 'Score Attack', '1CC run',
        ];
        for (const title of keyworded) {
            expect(classifyBoard({ Format: 'SCORE', RankAsc: false, Title: title }), title)
                .toBe('score');
        }
    });

    it('reads the keyword from the description too, not only the title', () => {
        expect(classifyBoard({
            Format: 'VALUE', RankAsc: false,
            Title: 'Stage 3', Description: 'Best points total on stage 3',
        })).toBe('score');
    });

    it('calls an unrecognised format unknown rather than guessing', () => {
        // A format RA adds later must surface as "we don't know", not be
        // silently mis-filed as a score.
        for (const format of ['', 'FUTURE_FORMAT', 'ACHIEVEMENT_POINTS', null]) {
            expect(classifyBoard({ Format: format, RankAsc: false }), String(format)).toBe('unknown');
        }
    });

    it('is case- and whitespace-insensitive about the format', () => {
        expect(classifyBoard({ Format: '  score  ', RankAsc: false, Title: 'High Score' })).toBe('score');
        expect(classifyBoard({ Format: 'time', RankAsc: false })).toBe('time');
    });

    it('gives a game with no boards the unknown verdict — silence is not a no', () => {
        expect(classifyGame([])).toBe('unknown');
        expect(classifyGame(undefined as unknown as [])).toBe('unknown');
    });

    it('takes the strongest verdict across a game\'s boards', () => {
        const cases: Array<{ boards: Array<Record<string, unknown>>; expect: ScoreEligibility }> = [
            {
                boards: [
                    { Format: 'TIME', RankAsc: true, Title: 'Any%' },
                    { Format: 'SCORE', RankAsc: false, Title: 'High Score' },
                ],
                expect: 'score',
            },
            {
                boards: [
                    { Format: 'TIME', RankAsc: true },
                    { Format: 'SCORE', RankAsc: false, Title: 'Coins' },
                ],
                expect: 'score_maybe',
            },
            {
                boards: [
                    { Format: 'SCORE', RankAsc: true, Title: 'Deaths' },
                    { Format: 'TIME', RankAsc: false },
                ],
                expect: 'time',
            },
            {
                boards: [
                    { Format: 'SCORE', RankAsc: true, Title: 'Deaths' },
                    { Format: 'WHAT', RankAsc: false },
                ],
                expect: 'novelty',
            },
            { boards: [{ Format: 'MYSTERY', RankAsc: false }], expect: 'unknown' },
        ];

        for (const c of cases) {
            expect(classifyGame(c.boards), JSON.stringify(c.boards)).toBe(c.expect);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Import service
// ─────────────────────────────────────────────────────────────────────────────

describe('RA import (contract §3)', () => {
    const originalKey = process.env.RA_API_KEY;
    const imageDir = path.join(process.cwd(), 'data', 'catalogue-images', 'ra');

    beforeEach(async () => {
        await setupTestDb();
        process.env.RA_API_KEY = TEST_KEY;
        installFetchMock();
        // Artwork from an earlier run would make the existsSync skip hide a
        // regression in the download path.
        if (fs.existsSync(imageDir)) fs.rmSync(imageDir, { recursive: true, force: true });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (fs.existsSync(imageDir)) fs.rmSync(imageDir, { recursive: true, force: true });
        if (originalKey === undefined) delete process.env.RA_API_KEY;
        else process.env.RA_API_KEY = originalKey;
    });

    it('imports a game as an approved catalogue row with engine platforms + eligibility', async () => {
        raMock.extended[1447] = extendedFixture();
        raMock.leaderboards[1447] = [
            { ID: 1, Format: 'SCORE', RankAsc: false, Title: 'High Score' },
            { ID: 2, Format: 'TIME', RankAsc: true, Title: 'Any%' },
        ];

        const result = await RAImportService.importGame(1447, { importedBy: 'discord:123' });

        expect(result.action).toBe('inserted');
        expect(result.scoreEligibility).toBe('score');
        expect(result.leaderboardCount).toBe(2);

        const game = result.game;
        expect(game.name).toBe('Donkey Kong');
        expect(game.status).toBe('approved');
        expect(game.type).toBe('video_game');
        expect(game.subtype).toBe('console');
        expect(JSON.parse(game.platforms)).toEqual(['nes']);
        expect(game.manufacturer).toBe('Nintendo');
        expect(game.year).toBe(1986);
        expect(game.ra_id).toBe(1447);
        expect(game.score_eligibility).toBe('score');
        expect(game.ra_leaderboard_count).toBe(2);
        expect(game.ra_imported_by).toBe('discord:123');
        expect(game.imported_from).toBe('ra');
        expect(game.external_url).toBe('https://retroachievements.org/game/1447');
    });

    it('files an RA arcade game under type=arcade with the arcade engine', async () => {
        raMock.extended[2] = extendedFixture({ ID: 2, Title: 'Pac-Man', ConsoleID: 27 });
        const result = await RAImportService.importGame(2);
        expect(result.game.type).toBe('arcade');
        expect(JSON.parse(result.game.platforms)).toEqual(['arcade']);
    });

    it('records unknown eligibility when RA has no boards, and imports anyway', async () => {
        raMock.extended[1447] = extendedFixture();
        raMock.leaderboards[1447] = [];

        const result = await RAImportService.importGame(1447);
        expect(result.scoreEligibility).toBe('unknown');
        expect(result.leaderboardCount).toBe(0);
        expect(result.game.status).toBe('approved');
    });

    it('imports a novelty/time game rather than refusing it', async () => {
        raMock.extended[1447] = extendedFixture();
        raMock.leaderboards[1447] = [{ ID: 1, Format: 'TIME', RankAsc: true, Title: 'Any%' }];

        const result = await RAImportService.importGame(1447);
        expect(result.scoreEligibility).toBe('time');
        expect(result.game.status).toBe('approved');
    });

    it('survives a leaderboard lookup failure with an unknown verdict', async () => {
        raMock.extended[1447] = extendedFixture();
        raMock.failLeaderboards.add(1447);

        const result = await RAImportService.importGame(1447);
        expect(result.scoreEligibility).toBe('unknown');
        expect(result.game.name).toBe('Donkey Kong');
    });

    it('stores an honest NULL manufacturer when RA has neither publisher nor developer', async () => {
        raMock.extended[1447] = extendedFixture({ Publisher: '', Developer: '' });
        const result = await RAImportService.importGame(1447);
        expect(result.game.manufacturer).toBeNull();
    });

    it('falls back to Developer when Publisher is empty', async () => {
        raMock.extended[1447] = extendedFixture({ Publisher: '', Developer: 'Rare' });
        const result = await RAImportService.importGame(1447);
        expect(result.game.manufacturer).toBe('Rare');
    });

    it('parses a year out of RA\'s loose Released strings, and leaves junk null', async () => {
        const cases: Array<[string | null, number | null]> = [
            ['1986-06-01', 1986], ['1986', 1986], ['June 1986', 1986],
            ['', null], [null, null], ['TBA', null],
        ];
        let id = 500;
        for (const [released, expected] of cases) {
            id++;
            raMock.extended[id] = extendedFixture({ ID: id, Title: `Game ${id}`, Released: released });
            const result = await RAImportService.importGame(id);
            expect(result.game.year, String(released)).toBe(expected);
        }
    });

    it('rehosts the icon and box art under data/catalogue-images/ra/', async () => {
        raMock.extended[1447] = extendedFixture();
        const result = await RAImportService.importGame(1447);

        expect(result.game.local_image_path).toBe('data/catalogue-images/ra/1447-box.png');
        expect(result.game.wheel_image_path).toBe('data/catalogue-images/ra/1447-icon.png');
        expect(fs.existsSync(path.join(imageDir, '1447-box.png'))).toBe(true);
        expect(fs.existsSync(path.join(imageDir, '1447-icon.png'))).toBe(true);
        expect(result.game.image_url).toBe('https://media.retroachievements.org/Images/060005.png');
    });

    it('skips a re-download when the file is already on disk', async () => {
        raMock.extended[1447] = extendedFixture();
        await RAImportService.importGame(1447);
        const firstPassImages = raMock.calls.images;
        expect(firstPassImages).toBe(2);

        await RAImportService.importGame(1447);
        expect(raMock.calls.images).toBe(firstPassImages);
    });

    it('imports the game even when the artwork fetch fails', async () => {
        raMock.extended[1447] = extendedFixture();
        raMock.imageStatus = 500;

        const result = await RAImportService.importGame(1447);
        expect(result.game.name).toBe('Donkey Kong');
        expect(result.game.local_image_path).toBeNull();
    });

    it('404s an RA id that does not exist', async () => {
        await expect(RAImportService.importGame(999999)).rejects.toThrow(/no game with id 999999/);
    });

    it('refuses a console with no Arcaid engine rather than inventing one', async () => {
        raMock.extended[3] = extendedFixture({ ID: 3, Title: 'PSP Game', ConsoleID: 41 });
        await expect(RAImportService.importGame(3)).rejects.toThrow(/not mapped to an Arcaid engine/);
    });

    it('is single-flight per RA game id — a double-click cannot race an INSERT', async () => {
        raMock.extended[1447] = extendedFixture();

        const [a, b] = await Promise.all([
            RAImportService.importGame(1447),
            RAImportService.importGame(1447),
        ]);

        expect(a).toBe(b);
        expect(raMock.calls.extended).toBe(1);

        const db = await getDatabase();
        const rows = await db.all(`SELECT id FROM global_games WHERE ra_id = 1447`);
        expect(rows).toHaveLength(1);
    });

    describe('dedup', () => {
        it('re-importing the same game updates the row instead of forking it', async () => {
            raMock.extended[1447] = extendedFixture();
            const first = await RAImportService.importGame(1447);

            raMock.extended[1447] = extendedFixture({ Genre: 'Arcade' });
            raMock.leaderboards[1447] = [{ ID: 1, Format: 'SCORE', RankAsc: false, Title: 'High Score' }];
            const second = await RAImportService.importGame(1447);

            expect(second.action).toBe('updated');
            expect(second.game.id).toBe(first.game.id);
            // The verdict refreshes from RA's current answer.
            expect(second.game.score_eligibility).toBe('score');
            expect(second.game.ra_leaderboard_count).toBe(1);

            const db = await getDatabase();
            const rows = await db.all(`SELECT id FROM global_games`);
            expect(rows).toHaveLength(1);
        });

        it('keeps the FIRST importer\'s credit on a re-import', async () => {
            raMock.extended[1447] = extendedFixture();
            await RAImportService.importGame(1447, { importedBy: 'discord:first' });
            const second = await RAImportService.importGame(1447, { importedBy: 'discord:second' });

            // ra_imported_by is moderation provenance — "who put this here" —
            // so a later re-import must not overwrite it.
            expect(second.game.ra_imported_by).toBe('discord:first');
        });

        it('ENRICHES an existing IGDB row instead of forking a duplicate', async () => {
            // The contract's enrich-not-fork case: the game is already in the
            // catalogue from a different source, and the RA import lands on it
            // via the step-4 normalized-name match.
            const seeded = await GlobalGameService.upsert({
                name: 'Donkey Kong',
                manufacturer: 'Nintendo',
                year: 1986,
                type: 'video_game',
                subtype: 'console',
                platforms: ['nes'],
                igdb_id: 55555,
                imported_from: 'igdb',
                status: 'approved',
            });

            raMock.extended[1447] = extendedFixture();
            raMock.leaderboards[1447] = [{ ID: 1, Format: 'SCORE', RankAsc: false, Title: 'High Score' }];
            const result = await RAImportService.importGame(1447);

            expect(result.action).toBe('updated');
            expect(result.game.id).toBe(seeded.id);
            // Both external ids now live on the one row.
            expect(result.game.igdb_id).toBe(55555);
            expect(result.game.ra_id).toBe(1447);
            expect(result.game.score_eligibility).toBe('score');

            const db = await getDatabase();
            expect(await db.all(`SELECT id FROM global_games`)).toHaveLength(1);
        });

        it('applies the cross-type guard to ra_id like any other external id', async () => {
            // A pinball row holding an `ra_id` cannot arise through any code
            // path — the RA importer is the ONLY writer of that column and it
            // only ever produces video_game/arcade rows, so the types can
            // never differ on a real ra_id match. This raw INSERT manufactures
            // the state anyway to pin the guard's behaviour down.
            //
            // The guard refuses the merge (correct — these are different
            // games), which sends the import to INSERT, where the partial
            // UNIQUE index on ra_id rejects it. That combination is the one
            // place the contract-mandated UNIQUE index and the pre-existing
            // cross-type guard disagree; it surfaces as a failed import rather
            // than a silent duplicate, which is the safer of the two, and it
            // is unreachable in production. Asserted so a future change that
            // makes the state reachable fails HERE and gets a design decision
            // rather than a mystery 500.
            const db = await getDatabase();
            await db.run(
                `INSERT INTO global_games (id, name, normalized_name, type, status, ra_id, platforms)
                 VALUES ('pin-1', 'Donkey Kong', 'donkey kong', 'pinball', 'approved', 1447, '["vpx"]')`,
            );

            raMock.extended[1447] = extendedFixture();
            await expect(RAImportService.importGame(1447)).rejects.toThrow(/UNIQUE constraint failed/);

            // The pinball row is untouched — no cross-type merge happened.
            const pin = await db.get(`SELECT * FROM global_games WHERE id = 'pin-1'`);
            expect(pin.type).toBe('pinball');
        });

        it('collapses two RA games that share (name, manufacturer, year) onto one row', async () => {
            // Pre-existing dedup semantics (v2.4.15): the step-4 CONCRETE tier
            // matches on (name, mfg, year) and deliberately IGNORES external-id
            // conflicts, on the reasoning that a divergent source id just means
            // the source re-indexed itself. RA makes that assumption visible,
            // because two genuinely different RA entries can share all three —
            // the same game released on two consoles in the same year.
            //
            // The result is a single catalogue row with BOTH engines and the
            // most recent import's `ra_id`. For a catalogue that is defensible
            // (one game, two platforms), but it means the master-list search
            // will mark only the last-imported of the pair as "already in
            // catalogue". Documented here rather than changed: the dedup
            // hierarchy's semantics are out of this contract's scope.
            raMock.extended[10] = extendedFixture({
                ID: 10, Title: 'Sonic the Hedgehog', ConsoleID: 1,
                Publisher: 'Sega', Released: '1991',
            });
            raMock.extended[11] = extendedFixture({
                ID: 11, Title: 'Sonic the Hedgehog', ConsoleID: 15,
                Publisher: 'Sega', Released: '1991',
            });

            const first = await RAImportService.importGame(10);
            const second = await RAImportService.importGame(11);

            expect(second.action).toBe('updated');
            expect(second.game.id).toBe(first.game.id);
            expect(JSON.parse(second.game.platforms)).toEqual(['genesis', 'game_gear']);
            expect(second.game.ra_id).toBe(11);

            const db = await getDatabase();
            expect(await db.all(`SELECT id FROM global_games`)).toHaveLength(1);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Acceptance (the contract's own test)
    // ─────────────────────────────────────────────────────────────────────────

    describe('acceptance: an imported game is instantly usable', () => {
        it('is findable in the room add-game read path AND appears on the Global Scoreboard as a claim card', async () => {
            raMock.extended[1447] = extendedFixture();
            raMock.leaderboards[1447] = [
                { ID: 1, Format: 'SCORE', RankAsc: false, Title: 'High Score' },
            ];

            const result = await RAImportService.importGame(1447, { importedBy: 'discord:123' });

            // 1. Room add-game: the library IS the approved catalogue (ADR 0007),
            //    so nothing extra had to be built — assert that, don't assume it.
            const libraryHits = await GameLibraryService.search('Donkey');
            expect(libraryHits.map(g => g.name)).toContain('Donkey Kong');

            const db = await getDatabase();
            const libraryRows = await db.all(
                `SELECT name FROM global_games WHERE status = 'approved'`,
            );
            expect(libraryRows.map((r: any) => r.name)).toContain('Donkey Kong');

            // 2. Global Scoreboard, filtered to the band the game's engine
            //    implies. It has no scores yet, so it is a CLAIM card: category
            //    null (there is no board), prospective_category naming the band
            //    the first score would open (v2.63 logic).
            const board = await GlobalLeaderboardService.getTopGames({ category: 'video' });
            const card = board.data.find(row => row.global_game_id === result.game.id);

            expect(card, 'imported game must appear under its category filter').toBeTruthy();
            expect(card!.score_count).toBe(0);
            expect(card!.category).toBeNull();
            expect(card!.prospective_category).toBe('video');
            expect(card!.card_id).toBe(`${result.game.id}::none`);

            // …and it must NOT be conjured into a band its engine cannot reach.
            const wrongBand = await GlobalLeaderboardService.getTopGames({ category: 'simulation' });
            expect(wrongBand.data.find(row => row.global_game_id === result.game.id)).toBeUndefined();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Endpoint
    // ─────────────────────────────────────────────────────────────────────────

    describe('import endpoint (shared by all three surfaces)', () => {
        function makeApp(user?: Record<string, unknown>) {
            const app = express();
            app.post('/ra-catalogue/import/:raGameId', (req, _res, next) => {
                if (user) (req as any).user = user;
                next();
            }, raImportHandler);
            return app;
        }

        it('returns the created row plus the verdict', async () => {
            raMock.extended[1447] = extendedFixture();
            raMock.leaderboards[1447] = [
                { ID: 1, Format: 'SCORE', RankAsc: false, Title: 'High Score' },
            ];

            const res = await request(makeApp({ discordId: '999' }))
                .post('/ra-catalogue/import/1447');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.action).toBe('inserted');
            expect(res.body.raGameId).toBe(1447);
            expect(res.body.scoreEligibility).toBe('score');
            expect(res.body.leaderboardCount).toBe(1);
            expect(res.body.game.name).toBe('Donkey Kong');
            expect(res.body.game.ra_id).toBe(1447);
            expect(res.body.attribution.source).toBe('RetroAchievements');
        });

        it('records the caller as the importer', async () => {
            raMock.extended[1447] = extendedFixture();
            const res = await request(makeApp({ discordId: '999' }))
                .post('/ra-catalogue/import/1447');
            expect(res.body.game.ra_imported_by).toBe('999');
        });

        it('rejects a non-numeric id with 400', async () => {
            const res = await request(makeApp()).post('/ra-catalogue/import/abc');
            expect(res.status).toBe(400);
        });

        it('answers 404 for an RA game that does not exist', async () => {
            const res = await request(makeApp()).post('/ra-catalogue/import/999999');
            expect(res.status).toBe(404);
        });

        it('answers 422 for a console with no Arcaid engine', async () => {
            raMock.extended[3] = extendedFixture({ ID: 3, ConsoleID: 41 });
            const res = await request(makeApp()).post('/ra-catalogue/import/3');
            expect(res.status).toBe(422);
        });

        it('answers 400 with something actionable when no key is configured', async () => {
            delete process.env.RA_API_KEY;
            const res = await request(makeApp()).post('/ra-catalogue/import/1447');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/RA_API_KEY/);
        });
    });
});
