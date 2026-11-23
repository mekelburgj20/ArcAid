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

const requireFromRoot = createRequire(resolve(ROOT, 'package.json'));
const { auditCss } = requireFromRoot('./scripts/contrastAudit.cjs') as { auditCss: (css: string) => Audit };
const result = auditCss(readFileSync(resolve(ROOT, 'src/index.css'), 'utf8'));

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
