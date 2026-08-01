import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { foldCatalogueToEngines } from '../database/migrations/catalogueEngineFold.js';

/**
 * Migration 129 — `global_games.platforms` becomes an engine list
 * (ADR 0016 catalogue phase §3).
 *
 * The migration runs once at startup on a real deploy, so the only chance to
 * find out whether it does the right thing is here. The suite covers the three
 * things a data migration can get wrong: the transform, re-runnability, and
 * what it touches that it shouldn't.
 */

let seq = 0;
async function seedGame(
    platforms: string[],
    features: string[] = [],
    name = `game-${++seq}`,
): Promise<string> {
    const db = await getDatabase();
    const id = `gg-${seq}`;
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, features, status)
         VALUES (?, ?, 'pinball', ?, ?, 'approved')`,
        id, name, JSON.stringify(platforms), JSON.stringify(features),
    );
    return id;
}

async function readGame(id: string): Promise<{ platforms: string[]; features: string[] }> {
    const db = await getDatabase();
    const row = await db.get('SELECT platforms, features FROM global_games WHERE id = ?', id);
    return { platforms: JSON.parse(row.platforms), features: JSON.parse(row.features) };
}

describe('migration 129 — catalogue platforms → engines', () => {
    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    it('folds a fixture carrying every legacy id in the contract table', async () => {
        const cases: Array<[string[], string[], string[]]> = [
            // [seeded platforms, expected engines, expected features]
            [['real'],                  ['real'],           []],
            [['vpx'],                   ['vpx'],            []],
            [['vpxs'],                  ['vpx'],            ['vpxs']],
            [['vpxs_manual'],           ['vpx'],            ['vpxs_manual']],
            [['vp9'],                   ['vp9'],            []],
            [['fp'],                    ['fp'],             []],
            [['bam'],                   ['fp'],             ['bam']],
            [['pinball_fx'],            ['fx'],             []],
            [['pinball_fx_vr'],         ['fx'],             ['vr']],
            [['pinball_fx_classic'],    ['fx_classic'],     []],
            [['fx2'],                   ['fx_classic'],     []],
            [['pinball_fx_classic_vr'], ['fx_classic'],     ['vr']],
            [['pinball_fx_midnight'],   ['fx_midnight'],    []],
            [['star_wars_pinball_vr'],  ['star_wars'],      ['vr']],
            [['zaccaria'],              ['zaccaria'],       []],
            [['zaccaria_vr'],           ['zaccaria'],       ['vr']],
            [['atgames'],               ['atgames_native'], ['atgames']],
            [['nes'],                   ['nes'],            []],
            [['arcade'],                ['arcade'],         []],
            [['pc'],                    ['pc'],             []],
        ];
        const ids: string[] = [];
        for (const [platforms] of cases) ids.push(await seedGame(platforms));

        await foldCatalogueToEngines(await getDatabase());

        for (let i = 0; i < cases.length; i++) {
            const [seeded, engines, features] = cases[i];
            const got = await readGame(ids[i]);
            expect(got.platforms, JSON.stringify(seeded)).toEqual(engines);
            expect(got.features, JSON.stringify(seeded)).toEqual(features);
        }
    });

    it('collapses a multi-platform row and preserves first-seen engine order', async () => {
        const id = await seedGame(['vpxs', 'vpx', 'real', 'atgames', 'pinball_fx_vr']);
        await foldCatalogueToEngines(await getDatabase());
        const got = await readGame(id);
        expect(got.platforms).toEqual(['vpx', 'real', 'atgames_native', 'fx']);
        expect(got.features).toEqual(['vpxs', 'atgames', 'vr']);
    });

    it('union-merges into existing features without disturbing them', async () => {
        // The 8 AtGames cabinet variants (migration 101) already live here and
        // are read by the FE — they must keep their position, not be re-sorted.
        const id = await seedGame(['atgames', 'vpxs'], ['atgames_4k', 'atgames_hd']);
        await foldCatalogueToEngines(await getDatabase());
        const got = await readGame(id);
        expect(got.features).toEqual(['atgames_4k', 'atgames_hd', 'atgames', 'vpxs']);
    });

    it('does not duplicate a feature the row already carries', async () => {
        const id = await seedGame(['atgames'], ['atgames']);
        await foldCatalogueToEngines(await getDatabase());
        expect((await readGame(id)).features).toEqual(['atgames']);
    });

    it('drops junk from platforms and logs it with the row id', async () => {
        const id = await seedGame(['vpx', 'xyzzy', 'some vps format']);
        const counts = await foldCatalogueToEngines(await getDatabase());
        expect((await readGame(id)).platforms).toEqual(['vpx']);
        expect(counts.dropped['xyzzy']).toEqual([id]);
        expect(counts.dropped['some vps format']).toEqual([id]);
    });

    it('counts rows left with no engine at all', async () => {
        await seedGame(['xyzzy']);
        await seedGame(['vr']);      // feature-only, legitimately engine-less
        await seedGame(['vpx']);
        const counts = await foldCatalogueToEngines(await getDatabase());
        expect(counts.rowsWithNoEngines).toBe(2);
    });

    it('reports the pre-fold distribution and per-id transform counts', async () => {
        await seedGame(['vpx', 'vpxs']);
        await seedGame(['vpxs']);
        await seedGame(['atgames']);
        const counts = await foldCatalogueToEngines(await getDatabase());
        expect(counts.scanned).toBe(3);
        expect(counts.distribution).toEqual({ vpx: 1, vpxs: 2, atgames: 1 });
        expect(counts.transformed).toEqual({ vpx: 1, vpxs: 2, atgames: 1 });
        expect(counts.featuresAdded).toEqual({ vpxs: 2, atgames: 1 });
        expect(counts.updated).toBe(3);
    });

    it('is idempotent — a second run changes nothing and reports zero updates', async () => {
        const ids = [
            await seedGame(['vpx', 'vpxs', 'atgames']),
            await seedGame(['pinball_fx_vr', 'zaccaria_vr']),
            await seedGame(['bam', 'fp']),
            await seedGame(['real'], ['atgames_hd']),
        ];
        const db = await getDatabase();

        await foldCatalogueToEngines(db);
        const after = await Promise.all(ids.map(readGame));

        const second = await foldCatalogueToEngines(db);
        expect(second.updated).toBe(0);
        expect(second.transformed).toEqual({});
        expect(second.featuresAdded).toEqual({});
        expect(second.dropped).toEqual({});

        for (let i = 0; i < ids.length; i++) {
            expect(await readGame(ids[i])).toEqual(after[i]);
        }
    });

    it('leaves an already-folded row untouched', async () => {
        // A row an importer wrote post-release, before the migration ran.
        const id = await seedGame(['vpx', 'atgames_native'], ['vpxs', 'atgames']);
        const counts = await foldCatalogueToEngines(await getDatabase());
        expect(counts.updated).toBe(0);
        expect(await readGame(id)).toEqual({
            platforms: ['vpx', 'atgames_native'],
            features: ['vpxs', 'atgames'],
        });
    });

    it('busts both leaderboard caches when it changes anything', async () => {
        const db = await getDatabase();
        await seedGame(['vpxs']);
        // Both caches hold serialized card rows that embed platform chips and
        // neither self-invalidates on a catalogue edit (precedent 086/088/127).
        await db.run(
            `INSERT INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at)
             VALUES ('gg-1', 'all', '[]', datetime('now'))`,
        );
        await foldCatalogueToEngines(db);
        const left = await db.get('SELECT COUNT(*) AS n FROM global_leaderboard_cache');
        expect(left.n).toBe(0);
        const roomLeft = await db.get('SELECT COUNT(*) AS n FROM leaderboard_cache');
        expect(roomLeft.n).toBe(0);
    });

    it('touches nothing outside global_games', async () => {
        const db = await getDatabase();
        await seedGame(['vpxs', 'atgames']);
        await db.run(
            `INSERT INTO room_game_tags (game_room_id, global_game_id, tag)
             VALUES ('r1', 'gg-1', 'vpxs')`,
        );
        const rulesBefore = JSON.stringify({ required: ['atgames'], excluded: [] });
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, platform_rules)
             VALUES ('t1', 'T', 'weekly', 'pinball', ?)`,
            rulesBefore,
        );

        await foldCatalogueToEngines(db);

        // Room tags stay free-form (hazard H-G) and stored rules stay legacy —
        // P2's read-time shim owns rule shape, nothing rewrites a row here.
        const tag = await db.get('SELECT tag FROM room_game_tags WHERE global_game_id = ?', 'gg-1');
        expect(tag.tag).toBe('vpxs');
        const t = await db.get('SELECT platform_rules FROM tournaments WHERE id = ?', 't1');
        expect(t.platform_rules).toBe(rulesBefore);
    });

    it('is a no-op on an empty catalogue', async () => {
        const counts = await foldCatalogueToEngines(await getDatabase());
        expect(counts).toMatchObject({ scanned: 0, updated: 0, rowsWithNoEngines: 0 });
    });
});
