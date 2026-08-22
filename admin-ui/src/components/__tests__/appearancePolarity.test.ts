import { describe, it, expect } from 'vitest';
import { THEMES, THEME_POLARITY, resolveAppearance, type ThemeId } from '../ThemeProvider';

/**
 * v2.130.0 — `THEME_POLARITY` is what the appearance override consults to
 * decide whether a resolved theme already renders at the requested polarity.
 * A theme missing from it resolves to `undefined`, which silently means
 * "never matches" — every light theme would get flattened to `theme-light`
 * under appearance=light instead of keeping its own look. This is the lock.
 *
 * The values themselves are transcribed from `color-scheme` in
 * admin-ui/src/index.css; the second test pins the two light-polarity themes
 * by name so a future CSS edit that flips one has to come here too.
 */
describe('THEME_POLARITY', () => {
    it('classifies every theme in THEMES', () => {
        const themeIds = Object.keys(THEMES) as ThemeId[];
        const missing = themeIds.filter(id => THEME_POLARITY[id] === undefined);
        expect(missing).toEqual([]);
        // ...and carries no entries for themes that no longer exist.
        expect(Object.keys(THEME_POLARITY).sort()).toEqual(themeIds.sort());
    });

    it('marks exactly the two `color-scheme: light` themes as light', () => {
        const light = (Object.keys(THEME_POLARITY) as ThemeId[])
            .filter(id => THEME_POLARITY[id] === 'light')
            .sort();
        expect(light).toEqual(['coffee', 'light']);
    });

    it('keeps `minimal` dark despite the name', () => {
        // .theme-minimal is a dark monochrome theme (--color-deep oklch(14%)).
        expect(THEME_POLARITY.minimal).toBe('dark');
    });
});

describe('resolveAppearance', () => {
    it('auto never changes the resolved theme', () => {
        expect(resolveAppearance('ocean', 'auto')).toBe('ocean');
        expect(resolveAppearance('coffee', 'auto')).toBe('coffee');
        expect(resolveAppearance('dark', 'auto')).toBe('dark');
    });

    it('swaps a dark theme for `light` under appearance=light', () => {
        expect(resolveAppearance('ocean', 'light')).toBe('light');
        expect(resolveAppearance('dark', 'light')).toBe('light');
    });

    it('leaves a theme that already matches the requested polarity alone', () => {
        // A room on Coffee keeps ITS light theme rather than being flattened.
        expect(resolveAppearance('coffee', 'light')).toBe('coffee');
        expect(resolveAppearance('light', 'light')).toBe('light');
        expect(resolveAppearance('ocean', 'dark')).toBe('ocean');
    });

    it('swaps a light theme for `dark` under appearance=dark', () => {
        expect(resolveAppearance('coffee', 'dark')).toBe('dark');
        expect(resolveAppearance('light', 'dark')).toBe('dark');
    });
});
