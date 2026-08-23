import { describe, it, expect } from 'vitest';
import { THEMES, THEME_POLARITY, resolveAppearance } from '../ThemeProvider';
import { THEME_IDS, type ThemeId } from '../../lib/themeIds';

/**
 * v2.130.0 — `THEME_POLARITY` is what the appearance override consults to
 * decide whether a resolved theme already renders at the requested polarity.
 * A theme missing from it resolves to `undefined`, which silently means
 * "never matches" — every light theme would get flattened to `theme-light`
 * under appearance=light instead of keeping its own look. This is the lock.
 *
 * The values themselves are transcribed from `color-scheme` in
 * admin-ui/src/index.css; the second test pins the light-polarity themes by
 * name so a future CSS edit that flips one has to come here too.
 */
describe('THEME_POLARITY', () => {
    it('classifies every theme in THEMES', () => {
        const themeIds = Object.keys(THEMES) as ThemeId[];
        const missing = themeIds.filter(id => THEME_POLARITY[id] === undefined);
        expect(missing).toEqual([]);
        // ...and carries no entries for themes that no longer exist.
        expect(Object.keys(THEME_POLARITY).sort()).toEqual([...themeIds].sort());
    });

    it('marks exactly the four `color-scheme: light` themes as light', () => {
        const light = (Object.keys(THEME_POLARITY) as ThemeId[])
            .filter(id => THEME_POLARITY[id] === 'light')
            .sort();
        expect(light).toEqual(['arctic', 'light', 'paper', 'speegle']);
    });

    it('keeps the pale-SOUNDING dark themes dark', () => {
        // graphite is a neutral CHARCOAL (--color-deep oklch(18%)), silverball
        // is gunmetal, contrast is pure black. All three read "bright" or
        // "neutral" in the name and are dark-surfaced in the stylesheet.
        expect(THEME_POLARITY.graphite).toBe('dark');
        expect(THEME_POLARITY.silverball).toBe('dark');
        expect(THEME_POLARITY.contrast).toBe('dark');
    });
});

/**
 * v2.133.0 — the picker and the id list are two views of ONE set (the class
 * stripper is a third, derived from `THEME_IDS` inside ThemeProvider so it
 * cannot drift). Before this release all three were hand-written literals and
 * the class list HAD drifted from the picker.
 */
describe('the theme set is one set', () => {
    it('THEMES is keyed by THEME_IDS, in THEME_IDS order', () => {
        expect(Object.keys(THEMES)).toEqual([...THEME_IDS]);
    });

    it('gives every theme a label and a description of what it renders', () => {
        for (const [id, { label, description }] of Object.entries(THEMES)) {
            expect(label.length, `${id} label`).toBeGreaterThan(0);
            expect(label.length, `${id} label`).toBeLessThanOrEqual(20);
            expect(description.length, `${id} description`).toBeGreaterThan(0);
            // The picker renders `label — description` in one <option>; the
            // old set had descriptions long enough to truncate in the select.
            expect(description.length, `${id} description`).toBeLessThanOrEqual(60);
        }
    });
});

describe('resolveAppearance', () => {
    it('auto never changes the resolved theme', () => {
        expect(resolveAppearance('midnight', 'auto')).toBe('midnight');
        expect(resolveAppearance('paper', 'auto')).toBe('paper');
        expect(resolveAppearance('dark', 'auto')).toBe('dark');
    });

    it('swaps a dark theme for `light` under appearance=light', () => {
        expect(resolveAppearance('midnight', 'light')).toBe('light');
        expect(resolveAppearance('dark', 'light')).toBe('light');
    });

    it('leaves a theme that already matches the requested polarity alone', () => {
        // A room on Paper keeps ITS light theme rather than being flattened.
        expect(resolveAppearance('paper', 'light')).toBe('paper');
        expect(resolveAppearance('arctic', 'light')).toBe('arctic');
        expect(resolveAppearance('light', 'light')).toBe('light');
        expect(resolveAppearance('midnight', 'dark')).toBe('midnight');
    });

    it('swaps a light theme for `dark` under appearance=dark', () => {
        expect(resolveAppearance('paper', 'dark')).toBe('dark');
        expect(resolveAppearance('arctic', 'dark')).toBe('dark');
        expect(resolveAppearance('light', 'dark')).toBe('dark');
    });
});
