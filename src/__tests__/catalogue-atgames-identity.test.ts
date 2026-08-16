import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { AtGamesEStoreClient, atgamesMatchKey, seriesOf, brandOf, stripBlurb } from '../services/AtGamesEStoreClient.js';
import { ATGAMES_STUDIO_OVERRIDES, buildOverrideIndex } from '../services/atgamesStudioOverrides.js';
import { AtGamesApiClient } from '../services/AtGamesApiClient.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';

/**
 * AtGames importer: external-id identity, studio as its own axis, and the
 * pinball/arcade classifier.
 *
 * The thing these tests exist to protect is the SEPARATION between `studio` and
 * `manufacturer`. FarSight publishes Gottlieb machines, Magic Pixel publishes
 * Zaccaria, Zen publishes Williams. If a future change routes the studio into
 * `manufacturer`, `manufacturerYearAgree` starts comparing "magic pixel"
 * against "zaccaria", step-4 dedup fails, and every sync inserts a duplicate
 * beside the row it should have updated — which is exactly the failure that
 * produced the 88 Zaccaria/AtGames duplicates repaired on prod 2026-08-16.
 */

async function insertGame(fields: {
    name: string;
    type?: string;
    manufacturer?: string | null;
    year?: number | null;
    atgames_id?: number | null;
    studio?: string | null;
    platforms?: string[];
}): Promise<string> {
    const db = await getDatabase();
    const id = `atg-test-${fields.name.replace(/\W+/g, '-').toLowerCase()}`
        + `-${fields.manufacturer ?? 'nomfg'}-${fields.year ?? 'x'}`.toLowerCase();
    await db.run(
        `INSERT INTO global_games (id, name, normalized_name, type, manufacturer, year,
                                   atgames_id, studio, platforms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
        id,
        fields.name,
        normalizeGameName(fields.name),
        fields.type ?? 'pinball',
        fields.manufacturer ?? null,
        fields.year ?? null,
        fields.atgames_id ?? null,
        fields.studio ?? null,
        JSON.stringify(fields.platforms ?? []),
    );
    return id;
}

describe('AtGames catalogue identity', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    describe('atgames_id as a step-1 external id', () => {
        it('resolves an existing row by id even when the name changed upstream', async () => {
            // AtGames renamed the sheet's "Locomotion Remake" to "Locomotion
            // 2018". Under name-only dedup that is a new row; under the id it
            // is the same table.
            const id = await insertGame({ name: 'Locomotion Remake', atgames_id: 50209 });

            const result = await GlobalGameService.upsert({
                name: 'Locomotion 2018',
                type: 'pinball',
                atgames_id: 50209,
                platforms: ['atgames_native'],
                imported_from: 'atgames',
            });

            expect(result.action).toBe('updated');
            expect(result.id).toBe(id);
        });

        it('keeps the four Zaccaria designs of one machine apart', async () => {
            // normalizeGameName strips "Remake" as an edition suffix, so the
            // legacy spelling collides with plain "Locomotion" on the name key.
            // The ids are what stop them merging.
            expect(normalizeGameName('Locomotion Remake')).toBe(normalizeGameName('Locomotion'));

            const plain = await insertGame({ name: 'Locomotion', atgames_id: 50208 });
            const deluxe = await GlobalGameService.upsert({
                name: 'Locomotion Deluxe', type: 'pinball', atgames_id: 50687, imported_from: 'atgames',
            });
            const retro = await GlobalGameService.upsert({
                name: 'Locomotion Retro', type: 'pinball', atgames_id: 50210, imported_from: 'atgames',
            });

            expect(deluxe.action).toBe('inserted');
            expect(retro.action).toBe('inserted');
            expect(new Set([plain, deluxe.id, retro.id]).size).toBe(3);
        });

        it('refuses to merge a name match whose atgames_id conflicts', async () => {
            // Same normalized name, different AtGames table. Without the
            // conflict guard the name walk would fold one onto the other.
            await insertGame({ name: 'Locomotion', atgames_id: 50208 });

            const result = await GlobalGameService.upsert({
                name: 'Locomotion Remake',
                type: 'pinball',
                atgames_id: 50209,
                imported_from: 'atgames',
            });

            expect(result.action).toBe('inserted');
        });

        it('survives a merge so the next sync does not re-insert the absorbed row', async () => {
            const target = await insertGame({ name: 'Black Belt', manufacturer: 'Bally', year: 1986 });
            const source = await insertGame({ name: 'Blackbelt', atgames_id: 50101, studio: 'Magic Pixel' });

            await GlobalGameService.merge(target, source);

            const db = await getDatabase();
            const survivor = await db.get<{ atgames_id: number | null; studio: string | null }>(
                'SELECT atgames_id, studio FROM global_games WHERE id = ?', target,
            );
            expect(survivor?.atgames_id).toBe(50101);
            expect(survivor?.studio).toBe('Magic Pixel');

            // And the re-sync lands back on the survivor rather than forking.
            const resync = await GlobalGameService.upsert({
                name: 'Blackbelt', type: 'pinball', atgames_id: 50101, imported_from: 'atgames',
            });
            expect(resync.action).toBe('updated');
            expect(resync.id).toBe(target);
        });
    });

    describe('studio does not contaminate manufacturer', () => {
        it('stores the studio without touching the machine manufacturer', async () => {
            const id = await insertGame({ name: 'Cue Ball Wizard', manufacturer: 'Gottlieb', year: 1992 });

            await GlobalGameService.upsert({
                name: 'Cue Ball Wizard',
                type: 'pinball',
                manufacturer: 'Gottlieb',
                year: 1992,
                atgames_id: 50501,
                studio: 'FarSight Studios',
                imported_from: 'atgames',
            });

            const db = await getDatabase();
            const row = await db.get<{ manufacturer: string; studio: string }>(
                'SELECT manufacturer, studio FROM global_games WHERE id = ?', id,
            );
            expect(row?.manufacturer).toBe('Gottlieb');
            expect(row?.studio).toBe('FarSight Studios');
        });

        it('an import carrying only a studio still merges onto a manufactured row', async () => {
            // The regression this guards: had the importer sent studio AS the
            // manufacturer, manufacturerYearAgree would compare "magic pixel"
            // to "zaccaria", return false, and insert a duplicate.
            const id = await insertGame({ name: 'Time Machine', manufacturer: 'Zaccaria', year: 1983 });

            const result = await GlobalGameService.upsert({
                name: 'Time Machine',
                type: 'pinball',
                studio: 'Magic Pixel',
                atgames_id: 50777,
                imported_from: 'atgames',
            });

            expect(result.action).toBe('updated');
            expect(result.id).toBe(id);
        });

        it('re-syncs the studio when the store re-files a pack, but never clears it', async () => {
            const id = await insertGame({ name: 'Devil Riders', studio: 'Magic Pixel', atgames_id: 50900 });
            const db = await getDatabase();

            // A supplied value wins — the store is the authority, so a
            // re-filing there propagates on the next sync.
            await GlobalGameService.upsert({
                name: 'Devil Riders', type: 'pinball', atgames_id: 50900,
                studio: 'Zen Studios', imported_from: 'atgames',
            });
            expect((await db.get<{ studio: string }>('SELECT studio FROM global_games WHERE id = ?', id))?.studio)
                .toBe('Zen Studios');

            // But an import that knows no studio (any other importer, or an
            // AtGames row the store never attributed) must not wipe it.
            await GlobalGameService.upsert({
                name: 'Devil Riders', type: 'pinball', atgames_id: 50900, imported_from: 'vps',
            });
            expect((await db.get<{ studio: string }>('SELECT studio FROM global_games WHERE id = ?', id))?.studio)
                .toBe('Zen Studios');
        });
    });

    describe('fillMissingManufacturer', () => {
        it('fills only when the row has none', async () => {
            const empty = await insertGame({ name: 'Farfalla' });
            const taken = await insertGame({ name: 'Pinball Champ', manufacturer: 'Zaccaria', year: 1983 });

            expect(await GlobalGameService.fillMissingManufacturer(empty, 'Zaccaria', 'atgames')).toBe(true);
            expect(await GlobalGameService.fillMissingManufacturer(taken, 'Williams', 'atgames')).toBe(false);

            const db = await getDatabase();
            const a = await db.get<{ manufacturer: string }>('SELECT manufacturer FROM global_games WHERE id = ?', empty);
            const b = await db.get<{ manufacturer: string }>('SELECT manufacturer FROM global_games WHERE id = ?', taken);
            expect(a?.manufacturer).toBe('Zaccaria');
            expect(b?.manufacturer).toBe('Zaccaria');
        });

        it('declines rather than throwing when the fill would collide on identity', async () => {
            // idx_global_games_identity covers (name, type, manufacturer, year).
            // Filling the blank row's manufacturer moves it onto the other
            // row's tuple; that is a merge decision, not a backfill's call.
            await insertGame({ name: 'Combat', manufacturer: 'Zaccaria', year: null });
            const blank = await insertGame({ name: 'Combat', type: 'pinball', manufacturer: null, year: null });

            await expect(
                GlobalGameService.fillMissingManufacturer(blank, 'Zaccaria', 'atgames'),
            ).resolves.toBe(false);
        });
    });

    describe('pinball / arcade classifier', () => {
        const row = (hardware_models: string[]) => ({
            game_id: 1, name: 'x', hardware_models,
            internal_number: null, boxart: null, boxart_480w: null,
        });

        it('accepts rows on pinball-only cabinets', () => {
            expect(AtGamesApiClient.isPinball(row(['RK9920']))).toBe(true);   // Pinball 4K
            expect(AtGamesApiClient.isPinball(row(['HA9919']))).toBe(true);   // HDP
            expect(AtGamesApiClient.isPinball(row(['HA8818']))).toBe(true);   // Pinball Micro
            expect(AtGamesApiClient.isPinball(row(['HA8819C']))).toBe(true);  // Pinball ES
        });

        it('rejects an arcade ROM that merely runs on the pinball cabinet', () => {
            // The live shape of "8 Eyes": it lists HA8819 (Legends Pinball,
            // which also plays arcade games), so the shared codes cannot be
            // the discriminator.
            expect(AtGamesApiClient.isPinball(row([
                'HA8800', 'HA8819', 'HA2802', 'HA8801', 'HA2811', 'HA2812', 'HAB800', 'HA8810',
            ]))).toBe(false);
        });

        it('maps cabinets to availability features without duplicates', () => {
            const features = AtGamesApiClient.cabinetFeatures(row(['RK9920', 'HA8819', 'HA8819C', 'HA2811', 'HA2819']));
            expect(features).toContain('atgames_4k');
            expect(features).toContain('atgames_hd');
            expect(features).toContain('atgames_core');
            expect(new Set(features).size).toBe(features.length);
        });
    });

    describe('store ↔ API name matching', () => {
        it('strips the brand prefix the API adds and the store omits', () => {
            expect(atgamesMatchKey('Williams™ Pinball: Attack from Mars™'))
                .toBe(atgamesMatchKey('Attack from Mars™'));
            expect(atgamesMatchKey('Williams™ Pinball The Addams Family™'))
                .toBe(atgamesMatchKey('The Addams Family'));
        });

        it('strips the series parenthetical the API adds and the store omits', () => {
            expect(atgamesMatchKey('Africa (Natural History)')).toBe(atgamesMatchKey('Africa'));
            expect(atgamesMatchKey('Arkanoid (Pinball)')).toBe(atgamesMatchKey('Arkanoid'));
        });

        it('keeps edition variants distinct — unlike normalizeGameName', () => {
            // This key must NOT collapse the Zaccaria designs. normalizeGameName
            // does collapse "Remake", which is why matching uses its own key.
            expect(atgamesMatchKey('Locomotion')).not.toBe(atgamesMatchKey('Locomotion Deluxe'));
            expect(atgamesMatchKey('Locomotion')).not.toBe(atgamesMatchKey('Locomotion Retro'));
            expect(atgamesMatchKey('Locomotion')).not.toBe(atgamesMatchKey('Locomotion 2018'));
        });

        it('reads the series off an API name', () => {
            expect(seriesOf('Fox in Socks (Dr. Seuss)')).toBe('dr. seuss');
            expect(seriesOf('Deep Ocean (Natural History)')).toBe('natural history');
            expect(seriesOf('Locomotion')).toBeNull();
        });

        it('reads the announced brand, and only when it is announced', () => {
            // The brand tier answers "Williams™ Pinball: FunHouse™" — a table
            // in a Volume pack that lists no contents. It must NOT fire on
            // "Medieval Madness™", which is equally a Williams machine but
            // says nothing about it; recognising machines is not this rule's
            // job and guessing there would attribute by vibe.
            expect(brandOf('Williams™ Pinball: FunHouse™')).toBe('williams');
            expect(brandOf('Williams™ Pinball Volume 4')).toBe('williams');
            expect(brandOf('Medieval Madness™')).toBeNull();
            expect(brandOf('Locomotion Deluxe')).toBeNull();
        });
    });

    describe('prefix claims', () => {
        const claims = (entries: Array<[string, string]>) =>
            entries
                .map(([prefix, studio]) => ({
                    prefix, attribution: { studio, manufacturer: null, packTitle: `${studio} pack` },
                }))
                .sort((a, b) => b.prefix.length - a.prefix.length);

        it('claims the tables a mini pack names itself after', () => {
            const byPrefix = claims([[atgamesMatchKey('Star Trek Pinball'), 'Zen Studios']]);
            expect(AtGamesEStoreClient.matchByPrefix(byPrefix, 'Star Trek™ Pinball: Discovery')?.studio)
                .toBe('Zen Studios');
        });

        it('prefers the longest matching claim', () => {
            const byPrefix = claims([
                [atgamesMatchKey('Jurassic Park Pinball'), 'Zen Studios'],
                [atgamesMatchKey('Jurassic Park Pinball Mayhem'), 'Magic Pixel'],
            ]);
            expect(AtGamesEStoreClient.matchByPrefix(byPrefix, 'Jurassic Park Pinball Mayhem™')?.studio)
                .toBe('Magic Pixel');
        });

        it('returns null when nothing claims the name', () => {
            const byPrefix = claims([[atgamesMatchKey('Star Trek Pinball'), 'Zen Studios']]);
            expect(AtGamesEStoreClient.matchByPrefix(byPrefix, 'Locomotion Deluxe')).toBeNull();
        });
    });

    describe('marketing-copy list items', () => {
        it('recovers the name from an ALL-CAPS headed blurb', () => {
            expect(stripBlurb("FUNHOUSE: Starring Rudy, pinball's most iconic ventriloquist dummy antagonist!"))
                .toBe('FUNHOUSE');
            expect(stripBlurb('SPACE STATION: Prepare for liftoff. We have ignition.'))
                .toBe('SPACE STATION');
        });

        it('leaves ordinary titles containing a colon completely alone', () => {
            // The safety property. Truncating at the colon here would collapse
            // three distinct Star Trek tables into one shared prefix, and lose
            // the edition on the Getaway.
            for (const title of [
                'Star Trek™ Pinball: Deep Space Nine',
                'Star Trek™ Pinball: Discovery',
                'The Getaway: High Speed II™',
                'Firefighter: Wildlands',
                'Wrath of the Elder Gods: Director’s Cut',
            ]) {
                expect(stripBlurb(title)).toBe(title);
            }
        });
    });

    describe('curated studio overrides', () => {
        const index = buildOverrideIndex(atgamesMatchKey);

        it('maps every entry to a known studio, with a reason recorded', () => {
            const known = new Set(['Zen Studios', 'Magic Pixel', 'FarSight Studios', 'AtGames Originals']);
            expect(ATGAMES_STUDIO_OVERRIDES.length).toBeGreaterThan(0);
            for (const entry of ATGAMES_STUDIO_OVERRIDES) {
                expect(known.has(entry.studio), `${entry.name} → "${entry.studio}"`).toBe(true);
                // The provenance note is what makes this map auditable rather
                // than a pile of assertions. An entry without one is a guess.
                expect(entry.why.trim().length, `${entry.name} has no "why"`).toBeGreaterThan(20);
            }
        });

        it('has no two entries claiming the same table', () => {
            expect(index.size).toBe(ATGAMES_STUDIO_OVERRIDES.length);
        });

        it('keys through the same match key the store lookup uses', () => {
            // If these drifted apart, every override would silently miss.
            expect(index.get(atgamesMatchKey('Medieval Madness™'))?.studio).toBe('Zen Studios');
            expect(index.get(atgamesMatchKey('Arkanoid (Pinball)'))?.studio).toBe('AtGames Originals');
            expect(index.get(atgamesMatchKey('Zombies'))?.studio).toBe('Magic Pixel');
        });

        it('does not claim tables the derived tiers already own', () => {
            // The override tier runs LAST so the store always wins, but an
            // entry duplicating a derived answer is dead weight that hides a
            // store change. These three are attributed by pack list, series
            // and brand respectively.
            for (const name of ['Cue Ball Wizard', 'Africa (Natural History)', 'Williams™ Pinball: FunHouse™']) {
                expect(index.has(atgamesMatchKey(name)), `${name} should not need an override`).toBe(false);
            }
        });
    });
});
