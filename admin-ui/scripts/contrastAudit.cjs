#!/usr/bin/env node
/*
 * Theme contrast audit (v2.131.2; the accent text bar since v2.263.0, G29).
 *
 * Parses every theme block in src/index.css (the `@theme` default plus every
 * `.theme-*` class that sets `--color-deep`) and computes the WCAG 2.x
 * contrast ratio of the text and accent tokens against the background tokens.
 *
 * The bar, in every theme:
 *   - primary and muted clear 4.5:1 on deep, surface and raised;
 *   - faint clears 4.5:1 on deep and surface (it carries real content);
 *   - every accent that is used as TEXT (the seven neon tokens, lead and
 *     second) clears 4.5:1 on deep and surface. A `var()` value is resolved
 *     inside its theme, so `--color-lead: var(--color-neon-magenta)` is judged
 *     as that theme's magenta.
 *   - the button ink (lead and coral, each pulled 20% toward `--color-primary`
 *     in oklab, as `ink-lead` / `ink-danger` do) clears 4.5:1 on a 10% fill
 *     of its own colour over deep and surface.
 * The script exits 1 when anything misses. `src/__tests__/themeContrast.test.ts`
 * runs the same `auditCss` and fails on the same misses.
 *
 * No dependencies: oklch -> Oklab -> linear sRGB -> sRGB is done inline.
 *
 * Usage:  node admin-ui/scripts/contrastAudit.cjs [--all]
 *   (default prints the text tokens; --all adds the accent rows. Either way
 *   every token is checked and counted.)
 */

const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', 'src', 'index.css');

// ── colour math ────────────────────────────────────────────────────────────

function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return [lr, lg, lb].map(clampLinear);
}

function clampLinear(v) {
  return Math.min(1, Math.max(0, v));
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Parse a CSS colour value we care about -> [r,g,b] in 0..1 sRGB, or null. */
function parseColor(value) {
  const v = value.trim();
  let m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(v);
  if (m) {
    const [, L, C, h] = m;
    return oklchToRgb(parseFloat(L) / 100, parseFloat(C), parseFloat(h)).map(linearToSrgb);
  }
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) {
    return m[1].split('').map((c) => parseInt(c + c, 16) / 255);
  }
  return null;
}

function relLuminance(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB (0..1, gamma-encoded) -> Oklab. */
function srgbToOklab(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Oklab -> sRGB (0..1, gamma-encoded, clamped). */
function oklabToSrgb([L, a, b]) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => linearToSrgb(clampLinear(v)));
}

/** `color-mix(in oklab, from (1-t), to t)`. */
function mixOklab(from, to, t) {
  const a = srgbToOklab(from);
  const b = srgbToOklab(to);
  return oklabToSrgb(a.map((v, i) => v * (1 - t) + b[i] * t));
}

/** A fill of `alpha` over a background: alpha compositing on the encoded channels. */
function overlay(fg, bg, alpha) {
  return fg.map((v, i) => alpha * v + (1 - alpha) * bg[i]);
}

// ── CSS parsing ────────────────────────────────────────────────────────────

/** Pull `--token: value;` declarations out of the block that starts at `idx`. */
function readBlock(src, idx) {
  const open = src.indexOf('{', idx);
  if (open < 0) return {};
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}

/**
 * The default (`@theme`) plus every `.theme-x {` block that is a bare
 * single-class selector at line start and sets `--color-deep`. `own` is what
 * the block itself declares; `tokens` adds what it inherits from the default.
 */
function parseThemes(src) {
  const themes = [];
  const themeIdx = src.search(/^@theme\s*\{/m);
  if (themeIdx < 0) throw new Error('no @theme block found');
  const defaults = readBlock(src, themeIdx);
  themes.push({ name: 'dark (default)', own: defaults, tokens: defaults });

  const classRe = /^\.(theme-[a-z-]+)\s*\{/gm;
  let cm;
  const seen = new Set();
  while ((cm = classRe.exec(src))) {
    const name = cm[1];
    const own = readBlock(src, cm.index);
    if (!own['--color-deep']) continue; // helper blocks (scanlines, inputs, glows)
    if (seen.has(name)) continue;
    seen.add(name);
    themes.push({ name, own, tokens: { ...defaults, ...own } });
  }
  return themes;
}

/** Follow `var(--x)` inside one theme's tokens to a literal value. */
function resolveValue(tokens, value, depth = 0) {
  if (typeof value !== 'string') return undefined;
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value.trim());
  if (!m) return value;
  if (depth > 8) return undefined;
  return resolveValue(tokens, tokens[m[1]], depth + 1);
}

// ── the audit ──────────────────────────────────────────────────────────────

const AA = 4.5;
const BGS = ['--color-deep', '--color-surface', '--color-raised'];
const TEXT = ['--color-primary', '--color-muted', '--color-faint'];
/** Every accent that appears as text somewhere: a status word, a tag, a rank. */
const ACCENTS = [
  '--color-neon-cyan',
  '--color-neon-magenta',
  '--color-neon-green',
  '--color-neon-amber',
  '--color-neon-purple',
  '--color-neon-coral',
  '--color-neon-blue',
  '--color-lead',
  '--color-second',
];

/** Lead and danger (coral) as button text: [label, token]. */
const BUTTONS = [
  ['lead', '--color-lead'],
  ['danger', '--color-neon-coral'],
];
/** The resting fill under a button's ink. */
const BUTTON_FILL = 0.1;

/** The backgrounds a token is judged on (v2.131.2 for the text tokens). */
function judgedOn(token) {
  return token === '--color-primary' || token === '--color-muted' ? BGS : BGS.slice(0, 2);
}

/**
 * Audit a stylesheet's text. Returns every theme's rows and the list of
 * failures (a ratio under 4.5:1 on a background the token is judged on, or a
 * value that does not parse).
 */
function auditCss(src) {
  const themes = parseThemes(src).map((theme) => {
    const bg = {};
    for (const b of BGS) bg[b] = parseColor(resolveValue(theme.tokens, theme.tokens[b]) || '');
    const rows = [...TEXT, ...ACCENTS].map((token) => {
      const raw = theme.tokens[token];
      const value = resolveValue(theme.tokens, raw);
      const rgb = parseColor(value || '');
      const ratios = {};
      for (const b of BGS) ratios[b] = rgb && bg[b] ? contrast(rgb, bg[b]) : NaN;
      const on = judgedOn(token);
      const fail = !rgb || on.some((b) => !(ratios[b] >= AA));
      return { token, raw, value, ratios, judgedOn: on, kind: TEXT.includes(token) ? 'text' : 'accent', fail };
    });
    // The button check: the ink (the token pulled 20% toward the theme's ink,
    // `ink-lead` / `ink-danger` in index.css) on a 10% fill of the token, over
    // surface and over deep.
    const primary = parseColor(resolveValue(theme.tokens, theme.tokens['--color-primary']) || '');
    for (const [label, token] of BUTTONS) {
      const value = resolveValue(theme.tokens, theme.tokens[token]);
      const rgb = parseColor(value || '');
      const ratios = {};
      for (const b of BGS.slice(0, 2)) {
        ratios[b] =
          rgb && primary && bg[b]
            ? contrast(mixOklab(rgb, primary, 0.2), overlay(rgb, bg[b], BUTTON_FILL))
            : NaN;
      }
      ratios['--color-raised'] = NaN;
      const fail = !rgb || !primary || BGS.slice(0, 2).some((b) => !(ratios[b] >= AA));
      rows.push({ token: `button:${label}`, raw: value, value, ratios, judgedOn: BGS.slice(0, 2), kind: 'button', fail });
    }
    return { name: theme.name, own: theme.own, rows };
  });
  const failures = [];
  for (const theme of themes) {
    for (const row of theme.rows) if (row.fail) failures.push({ theme: theme.name, ...row });
  }
  return { themes, failures };
}

// ── report ─────────────────────────────────────────────────────────────────

function fmt(n) {
  return Number.isNaN(n) ? '  n/a' : n.toFixed(2).padStart(5);
}

function main() {
  const src = fs.readFileSync(CSS, 'utf8');
  const { themes, failures } = auditCss(src);
  const showAll = process.argv.includes('--all');
  const lines = [];

  for (const theme of themes) {
    lines.push('');
    lines.push(`### ${theme.name}`);
    lines.push(
      `${'token'.padEnd(16)}  ${'value'.padEnd(28)}  ${'deep'.padStart(5)}  ${'surface'.padStart(7)}  ${'raised'.padStart(6)}`
    );
    for (const row of theme.rows) {
      if (row.kind === 'accent' && !showAll && !row.fail) continue;
      const shown = row.raw === row.value ? row.value || '(unset)' : `${row.raw} = ${row.value}`;
      lines.push(
        `${row.token.replace('--color-', '').padEnd(16)}  ${String(shown).padEnd(28)}  ${BGS.map((b) => fmt(row.ratios[b])).join('  ')}${row.fail ? '   <-- FAIL' : ''}`
      );
    }
  }

  const textFails = failures.filter((f) => f.kind === 'text').length;
  const accentFails = failures.filter((f) => f.kind === 'accent').length;
  const buttonFails = failures.filter((f) => f.kind === 'button').length;
  console.log(`WCAG contrast audit: ${themes.length} themes`);
  console.log(`Bar: primary and muted >= ${AA}:1 on deep, surface and raised; faint and every accent used as text`);
  console.log(`(the seven neon tokens, lead and second) >= ${AA}:1 on deep and surface; the lead and danger ink`);
  console.log(`(the token pulled 20% toward primary) >= ${AA}:1 on a ${BUTTON_FILL * 100}% fill of itself over deep and surface.`);
  console.log(lines.join('\n'));
  console.log('');
  for (const [label] of BUTTONS) {
    let worst = null;
    for (const theme of themes) {
      for (const row of theme.rows) {
        if (row.token !== `button:${label}`) continue;
        for (const b of BGS.slice(0, 2)) if (!worst || row.ratios[b] < worst.ratio) worst = { theme: theme.name, ratio: row.ratios[b] };
      }
    }
    if (worst) console.log(`Worst button ink (${label}): ${worst.ratio.toFixed(2)}:1 in ${worst.theme}`);
  }
  console.log(`TEXT-TOKEN FAILURES: ${textFails}   ACCENT FAILURES: ${accentFails}   BUTTON FAILURES: ${buttonFails}`);

  // Parity sanity: @theme vs .sb-theme-scope for the tokens checked here.
  const scopeIdx = src.search(/^\.sb-theme-scope\s*\{/m);
  const scopeTokens = scopeIdx >= 0 ? readBlock(src, scopeIdx) : {};
  const defaults = parseThemes(src)[0].tokens;
  const drift = [...TEXT, ...ACCENTS, ...BGS].filter(
    (t) => scopeTokens[t] !== undefined && scopeTokens[t] !== defaults[t]
  );
  if (drift.length) {
    console.log(`\n!! .sb-theme-scope drifts from @theme for: ${drift.join(', ')}`);
  } else {
    console.log('\n.sb-theme-scope matches @theme for every token checked here.');
  }

  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { auditCss, parseThemes, parseColor, contrast, resolveValue, AA, BGS, TEXT, ACCENTS };
