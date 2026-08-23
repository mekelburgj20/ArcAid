import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as be from '../utils/themeIds.js';
// Deliberately reaches across the BE/FE boundary: this test exists precisely to
// prove the two copies have not drifted. Vitest resolves the .ts directly; the
// module is dependency-free so nothing browser-specific is pulled in.
import * as fe from '../../admin-ui/src/lib/themeIds';

/**
 * BE ↔ FE theme-identity parity (v2.133.0).
 *
 * Same contract, and the same reasoning, as `scoreProvenance-parity.test.ts`:
 * two copies of one table drift, and the drift is silent. Here the failure
 * mode is specific — the API's Zod enum would accept a theme the picker cannot
 * show (or reject one it can), and `LEGACY_THEME_MAP` diverging would send
 * migration 162 and the runtime shim to DIFFERENT survivors for the same
 * retired id, so a viewer's room would change theme every time the two
 * disagreed about which one it was.
 *
 * The text comparison is the strong one: the region below each file's header
 * must be byte-identical.
 */

const MARK_BEGIN = '// ─── MIRRORED REGION BEGINS';

function mirroredRegion(path: string): string {
    const text = readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
    const at = text.indexOf(MARK_BEGIN);
    expect(at, `${path}: mirrored-region marker missing`).toBeGreaterThan(-1);
    return text.slice(at);
}

describe('theme identity — BE/FE parity', () => {
    it('has a byte-identical mirrored region on both sides', () => {
        expect(mirroredRegion('../utils/themeIds.ts'))
            .toEqual(mirroredRegion('../../admin-ui/src/lib/themeIds.ts'));
    });

    it('exports exactly the same set of names', () => {
        expect(Object.keys(fe).sort()).toEqual(Object.keys(be).sort());
    });

    it('exports the same theme ids, in the same order', () => {
        expect([...fe.THEME_IDS]).toEqual([...be.THEME_IDS]);
    });

    it('exports the same legacy theme map', () => {
        expect(fe.LEGACY_THEME_MAP).toEqual(be.LEGACY_THEME_MAP);
    });

    it('behaves identically across every live id, retired id and garbage value', () => {
        const inputs: unknown[] = [
            ...be.THEME_IDS,
            ...Object.keys(be.LEGACY_THEME_MAP),
            '', ' ocean ', 'sepia', 'arcade', null, undefined, 7, {},
        ];
        for (const input of inputs) {
            expect(fe.normalizeThemeId(input), String(input)).toBe(be.normalizeThemeId(input));
            expect(fe.isThemeId(input), String(input)).toBe(be.isThemeId(input));
            expect(fe.normalizeThemeIdOr(input), String(input)).toBe(be.normalizeThemeIdOr(input));
        }
    });
});
