import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import {
    isRetiredWizardExternalUrl,
    isReadmeEraWizardRow,
    isWizardFileFeature,
    readmeEraFeatureCarry,
    wizardFolderSlugs,
    withoutRetiredDownloads,
} from '../utils/wizardLegacy.js';

/**
 * C14 — the README-era Wizard rows (imported_from 'wizard', no VPS id, a link
 * into the repo) are merged into the VPS rows they copy. Covers the pure
 * rules, the merge (what moves, what stays behind), the Wizard reconcile's
 * file facts, migration 219 and the preview / batch merge service.
 */

const DEAD_TREE = 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/external/vpx-getaway';
const DEAD_RAW = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/main/external/vpx-getaway/launcher.png';
const LIVE_TREE = 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/tables/vpx-getaway';
const CATALOG = 'https://vpxtablemanager.com/catalog/#table=vpx-getaway';

interface Row {
    name: string;
    manufacturer?: string | null;
    year?: number | null;
    status?: string;
    imported_from?: string | null;
    vps_id?: string | null;
    external_url?: string | null;
    image_url?: string | null;
    table_download_urls?: Array<{ format?: string; url: string }> | null;
    features?: string[];
    platforms?: string[];
}

async function insertGame(r: Row): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, normalized_name, type, manufacturer, year, status, imported_from,
                                   vps_id, external_url, image_url, table_download_urls, features, platforms)
         VALUES (?, ?, ?, 'pinball', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, r.name, normalizeGameName(r.name), r.manufacturer ?? null, r.year ?? null, r.status ?? 'approved',
        r.imported_from ?? null, r.vps_id ?? null, r.external_url ?? null, r.image_url ?? null,
        r.table_download_urls ? JSON.stringify(r.table_download_urls) : null,
        JSON.stringify(r.features ?? []), JSON.stringify(r.platforms ?? ['vpx']),
    );
    return id;
}

/** A README-era row as the old importer left it. */
function oldRow(name: string, extra: Partial<Row> = {}): Row {
    const link = extra.external_url ?? DEAD_TREE;
    return {
        name,
        imported_from: 'wizard',
        vps_id: null,
        external_url: link,
        table_download_urls: [{ format: 'wizard', url: link }],
        features: ['wizard_manual', 'vpxs_manual', 'fps_45', 'has_puppack', 'has_dmd'],
        ...extra,
    };
}

async function row(id: string) {
    const db = await getDatabase();
    return db.get<{ features: string; external_url: string | null; image_url: string | null; table_download_urls: string | null; dedup_aliases: string | null }>(
        `SELECT features, external_url, image_url, table_download_urls, dedup_aliases FROM global_games WHERE id = ?`, id,
    );
}

async function reset() {
    await setupTestDb();
    const db = await getDatabase();
    for (const t of ['global_scores', 'global_leaderboard_cache', 'player_tables', 'global_game_pins', 'game_feedback',
        'global_game_tables', 'global_game_ratings', 'wizard_table_slugs', 'games', 'global_games']) {
        await db.run(`DELETE FROM ${t}`);
    }
}

describe('wizardLegacy rules', () => {
    it('recognises links into the deleted external/ folder, tree and raw alike', () => {
        expect(isRetiredWizardExternalUrl(DEAD_TREE)).toBe(true);
        expect(isRetiredWizardExternalUrl(DEAD_RAW)).toBe(true);
        expect(isRetiredWizardExternalUrl(LIVE_TREE)).toBe(false);
        expect(isRetiredWizardExternalUrl(CATALOG)).toBe(false);
        expect(isRetiredWizardExternalUrl('https://example.com/external/x')).toBe(false);
        expect(isRetiredWizardExternalUrl(null)).toBe(false);
    });

    it('a README-era row is wizard-stamped, has no VPS id and no catalog-site link', () => {
        expect(isReadmeEraWizardRow({ imported_from: 'wizard', vps_id: null, external_url: DEAD_TREE })).toBe(true);
        expect(isReadmeEraWizardRow({ imported_from: 'wizard', vps_id: null, external_url: null })).toBe(true);
        expect(isReadmeEraWizardRow({ imported_from: 'wizard', vps_id: 'abc', external_url: DEAD_TREE })).toBe(false);
        // A future manifest entry with no VPS id still carries the catalog link.
        expect(isReadmeEraWizardRow({ imported_from: 'wizard', vps_id: null, external_url: CATALOG })).toBe(false);
        expect(isReadmeEraWizardRow({ imported_from: 'vps', vps_id: null, external_url: DEAD_TREE })).toBe(false);
    });

    it('file features are the install / ships-with / fps facts and nothing else', () => {
        for (const f of ['vpxs', 'vpxs_manual', 'wizard_auto', 'wizard_manual', 'has_backglass', 'has_puppack', 'requires_rom', 'fps_60']) {
            expect(isWizardFileFeature(f)).toBe(true);
        }
        // has_dmd has no manifest source, so it is the machine's, kept.
        for (const f of ['has_dmd', 'atgames', 'vr', 'bam', 'atgames_4k', 'fx_vr', 'fps']) expect(isWizardFileFeature(f)).toBe(false);
    });

    it('carries no file facts, but keeps AtGames eligibility when the survivor had none', () => {
        expect(readmeEraFeatureCarry(['vpxs_manual', 'fps_45', 'vr'], [])).toEqual(['vr', 'vpxs_manual']);
        // An old AUTO row still only lends the weaker claim.
        expect(readmeEraFeatureCarry(['vpxs', 'wizard_auto'], [])).toEqual(['vpxs_manual']);
        // The survivor already installs through the Table Manager: nothing to keep.
        expect(readmeEraFeatureCarry(['vpxs_manual', 'wizard_manual'], ['vpxs'])).toEqual([]);
        expect(readmeEraFeatureCarry(['fps_45'], [])).toEqual([]);
    });

    it('reads the install folder from any of the row\'s links', () => {
        expect(wizardFolderSlugs({ external_url: DEAD_TREE })).toEqual(['vpx-getaway']);
        expect(wizardFolderSlugs({ image_url: DEAD_RAW })).toEqual(['vpx-getaway']);
        expect(wizardFolderSlugs({ table_download_urls: JSON.stringify([{ format: 'wizard', url: LIVE_TREE }]) })).toEqual(['vpx-getaway']);
        expect(wizardFolderSlugs({ external_url: CATALOG })).toEqual(['vpx-getaway']);
        expect(wizardFolderSlugs({ external_url: 'https://store.steampowered.com/app/2660540/' })).toEqual([]);
        expect(wizardFolderSlugs({ table_download_urls: 'not json' })).toEqual([]);
    });

    it('drops only the dead download entries', () => {
        const raw = JSON.stringify([{ format: 'wizard', url: DEAD_TREE }, { format: 'vps', url: 'https://vpuniverse.com/x' }]);
        expect(withoutRetiredDownloads(raw)).toEqual({ value: JSON.stringify([{ format: 'vps', url: 'https://vpuniverse.com/x' }]), changed: true });
        expect(withoutRetiredDownloads(JSON.stringify([{ url: DEAD_TREE }]))).toEqual({ value: null, changed: true });
        expect(withoutRetiredDownloads(JSON.stringify([{ url: LIVE_TREE }])).changed).toBe(false);
        expect(withoutRetiredDownloads(null)).toEqual({ value: null, changed: false });
    });
});

describe('GlobalGameService.merge — C14', () => {
    beforeEach(reset);

    it('moves My Tables and Global pins instead of deleting them with the old row', async () => {
        const db = await getDatabase();
        const target = await insertGame({ name: 'The Getaway: High Speed II', manufacturer: 'Williams', year: 1992, vps_id: 'vps-getaway', imported_from: 'vps' });
        const source = await insertGame(oldRow('Getaway - High Speed II, The', { manufacturer: 'Williams', year: 1992 }));
        await db.run(`INSERT INTO player_tables (user_id, global_game_id, platform) VALUES ('u1', ?, '')`, source);
        await db.run(`INSERT INTO player_tables (user_id, global_game_id, platform) VALUES ('u2', ?, '')`, source);
        await db.run(`INSERT INTO player_tables (user_id, global_game_id, platform) VALUES ('u2', ?, 'vpx')`, target);
        await db.run(`INSERT INTO global_game_pins (discord_user_id, global_game_id) VALUES ('u1', ?)`, source);
        await db.run(`INSERT INTO global_game_pins (discord_user_id, global_game_id) VALUES ('u3', ?)`, source);
        await db.run(`INSERT INTO global_game_pins (discord_user_id, global_game_id) VALUES ('u3', ?)`, target);

        await GlobalGameService.merge(target, source);

        const tables = await db.all<Array<{ user_id: string; platform: string }>>(
            `SELECT user_id, platform FROM player_tables WHERE global_game_id = ? ORDER BY user_id, platform`, target);
        // u1's generic row moved; u2's generic row met their engine row and went.
        expect(tables).toEqual([{ user_id: 'u1', platform: '' }, { user_id: 'u2', platform: 'vpx' }]);
        const pins = await db.all<Array<{ discord_user_id: string }>>(
            `SELECT discord_user_id FROM global_game_pins WHERE global_game_id = ? ORDER BY discord_user_id`, target);
        expect(pins.map(p => p.discord_user_id)).toEqual(['u1', 'u3']);
        expect((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM player_tables WHERE global_game_id = ?`, source))?.n).toBe(0);
    });

    it('re-points game reports and VPS table files, and drops the survivor\'s cached board', async () => {
        const db = await getDatabase();
        const target = await insertGame({ name: 'Medusa', manufacturer: 'Bally', year: 1981, vps_id: 'vps-medusa', imported_from: 'vps' });
        const source = await insertGame(oldRow('Medusa - JP', { manufacturer: 'Bally', year: 1981 }));
        await db.run(`INSERT INTO game_feedback (id, global_game_id, game_name, reporter_discord_id, field) VALUES ('f1', ?, 'Medusa - JP', 'u1', 'year')`, source);
        await db.run(`INSERT INTO global_game_tables (vps_table_id, global_game_id, vps_game_id) VALUES ('t1', ?, 'x')`, source);
        await db.run(`INSERT INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at) VALUES (?, 'global', '[]', datetime('now'))`, target);

        await GlobalGameService.merge(target, source);

        expect((await db.get<{ global_game_id: string }>(`SELECT global_game_id FROM game_feedback WHERE id = 'f1'`))?.global_game_id).toBe(target);
        expect((await db.get<{ global_game_id: string }>(`SELECT global_game_id FROM global_game_tables WHERE vps_table_id = 't1'`))?.global_game_id).toBe(target);
        expect(await db.get(`SELECT 1 FROM global_leaderboard_cache WHERE global_game_id = ?`, target)).toBeUndefined();
    });

    it('leaves a README-era row\'s file facts and dead links behind, keeps its name as an alias', async () => {
        const target = await insertGame({
            name: 'The Getaway: High Speed II', manufacturer: 'Williams', year: 1992, vps_id: 'vps-getaway', imported_from: 'wizard',
            external_url: CATALOG, features: ['vpxs', 'wizard_auto', 'fps_60'],
            table_download_urls: [{ format: 'wizard', url: LIVE_TREE }],
        });
        const source = await insertGame(oldRow('Getaway - High Speed II, The', {
            manufacturer: 'Williams', year: 1992, image_url: DEAD_RAW, features: ['wizard_manual', 'vpxs_manual', 'fps_45', 'vr'],
        }));

        await GlobalGameService.merge(target, source);

        const t = await row(target);
        expect(JSON.parse(t!.features).sort()).toEqual(['fps_60', 'vpxs', 'vr', 'wizard_auto']);
        expect(JSON.parse(t!.table_download_urls!)).toEqual([{ format: 'wizard', url: LIVE_TREE }]);
        expect(t!.external_url).toBe(CATALOG);
        expect(JSON.parse(t!.dedup_aliases!)).toEqual(['Getaway - High Speed II, The']);
    });

    it('never fills a gap with a dead link, and keeps AtGames eligibility for an unlisted survivor', async () => {
        const target = await insertGame({ name: 'Skateball', manufacturer: 'Bally', year: 1980, vps_id: 'vps-skate', imported_from: 'vps', features: [] });
        const source = await insertGame(oldRow('Skate Ball', { manufacturer: 'Bally', year: 1980, image_url: DEAD_RAW }));

        await GlobalGameService.merge(target, source);

        const t = await row(target);
        expect(t!.external_url).toBeNull();
        expect(t!.image_url).toBeNull();
        expect(t!.table_download_urls).toBeNull();
        expect(JSON.parse(t!.features)).toEqual(['has_dmd', 'vpxs_manual']);
    });

    it('still unions every feature when the absorbed row is not README-era', async () => {
        const target = await insertGame({ name: 'Cyclone', manufacturer: 'Williams', year: 1988, vps_id: 'vps-cyc', imported_from: 'vps', features: ['vr'] });
        const source = await insertGame({ name: 'Cyclone ', manufacturer: 'Williams', year: 1988, imported_from: 'opdb', features: ['fps_60', 'atgames'] });

        await GlobalGameService.merge(target, source);

        expect(JSON.parse((await row(target))!.features).sort()).toEqual(['atgames', 'fps_60', 'vr']);
    });
});

describe('Wizard reconcile owns the file facts on manifest rows', () => {
    beforeEach(reset);

    it('replaces stale fps / wizard_manual with the manifest\'s facts, keeps the rest', async () => {
        const id = await insertGame({
            name: 'The Getaway: High Speed II', vps_id: 'vps-getaway', imported_from: 'wizard',
            features: ['vpxs', 'vpxs_manual', 'wizard_manual', 'wizard_auto', 'fps_45', 'fps_60', 'has_dmd', 'vr', 'atgames'],
        });
        const { reconcileWizardPlatformTags } = await import('../services/WizardImportService.js');
        await reconcileWizardPlatformTags(new Map([[id, { auto: true, manual: false, fileFeatures: ['wizard_auto', 'fps_60', 'has_backglass'] }]]));

        expect(JSON.parse((await row(id))!.features).sort()).toEqual(['atgames', 'fps_60', 'has_backglass', 'has_dmd', 'vpxs', 'vr', 'wizard_auto']);
    });

    it('without file facts it reconciles only the vpxs pair, as before', async () => {
        const id = await insertGame({ name: 'X', features: ['vpxs_manual', 'fps_45'] });
        const { reconcileWizardPlatformTags } = await import('../services/WizardImportService.js');
        await reconcileWizardPlatformTags(new Map([[id, { auto: true, manual: false }]]));

        expect(JSON.parse((await row(id))!.features).sort()).toEqual(['fps_45', 'vpxs']);
    });
});

describe('migration 219 — dead external/ links', () => {
    beforeEach(reset);

    it('clears them from VPS rows, leaves README-era rows alone, and is idempotent', async () => {
        const { stripRetiredWizardLinks } = await import('../database/migrations/retiredWizardLinks.js');
        const db = await getDatabase();
        const vpsRow = await insertGame({
            name: 'Getaway', vps_id: 'vps-getaway', imported_from: 'vps', external_url: DEAD_TREE,
            table_download_urls: [{ format: 'wizard', url: DEAD_TREE }, { format: 'wizard', url: LIVE_TREE }],
        });
        const old = await insertGame(oldRow('Getaway, The'));

        expect(await stripRetiredWizardLinks(db)).toBe(1);
        const v = await row(vpsRow);
        expect(v!.external_url).toBeNull();
        expect(JSON.parse(v!.table_download_urls!)).toEqual([{ format: 'wizard', url: LIVE_TREE }]);
        expect((await row(old))!.external_url).toBe(DEAD_TREE);
        expect(await stripRetiredWizardLinks(db)).toBe(0);
    });
});

describe('WizardLegacyMergeService', () => {
    beforeEach(reset);

    it('pairs by Wizard folder first, then name (sort form), then maker + year', async () => {
        const db = await getDatabase();
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        const getaway = await insertGame({ name: 'The Getaway: High Speed II', manufacturer: 'Williams', year: 1992, vps_id: 'vps-getaway', imported_from: 'vps' });
        await db.run(`INSERT INTO wizard_table_slugs (slug, vps_id) VALUES ('vpx-getaway', 'vps-getaway')`);
        const addams = await insertGame({ name: 'The Addams Family', manufacturer: 'Bally', year: 1992, vps_id: 'vps-taf', imported_from: 'vps' });
        const skate = await insertGame({ name: 'Skateball', manufacturer: 'Bally', year: 1980, vps_id: 'vps-skate', imported_from: 'vps' });

        const oldGetaway = await insertGame(oldRow('Getaway, The - High Speed II', { manufacturer: 'Williams', year: 1992 }));
        const oldAddams = await insertGame(oldRow('Addams Family, The', {
            manufacturer: 'Bally', year: 1992,
            external_url: 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/external/vpx-taf',
        }));
        const oldSkate = await insertGame(oldRow('Skate Ball - JP', {
            manufacturer: 'Bally', year: 1980,
            external_url: 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/external/vpx-skate',
        }));
        const orphan = await insertGame(oldRow('Nothing Like It', {
            manufacturer: 'Nobody', year: 1999,
            external_url: 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/external/vpx-nothing',
        }));

        const { rows, summary } = await WizardLegacyMergeService.preview();
        const by = new Map(rows.map(r => [r.id, r]));

        expect(by.get(oldGetaway)!.suggestion).toMatchObject({ tier: 'folder', target: { id: getaway }, disagreements: [], conflict: null });
        expect(by.get(oldGetaway)!.folder).toBe('vpx-getaway');
        expect(by.get(oldGetaway)!.preselect).toBe(true);
        expect(by.get(oldAddams)!.suggestion).toMatchObject({ tier: 'name', target: { id: addams } });
        expect(by.get(oldAddams)!.preselect).toBe(true);
        // The weakest tier is suggested but never pre-ticked.
        expect(by.get(oldSkate)!.suggestion).toMatchObject({ tier: 'maker_year', target: { id: skate } });
        expect(by.get(oldSkate)!.preselect).toBe(false);
        expect(by.get(orphan)!.suggestion).toBeNull();
        expect(summary).toEqual({ total: 4, suggested: 3, preselected: 2, ambiguous: 0, none: 1 });
    });

    it('shows a maker/year disagreement and an ADR 0014 conflict, and pre-ticks neither', async () => {
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        await insertGame({ name: 'Metropolis', manufacturer: 'Maresa', year: 1982, vps_id: 'vps-metro', imported_from: 'vps' });
        await insertGame({ name: 'Night Rider', manufacturer: 'Bally', year: 1976, vps_id: 'vps-nr', imported_from: 'vps' });
        const metro = await insertGame(oldRow('Metropolis', { manufacturer: 'Original', year: 2022 }));
        const rider = await insertGame(oldRow('Night Rider', { manufacturer: 'Bally', year: 1977 }));

        const by = new Map((await WizardLegacyMergeService.preview()).rows.map(r => [r.id, r]));

        expect(by.get(metro)!.suggestion!.conflict).toMatch(/ADR 0014/);
        expect(by.get(metro)!.preselect).toBe(false);
        expect(by.get(rider)!.suggestion!.disagreements).toEqual(['year']);
        expect(by.get(rider)!.preselect).toBe(false);
    });

    it('lists the candidates when several rows fit equally well', async () => {
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        await insertGame({ name: 'Godzilla', manufacturer: 'Sega', year: 1998, vps_id: 'g1', imported_from: 'vps' });
        await insertGame({ name: 'Godzilla', manufacturer: 'Stern', year: 2021, vps_id: 'g2', imported_from: 'vps' });
        const old = await insertGame(oldRow('Godzilla', { manufacturer: null, year: null }));

        const plan = (await WizardLegacyMergeService.preview()).rows.find(r => r.id === old)!;
        expect(plan.suggestion).toBeNull();
        expect(plan.alternatives.map(a => a.vps_id).sort()).toEqual(['g1', 'g2']);
    });

    it('counts what each old row holds', async () => {
        const db = await getDatabase();
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        const old = await insertGame(oldRow('Terminator 3', { manufacturer: 'Stern', year: 2003 }));
        await db.run(`INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type) VALUES ('s1', ?, 'p1', 'A', 10, 'global')`, old);
        await db.run(`INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type) VALUES ('s2', ?, 'p1', 'A', 20, 'global')`, old);
        await db.run(`INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type) VALUES ('s3', ?, 'p2', 'B', 30, 'global')`, old);
        await db.run(`INSERT INTO player_tables (user_id, global_game_id, platform) VALUES ('u1', ?, '')`, old);

        const plan = (await WizardLegacyMergeService.preview()).rows.find(r => r.id === old)!;
        expect(plan.counts).toMatchObject({ globalScores: 3, globalPlayers: 2, myTables: 1, ratings: 0 });
    });

    it('merges ticked pairs, one transaction each, and refuses what is not an old row', async () => {
        const db = await getDatabase();
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        const target = await insertGame({ name: 'Medusa', manufacturer: 'Bally', year: 1981, vps_id: 'vps-medusa', imported_from: 'vps' });
        const old = await insertGame(oldRow('Medusa - JP', { manufacturer: 'Bally', year: 1981 }));
        const notOld = await insertGame({ name: 'Medusa (dup)', vps_id: 'other', imported_from: 'vps' });
        await db.run(`INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type) VALUES ('s1', ?, 'p1', 'A', 10, 'global')`, old);

        const result = await WizardLegacyMergeService.merge([
            { sourceId: old, targetId: target },
            { sourceId: notOld, targetId: target },
        ]);

        expect(result.merged).toEqual([{ sourceId: old, targetId: target, scoresMoved: 1 }]);
        expect(result.failed).toEqual([{ sourceId: notOld, targetId: target, error: 'Not an old README Wizard row' }]);
        expect(await db.get(`SELECT 1 FROM global_games WHERE id = ?`, old)).toBeUndefined();
        expect(await db.get(`SELECT 1 FROM global_games WHERE id = ?`, notOld)).toBeDefined();
    });

    it('refuses an unapproved or README-era survivor per pair', async () => {
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        const pending = await insertGame({ name: 'Pending Row', vps_id: 'p', imported_from: 'vps', status: 'pending' });
        const oldA = await insertGame(oldRow('Old A'));
        const oldB = await insertGame(oldRow('Old B'));
        const oldC = await insertGame(oldRow('Old C'));

        const result = await WizardLegacyMergeService.merge([
            { sourceId: oldA, targetId: pending },
            { sourceId: oldB, targetId: oldC },
        ]);
        expect(result.merged).toEqual([]);
        expect(result.failed.map(f => f.error)).toEqual(['The survivor is not approved', 'The survivor is itself an old README Wizard row']);
    });

    it('refuses a malformed batch before merging anything', async () => {
        const { WizardLegacyMergeService, OldWizardMergeError } = await import('../services/WizardLegacyMergeService.js');
        await expect(WizardLegacyMergeService.merge([])).rejects.toBeInstanceOf(OldWizardMergeError);
        await expect(WizardLegacyMergeService.merge([{ sourceId: 'a', targetId: 'a' }])).rejects.toThrow(/itself/);
        await expect(WizardLegacyMergeService.merge([{ sourceId: 'a', targetId: 'b' }, { sourceId: 'a', targetId: 'c' }])).rejects.toThrow(/twice/);
        await expect(WizardLegacyMergeService.merge([{ sourceId: 'a', targetId: 'b' }, { sourceId: 'b', targetId: 'c' }])).rejects.toThrow(/survivor/);
    });

    it('target search never offers a README-era row, VPS rows first', async () => {
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        await insertGame(oldRow('Getaway, The'));
        const opdbOnly = await insertGame({ name: 'Getaway (OPDB)', imported_from: 'opdb' });
        const vps = await insertGame({ name: 'The Getaway: High Speed II', vps_id: 'vps-getaway', imported_from: 'vps' });

        const hits = await WizardLegacyMergeService.searchTargets('getaway');
        expect(hits.map(h => h.id)).toEqual([vps, opdbOnly]);
    });
});
