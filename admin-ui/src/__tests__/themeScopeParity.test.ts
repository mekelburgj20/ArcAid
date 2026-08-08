import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * v2.86.0 — locks the generated `.sb-theme-scope` block in index.css.
 *
 * WHY IT EXISTS. Themes are plain class selectors that only set custom
 * properties, so a theme re-scopes cleanly onto a subtree — which is how the
 * room-admin Leaderboard renders the public scoreboard under the ROOM's
 * public_theme while the surrounding admin page keeps the admin's own theme.
 *
 * The default (dark) theme is the exception: it has no class, its values are
 * the `@theme` block emitted at `:root`, so a bare wrapper would inherit
 * whatever <html> is wearing. `.sb-theme-scope` restates those defaults so
 * "no theme class" means dark inside the wrapper too.
 *
 * WHAT BREAKS IT. Restating values means duplicating them, and duplication
 * drifts. Add a token to `@theme` and override it in one `.theme-*` class, and
 * `.sb-theme-scope` silently stops covering it — the admin mirror would then
 * show that ONE token in the admin's theme while everything around it is in the
 * room's. This test recomputes the block from the same two sources the
 * generator used and fails on any divergence, printing the corrected block.
 *
 * THE RULE. `.sb-theme-scope` declares exactly the custom properties that some
 * element-level `.theme-*` rule overrides, each with its `@theme` default
 * verbatim. Not a subset (gaps leak), not a superset (it must stay a pure
 * restatement of the defaults, so a `.theme-*` class on the same element can
 * win every property it names by source order alone).
 */

/** Vitest's cwd is the Vite project root (admin-ui); the second candidate
 *  covers a run launched from the repo root. */
const CSS_PATH = [
  resolve(process.cwd(), 'src/index.css'),
  resolve(process.cwd(), 'admin-ui/src/index.css'),
].find(existsSync)!;

/** Declarations, comments removed, from the outermost `{...}` of each rule. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    out.push({ selector: m[1]!.trim().split('\n').pop()!.trim(), body: m[2]! });
  }
  return out;
}

function declarations(body: string): Array<[string, string]> {
  return body
    .split(';')
    .map(d => d.trim())
    .filter(Boolean)
    .map(d => {
      const i = d.indexOf(':');
      return [d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' ')] as [string, string];
    })
    .filter(([p]) => p.length > 0);
}

/** A rule that targets a theme class directly (not a descendant of one). A
 *  descendant rule like `.theme-retro input` cannot be undone by a nested
 *  wrapper anyway, so it is out of scope for this reset by construction. */
function isElementLevelThemeRule(selector: string): boolean {
  if (!selector.includes('.theme-')) return false;
  return selector.split(',').every(s => /^\.theme-[a-z-]+$/.test(s.trim()));
}

function readCss(): string {
  return readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every custom property some theme class overrides — the reset surface. */
function overriddenTokens(css: string): string[] {
  const props = new Set<string>();
  for (const { selector, body } of rules(css)) {
    if (!isElementLevelThemeRule(selector)) continue;
    for (const [p] of declarations(body)) if (p.startsWith('--')) props.add(p);
  }
  return [...props].sort();
}

/** The dark defaults, i.e. the `@theme` block Tailwind emits at `:root`. */
function themeDefaults(css: string): Map<string, string> {
  const start = css.indexOf('@theme {');
  expect(start, '@theme block not found in index.css').toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = start + 7; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) { end = i; break; }
  }
  return new Map(declarations(css.slice(start + 8, end)).filter(([p]) => p.startsWith('--')));
}

function scopeBlock(css: string): Map<string, string> {
  const rule = rules(css).find(r => r.selector === '.sb-theme-scope');
  expect(rule, '.sb-theme-scope rule not found in index.css').toBeDefined();
  return new Map(declarations(rule!.body));
}

describe('.sb-theme-scope stays in parity with the @theme defaults', () => {
  const css = readCss();
  const required = overriddenTokens(css);
  const defaults = themeDefaults(css);
  const scope = scopeBlock(css);

  it('covers a non-empty reset surface (guards the parser itself)', () => {
    expect(required.length).toBeGreaterThan(20);
    expect(defaults.size).toBeGreaterThan(required.length);
  });

  it('declares exactly the tokens the theme classes override', () => {
    const declared = [...scope.keys()].filter(p => p.startsWith('--')).sort();
    const missing = required.filter(p => !scope.has(p));
    const extra = declared.filter(p => !required.includes(p));

    if (missing.length || extra.length) {
      console.error(
        'Regenerate the .sb-theme-scope custom properties in index.css as:\n' +
        required.map(p => `  ${p}: ${defaults.get(p) ?? '/* MISSING FROM @theme */'};`).join('\n'),
      );
    }
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('restates every value verbatim from @theme', () => {
    const drifted = required
      .filter(p => scope.has(p) && scope.get(p) !== defaults.get(p))
      .map(p => ({ token: p, scope: scope.get(p), theme: defaults.get(p) }));
    expect(drifted).toEqual([]);
  });

  it('resets the non-custom properties themes set on the element itself', () => {
    // `text-shadow` in particular is INHERITED, so an ambient theme's page-wide
    // glow would otherwise bleed into the scoped subtree.
    const nonCustom = new Set<string>();
    for (const { selector, body } of rules(css)) {
      if (!isElementLevelThemeRule(selector)) continue;
      for (const [p] of declarations(body)) if (!p.startsWith('--')) nonCustom.add(p);
    }
    for (const p of nonCustom) expect([...scope.keys()]).toContain(p);
  });

  it('is declared before every .theme-* class, so those win by source order', () => {
    // Equal specificity (both a single class), same element. The room's theme
    // class must therefore come LATER in the file to override this reset.
    const text = readFileSync(CSS_PATH, 'utf8');
    const scopeAt = text.indexOf('.sb-theme-scope {');
    expect(scopeAt).toBeGreaterThan(-1);
    for (const cls of ['.theme-light', '.theme-retro', '.theme-cyberpunk', '.theme-coffee', '.theme-minimal']) {
      expect(text.indexOf(`${cls} {`), `${cls} must come after .sb-theme-scope`).toBeGreaterThan(scopeAt);
    }
  });
});
