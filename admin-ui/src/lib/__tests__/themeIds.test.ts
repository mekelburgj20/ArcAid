import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_IDS, LEGACY_THEME_MAP, isThemeId, normalizeThemeId, normalizeThemeIdOr } from '../themeIds';

/**
 * v2.133.0 — the theme cull. Eleven ids were retired and their `.theme-*`
 * blocks deleted; anything still holding one (a localStorage mirror, a row
 * written before migration 162 ran, an old client POSTing) must land on a
 * theme that EXISTS. A miss is silent: `applyThemeClass` adds a class no
 * stylesheet defines and the page paints the default dark.
 */

const CSS_PATH = [
    resolve(process.cwd(), 'src/index.css'),
    resolve(process.cwd(), 'admin-ui/src/index.css'),
].find(existsSync)!;

describe('THEME_IDS', () => {
    it('is the 16 shipped themes, darks first and lights last', () => {
        expect(THEME_IDS).toHaveLength(16);
        expect(THEME_IDS[0]).toBe('dark');
        expect(THEME_IDS.slice(-4)).toEqual(['light', 'arctic', 'paper', 'speegle']);
    });

    it('has no duplicates', () => {
        expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    });

    it('names a `.theme-<id>` block in index.css for everything but `dark`', () => {
        const css = readFileSync(CSS_PATH, 'utf8');
        for (const id of THEME_IDS) {
            if (id === 'dark') continue; // the no-class default lives in @theme
            expect(css.includes(`.theme-${id} {`), `.theme-${id} block`).toBe(true);
        }
    });

    it('leaves no rule anywhere in index.css for a retired theme', () => {
        const css = readFileSync(CSS_PATH, 'utf8');
        for (const legacy of Object.keys(LEGACY_THEME_MAP)) {
            expect(css.includes(`theme-${legacy}`), `residual theme-${legacy} rule`).toBe(false);
        }
    });
});

describe('LEGACY_THEME_MAP', () => {
    it('maps the eleven retired ids', () => {
        expect(Object.keys(LEGACY_THEME_MAP).sort()).toEqual([
            'cabinet', 'coffee', 'crt-green', 'cyberpunk', 'invaders', 'marquee',
            'minimal', 'ocean', 'playfield', 'sunset', 'wizard',
        ]);
    });

    it('only ever points at a LIVE theme', () => {
        for (const [legacy, replacement] of Object.entries(LEGACY_THEME_MAP)) {
            expect(isThemeId(replacement), `${legacy} -> ${replacement}`).toBe(true);
        }
    });

    it('never names a live theme as a key (that would shadow it)', () => {
        for (const id of THEME_IDS) {
            expect(LEGACY_THEME_MAP[id], id).toBeUndefined();
        }
    });
});

describe('normalizeThemeId', () => {
    it('passes a live id through', () => {
        for (const id of THEME_IDS) expect(normalizeThemeId(id)).toBe(id);
    });

    it('folds every retired id forward', () => {
        expect(normalizeThemeId('coffee')).toBe('paper');
        expect(normalizeThemeId('crt-green')).toBe('retro');
        expect(normalizeThemeId('cyberpunk')).toBe('synthwave');
        expect(normalizeThemeId('ocean')).toBe('midnight');
        expect(normalizeThemeId('minimal')).toBe('graphite');
        expect(normalizeThemeId('sunset')).toBe('ember');
        expect(normalizeThemeId('playfield')).toBe('forest');
        expect(normalizeThemeId('invaders')).toBe('forest');
        expect(normalizeThemeId('wizard')).toBe('plasma');
        expect(normalizeThemeId('marquee')).toBe('dark');
        expect(normalizeThemeId('cabinet')).toBe('dark');
    });

    it('is idempotent — folding twice is folding once', () => {
        for (const legacy of Object.keys(LEGACY_THEME_MAP)) {
            const once = normalizeThemeId(legacy)!;
            expect(normalizeThemeId(once)).toBe(once);
        }
    });

    it('returns null for absent, unknown and non-string values', () => {
        expect(normalizeThemeId(null)).toBeNull();
        expect(normalizeThemeId(undefined)).toBeNull();
        expect(normalizeThemeId('')).toBeNull();
        expect(normalizeThemeId('sepia')).toBeNull();
        expect(normalizeThemeId(7)).toBeNull();
        expect(normalizeThemeId({})).toBeNull();
    });

    it('tolerates the stray whitespace a hand-edited localStorage value has', () => {
        expect(normalizeThemeId(' ocean ')).toBe('midnight');
    });

    it('normalizeThemeIdOr supplies a fallback', () => {
        expect(normalizeThemeIdOr('sepia')).toBe('dark');
        expect(normalizeThemeIdOr('sepia', 'light')).toBe('light');
        expect(normalizeThemeIdOr('ocean', 'light')).toBe('midnight');
    });
});
