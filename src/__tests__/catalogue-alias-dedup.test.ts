import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

/**
 * Aliases-aware dedup + the exactly-one-candidate guard.
 *
 * These two ship together on purpose. Aliases WIDEN the set of names that can
 * match an existing row; the guard NARROWS what a tag-only importer is allowed
 * to do with a match. Widening without the guard makes mis-attachment more
 * likely, not less — this catalogue already has 362 normalized names shared by
 * two or more rows.
 *
 * Dedup reads `dedup_aliases`, NOT `aliases`. A dry run against production
 * proved why: `aliases` is a search/synonym field holding community acronyms,
 * several attached to the wrong row ("TZ" on "Tropical EM+" while Twilight
 * Zone exists separately). `dedup_aliases` is written only by `merge`, so
 * every entry means an admin decided two rows were the same game.
 *
 * The invariant that matters most, and the one most likely to be broken later:
 * **the alias lookup is a FALLBACK, never an addition.** It runs only when the
 * normalized-name walk found nothing. If it ever contributes candidates to a
 * non-empty set it could change which row an existing import resolves to, and
 * no existing import is allowed to move.
 */

async function insertGame(fields: {
    name: string;
    type?: string;
    manufacturer?: string | null;
    year?: number | null;
    dedupAliases?: string[];
    opdb_id?: string | null;
    platforms?: string[];
}): Promise<string> {
    const db = await getDatabase();
    const id = `test-${Math.abs(hash(fields.name + (fields.manufacturer ?? '')))}`;
    const { normalizeGameName } = await import('../utils/catalogueUtils.js');
    await db.run(
        `INSERT INTO global_games (id, name, normalized_name, type, manufacturer, year, dedup_aliases, opdb_id, platforms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
        id,
        fields.name,
        normalizeGameName(fields.name),
        fields.type ?? 'pinball',
        fields.manufacturer ?? null,
        fields.year ?? null,
        fields.dedupAliases ? JSON.stringify(fields.dedupAliases) : null,
        fields.opdb_id ?? null,
        JSON.stringify(fields.platforms ?? []),
    );
    return id;
}

function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

describe('findByAlias', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('finds a row by an alternate spelling the normalizer cannot bridge', async () => {
        // The real case: normalizeGameName strips punctuation and articles but
        // does NOT collapse internal spaces, so these never met.
        await insertGame({ name: 'Junk Yard', manufacturer: 'Williams', year: 1996, dedupAliases: ['JunkYard'] });

        const hits = await GlobalGameService.findByAlias('JunkYard');

        expect(hits.map(h => h.name)).toEqual(['Junk Yard']);
    });

    it('matches aliases through the normalizer, not by raw string', async () => {
        await insertGame({ name: 'TX-Sector', dedupAliases: ['TX Sector'] });

        // Punctuation differs from the stored alias; normalizeGameName folds it.
        expect((await GlobalGameService.findByAlias('TX  Sector')).map(h => h.name)).toEqual(['TX-Sector']);
    });

    it('returns nothing for rows with no aliases, an empty array, or junk JSON', async () => {
        await insertGame({ name: 'No Aliases' });
        const db = await getDatabase();
        await db.run(`UPDATE global_games SET dedup_aliases = '[]' WHERE name = 'No Aliases'`);
        expect(await GlobalGameService.findByAlias('No Aliases')).toEqual([]);

        await db.run(`UPDATE global_games SET dedup_aliases = 'not json' WHERE name = 'No Aliases'`);
        expect(await GlobalGameService.findByAlias('No Aliases')).toEqual([]);
    });

    it('ignores non-string entries inside the aliases array', async () => {
        await insertGame({ name: 'Weird' });
        const db = await getDatabase();
        await db.run(`UPDATE global_games SET dedup_aliases = '[123, null, {"a":1}]' WHERE name = 'Weird'`);
        expect(await GlobalGameService.findByAlias('Weird')).toEqual([]);
    });
});

describe('alias fallback inside the dedup walk', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('lands an alternate-spelling import on the existing row instead of forking it', async () => {
        await insertGame({ name: 'Black Belt', manufacturer: 'Zaccaria', year: 1986, dedupAliases: ['Blackbelt'] });

        const result = await GlobalGameService.upsert({
            name: 'Blackbelt',
            type: 'pinball',
            platforms: ['atgames_native'],
            features: ['atgames'],
            status: 'approved',
        });

        expect(result.action).toBe('updated');
        const db = await getDatabase();
        const rows = await db.all(`SELECT name, platforms FROM global_games`);
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].platforms)).toContain('atgames_native');
    });

    it('does NOT consult aliases when the name already matched something', async () => {
        // The invariant. `Decoy` matches by NAME; `Real` only by alias. If the
        // alias hit were ADDED to the candidate set rather than used as a
        // fallback, the richer `Real` row could outrank the name match and the
        // import would move — silently changing behaviour for existing
        // importers.
        await insertGame({ name: 'Sonic Wave', manufacturer: null, year: null });
        await insertGame({ name: 'Something Else', manufacturer: 'Bally', year: 1979, opdb_id: 'G-rich', dedupAliases: ['Sonic Wave'] });

        await GlobalGameService.upsert({ name: 'Sonic Wave', type: 'pinball', platforms: ['vpx'] });

        const db = await getDatabase();
        const decoy = await db.get(`SELECT platforms FROM global_games WHERE name = 'Sonic Wave'`);
        const aliased = await db.get(`SELECT platforms FROM global_games WHERE name = 'Something Else'`);
        expect(JSON.parse(decoy.platforms)).toContain('vpx');
        expect(JSON.parse(aliased.platforms)).not.toContain('vpx');
    });

    it('never bridges types on an alias', async () => {
        await insertGame({ name: 'Tron', type: 'video_game', dedupAliases: ['TRON Legacy'] });

        const result = await GlobalGameService.upsert({ name: 'TRON Legacy', type: 'pinball' });

        // A pinball import must not land on a video_game row just because it
        // shares an alias — the cross-type guard applies here too.
        expect(result.action).toBe('inserted');
    });

    it('still inserts when no name and no alias matches', async () => {
        await insertGame({ name: 'Unrelated', dedupAliases: ['Also Unrelated'] });
        const result = await GlobalGameService.upsert({ name: 'Brand New Table', type: 'pinball' });
        expect(result.action).toBe('inserted');
    });
});

describe('resolveForTagging — the exactly-one-candidate guard', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('returns the single match when the name is unambiguous', async () => {
        await insertGame({ name: 'Ikari Warriors', type: 'video_game' });

        const r = await GlobalGameService.resolveForTagging({ name: 'Ikari Warriors', type: 'video_game' });

        expect(r.match?.name).toBe('Ikari Warriors');
        expect(r.ambiguous).toBe(false);
    });

    it('REFUSES to choose between same-named rows', async () => {
        // The real hazard. AtGames supplies a bare name with no manufacturer,
        // year or external id; this catalogue has `circus` six times over.
        await insertGame({ name: 'Circus', manufacturer: 'Bally', year: 1973 });
        await insertGame({ name: 'Circus', manufacturer: 'Brunswick', year: 1980 });

        const r = await GlobalGameService.resolveForTagging({ name: 'Circus', type: 'pinball' });

        expect(r.match).toBeNull();
        expect(r.ambiguous).toBe(true);
        expect(r.candidates).toHaveLength(2);
    });

    it('reports no match and no ambiguity when nothing matches', async () => {
        const r = await GlobalGameService.resolveForTagging({ name: 'Nothing Here', type: 'pinball' });
        expect(r.match).toBeNull();
        expect(r.ambiguous).toBe(false);
        expect(r.candidates).toEqual([]);
    });

    it('uses the alias fallback, and still refuses when the alias is ambiguous', async () => {
        await insertGame({ name: 'Solo Row', dedupAliases: ['Alt Spelling'] });
        expect((await GlobalGameService.resolveForTagging({ name: 'Alt Spelling', type: 'pinball' })).match?.name)
            .toBe('Solo Row');

        await insertGame({ name: 'Second Row', dedupAliases: ['Alt Spelling'] });
        const r = await GlobalGameService.resolveForTagging({ name: 'Alt Spelling', type: 'pinball' });
        expect(r.match).toBeNull();
        expect(r.ambiguous).toBe(true);
    });

    it('keeps a name match in preference to an alias match, and stays unambiguous', async () => {
        await insertGame({ name: 'Exact Name' });
        await insertGame({ name: 'Other Row', dedupAliases: ['Exact Name'] });

        const r = await GlobalGameService.resolveForTagging({ name: 'Exact Name', type: 'pinball' });

        expect(r.match?.name).toBe('Exact Name');
        expect(r.ambiguous).toBe(false);
    });
});

describe('merge records the source name as an alias', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('adds the merged-away spelling so the next import cannot re-fork it', async () => {
        const target = await insertGame({ name: 'Junk Yard', manufacturer: 'Williams', year: 1996 });
        const source = await insertGame({ name: 'JunkYard', platforms: ['atgames_native'] });

        await GlobalGameService.merge(target, source);

        const db = await getDatabase();
        const row = await db.get(`SELECT dedup_aliases FROM global_games WHERE id = ?`, target);
        expect(JSON.parse(row.dedup_aliases)).toContain('JunkYard');

        // ...and the whole point: re-importing under the old spelling now
        // UPDATES rather than INSERTS.
        const again = await GlobalGameService.upsert({ name: 'JunkYard', type: 'pinball', features: ['atgames'] });
        expect(again.action).toBe('updated');
        expect(again.id).toBe(target);
    });

    it('does not record an alias that normalizes to the survivor name', async () => {
        // "Blackbelt 2018 - Remake" normalizes to the same key as "Blackbelt
        // 2018" (EDITION_SUFFIXES strips "Remake"), so recording it would be
        // dead weight — findByAlias only runs after the name walk came up
        // empty, which cannot happen for a name that already matches.
        const target = await insertGame({ name: 'Blackbelt 2018' });
        const source = await insertGame({ name: 'Blackbelt 2018 - Remake' });

        await GlobalGameService.merge(target, source);

        const db = await getDatabase();
        const row = await db.get(`SELECT dedup_aliases FROM global_games WHERE id = ?`, target);
        expect(row.dedup_aliases == null || JSON.parse(row.dedup_aliases).length === 0).toBe(true);
    });

    it('appends without dropping aliases the survivor already had', async () => {
        const target = await insertGame({ name: 'Wipe Out', dedupAliases: ['WipeOut Deluxe'] });
        const source = await insertGame({ name: 'Wipeout' });

        await GlobalGameService.merge(target, source);

        const db = await getDatabase();
        const aliases = JSON.parse((await db.get(`SELECT dedup_aliases FROM global_games WHERE id = ?`, target)).dedup_aliases);
        expect(aliases).toContain('WipeOut Deluxe');
        expect(aliases).toContain('Wipeout');
    });

    it('is idempotent — re-merging the same spelling does not duplicate it', async () => {
        const target = await insertGame({ name: 'TX-Sector' });
        const first = await insertGame({ name: 'TX Sector' });
        await GlobalGameService.merge(target, first);

        const second = await insertGame({ name: 'TX Sector', manufacturer: 'Gottlieb' });
        await GlobalGameService.merge(target, second);

        const db = await getDatabase();
        const aliases = JSON.parse((await db.get(`SELECT dedup_aliases FROM global_games WHERE id = ?`, target)).dedup_aliases);
        expect(aliases.filter((a: string) => a === 'TX Sector')).toHaveLength(1);
    });
});
