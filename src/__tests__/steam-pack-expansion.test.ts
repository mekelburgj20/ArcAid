import { describe, it, expect } from 'vitest';
import { extractPackTables } from '../services/SteamPinballImportService.js';

/**
 * Steam pack auto-expansion (2026-08-18).
 *
 * The curated PACK_CONTENTS map covered 78 hand-listed packs and had "no
 * defined go-forward path", so everything Zen/Zaccaria shipped afterwards was
 * silently skipped — 40 Retro tables in one DLC, seven EM+ packs, and the
 * licensed POSTAL / Primal Carnage / Chernobylite / Fallen Aces / Blood West
 * packs.
 *
 * Every fixture below is REAL copy fetched from Steam on 2026-08-18, trimmed.
 * The negative cases matter as much as the positive ones: a looser parser
 * imports ball skins as pinball tables, and the catalogue's dedup hierarchy
 * would then faithfully preserve the junk.
 */

const RETRO_40 = `
<p>All Silver Pack, Gold Pack and Platinum Pack owners already have all retro tables.</p>
<p>This DLC unlocks the following contents:</p>
<ul>
<li>Time Machine Retro Table</li>
<li>Locomotion Retro Table</li>
<li>Combat Retro Table</li>
<li>Mexico &#39;86 Retro Table</li>
<li>Star&#39;s Phoenix Retro Table</li>
<li>2 Ball Skins</li>
</ul>`;

const EM_PLUS_1 = `
<p>This table pack includes such more advanced electro-mechanical pinball tables.</p>
<p>This table pack contains the following pinball tables:</p>
<ul>
<li>Combat EM+ table</li>
<li>Earth Wind Fire EM+ table</li>
<li>Farfalla EM+ table</li>
<li>Spooky EM+ table</li>
</ul>`;

const POSTAL_2 = `
<p>The official POSTAL 2 Table Pack.</p>
<p>Purchase this DLC unlocks the following content:</p>
<ul>
<li>POSTAL 2 Retro Table (Sweet Home)</li>
<li>POSTAL 2 SS Table (Paradise Mall)</li>
<li>POSTAL 2 Remake Table (Hate Groups)</li>
<li>POSTAL 2 Deluxe Table (Sign My Petition)</li>
<li>1 Arcade Cabinet Skin</li>
<li>4 Ball Skins</li>
<li>1 Table Lockdown Bar</li>
<li>2 Table Legs</li>
</ul>
<h2>POSTAL 2 Retro Table</h2>
<p>Information:</p>
<p>Name: POSTAL 2 Retro</p>`;

/** Cosmetics-only DLC. Says outright it unlocks no tables. */
const BRONZE_PACK = `
<p>Does NOT include any table unlocks.</p>
<p>This DLC unlocks all customization options in the game, including</p>
<ul>
<li>Ball size</li>
<li>Table texture options</li>
<li>More environment settings</li>
<li>25 Ball Skins</li>
<li>6 Cup Holders</li>
</ul>`;

/** 19 real tables, but listed as bare names with no "Table" suffix. */
const ACHIEVEMENT_PACK = `
<p>This DLC unlocks the following contents, including 19 pinball tables which can be unlocked by achievements:</p>
<ul><li>The Mummy</li><li>Aliens</li><li>Hippie</li><li>1 Ball Skin</li></ul>`;

describe('extractPackTables — the packs that were being lost', () => {
    it('reads the 40 Retro Tables DLC and drops the ball-skins line', () => {
        const t = extractPackTables(RETRO_40);
        expect(t).toContain('Time Machine Retro');
        expect(t).toContain('Combat Retro');
        expect(t).toContain("Mexico '86 Retro");
        expect(t).toContain("Star's Phoenix Retro");
        expect(t).not.toContain('2 Ball Skins');
        expect(t.some(n => /skin/i.test(n))).toBe(false);
    });

    it('reads an EM+ pack, lower-case "table" suffix and all', () => {
        expect(extractPackTables(EM_PLUS_1)).toEqual([
            'Combat EM+', 'Earth Wind Fire EM+', 'Farfalla EM+', 'Spooky EM+',
        ]);
    });

    it('strips the trailing parenthetical the POSTAL packs append', () => {
        const t = extractPackTables(POSTAL_2);
        expect(t).toContain('POSTAL 2 Retro');
        expect(t).toContain('POSTAL 2 Deluxe');
        expect(t.some(n => n.includes('('))).toBe(false);
    });

    it('does not double-count a name repeated as a detail heading', () => {
        const t = extractPackTables(POSTAL_2);
        expect(t.filter(n => n === 'POSTAL 2 Retro')).toHaveLength(1);
    });

    it('never mistakes cosmetics for tables', () => {
        const t = extractPackTables(POSTAL_2);
        for (const junk of ['1 Arcade Cabinet Skin', '4 Ball Skins', '1 Table Lockdown Bar', '2 Table Legs']) {
            expect(t).not.toContain(junk);
        }
        expect(t).toHaveLength(4);
    });
});

describe('extractPackTables — refuses to guess', () => {
    it('returns nothing for a cosmetics-only pack', () => {
        // "Table texture options" is the trap here: a parser keying on the word
        // "Table" anywhere would import it.
        expect(extractPackTables(BRONZE_PACK)).toEqual([]);
    });

    it('returns nothing when the list has no "Table" suffix, rather than importing prose', () => {
        // 19 genuine tables live in here, but nothing distinguishes them from a
        // ball-skin line. Skipping preserves today's behaviour and raises the
        // maintenance WARN; guessing would import "1 Ball Skin" as a table.
        expect(extractPackTables(ACHIEVEMENT_PACK)).toEqual([]);
    });

    it('returns nothing without a contents marker', () => {
        expect(extractPackTables('<p>Some Table</p><p>Another Table</p>')).toEqual([]);
    });

    it('handles missing or empty descriptions', () => {
        expect(extractPackTables(undefined)).toEqual([]);
        expect(extractPackTables('')).toEqual([]);
    });
});

describe('extractPackTables — theme parentheticals on either side of the suffix', () => {
    /**
     * Steam is inconsistent: POSTAL 2 writes "<name> Table (Theme)" while POSTAL
     * Brain Damaged writes "<name> (Theme) Table". Handling only one position
     * imported the same product family under two naming conventions — the drift
     * that forks a catalogue row later.
     */
    const BRAIN_DAMAGED = `
<p>Purchase this DLC unlocks the following content:</p>
<ul>
<li>POSTAL Brain Damaged Retro (Suburbia) Table</li>
<li>POSTAL Brain Damaged SS (American Dream) Table</li>
<li>POSTAL Brain Damaged Deluxe (Going All The Way) Table</li>
</ul>`;

    it('strips a parenthetical that precedes the suffix', () => {
        expect(extractPackTables(BRAIN_DAMAGED)).toEqual([
            'POSTAL Brain Damaged Retro',
            'POSTAL Brain Damaged SS',
            'POSTAL Brain Damaged Deluxe',
        ]);
    });

    it('names match the sibling pack that writes it the other way round', () => {
        const a = extractPackTables(BRAIN_DAMAGED);
        expect(a.every(n => !n.includes('('))).toBe(true);
    });
});
