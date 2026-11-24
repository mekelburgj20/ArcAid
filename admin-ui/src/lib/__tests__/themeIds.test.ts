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
 * stylesheet defines and the page paints the default dark. v2.263.0 (G29)
 * retired five more (migration 220), leaving eleven themes.
 */

const CSS_PATH = [
    resolve(process.cwd(), 'src/index.css'),
    resolve(process.cwd(), 'admin-ui/src/index.css'),
].find(existsSync)!;

describe('THEME_IDS', () => {
    it('is the 11 shipped themes, in picker order, darks first and lights last', () => {
        expect([...THEME_IDS]).toEqual([
            'dark', 'synthwave', 'backglass', 'forest', 'nordic', 'graphite', 'retro', 'contrast',
            'light', 'paper', 'speegle',
        ]);
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
    it('maps the sixteen retired ids', () => {
        expect(Object.keys(LEGACY_THEME_MAP).sort()).toEqual([
            'arctic', 'cabinet', 'coffee', 'crt-green', 'cyberpunk', 'ember', 'invaders', 'marquee',
            'midnight', 'minimal', 'ocean', 'plasma', 'playfield', 'silverball', 'sunset', 'wizard',
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
        expect(normalizeThemeId('ocean')).toBe('dark');
        expect(normalizeThemeId('minimal')).toBe('graphite');
        expect(normalizeThemeId('sunset')).toBe('backglass');
        expect(normalizeThemeId('playfield')).toBe('forest');
        expect(normalizeThemeId('invaders')).toBe('forest');
        expect(normalizeThemeId('wizard')).toBe('synthwave');
        expect(normalizeThemeId('marquee')).toBe('dark');
        expect(normalizeThemeId('cabinet')).toBe('dark');
    });

    it('folds the five ids retired in v2.263.0 (G29) to their nearest survivor', () => {
        expect(normalizeThemeId('midnight')).toBe('dark');
        expect(normalizeThemeId('silverball')).toBe('graphite');
        expect(normalizeThemeId('plasma')).toBe('synthwave');
        expect(normalizeThemeId('ember')).toBe('backglass');
        expect(normalizeThemeId('arctic')).toBe('light');
    });

    it('never points one retired id at another (a fold is one step)', () => {
        for (const [legacy, replacement] of Object.entries(LEGACY_THEME_MAP)) {
            expect(LEGACY_THEME_MAP[replacement], `${legacy} -> ${replacement}`).toBeUndefined();
        }
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
        expect(normalizeThemeId(' ocean ')).toBe('dark');
        expect(normalizeThemeId(' arctic ')).toBe('light');
    });

    it('normalizeThemeIdOr supplies a fallback', () => {
        expect(normalizeThemeIdOr('sepia')).toBe('dark');
        expect(normalizeThemeIdOr('sepia', 'light')).toBe('light');
        expect(normalizeThemeIdOr('ocean', 'light')).toBe('dark');
        expect(normalizeThemeIdOr('plasma', 'light')).toBe('synthwave');
    });
});
