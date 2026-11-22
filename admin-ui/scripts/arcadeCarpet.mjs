// The arcade-carpet background of the Arcaid-look pages (`.aw-screen--arcaid` in
// public/aw-theme/aw-web.css; owner 2026-11-22: "Arcaid colours", "Faint").
//
// Writes four seamless SVG tiles to public/carpet/:
//   specks    293 px  paint-chip flecks, the carpet's texture
//   motifs-a 1013 px  90s arcade-carpet shapes: gradient triangles, rings, zigzags, squiggles,
//   motifs-b 1279 px    spirals, striped dots, dotted triangles, bolts (half the density each)
//   marks    1597 px  the large Arcaid marks: the logo's double-line neon triangle, chrome pinballs
// The sizes share no factor, so the stacked layers never visibly repeat. Placement is seeded and
// wraps around the tile edges (a shape crossing an edge is drawn again on the opposite side), so each
// tile joins itself seamlessly and the same seeds always give the same carpet.
//
// Colours are the kit's, read from public/aw-theme/aw-theme.css (violet is the kit's pink and cyan
// mixed in oklch, as aw-web.css mixes it), so the carpet never carries a colour of its own.
//
// Run from admin-ui/: node scripts/arcadeCarpet.mjs
// A changed picture needs a new file name (public statics are cached for a day): bump VERSION, run
// it, update the four url()s in aw-web.css and delete the old files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const KIT_CSS = path.join(here, '..', 'public', 'aw-theme', 'aw-theme.css');
const OUT_DIR = path.join(here, '..', 'public', 'carpet');

const r1 = (n) => Math.round(n * 10) / 10;

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- colours ---- */
function kitColour(css, name) {
  const m = css.match(new RegExp(`--aw-${name}:\\s*(#[0-9A-Fa-f]{6})\\b`));
  if (!m) throw new Error(`--aw-${name} not found in ${KIT_CSS}`);
  return m[1].toUpperCase();
}
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function hexToOklch(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => toLin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}
function oklchToHex([L, C, h]) {
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGam(c))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function mixOklch(a, b, t = 0.5) {
  const [L1, C1, h1] = hexToOklch(a), [L2, C2, h2] = hexToOklch(b);
  let dh = h2 - h1;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  return oklchToHex([L1 + (L2 - L1) * t, C1 + (C2 - C1) * t, h1 + dh * t]);
}

const css = fs.readFileSync(KIT_CSS, 'utf8');
const KIT = Object.fromEntries(['pink', 'cyan', 'ice', 'chrome', 'gunmetal', 'canvas'].map((n) => [n, kitColour(css, n)]));
KIT.violet = mixOklch(KIT.pink, KIT.cyan);
// The pinball's shadow edge: the kit canvas lifted a quarter of the way to gunmetal, so the ball reads
// as round on the floor.
const BALL_EDGE = mixOklch(KIT.canvas, KIT.gunmetal, 0.25);

const PAL = {
  hues: [KIT.pink, KIT.cyan, KIT.violet, KIT.pink, KIT.cyan],
  grads: [[KIT.pink, KIT.violet], [KIT.cyan, KIT.violet], [KIT.violet, KIT.pink], [KIT.cyan, KIT.ice], [KIT.pink, KIT.cyan]],
  neon: [KIT.pink, KIT.cyan, KIT.pink, KIT.violet],
  stripes: [KIT.chrome, KIT.cyan, KIT.pink],
  specks: [KIT.ice, KIT.ice, KIT.ice, KIT.chrome, KIT.cyan, KIT.pink],
};

/* ---- shapes: each returns [markup around 0,0, bounding radius] ---- */
const pts = (list) => list.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');

// The logo's triangle (arcaid-logo-v2.png) around its centroid: long, skewed, one sharp point.
const LOGO_TRI = [[-1.02, 0.06], [0.84, -0.73], [0.19, 0.66]];

function makeShapes(rand, ids) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const grad = () => `url(#${ids.grad}${Math.floor(rand() * PAL.grads.length)})`;
  return {
    triFill(s) {
      const a0 = rand() * Math.PI * 2;
      const p = [0, 1, 2].map((i) => {
        const a = a0 + (i * 2 * Math.PI) / 3 + (rand() - 0.5) * 0.9;
        const rr = s * (0.6 + rand() * 0.6);
        return [Math.cos(a) * rr, Math.sin(a) * rr];
      });
      return [`<polygon points='${pts(p)}' fill='${grad()}'/>`, s * 1.25];
    },
    triNeon(s) {
      const c = pick(PAL.neon), w = Math.max(1.6, Math.min(3.4, s * 0.03));
      const flip = rand() < 0.5 ? -1 : 1;
      const outer = LOGO_TRI.map(([x, y]) => [x * s * flip, y * s]);
      const inner = outer.map(([x, y]) => [x * 0.76, y * 0.76]);
      return [`<g fill='none' stroke='${c}' stroke-linejoin='round'>`
        + `<polygon points='${pts(outer)}' stroke-width='${r1(w * 3.6)}' opacity='.16'/>`
        + `<polygon points='${pts(outer)}' stroke-width='${r1(w)}'/>`
        + `<polygon points='${pts(inner)}' stroke-width='${r1(w * 0.6)}' opacity='.75'/></g>`, s * 1.15 + w * 2];
    },
    ring(s) {
      const w = Math.max(1.8, s * 0.2);
      return [`<circle r='${r1(s)}' fill='none' stroke='${pick(PAL.hues)}' stroke-width='${r1(w)}'/>`, s + w];
    },
    dot(s) { const r = s > 8 ? s * 0.55 : s; return [`<circle r='${r1(r)}' fill='${pick(PAL.hues)}'/>`, r]; },
    striped(s) {
      return [`<circle r='${r1(s)}' fill='url(#${ids.stripe}${Math.floor(rand() * PAL.stripes.length)})'/>`, s];
    },
    halfMoon(s) { return [`<path d='M${r1(-s)},0A${r1(s)} ${r1(s)} 0 0 1 ${r1(s)},0Z' fill='${pick(PAL.hues)}'/>`, s]; },
    zigzag(s) {
      const n = 4 + Math.floor(rand() * 3), len = s * 2.2, amp = s * 0.42;
      const p = Array.from({ length: n + 1 }, (_, i) => [-len / 2 + (i * len) / n, i % 2 ? amp : -amp]);
      return [`<polyline points='${pts(p)}' fill='none' stroke='${grad()}' stroke-width='${r1(Math.max(2, s * 0.2))}' stroke-linecap='round' stroke-linejoin='round'/>`, len / 2 + amp];
    },
    wave(s) {
      const n = 2 + Math.floor(rand() * 2), q = (s * 2.2) / (n * 2), amp = s * 0.38;
      let d = `M${r1(-q * n)},0`;
      for (let i = 0; i < n; i++) d += `q${r1(q / 2)},${r1(-amp * 2)} ${r1(q)},0 t${r1(q)},0`;
      return [`<path d='${d}' fill='none' stroke='${pick(PAL.hues)}' stroke-width='${r1(Math.max(1.8, s * 0.15))}' stroke-linecap='round'/>`, q * n + amp];
    },
    plus(s) {
      return [`<path d='M${r1(-s)},0H${r1(s)}M0,${r1(-s)}V${r1(s)}' stroke='${pick(PAL.hues)}' stroke-width='${r1(Math.max(1.6, s * 0.36))}' stroke-linecap='round'/>`, s * 1.2];
    },
    diamond(s) { return [`<rect x='${r1(-s)}' y='${r1(-s)}' width='${r1(2 * s)}' height='${r1(2 * s)}' fill='${pick(PAL.hues)}'/>`, s * 1.45]; },
    box(s) {
      const w = Math.max(1.6, s * 0.14);
      return [`<rect x='${r1(-s)}' y='${r1(-s)}' width='${r1(2 * s)}' height='${r1(2 * s)}' fill='none' stroke='${pick(PAL.hues)}' stroke-width='${r1(w)}'/>`, s * 1.45 + w];
    },
    sprinkle(s) {
      return [`<line x1='${r1(-s)}' x2='${r1(s)}' stroke='${pick(PAL.hues)}' stroke-width='${r1(Math.max(1.6, s * 0.42))}' stroke-linecap='round'/>`, s * 1.2];
    },
    bars(s) {
      const c = pick(PAL.hues), w = r1(Math.max(1.6, s * 0.17));
      const line = (y, a, b) => `<line x1='${r1(a)}' x2='${r1(b)}' y1='${r1(y)}' y2='${r1(y)}'/>`;
      return [`<g stroke='${c}' stroke-width='${w}' stroke-linecap='round'>`
        + line(-s * 0.55, -s, s * 0.7) + line(0, -s * 0.8, s) + line(s * 0.55, -s * 0.6, s * 0.8) + '</g>', s * 1.2];
    },
    curl(s) {
      const p = Array.from({ length: 34 }, (_, i) => {
        const t = i / 33, a = t * Math.PI * 3.3, rr = s * (0.12 + 0.88 * t);
        return [Math.cos(a) * rr, Math.sin(a) * rr];
      });
      return [`<polyline points='${pts(p)}' fill='none' stroke='${pick(PAL.hues)}' stroke-width='${r1(Math.max(1.8, s * 0.14))}' stroke-linecap='round' stroke-linejoin='round'/>`, s * 1.1];
    },
    dotTri(s) {
      const c = pick(PAL.hues), g = s * 0.62, r = r1(Math.max(1.4, s * 0.14));
      const dots = [];
      for (let row = 0; row < 3; row++) for (let i = 0; i <= row; i++) dots.push([(i - row / 2) * g, (row - 1) * g * 0.87]);
      return [`<g fill='${c}'>${dots.map(([x, y]) => `<circle cx='${r1(x)}' cy='${r1(y)}' r='${r}'/>`).join('')}</g>`, s * 1.2];
    },
    bolt(s) {
      const p = [[-0.3, -1], [0.38, -1], [0.06, -0.16], [0.46, -0.16], [-0.34, 1], [-0.06, 0.12], [-0.46, 0.12]].map(([x, y]) => [x * s, y * s]);
      return [`<polygon points='${pts(p)}' fill='${pick(PAL.hues)}'/>`, s * 1.1];
    },
    pinball(s) { return [`<circle r='${r1(s)}' fill='url(#${ids.ball})'/>`, s]; },
    speck(s) {
      const n = 3 + Math.floor(rand() * 3), a0 = rand() * 6.28;
      const p = Array.from({ length: n }, (_, i) => {
        const a = a0 + (i * 6.28) / n + (rand() - 0.5) * 0.8, rr = s * (0.5 + rand() * 0.7);
        return [Math.cos(a) * rr, Math.sin(a) * rr];
      });
      return [`<polygon points='${pts(p)}' fill='${pick(PAL.specks)}'/>`, s * 1.3];
    },
  };
}

/* ---- placement on a torus ---- */
function tile(W, seed, plan) {
  const rand = rng(seed);
  const ids = { grad: `g${seed}_`, stripe: `s${seed}_`, ball: `b${seed}` };
  const shapes = makeShapes(rand, ids);
  const placed = []; // [x, y, R]
  const out = [];
  const dist = (ax, ay, bx, by) => {
    let dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    dx = Math.min(dx, W - dx); dy = Math.min(dy, W - dy);
    return Math.hypot(dx, dy);
  };
  for (const { kinds, count, size: [lo, hi], gap = 6, alpha = [0.8, 1] } of plan) {
    let made = 0, tries = 0;
    while (made < count && tries < count * 20) {
      tries++;
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const s = lo + rand() * (hi - lo);
      const rot = Math.round(rand() * 360);
      const op = r1(alpha[0] + rand() * (alpha[1] - alpha[0]));
      const [svg, R] = shapes[kind](s);
      let spot = null;
      for (let k = 0; k < 120 && !spot; k++) {
        const x = rand() * W, y = rand() * W;
        if (!placed.some(([px, py, pr]) => dist(x, y, px, py) < R + pr + gap)) spot = [x, y];
      }
      if (!spot) continue;
      const [x, y] = spot;
      placed.push([x, y, R]);
      made++;
      for (const dx of [-W, 0, W]) for (const dy of [-W, 0, W]) {
        const cx = x + dx, cy = y + dy;
        if (cx + R < 0 || cx - R > W || cy + R < 0 || cy - R > W) continue;
        out.push(`<g transform='translate(${r1(cx)} ${r1(cy)}) rotate(${rot})'${op < 1 ? ` opacity='${op}'` : ''}>${svg}</g>`);
      }
    }
  }
  const defs = PAL.grads.map(([a, b], i) => `<linearGradient id='${ids.grad}${i}' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient>`).join('')
    + PAL.stripes.map((c, i) => `<pattern id='${ids.stripe}${i}' patternUnits='userSpaceOnUse' width='6' height='6'><rect width='6' height='2.6' fill='${c}'/></pattern>`).join('')
    + `<radialGradient id='${ids.ball}' cx='.36' cy='.32' r='.78'><stop offset='0' stop-color='${KIT.ice}'/><stop offset='.3' stop-color='${KIT.chrome}'/><stop offset='.68' stop-color='${KIT.gunmetal}'/><stop offset='1' stop-color='${BALL_EDGE}'/></radialGradient>`;
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${W}' viewBox='0 0 ${W} ${W}'><defs>${defs}</defs>${out.join('')}</svg>\n`;
}

/* ---- the four tiles ---- */
const MID = ['triFill', 'triFill', 'triFill', 'triNeon', 'ring', 'ring', 'dot', 'striped', 'striped', 'zigzag', 'zigzag', 'zigzag', 'wave', 'wave', 'halfMoon', 'bars', 'curl', 'curl', 'dotTri', 'bolt', 'box'];
const SMALL = ['diamond', 'diamond', 'sprinkle', 'sprinkle', 'sprinkle', 'dot', 'plus'];
// Motif density is split across two tiles, half each, so together they make one dense carpet.
const motifs = (W, seed) => {
  const area = (W * W) / (720 * 720);
  return tile(W, seed, [
    { kinds: MID, count: Math.round(21 * area), size: [11, 26], gap: 20 },
    { kinds: SMALL, count: Math.round(36 * area), size: [2.6, 6], gap: 12, alpha: [0.7, 1] },
  ]);
};
const TILES = {
  specks: tile(293, 11, [{ kinds: ['speck'], count: 95, size: [0.9, 2.3], gap: 4, alpha: [0.35, 0.85] }]),
  'motifs-a': motifs(1013, 29),
  'motifs-b': motifs(1279, 83),
  marks: tile(1597, 47, [
    { kinds: ['triNeon'], count: 7, size: [80, 150], gap: 60, alpha: [0.7, 0.95] },
    { kinds: ['triFill'], count: 7, size: [55, 95], gap: 50, alpha: [0.5, 0.7] },
    { kinds: ['pinball'], count: 6, size: [8, 13], gap: 50, alpha: [0.6, 0.8] },
  ]),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, svg] of Object.entries(TILES)) {
  const file = path.join(OUT_DIR, `arcaid-carpet-${name}-v${VERSION}.svg`);
  fs.writeFileSync(file, svg);
  console.log(`${path.relative(path.join(here, '..'), file)}  ${(svg.length / 1024).toFixed(1)} KB`);
}
