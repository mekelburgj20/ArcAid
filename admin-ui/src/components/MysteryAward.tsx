import { useState, useRef, useEffect, useCallback } from 'react';
import NeonButton from './NeonButton';
import { drawCanvasStar } from '../assets/icons/ThemedIcons';

// --- Props ---
interface MysteryAwardProps {
  availableGames: string[];
  onClose: () => void;
  roomName?: string;
  backglassUrl?: string;
  onPickGame?: (gameName: string) => void;
}

type Phase = 'idle' | 'cycling' | 'landed';

// --- DMD Constants ---
const COLS = 192;
const ROWS = 48;
const DOT = 4;
const GAP = 1;
const CELL = DOT + GAP;
const CVS_W = COLS * CELL;
const CVS_H = ROWS * CELL;

// --- Animation Constants ---
const SPIN_DURATION_MS = 4200;

// --- Performance: reusable offscreen canvas for text rasterization ---
let _offscreen: HTMLCanvasElement | null = null;
function getOffscreen(): HTMLCanvasElement {
  if (!_offscreen || _offscreen.width !== COLS || _offscreen.height !== ROWS) {
    _offscreen = document.createElement('canvas');
    _offscreen.width = COLS;
    _offscreen.height = ROWS;
  }
  return _offscreen;
}

// --- Pre-computed star positions for translite (seeded PRNG, deterministic) ---
const STAR_POSITIONS = (() => {
  const rng = (s: number) => {
    let h = s | 0;
    return () => {
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
      h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
  };
  const rand = rng(777);
  return Array.from({ length: 40 }, () => ({
    x: rand(), y: rand() * 0.6,
    r: 0.5 + rand() * 2,
    a: 0.3 + rand() * 0.5,
  }));
})();


/* ═══════════════════════════════════════════
   DMD Buffer Utilities
   ═══════════════════════════════════════════ */

function createBuffer(): Float32Array { return new Float32Array(COLS * ROWS); }
function clearBuffer(buf: Float32Array): void { buf.fill(0); }

function setPixel(buf: Float32Array, x: number, y: number, br: number): void {
  if (x >= 0 && x < COLS && y >= 0 && y < ROWS)
    buf[y * COLS + x] = Math.max(buf[y * COLS + x], br);
}

function rasterizeText(
  buf: Float32Array, text: string, cx: number, cy: number, fontSize: number, maxWidth?: number
): void {
  const tmp = getOffscreen();
  const tc = tmp.getContext('2d')!;
  tc.clearRect(0, 0, COLS, ROWS);
  let fs = fontSize;
  tc.font = `bold ${fs}px monospace`;
  while (maxWidth && tc.measureText(text).width > maxWidth && fs > 5) {
    fs--;
    tc.font = `bold ${fs}px monospace`;
  }
  // Truncate with ellipsis if still too wide at minimum font
  let displayText = text;
  if (maxWidth && tc.measureText(displayText).width > maxWidth) {
    while (tc.measureText(displayText + '…').width > maxWidth && displayText.length > 0)
      displayText = displayText.slice(0, -1);
    displayText += '…';
  }
  tc.fillStyle = '#fff';
  tc.textAlign = 'center';
  tc.textBaseline = 'middle';
  tc.fillText(displayText, cx, cy);
  const img = tc.getImageData(0, 0, COLS, ROWS);
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      const a = img.data[(y * COLS + x) * 4 + 3];
      if (a > 30) setPixel(buf, x, y, a / 255);
    }
}

function drawRect(buf: Float32Array, x1: number, y1: number, x2: number, y2: number, br: number): void {
  for (let x = x1; x <= x2; x++) { setPixel(buf, x, y1, br); setPixel(buf, x, y2, br); }
  for (let y = y1; y <= y2; y++) { setPixel(buf, x1, y, br); setPixel(buf, x2, y, br); }
}

function drawHLine(buf: Float32Array, x1: number, x2: number, y: number, br: number): void {
  for (let x = x1; x <= x2; x++) setPixel(buf, x, y, br);
}

function drawDiamond(buf: Float32Array, cx: number, cy: number, size: number, br: number): void {
  for (let i = 0; i <= size; i++) {
    setPixel(buf, cx + i, cy - size + i, br);
    setPixel(buf, cx + size - i, cy + i, br);
    setPixel(buf, cx - i, cy + size - i, br);
    setPixel(buf, cx - size + i, cy - i, br);
  }
}


/* ═══════════════════════════════════════════
   DMD Dot Renderer
   ═══════════════════════════════════════════ */

function renderDots(ctx: CanvasRenderingContext2D, buf: Float32Array): void {
  ctx.fillStyle = '#080400';
  ctx.fillRect(0, 0, CVS_W, CVS_H);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const br = buf[y * COLS + x];
      const px = x * CELL + DOT / 2;
      const py = y * CELL + DOT / 2;
      if (br > 0.05) {
        // Warm orange-amber (real plasma DMD color)
        const r = 255;
        const g = Math.floor(80 + br * 80);
        // Outer glow halo
        ctx.beginPath();
        ctx.arc(px, py, DOT * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,120,0,${br * 0.2})`;
        ctx.fill();
        // Main dot
        ctx.beginPath();
        ctx.arc(px, py, DOT / 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},0,${0.3 + br * 0.7})`;
        ctx.fill();
        // Hot center highlight
        if (br > 0.6) {
          ctx.beginPath();
          ctx.arc(px, py, DOT / 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,200,${Math.floor(80 * br)},${br * 0.3})`;
          ctx.fill();
        }
      } else {
        // Unlit dots — visible dark amber matrix
        ctx.beginPath();
        ctx.arc(px, py, DOT / 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(80,38,0,0.35)';
        ctx.fill();
      }
    }
  }
}


/* ═══════════════════════════════════════════
   DMD Composition Functions
   ═══════════════════════════════════════════ */

function composeIdle(buf: Float32Array, time: number): void {
  clearBuffer(buf);
  const t = time / 1000;
  rasterizeText(buf, '? MYSTERY ?', COLS / 2, 12, 15, COLS - 12);
  // Horizontal sweep line
  const sweep = Math.floor((t * 30) % (COLS + 20)) - 10;
  for (let x = 8; x < COLS - 8; x++) {
    const d = Math.abs(x - sweep);
    setPixel(buf, x, 22, d < 8 ? 0.8 - d * 0.08 : 0.15);
  }
  // Slow sine pulse (0.5 Hz) instead of jarring binary blink
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI);
  if (pulse > 0.4) rasterizeText(buf, 'HIT MYSTERY', COLS / 2, 36, 13, COLS - 12);
}

function composeCycling(buf: Float32Array, game: string): void {
  clearBuffer(buf);
  // Reuse rasterizeText instead of duplicating canvas code
  rasterizeText(buf, game, COLS / 2, ROWS / 2 + 2, 24, COLS - 16);
  drawHLine(buf, 0, COLS - 1, 0, 0.3);
  drawHLine(buf, 0, COLS - 1, ROWS - 1, 0.3);
}

function composeLanded(buf: Float32Array, game: string, elapsed: number): void {
  clearBuffer(buf);
  const t = elapsed / 1000;
  const fp = Math.floor(t * 6);
  // Flash sequence → pulse → stable border
  if (fp < 8) {
    if (fp % 2 === 0) {
      drawRect(buf, 0, 0, COLS - 1, ROWS - 1, 0.9);
      drawRect(buf, 2, 2, COLS - 3, ROWS - 3, 0.7);
    }
  } else if (fp < 14) {
    const p = 0.5 + Math.sin(t * 8) * 0.3;
    drawRect(buf, 0, 0, COLS - 1, ROWS - 1, p);
    drawRect(buf, 2, 2, COLS - 3, ROWS - 3, p * 0.8);
  } else {
    drawRect(buf, 0, 0, COLS - 1, ROWS - 1, 0.6);
    drawRect(buf, 2, 2, COLS - 3, ROWS - 3, 0.4);
  }
  rasterizeText(buf, game, COLS / 2, ROWS / 2 + 1, 24, COLS - 20);
  // Diamond decorations (authentic Williams touch)
  if (t > 1.5) {
    const ds = Math.floor((t - 1.5) * 8) % 16;
    const db = 0.2 + Math.sin(t * 3) * 0.1;
    drawDiamond(buf, 10, ROWS / 2, Math.min(ds, 8), db);
    drawDiamond(buf, COLS - 11, ROWS / 2, Math.min(ds, 8), db);
  }
  if (t > 2.5 && Math.floor(t * 2) % 2 === 0)
    rasterizeText(buf, 'WINNER!', COLS / 2, ROWS - 6, 10, COLS - 30);
}


/* ═══════════════════════════════════════════
   Animation Utilities
   ═══════════════════════════════════════════ */

function easeOutQuart(t: number): number { return 1 - Math.pow(1 - t, 4); }

function buildSequence(games: string[], targetIdx: number): string[] {
  const seq: string[] = [];
  for (let p = 0; p < 3; p++) seq.push(...[...games].sort(() => Math.random() - 0.5));
  const fin = [...games].sort(() => Math.random() - 0.5);
  const ti = fin.indexOf(games[targetIdx]);
  if (ti !== -1) fin.splice(ti, 1);
  seq.push(...fin.slice(0, 8));
  seq.push(games[targetIdx]);
  return seq;
}


/* ═══════════════════════════════════════════
   Translite Canvas Renderer
   (Used when no backglassUrl is provided)
   ═══════════════════════════════════════════ */

function renderTranslite(
  ctx: CanvasRenderingContext2D, w: number, h: number, intensity: number, displayName: string
): void {
  // Deep black base
  ctx.fillStyle = '#020204';
  ctx.fillRect(0, 0, w, h);

  // Backlight bleed — warm cyan/teal (real fluorescent GI, not purple)
  const tube1 = ctx.createRadialGradient(w * 0.35, h * 0.4, 5, w * 0.35, h * 0.4, h * 0.7);
  tube1.addColorStop(0, `rgba(0,200,180,${0.03 + intensity * 0.06})`);
  tube1.addColorStop(0.5, `rgba(0,150,130,${0.015 + intensity * 0.04})`);
  tube1.addColorStop(1, 'transparent');
  ctx.fillStyle = tube1; ctx.fillRect(0, 0, w, h);

  const tube2 = ctx.createRadialGradient(w * 0.65, h * 0.35, 5, w * 0.65, h * 0.35, h * 0.65);
  tube2.addColorStop(0, `rgba(0,180,160,${0.025 + intensity * 0.05})`);
  tube2.addColorStop(0.5, `rgba(0,120,100,${0.01 + intensity * 0.03})`);
  tube2.addColorStop(1, 'transparent');
  ctx.fillStyle = tube2; ctx.fillRect(0, 0, w, h);

  // Warm amber GI accent
  const gi = ctx.createRadialGradient(w * 0.5, h * 0.8, 5, w * 0.5, h * 0.85, h * 0.5);
  gi.addColorStop(0, `rgba(255,140,30,${0.04 + intensity * 0.06})`);
  gi.addColorStop(1, 'transparent');
  ctx.fillStyle = gi; ctx.fillRect(0, 0, w, h);

  // Starburst rays
  ctx.save();
  ctx.globalAlpha = 0.06 + intensity * 0.06;
  ctx.translate(w / 2, h * 0.38);
  for (let i = 0; i < 36; i++) {
    ctx.rotate(Math.PI / 18);
    const rayGrad = ctx.createLinearGradient(0, 0, 0, h * 0.4);
    rayGrad.addColorStop(0, 'rgba(0,220,200,0.5)');
    rayGrad.addColorStop(0.5, 'rgba(0,180,160,0.25)');
    rayGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = rayGrad;
    ctx.fillRect(-0.8, 0, 1.6, h * 0.4);
  }
  ctx.restore();

  // Abstract geometric art — visible at 0.15-0.25 opacity
  ctx.save();
  ctx.globalAlpha = 0.15 + intensity * 0.1;
  ctx.fillStyle = 'rgba(0,200,180,0.3)';
  ctx.beginPath();
  ctx.moveTo(w * 0.1, h * 0.15); ctx.lineTo(w * 0.3, h * 0.05);
  ctx.lineTo(w * 0.35, h * 0.35); ctx.lineTo(w * 0.15, h * 0.45);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = 'rgba(0,180,160,0.25)';
  ctx.beginPath();
  ctx.moveTo(w * 0.65, h * 0.08); ctx.lineTo(w * 0.9, h * 0.12);
  ctx.lineTo(w * 0.85, h * 0.42); ctx.lineTo(w * 0.6, h * 0.35);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = 'rgba(255,200,100,0.2)';
  ctx.fillRect(w * 0.08, h * 0.52, w * 0.84, 1.5);
  ctx.fillRect(w * 0.12, h * 0.56, w * 0.76, 1);

  ctx.strokeStyle = 'rgba(0,220,200,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w * 0.2, h * 0.6); ctx.lineTo(w * 0.4, h * 0.55);
  ctx.lineTo(w * 0.35, h * 0.7); ctx.closePath(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.6, h * 0.58); ctx.lineTo(w * 0.8, h * 0.55);
  ctx.lineTo(w * 0.75, h * 0.68); ctx.closePath(); ctx.stroke();
  ctx.restore();

  // Central question mark medallion
  ctx.save();
  const cxc = w / 2, cyc = h * 0.36;
  ctx.globalAlpha = 0.15 + intensity * 0.15;
  ctx.beginPath(); ctx.arc(cxc, cyc, h * 0.15, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,220,200,0.5)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(cxc, cyc, h * 0.1, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,200,100,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.globalAlpha = 0.3 + intensity * 0.25;
  ctx.font = `bold ${Math.floor(h * 0.18)}px serif`;
  ctx.fillStyle = 'rgba(255,200,100,0.7)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('?', cxc, cyc);
  ctx.restore();

  // Title text — bright and legible
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const titleSize = Math.floor(h * 0.13);
  ctx.font = `900 ${titleSize}px 'Courier New', monospace`;
  // Shadow
  ctx.globalAlpha = 0.08 + intensity * 0.06;
  ctx.fillStyle = '#000';
  ctx.fillText(displayName, w / 2 + 2, h * 0.72 + 2);
  // Main title — high visibility
  ctx.globalAlpha = 0.45 + intensity * 0.35;
  const tr = Math.floor(intensity * 40);
  const tg = Math.floor(200 + intensity * 55);
  const tb = Math.floor(180 + intensity * 35);
  ctx.fillStyle = `rgb(${tr},${tg},${tb})`;
  ctx.fillText(displayName, w / 2, h * 0.72);
  // Bright highlights
  ctx.globalAlpha = 0.15 + intensity * 0.2;
  ctx.fillStyle = '#fff';
  ctx.fillText(displayName, w / 2, h * 0.72);
  // Subtitle rendered with canvas-path stars flanking the title (no Unicode glyphs).
  ctx.font = `bold ${Math.floor(h * 0.045)}px 'Courier New', monospace`;
  ctx.globalAlpha = 0.25 + intensity * 0.2;
  ctx.fillStyle = 'rgba(255,200,120,0.8)';
  const subtitle = 'MYSTERY AWARD';
  const subtitleMetrics = ctx.measureText(subtitle);
  const starR = Math.floor(h * 0.028);
  const gap = starR * 2.2;
  ctx.fillText(subtitle, w / 2, h * 0.85);
  drawCanvasStar(ctx, w / 2 - subtitleMetrics.width / 2 - gap, h * 0.85 - starR * 0.4, starR);
  drawCanvasStar(ctx, w / 2 + subtitleMetrics.width / 2 + gap, h * 0.85 - starR * 0.4, starR);
  ctx.restore();

  // Scattered stars
  ctx.save();
  ctx.globalAlpha = 0.08 + intensity * 0.06;
  for (const star of STAR_POSITIONS) {
    ctx.beginPath();
    ctx.arc(star.x * w, star.y * h, star.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,220,200,${star.a})`;
    ctx.fill();
  }
  ctx.restore();

  // Vignette
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.78);
  vig.addColorStop(0, 'transparent');
  vig.addColorStop(0.7, 'rgba(0,0,0,0.15)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);

  // Top shadow from frame
  const topShadow = ctx.createLinearGradient(0, 0, 0, h * 0.12);
  topShadow.addColorStop(0, 'rgba(0,0,0,0.5)');
  topShadow.addColorStop(1, 'transparent');
  ctx.fillStyle = topShadow; ctx.fillRect(0, 0, w, h * 0.12);
}


/* ═══════════════════════════════════════════
   Hex Bolt Sub-component
   ═══════════════════════════════════════════ */

function HexBolt({ size = 12 }: { size?: number }) {
  return (
    <div
      className="rounded-full relative"
      style={{
        width: size, height: size,
        background: 'radial-gradient(circle at 38% 32%, #999, #555 60%, #2a2a2a)',
        boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.2), 0 1px 2px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.3)',
      }}
    >
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-[30deg]"
        style={{
          width: size * 0.38, height: size * 0.38,
          clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
          background: 'rgba(0,0,0,0.5)',
        }}
      />
    </div>
  );
}


/* ═══════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════ */

export default function MysteryAward({
  availableGames,
  onClose,
  roomName,
  backglassUrl,
  onPickGame,
}: MysteryAwardProps) {
  const dmdRef = useRef<HTMLCanvasElement>(null);
  const transliteRef = useRef<HTMLCanvasElement>(null);
  const transliteContRef = useRef<HTMLDivElement>(null);
  const bufRef = useRef(createBuffer());
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);

  const stateRef = useRef({
    phase: 'idle' as Phase,
    sequence: [] as string[],
    targetGame: null as string | null,
    startTime: 0,
    landedTime: 0,
    currentGame: '',
    lastIdx: -1,
  });
  const rafRef = useRef(0);
  const t0Ref = useRef(0);
  const transliteDirty = useRef(true);
  const lastGlow = useRef(-1);

  const displayName = (roomName || 'MYSTERY AWARD').toUpperCase();

  // --- Translite canvas draw (skipped when backglassUrl is provided) ---
  const drawTranslite = useCallback((intensity: number) => {
    if (backglassUrl) return;
    const q = Math.round(intensity * 20);
    if (q === lastGlow.current && !transliteDirty.current) return;
    lastGlow.current = q;
    transliteDirty.current = false;
    const cont = transliteContRef.current;
    const cvs = transliteRef.current;
    if (!cont || !cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = cont.clientWidth;
    const ch = cont.clientHeight;
    if (cw < 1 || ch < 1) return;
    const targetW = Math.round(cw * dpr);
    const targetH = Math.round(ch * dpr);
    // Only resize when dimensions actually change (avoids GPU texture reallocation)
    if (cvs.width !== targetW || cvs.height !== targetH) {
      cvs.width = targetW;
      cvs.height = targetH;
    } else {
      ctx.clearRect(0, 0, targetW, targetH);
    }
    renderTranslite(ctx, targetW, targetH, intensity, displayName);
    cvs.style.width = cw + 'px';
    cvs.style.height = ch + 'px';
  }, [backglassUrl, displayName]);

  // --- Main animation loop ---
  const draw = useCallback(() => {
    const cvs = dmdRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const buf = bufRef.current;
    const s = stateRef.current;
    const now = performance.now();

    if (s.phase === 'idle') {
      composeIdle(buf, now - t0Ref.current);
      drawTranslite(0);
    } else if (s.phase === 'cycling') {
      const elapsed = now - s.startTime;
      const progress = Math.min(elapsed / SPIN_DURATION_MS, 1);
      const idx = Math.min(
        Math.floor(easeOutQuart(progress) * s.sequence.length),
        s.sequence.length - 1,
      );
      if (idx !== s.lastIdx) { s.lastIdx = idx; s.currentGame = s.sequence[idx]; }
      composeCycling(buf, s.currentGame);
      drawTranslite(0.3 + Math.sin(now * 0.008) * 0.15);
      if (progress >= 1) {
        s.phase = 'landed';
        s.landedTime = now;
        setPhase('landed');
        setResult(s.targetGame);
      }
    } else if (s.phase === 'landed') {
      const elapsed = now - s.landedTime;
      composeLanded(buf, s.targetGame!, elapsed);
      const t = elapsed / 1000;
      drawTranslite(
        t < 1.5
          ? (Math.floor(t * 6) % 2 === 0 ? 1 : 0.2)
          : 0.6 + Math.sin(t * 2) * 0.15,
      );
    }

    renderDots(ctx, buf);
    rafRef.current = requestAnimationFrame(draw);
  }, [drawTranslite]);

  // --- Start/stop animation loop ---
  useEffect(() => {
    t0Ref.current = performance.now();
    const t = setTimeout(() => { rafRef.current = requestAnimationFrame(draw); }, 80);
    return () => { clearTimeout(t); if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [draw]);

  // --- Spin action ---
  const spin = useCallback(() => {
    const s = stateRef.current;
    if (s.phase === 'cycling') return;
    if (!availableGames || availableGames.length === 0) return;
    // Single game — skip cycling, go directly to landed
    if (availableGames.length === 1) {
      s.phase = 'landed';
      s.targetGame = availableGames[0];
      s.landedTime = performance.now();
      transliteDirty.current = true;
      setPhase('landed');
      setResult(availableGames[0]);
      return;
    }
    const ti = Math.floor(Math.random() * availableGames.length);
    s.phase = 'cycling';
    s.sequence = buildSequence(availableGames, ti);
    s.targetGame = availableGames[ti];
    s.startTime = performance.now();
    s.lastIdx = -1;
    s.currentGame = '';
    transliteDirty.current = true;
    setPhase('cycling');
    setResult(null);
  }, [availableGames]);

  // --- Empty state ---
  if (!availableGames || availableGames.length === 0) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-deep/90 backdrop-blur-sm"
        onClick={onClose}
      >
        <div className="text-center p-8">
          <p className="text-muted text-sm mb-4">No games available for Mystery Award.</p>
          <NeonButton variant="ghost" onClick={onClose}>Close</NeonButton>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep/90 backdrop-blur-sm font-mono select-none"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Screen reader result announcement */}
      <div className="sr-only" aria-live="polite">
        {phase === 'landed' && result ? `Mystery Award revealed: ${result}` : ''}
      </div>

      <div
        className="w-[480px] max-w-[92vw] flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ═══════════════════════════════════
            BACKBOX — Heavy metal/wood housing
            ═══════════════════════════════════ */}
        <div
          className="relative rounded-[5px]"
          style={{
            background: 'linear-gradient(180deg, #1c1c1e, #141416, #101012)',
            border: '6px solid #050505',
            boxShadow: '0 0 0 1px #333 inset, 0 0 60px rgba(0,0,0,0.9), 0 8px 40px rgba(0,0,0,0.7), 0 0 0 2px #333',
          }}
        >
          {/* Left side panel (wood grain — vertical direction) */}
          <div
            className="absolute left-0 top-0 bottom-0 w-[18px] rounded-l-[5px] z-[1]"
            style={{
              background: 'linear-gradient(90deg, #12100c 0%, #1e1a14 40%, #18140e 70%, #12100c 100%)',
              borderRight: '1px solid #0a0a0a',
            }}
          >
            <div
              className="absolute inset-0 opacity-[0.06]"
              style={{
                background: 'repeating-linear-gradient(90deg, transparent 0px, transparent 3px, rgba(0,0,0,0.3) 3px, transparent 4px, transparent 6px, rgba(255,255,255,0.1) 6px, transparent 7px)',
              }}
            />
          </div>
          {/* Right side panel */}
          <div
            className="absolute right-0 top-0 bottom-0 w-[18px] rounded-r-[5px] z-[1]"
            style={{
              background: 'linear-gradient(270deg, #12100c 0%, #1e1a14 40%, #18140e 70%, #12100c 100%)',
              borderLeft: '1px solid #0a0a0a',
            }}
          >
            <div
              className="absolute inset-0 opacity-[0.06]"
              style={{
                background: 'repeating-linear-gradient(90deg, transparent 0px, transparent 3px, rgba(0,0,0,0.3) 3px, transparent 4px, transparent 6px, rgba(255,255,255,0.1) 6px, transparent 7px)',
              }}
            />
          </div>

          {/* Hex bolts — 6 total (4 corners + 2 mid-rail) */}
          <div className="absolute top-2.5 left-[20px] z-[5]"><HexBolt size={11} /></div>
          <div className="absolute top-2.5 right-[20px] z-[5]"><HexBolt size={11} /></div>
          <div className="absolute top-1/2 -translate-y-1/2 left-[20px] z-[5]"><HexBolt size={10} /></div>
          <div className="absolute top-1/2 -translate-y-1/2 right-[20px] z-[5]"><HexBolt size={10} /></div>
          <div className="absolute bottom-2.5 left-[20px] z-[5]"><HexBolt size={11} /></div>
          <div className="absolute bottom-2.5 right-[20px] z-[5]"><HexBolt size={11} /></div>

          {/* Content area inside side panels */}
          <div className="mx-[18px] relative z-[2]">

            {/* ═══ TRANSLITE ═══ */}
            <div
              ref={transliteContRef}
              className="mx-[6px] mt-[10px] relative rounded-[3px] overflow-hidden"
              style={{
                height: 'clamp(220px, 50vw, 360px)',
                border: '2px solid #1a1a1c',
                boxShadow: 'inset 0 0 30px rgba(0,0,0,0.8), inset 0 0 60px rgba(0,0,0,0.4)',
                background: '#000',
              }}
            >
              {backglassUrl ? (
                <img
                  src={backglassUrl}
                  alt={displayName}
                  className="absolute inset-0 w-full h-full object-contain p-4"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <canvas
                  ref={transliteRef}
                  className="block absolute top-0 left-0"
                />
              )}
              {/* Glass reflection — primary diagonal streak */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: 'linear-gradient(140deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 8%, transparent 20%, transparent 45%, rgba(255,255,255,0.008) 55%, transparent 65%, transparent 100%)',
                }}
              />
              {/* Glass reflection — secondary streak */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: 'linear-gradient(125deg, transparent 0%, transparent 70%, rgba(255,255,255,0.02) 78%, rgba(255,255,255,0.01) 85%, transparent 100%)',
                }}
              />
              {/* GI lighting pulse for image mode */}
              {backglassUrl && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background: 'radial-gradient(ellipse at 50% 30%, rgba(255,136,0,0.08) 0%, transparent 70%)',
                    animation: 'mystery-gi-pulse 4s ease-in-out infinite',
                  }}
                />
              )}
            </div>

            {/* Metal channel (translite → title) */}
            <div
              className="mx-[6px] h-[10px]"
              style={{
                background: 'linear-gradient(180deg, #0a0a0c, #444, #2a2a2c, #0c0c0e)',
                borderTop: '1px solid #555',
                borderBottom: '1px solid #0a0a0a',
              }}
            />

            {/* Title strip — room name */}
            <div
              className="mx-[6px] h-[42px] flex items-center justify-center relative"
              style={{
                background: 'linear-gradient(180deg, #0c0c10, #08080c)',
                borderTop: '1px solid #1a1a1e',
                borderBottom: '1px solid #1a1a1e',
              }}
            >
              <div
                className="absolute inset-0"
                style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(0,200,200,0.04), transparent 70%)' }}
              />
              <span
                className="text-lg font-bold tracking-[6px] uppercase relative"
                style={{
                  color: 'rgba(0,220,200,0.5)',
                  textShadow: '0 0 15px rgba(0,200,200,0.2), 0 0 30px rgba(0,180,180,0.08)',
                }}
                aria-hidden="true"
              >
                {roomName || 'ArcAid'}
              </span>
            </div>

            {/* Metal channel (title → DMD) */}
            <div
              className="mx-[6px] h-[10px]"
              style={{
                background: 'linear-gradient(180deg, #0a0a0c, #444, #2a2a2c, #0a0a0c)',
                borderTop: '1px solid #555',
                borderBottom: '1px solid #222',
              }}
            />

            {/* DMD window */}
            <div
              className="mx-[6px] py-2 px-3"
              style={{ background: 'linear-gradient(180deg, #0a0a0c, #080808)' }}
            >
              {/* DMD plastic bezel — warm neutral, orange glow from display */}
              <div
                className="p-[5px] rounded-[6px]"
                style={{
                  background: 'linear-gradient(180deg, #181818, #111111, #0c0c0c)',
                  border: '2px solid #28282c',
                  boxShadow: 'inset 0 3px 10px rgba(0,0,0,0.9), inset 0 -2px 5px rgba(0,0,0,0.5), 0 0 20px rgba(255,120,0,0.15), 0 0 40px rgba(255,80,0,0.08), inset 0 0 8px rgba(255,100,0,0.1)',
                }}
              >
                {/* Tinted glass inner */}
                <div
                  className="p-0.5 rounded relative"
                  style={{ background: '#060402', border: '1px solid #1a1614' }}
                >
                  <canvas
                    ref={dmdRef}
                    width={CVS_W}
                    height={CVS_H}
                    className="w-full block rounded-[3px]"
                    style={{ aspectRatio: `${CVS_W} / ${CVS_H}` }}
                    role="img"
                    aria-label={
                      phase === 'landed' && result
                        ? `Selected game: ${result}`
                        : 'Mystery Award spinning display'
                    }
                  />
                  {/* Orange tinted glass overlay */}
                  <div
                    className="absolute inset-0.5 rounded-[3px] pointer-events-none"
                    style={{ background: 'linear-gradient(140deg, rgba(255,180,80,0.015) 0%, transparent 40%)' }}
                  />
                </div>
              </div>
            </div>

            {/* Metal channel (DMD → speakers) */}
            <div
              className="mx-[6px] h-[10px]"
              style={{
                background: 'linear-gradient(180deg, #0a0a0c, #444, #2a2a2c, #0a0a0c)',
                borderTop: '1px solid #555',
                borderBottom: '1px solid #222',
              }}
            />

            {/* Speaker panel */}
            <div
              className="mx-[6px] mb-[10px] h-11 flex items-center overflow-hidden rounded-b-sm"
              style={{
                background: 'linear-gradient(180deg, #0c0c0e, #08080a)',
                border: '1px solid #1a1a1c',
                borderTop: 'none',
              }}
            >
              {/* Left speaker grille — punched hole pattern */}
              <div
                className="flex-1 h-full"
                style={{
                  background: 'radial-gradient(circle, #333 1px, transparent 1px) 0 0 / 4px 4px',
                  boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.5)',
                  borderRight: '1px solid #1a1a1c',
                }}
              />
              {/* Center name strip */}
              <div
                className="flex-[1.2] h-full flex items-center justify-center relative"
                style={{ background: 'linear-gradient(180deg, #0e0e12, #0a0a0e)' }}
              >
                <div
                  className="absolute inset-0"
                  style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(0,200,200,0.03), transparent 70%)' }}
                />
                <span
                  className="text-[11px] font-bold tracking-[3px] uppercase"
                  style={{ color: 'rgba(255,180,80,0.5)', textShadow: '0 0 8px rgba(255,140,40,0.15)' }}
                  aria-hidden="true"
                >
                  Mystery Award
                </span>
              </div>
              {/* Right speaker grille */}
              <div
                className="flex-1 h-full"
                style={{
                  background: 'radial-gradient(circle, #333 1px, transparent 1px) 0 0 / 4px 4px',
                  boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.5)',
                  borderLeft: '1px solid #1a1a1c',
                }}
              />
            </div>
          </div>
        </div>

        {/* ═══ REVEALED RESULT (accessible DOM element) ═══ */}
        {phase === 'landed' && result && (
          <div className="text-center">
            <p className="text-xs text-neon-cyan uppercase tracking-wider mb-1">Mystery Award</p>
            <p className="text-lg font-display font-bold text-neon-green glow-green animate-pulse">{result}</p>
          </div>
        )}

        {/* ═══ CONTROL PANEL ═══ */}
        <div
          className="rounded-[10px] px-4 py-3"
          style={{
            background: 'linear-gradient(180deg, #161518, #0e0d10, #0a090c)',
            border: '2px solid #2a282c',
            boxShadow: '0 6px 24px rgba(0,0,0,0.6)',
          }}
        >
          <div className="flex gap-3">
            {/* v2.2.10 — chunky pinball-backbox-style action button for Hit
                Mystery / Add to Queue. Chrome bezel + neon inner face +
                pressed-in look on :active. Matches the feel of a flipper or
                magnasave button on a cabinet. */}
            {phase === 'idle' && (
              <button
                type="button"
                onClick={spin}
                className="flex-1 pinball-action-btn"
              >
                <span className="pinball-action-btn__face">Hit Mystery</span>
              </button>
            )}
            {phase === 'cycling' && (
              <button type="button" disabled className="flex-1 pinball-action-btn pinball-action-btn--disabled">
                <span className="pinball-action-btn__face">Selecting…</span>
              </button>
            )}
            {phase === 'landed' && onPickGame && result && (
              <button
                type="button"
                onClick={() => onPickGame(result)}
                className="flex-1 pinball-action-btn pinball-action-btn--green"
              >
                <span className="pinball-action-btn__face">Add to Queue</span>
              </button>
            )}
            {phase === 'landed' && !onPickGame && result && (
              // v2.0.1: tell unauthenticated users what they're missing so they
              // don't think the button is broken. Login CTA lives on the
              // surrounding page since this component is auth-agnostic.
              <div className="flex-1 flex items-center justify-center text-[11px] text-muted italic px-2 text-center">
                Log in to queue this game
              </div>
            )}
            {phase === 'landed' && (
              <NeonButton variant="ghost" onClick={spin} className="flex-1">
                Play Again
              </NeonButton>
            )}
            <NeonButton variant="ghost" onClick={onClose}>
              Close
            </NeonButton>
          </div>

          <div className="h-[22px] flex items-center justify-center mt-2">
            {phase === 'landed' && result && (
              <p className="text-[11px] tracking-[2px] text-amber-500/60">
                {availableGames.length} TABLES &bull; <strong className="text-amber-400">{result}</strong>
              </p>
            )}
            {phase === 'idle' && (
              <p className="text-[11px] tracking-[2px] text-amber-500/25">
                {availableGames.length} TABLES LOADED
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Keyframe for GI pulse (image mode) */}
      <style>{`
        @keyframes mystery-gi-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
