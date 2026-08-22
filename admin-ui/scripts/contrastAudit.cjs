#!/usr/bin/env node
/*
 * Theme contrast audit (v2.131.2).
 *
 * Parses every theme block in src/index.css — the `@theme` dark
 * default plus all 16 `.theme-*` classes — and computes the WCAG 2.x contrast
 * ratio of the text/accent tokens against the three background tokens.
 *
 * No dependencies: oklch -> Oklab -> linear sRGB -> sRGB is done inline.
 *
 * Usage:  node admin-ui/scripts/contrastAudit.cjs [--all]
 *   (default prints the text tokens only; --all adds the neon accents)
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

// ── CSS parsing ────────────────────────────────────────────────────────────

const src = fs.readFileSync(CSS, 'utf8');

/** Pull `--token: value;` declarations out of the block that starts at `idx`. */
function readBlock(idx) {
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
  const body = src.slice(open + 1, end);
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}

const themes = [];

// Dark default: @theme, with .sb-theme-scope restating it (they must agree —
// themeScopeParity.test.ts locks that). We read @theme as the source of truth.
const themeIdx = src.search(/^@theme\s*\{/m);
if (themeIdx < 0) throw new Error('no @theme block found');
themes.push({ name: '(default dark)', tokens: readBlock(themeIdx) });

const scopeIdx = src.search(/^\.sb-theme-scope\s*\{/m);
const scopeTokens = scopeIdx >= 0 ? readBlock(scopeIdx) : {};

// Every `.theme-x {` block that is a bare single-class selector at line start.
const classRe = /^\.(theme-[a-z-]+)\s*\{/gm;
let cm;
const seen = new Set();
while ((cm = classRe.exec(src))) {
  const name = cm[1];
  const tokens = readBlock(cm.index);
  if (!tokens['--color-deep']) continue; // helper blocks (scanlines, inputs…)
  if (seen.has(name)) continue;
  seen.add(name);
  // themes inherit anything they don't override from the @theme default
  themes.push({ name, tokens: { ...themes[0].tokens, ...tokens } });
}

// ── report ─────────────────────────────────────────────────────────────────

const BGS = ['--color-deep', '--color-surface', '--color-raised'];
const TEXT = ['--color-primary', '--color-muted', '--color-faint'];
const NEON = [
  '--color-neon-cyan',
  '--color-neon-magenta',
  '--color-neon-green',
  '--color-neon-amber',
  '--color-neon-purple',
  '--color-neon-coral',
  '--color-neon-blue',
];

const showAll = process.argv.includes('--all');
const FG = showAll ? [...TEXT, ...NEON] : TEXT;

const AA = 4.5;
const AA_LARGE = 3.0;

function fmt(n) {
  return n.toFixed(2).padStart(5);
}

let fails = 0;
let neonFails = 0;
const lines = [];

for (const theme of themes) {
  const bgRgb = {};
  for (const b of BGS) {
    const c = parseColor(theme.tokens[b] || '');
    if (c) bgRgb[b] = c;
  }
  lines.push('');
  lines.push(`### ${theme.name}`);
  lines.push(
    `${'token'.padEnd(22)}  ${'value'.padEnd(28)}  ${'deep'.padStart(5)}  ${'surface'.padStart(7)}  ${'raised'.padStart(6)}`
  );
  for (const f of FG) {
    const val = theme.tokens[f];
    const c = parseColor(val || '');
    if (!c) {
      lines.push(`${f.replace('--color-', '').padEnd(22)}  ${(val || '(unset)').padEnd(28)}  (unparsed)`);
      continue;
    }
    const ratios = BGS.map((b) => (bgRgb[b] ? contrast(c, bgRgb[b]) : NaN));
    const isText = TEXT.includes(f);
    // faint/muted are real content -> AA. deep+surface are the bar for faint.
    const bar = isText ? AA : AA_LARGE;
    const relevant = f === '--color-faint' ? ratios.slice(0, 2) : ratios;
    const bad = relevant.some((r) => r < bar);
    if (bad) {
      if (isText) fails++;
      else neonFails++;
    }
    lines.push(
      `${f.replace('--color-', '').padEnd(22)}  ${(val || '').padEnd(28)}  ${ratios
        .map(fmt)
        .join('  ')}${bad ? '   <-- FAIL' : ''}`
    );
  }
}

console.log(`WCAG contrast audit — ${themes.length} themes`);
console.log(`Bar: text tokens (primary/muted/faint) >= ${AA}:1; neon accents >= ${AA_LARGE}:1 (large/UI).`);
console.log('faint is judged on deep+surface only (per v2.131.2 spec); muted on all three.');
console.log(lines.join('\n'));
console.log('');
console.log(`TEXT-TOKEN FAILURES: ${fails}` + (showAll ? `   NEON FAILURES: ${neonFails}` : ''));

// Parity sanity: @theme vs .sb-theme-scope for the tokens we touch.
const drift = [...TEXT, ...BGS].filter(
  (t) => scopeTokens[t] !== undefined && scopeTokens[t] !== themes[0].tokens[t]
);
if (drift.length) {
  console.log(`\n!! .sb-theme-scope drifts from @theme for: ${drift.join(', ')}`);
} else {
  console.log('\n.sb-theme-scope matches @theme for all text/background tokens.');
}
