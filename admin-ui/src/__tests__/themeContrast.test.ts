import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_IDS } from '../lib/themeIds';

/**
 * G29 (v2.263.0): the contrast bar, as a test. It runs the same `auditCss`
 * as `node admin-ui/scripts/contrastAudit.cjs`, so the script and the suite
 * cannot disagree: in every theme, primary and muted clear 4.5:1 on deep,
 * surface and raised, and faint plus every accent used as text (the seven
 * neon tokens, lead and second) clear 4.5:1 on deep and surface.
 */

/** Vitest's cwd is the Vite project root (admin-ui); the second candidate
 *  covers a run launched from the repo root. */
const ROOT = [process.cwd(), resolve(process.cwd(), 'admin-ui')]
    .find(dir => existsSync(resolve(dir, 'scripts/contrastAudit.cjs')))!;

type Row = { token: string; raw?: string; value?: string; fail: boolean; ratios: Record<string, number> };
type Audit = {
    themes: Array<{ name: string; own: Record<string, string>; rows: Row[] }>;
    failures: Array<Row & { theme: string }>;
};

type FloorRow = {
    theme: string; scheme: string; cap: number; allowed: number; declared?: number; hidden: boolean;
    worst: { ratio: number; text: string; paint: string } | null; fail: boolean;
};

const requireFromRoot = createRequire(resolve(ROOT, 'package.json'));
const { auditCss, floorAudit } = requireFromRoot('./scripts/contrastAudit.cjs') as {
    auditCss: (css: string) => Audit;
    floorAudit: (css: string) => { rows: FloorRow[]; failures: FloorRow[] };
};
const css = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');
const result = auditCss(css);

describe('theme contrast', () => {
    it('audits exactly the shipped themes', () => {
        const names = result.themes.map(t => t.name).sort();
        const expected = THEME_IDS.map(id => (id === 'dark' ? 'dark (default)' : `theme-${id}`)).sort();
        expect(names).toEqual(expected);
    });

    it('clears 4.5:1 for every text token and every accent used as text, in every theme', () => {
        const misses = result.failures.map(f =>
            `${f.theme} ${f.token} = ${f.value ?? '(unset)'} (deep ${f.ratios['--color-deep']?.toFixed(2)}, surface ${f.ratios['--color-surface']?.toFixed(2)})`,
        );
        expect(misses).toEqual([]);
    });

    it('clears 4.5:1 for the lead and danger ink on a 10% fill of itself, in every theme', () => {
        for (const theme of result.themes) {
            for (const label of ['lead', 'danger']) {
                const row = theme.rows.find(r => r.token === `button:${label}`);
                expect(row, `${theme.name} button:${label} is audited`).toBeDefined();
                for (const bg of ['--color-deep', '--color-surface']) {
                    expect(row!.ratios[bg], `${theme.name} ${label} ink on ${bg}`).toBeGreaterThanOrEqual(4.5);
                }
            }
        }
    });

    it('has every theme name its own lead and second, as one of its accents', () => {
        for (const theme of result.themes) {
            for (const token of ['--color-lead', '--color-second']) {
                // Declared in the block itself: a theme that left them out
                // would take the default's roles.
                expect(theme.own[token], `${theme.name} ${token}`).toMatch(/^var\(--color-neon-[a-z]+\)$/);
                const row = theme.rows.find(r => r.token === token)!;
                expect(row.value, `${theme.name} ${token} resolves`).not.toMatch(/^var\(/);
            }
        }
    });
});

/**
 * G29 (v2.264.0): the carpet floor behind themed pages is only as strong as
 * each palette allows. `floorAudit` recomputes the allowed opacity from the
 * theme blocks (so a retuned palette is judged as it now is) and compares it
 * with the "Carpet floor" block's declared one.
 */
describe('carpet floor contrast', () => {
    const floor = floorAudit(css);

    it('judges every shipped theme', () => {
        expect(floor.rows.map(r => r.theme).sort()).toEqual(result.themes.map(t => t.name).sort());
    });

    it('declares no floor stronger than its palette allows', () => {
        const misses = floor.failures.map(f => `${f.theme}: declared ${f.declared ?? '(none)'}%, allowed ${f.allowed}%`);
        expect(misses).toEqual([]);
        for (const row of floor.rows) {
            if (row.hidden) continue;
            expect(row.worst!.ratio, `${row.theme} worst text on the floor`).toBeGreaterThanOrEqual(4.5);
            expect(row.declared!, `${row.theme} cap`).toBeLessThanOrEqual(row.cap);
        }
    });

    it('caps a light theme at 12% and a dark one at 16%', () => {
        for (const row of floor.rows) expect(row.cap, row.theme).toBe(row.scheme === 'light' ? 12 : 16);
        expect(floor.rows.filter(r => r.scheme === 'light').map(r => r.theme).sort())
            .toEqual(['theme-light', 'theme-paper', 'theme-speegle']);
    });

    it('never shows the floor under High contrast', () => {
        expect(floor.rows.find(r => r.theme === 'theme-contrast')?.hidden).toBe(true);
    });

    it('fails a declaration stronger than allowed', () => {
        const stronger = css.replace(/^(\.carpet-floor\s*\{[^}]*?opacity:\s*)[\d.]+/m, (_m, head: string) => `${head}0.5`);
        expect(stronger).not.toBe(css);
        expect(floorAudit(stronger).failures.map(f => f.theme)).toContain('dark (default)');
    });
});
