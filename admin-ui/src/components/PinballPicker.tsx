import { useCallback, useEffect, useRef, useState } from 'react';
import NeonButton from './NeonButton';

interface PinballPickerProps {
  availableGames: string[];
  onClose: () => void;
  roomName?: string;
  backglassUrl?: string;
  onPickGame?: (gameName: string) => void;
}

type Phase = 'idle' | 'pulling' | 'plunging' | 'cycling' | 'revealed';

// --- Canvas Dimensions ---
const W = 400;
const H = 720;
const BALL_R = 7;

// --- Layout ---
const FRAME = 12;
const PF_LEFT = FRAME + 2;
const PF_RIGHT = W - FRAME - 2;
const LANE_W = 28;
const LANE_X = PF_RIGHT - LANE_W;
const LANE_CX = LANE_X + LANE_W / 2;
const PF_CX = (PF_LEFT + LANE_X) / 2;

// Vertical zones
const TITLE_Y = 40;
const LOGO_Y = 65;
const SCOOP_Y = 355;
const SCOOP_R = 18;
const FLIPPER_Y = 510;
const DRAIN_Y = 540;
const DMD_TOP = 565;
const DMD_BOT = 670;
const DMD_CX = (PF_LEFT + 15 + LANE_X - 15) / 2;
const DMD_CY = (DMD_TOP + DMD_BOT) / 2;

// --- Peg positions ---
const PEG_R = 3.5;
const PEG_POSITIONS: [number, number][] = [
  [65, 225], [125, 220], [PF_CX, 225], [245, 220], [305, 225],
  [45, 258], [95, 255], [155, 258], [215, 255], [275, 258], [325, 255],
  [75, 290], [135, 292], [235, 292], [295, 290],
  [45, 325], [105, 320], [255, 320], [315, 325],
  [55, 365], [115, 368], [245, 368], [305, 365],
  [75, 400], [135, 398], [225, 398], [285, 400],
  [45, 430], [105, 432], [165, 428], [245, 432], [305, 430],
  [75, 460], [195, 455], [285, 460],
  [115, 488], [255, 488],
];

// Ring pegs around the scoop
function buildScoopRing(): [number, number][] {
  const pegs: [number, number][] = [];
  const ringR = SCOOP_R + 10;
  const count = 12;
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI / count) * i - Math.PI / 2;
    const fromTop = Math.abs(((angle + Math.PI / 2 + Math.PI) % (2 * Math.PI)) - Math.PI);
    if (fromTop < 0.7) continue;
    pegs.push([
      PF_CX + Math.cos(angle) * ringR,
      SCOOP_Y + Math.sin(angle) * ringR,
    ]);
  }
  return pegs;
}
const SCOOP_RING_PEGS = buildScoopRing();

// --- Colors (RTX themed) ---
const C = {
  frameDark: '#080810',
  frameMid: '#12121e',
  frameEdge: '#1a1a2a',
  pfBase: '#0a1428',
  pfLight: '#0e1e38',
  cyan: '#00c8ff',
  cyanDim: '#005580',
  cyanBright: '#00e8ff',
  silver: '#aab0b8',
  silverBright: '#d0d4d8',
  amber: '#ff8800',
  amberDim: '#664400',
  amberBright: '#ffbb44',
  amberBg: '#0c0400',
  pegNormal: '#556688',
  pegHit: '#88bbdd',
  scoopDark: '#020206',
  chrome: '#c0c0c8',
  chromeBright: '#ffffff',
  chromeShadow: '#606068',
};

// --- Sound Hooks (stubs — drop in audio clips here) ---
function playPlungeSound() { /* TODO: plunge whoosh */ }
function playScoopCapture() { /* TODO: scoop thud */ }
function playDmdTick() { /* TODO: DMD tick */ }
function playWinnerFlash() { /* TODO: winner fanfare */ }

// --- Utilities ---
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

interface Waypoint { x: number; y: number; t: number }

// Catmull-Rom spline interpolation — produces smooth curves through control points
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
}

function interpolatePath(path: Waypoint[], t: number): { x: number; y: number } {
  t = Math.max(0, Math.min(1, t));
  const n = path.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { x: path[0]!.x, y: path[0]!.y };

  // Find the segment
  let i = 0;
  while (i < n - 1 && path[i + 1]!.t <= t) i++;
  if (i >= n - 1) return { x: path[n - 1]!.x, y: path[n - 1]!.y };

  const segT = path[i + 1]!.t === path[i]!.t ? 1 : (t - path[i]!.t) / (path[i + 1]!.t - path[i]!.t);

  // Four control points for Catmull-Rom (clamp at boundaries)
  const p0 = path[Math.max(0, i - 1)]!;
  const p1 = path[i]!;
  const p2 = path[Math.min(n - 1, i + 1)]!;
  const p3 = path[Math.min(n - 1, i + 2)]!;

  return {
    x: catmullRom(p0.x, p1.x, p2.x, p3.x, segT),
    y: catmullRom(p0.y, p1.y, p2.y, p3.y, segT),
  };
}

// Pick a random peg near a y range, offset so ball routes beside it (not through it)
function pegNearby(yMin: number, yMax: number, xBias?: number): { x: number; y: number } | null {
  let candidates = PEG_POSITIONS.filter(([, y]) => y >= yMin && y <= yMax);
  if (candidates.length === 0) return null;
  if (xBias !== undefined) {
    const biased = candidates.filter(([x]) => Math.abs(x - xBias) < 100);
    if (biased.length > 0) candidates = biased;
  }
  const peg = candidates[Math.floor(Math.random() * candidates.length)]!;
  const side = Math.random() < 0.5 ? -1 : 1;
  return { x: peg[0] + side * (PEG_R + BALL_R + 4), y: peg[1] + (Math.random() - 0.5) * 6 };
}

// Ball path from plunger to scoop — gravity-timed with peg-aware routing
function generatePlungePath(): Waypoint[] {
  const jx = () => (Math.random() - 0.5) * 20;
  const jy = () => (Math.random() - 0.5) * 6;
  const wp: Waypoint[] = [];

  // --- Lane (fast launch, decelerating) ---
  wp.push({ x: LANE_CX, y: DRAIN_Y - 20, t: 0 });
  wp.push({ x: LANE_CX, y: DRAIN_Y - 100, t: 0.03 });
  wp.push({ x: LANE_CX, y: 350, t: 0.08 });
  wp.push({ x: LANE_CX, y: 200, t: 0.15 });
  wp.push({ x: LANE_CX, y: 110, t: 0.23 });

  // --- Top curve (slow — ball at apex of gravity arc) ---
  wp.push({ x: LANE_CX, y: 75, t: 0.30 });
  wp.push({ x: LANE_CX - 30, y: 58, t: 0.35 });
  wp.push({ x: PF_CX + 70, y: 55 + jy(), t: 0.39 });
  wp.push({ x: PF_CX + 25 + jx() * 0.3, y: 75 + jy(), t: 0.43 });

  // --- Descent through peg field (accelerating with gravity) ---
  // Route near random pegs from each row for visible deflections
  let lastX = PF_CX + 25;
  const pegRows: [number, number][] = [
    [215, 240], [245, 270], [280, 300], [310, 340],
    [355, 380], [390, 415], [420, 445], [450, 475], [480, 500],
  ];
  // Timing: each row takes less time as ball accelerates (gravity effect)
  const rowTimes = [0.48, 0.52, 0.56, 0.60, 0.64, 0.68, 0.72, 0.76, 0.80];

  for (let i = 0; i < pegRows.length; i++) {
    const [yMin, yMax] = pegRows[i]!;
    const p = pegNearby(yMin, yMax, lastX);
    if (p) {
      wp.push({ x: p.x, y: p.y, t: rowTimes[i]! });
      lastX = p.x;
    } else {
      // Fallback — drift toward center
      lastX += (PF_CX - lastX) * 0.3 + jx() * 0.5;
      wp.push({ x: lastX, y: (yMin + yMax) / 2 + jy(), t: rowTimes[i]! });
    }
  }

  // --- Approach scoop (decelerating into capture) ---
  wp.push({ x: PF_CX + (Math.random() - 0.5) * 12, y: SCOOP_Y - 25, t: 0.87 });
  wp.push({ x: PF_CX + (Math.random() - 0.5) * 5, y: SCOOP_Y - 10, t: 0.93 });
  wp.push({ x: PF_CX, y: SCOOP_Y - 2, t: 0.97 });
  wp.push({ x: PF_CX, y: SCOOP_Y, t: 1.0 });

  return wp;
}

// Ball eject path — smooth arc out and down
function generateEjectPath(): Waypoint[] {
  return [
    { x: PF_CX, y: SCOOP_Y, t: 0 },
    { x: PF_CX, y: SCOOP_Y - 10, t: 0.05 },
    { x: PF_CX + 3, y: SCOOP_Y - 30, t: 0.10 },
    { x: PF_CX + 5, y: SCOOP_Y - 15, t: 0.18 },
    { x: PF_CX - 5, y: SCOOP_Y + 15, t: 0.26 },
    { x: PF_CX - 10, y: SCOOP_Y + 60, t: 0.35 },
    { x: PF_CX + 5, y: SCOOP_Y + 110, t: 0.44 },
    { x: PF_CX - 5, y: 480, t: 0.54 },
    { x: PF_CX + 3, y: FLIPPER_Y, t: 0.64 },
    { x: PF_CX, y: DRAIN_Y, t: 0.75 },
    { x: PF_CX, y: DRAIN_Y + 25, t: 0.85 },
    { x: PF_CX, y: DRAIN_Y + 60, t: 0.93 },
    { x: PF_CX, y: H + 20, t: 1.0 },
  ];
}

// Roulette-style slowdown: exponential easing on tick intervals
function buildCycleSequence(items: string[], winner: string): { name: string; delay: number }[] {
  const TOTAL_TICKS = 32;
  const others = items.filter(i => i !== winner);

  if (others.length === 0) {
    // Only one game — brief cycle of the same name
    return Array.from({ length: 8 }, (_, i) => ({
      name: winner,
      delay: 60 + 90 * Math.pow(i / 7, 3),
    }));
  }

  const pool = shuffle(others);
  const sequence: { name: string; delay: number }[] = [];

  for (let i = 0; i < TOTAL_TICKS; i++) {
    const progress = i / (TOTAL_TICKS - 1);
    const easedProgress = progress < 0.01 ? 0 : Math.pow(2, 10 * (progress - 1));
    const delay = 40 + 700 * easedProgress;

    if (i === TOTAL_TICKS - 1) {
      sequence.push({ name: winner, delay });
    } else {
      sequence.push({ name: pool[i % pool.length]!, delay });
    }
  }

  // Near-miss: ensure last 2-3 items before winner are distinct names
  const nearMissNames = shuffle(others).slice(0, Math.min(3, others.length));
  for (let i = 0; i < nearMissNames.length; i++) {
    const idx = TOTAL_TICKS - 2 - i;
    if (idx > 0 && sequence[idx]) {
      sequence[idx] = { ...sequence[idx]!, name: nearMissNames[i]! };
    }
  }

  return sequence;
}

// --- Background Renderer ---
function renderBackground(logoImg: HTMLImageElement | null, roomName?: string): HTMLCanvasElement {
  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  const ctx = bg.getContext('2d')!;

  // Frame
  ctx.fillStyle = C.frameDark;
  ctx.fillRect(0, 0, W, H);
  const frameGrad = ctx.createLinearGradient(0, 0, W, H);
  frameGrad.addColorStop(0, C.frameEdge);
  frameGrad.addColorStop(0.5, C.frameMid);
  frameGrad.addColorStop(1, C.frameDark);
  ctx.fillStyle = frameGrad;
  ctx.fillRect(3, 3, W - 6, H - 6);

  // Top/left highlight
  const topBevel = ctx.createLinearGradient(0, 0, 0, 10);
  topBevel.addColorStop(0, '#2a2a4020');
  topBevel.addColorStop(1, 'transparent');
  ctx.fillStyle = topBevel;
  ctx.fillRect(0, 0, W, 10);

  // Cyan trim on frame
  ctx.strokeStyle = C.cyanDim;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(FRAME - 1, FRAME - 1, W - (FRAME - 1) * 2, H - (FRAME - 1) * 2);

  // Playfield
  const pfGrad = ctx.createRadialGradient(PF_CX, SCOOP_Y, 30, PF_CX, SCOOP_Y, 420);
  pfGrad.addColorStop(0, C.pfLight);
  pfGrad.addColorStop(0.5, C.pfBase);
  pfGrad.addColorStop(1, '#060e1e');
  ctx.fillStyle = pfGrad;
  ctx.fillRect(PF_LEFT, FRAME, LANE_X + LANE_W - PF_LEFT, H - FRAME * 2);

  // Subtle chevron pattern
  ctx.save();
  ctx.globalAlpha = 0.035;
  const chevSize = 40;
  for (let r = -1; r < Math.ceil(H / chevSize) + 1; r++) {
    for (let c = -1; c < Math.ceil(W / chevSize) + 1; c++) {
      const cx = c * chevSize + (r % 2 === 0 ? 0 : chevSize / 2);
      const cy = r * chevSize * 0.8 + FRAME;
      ctx.beginPath();
      ctx.moveTo(cx, cy - chevSize / 2);
      ctx.lineTo(cx + chevSize / 2, cy);
      ctx.lineTo(cx, cy + chevSize / 2);
      ctx.lineTo(cx - chevSize / 2, cy);
      ctx.closePath();
      ctx.fillStyle = C.cyan;
      ctx.fill();
    }
  }
  ctx.restore();

  // Plunger lane
  ctx.fillStyle = '#0c1830';
  ctx.fillRect(LANE_X, FRAME, LANE_W, H - FRAME * 2);
  // Lane divider
  ctx.strokeStyle = C.cyanDim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(LANE_X, FRAME + 55);
  ctx.lineTo(LANE_X, DRAIN_Y + 20);
  ctx.stroke();
  // Lane curve at top
  ctx.beginPath();
  ctx.arc(LANE_X - 12, FRAME + 55, 12, 0, -Math.PI / 2, true);
  ctx.strokeStyle = C.cyanDim;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Title — room name or fallback
  ctx.save();
  ctx.shadowColor = C.cyan;
  ctx.shadowBlur = 14;
  ctx.fillStyle = C.cyan;
  const titleText = roomName || 'MYSTERY AWARD';
  // Auto-size title to fit
  let titleFontSize = 18;
  ctx.font = `bold ${titleFontSize}px "Courier New", monospace`;
  while (ctx.measureText(titleText).width > (LANE_X - PF_LEFT - 20) && titleFontSize > 10) {
    titleFontSize--;
    ctx.font = `bold ${titleFontSize}px "Courier New", monospace`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleText, PF_CX, TITLE_Y);
  ctx.restore();
  // Subtitle
  ctx.fillStyle = C.cyanDim;
  ctx.font = '9px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('— MYSTERY AWARD —', PF_CX, TITLE_Y + 16);

  // RTX Logo
  if (logoImg) {
    const logoW = 130;
    const logoH = 130;
    const logoX = PF_CX - logoW / 2;
    const logoY = LOGO_Y;
    // Glow behind logo
    ctx.save();
    ctx.shadowColor = C.cyan;
    ctx.shadowBlur = 25;
    ctx.globalAlpha = 0.25;
    ctx.drawImage(logoImg, logoX, logoY, logoW, logoH);
    ctx.restore();
    // Logo
    ctx.drawImage(logoImg, logoX, logoY, logoW, logoH);
  }

  // Scoop hole
  ctx.save();
  ctx.shadowColor = C.cyan;
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.arc(PF_CX, SCOOP_Y, SCOOP_R + 5, 0, Math.PI * 2);
  ctx.strokeStyle = C.cyanDim;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Hole bevel rim
  const rimGrad = ctx.createLinearGradient(PF_CX, SCOOP_Y - SCOOP_R - 3, PF_CX, SCOOP_Y + SCOOP_R + 3);
  rimGrad.addColorStop(0, '#555566');
  rimGrad.addColorStop(0.5, '#333344');
  rimGrad.addColorStop(1, '#222233');
  ctx.beginPath();
  ctx.arc(PF_CX, SCOOP_Y, SCOOP_R + 3, 0, Math.PI * 2);
  ctx.fillStyle = rimGrad;
  ctx.fill();

  // Hole pit
  const holeGrad = ctx.createRadialGradient(PF_CX - 2, SCOOP_Y - 2, 0, PF_CX, SCOOP_Y, SCOOP_R);
  holeGrad.addColorStop(0, '#111118');
  holeGrad.addColorStop(0.6, C.scoopDark);
  holeGrad.addColorStop(1, '#010104');
  ctx.beginPath();
  ctx.arc(PF_CX, SCOOP_Y, SCOOP_R, 0, Math.PI * 2);
  ctx.fillStyle = holeGrad;
  ctx.fill();
  // Inner rim highlight
  ctx.beginPath();
  ctx.arc(PF_CX, SCOOP_Y, SCOOP_R - 1, -Math.PI * 0.8, -Math.PI * 0.2);
  ctx.strokeStyle = '#ffffff15';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Scoop label
  ctx.fillStyle = C.cyanDim;
  ctx.font = 'bold 8px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('MYSTERY', PF_CX, SCOOP_Y - SCOOP_R - 9);
  ctx.fillText('SCOOP', PF_CX, SCOOP_Y + SCOOP_R + 14);

  // Field pegs
  for (const [px, py] of PEG_POSITIONS) {
    ctx.beginPath();
    ctx.arc(px + 0.5, py + 0.5, PEG_R + 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#00000030';
    ctx.fill();
    const pegGrad = ctx.createRadialGradient(px - 1, py - 1, 0, px, py, PEG_R);
    pegGrad.addColorStop(0, C.silverBright);
    pegGrad.addColorStop(0.5, C.pegNormal);
    pegGrad.addColorStop(1, '#334455');
    ctx.beginPath();
    ctx.arc(px, py, PEG_R, 0, Math.PI * 2);
    ctx.fillStyle = pegGrad;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px - 0.5, py - 0.5, PEG_R * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = '#ccddee';
    ctx.fill();
  }

  // Scoop ring pegs
  for (const [px, py] of SCOOP_RING_PEGS) {
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = C.pegNormal;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px - 0.3, py - 0.3, 1, 0, Math.PI * 2);
    ctx.fillStyle = '#99aabb';
    ctx.fill();
  }

  // Flipper outlines
  const flipW = 50;
  const flipH = 8;
  const fGrad = ctx.createLinearGradient(0, -flipH / 2, 0, flipH / 2);
  fGrad.addColorStop(0, '#666680');
  fGrad.addColorStop(0.5, '#444458');
  fGrad.addColorStop(1, '#333346');
  // Left
  ctx.save();
  ctx.translate(PF_CX - 50, FLIPPER_Y);
  ctx.rotate(0.2);
  ctx.fillStyle = fGrad;
  ctx.beginPath();
  ctx.roundRect(-5, -flipH / 2, flipW, flipH, 4);
  ctx.fill();
  ctx.restore();
  // Right
  ctx.save();
  ctx.translate(PF_CX + 50, FLIPPER_Y);
  ctx.rotate(-0.2);
  ctx.fillStyle = fGrad;
  ctx.beginPath();
  ctx.roundRect(-flipW + 5, -flipH / 2, flipW, flipH, 4);
  ctx.fill();
  ctx.restore();

  // Drain label
  ctx.fillStyle = '#ffffff08';
  ctx.font = 'bold 8px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('DRAIN', PF_CX, DRAIN_Y + 12);

  // Drain guides
  ctx.strokeStyle = C.cyanDim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PF_LEFT, FLIPPER_Y - 20);
  ctx.lineTo(PF_CX - 40, DRAIN_Y + 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(LANE_X, FLIPPER_Y - 20);
  ctx.lineTo(PF_CX + 40, DRAIN_Y + 5);
  ctx.stroke();

  // DMD panel frame
  const dmdLeft = PF_LEFT + 10;
  const dmdRight = LANE_X - 10;
  ctx.fillStyle = '#2a2a3a';
  ctx.beginPath();
  ctx.roundRect(dmdLeft - 4, DMD_TOP - 4, dmdRight - dmdLeft + 8, DMD_BOT - DMD_TOP + 8, 4);
  ctx.fill();
  ctx.strokeStyle = '#444460';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(dmdLeft - 4, DMD_TOP - 4, dmdRight - dmdLeft + 8, DMD_BOT - DMD_TOP + 8, 4);
  ctx.stroke();

  // DMD screen
  ctx.fillStyle = C.amberBg;
  ctx.beginPath();
  ctx.roundRect(dmdLeft, DMD_TOP, dmdRight - dmdLeft, DMD_BOT - DMD_TOP, 2);
  ctx.fill();

  // DMD scan lines
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(dmdLeft, DMD_TOP, dmdRight - dmdLeft, DMD_BOT - DMD_TOP, 2);
  ctx.clip();
  for (let y = DMD_TOP; y < DMD_BOT; y += 3) {
    ctx.fillStyle = '#00000018';
    ctx.fillRect(dmdLeft, y, dmdRight - dmdLeft, 1);
  }
  ctx.restore();

  // Status bar
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(PF_LEFT, DMD_BOT + 6, PF_RIGHT - PF_LEFT, 20);

  return bg;
}

// --- Main Component ---
export default function PinballPicker({ availableGames, onClose, roomName, backglassUrl, onPickGame }: PinballPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [logoLoaded, setLogoLoaded] = useState(false);

  const state = useRef({
    phase: 'idle' as Phase,
    ballPos: { x: LANE_CX, y: DRAIN_Y - 20 },
    ballVisible: true,
    ballTrail: [] as { x: number; y: number }[],
    pulling: false,
    pullStart: 0,
    pullAmount: 0,
    plungePath: [] as Waypoint[],
    plungeStart: 0,
    plungeDuration: 2800,
    cycleSequence: [] as { name: string; delay: number }[],
    cycleIndex: 0,
    cycleNextAt: 0,
    currentName: '',
    winner: '',
    revealStart: 0,
    ejectPath: [] as Waypoint[],
    ejectStarted: false,
    flashOn: true,
    pegHits: new Map<number, number>(),
    animId: 0,
  });

  // Load logo
  useEffect(() => {
    const src = backglassUrl || '/arcaid-logo.png';
    const img = new Image();
    img.onload = () => {
      logoRef.current = img;
      bgRef.current = null;
      setLogoLoaded(true);
    };
    img.onerror = () => {
      // Fallback to default logo on load failure
      if (src !== '/arcaid-logo.png') {
        const fallback = new Image();
        fallback.onload = () => { logoRef.current = fallback; bgRef.current = null; setLogoLoaded(true); };
        fallback.src = '/arcaid-logo.png';
      }
    };
    img.src = src;
  }, [backglassUrl]);

  const pickWinner = useCallback(() => {
    return shuffle(availableGames)[0] || 'No games available';
  }, [availableGames]);

  const startPlunge = useCallback(() => {
    const s = state.current;
    if (s.phase !== 'idle' && s.phase !== 'pulling') return;

    playPlungeSound();
    const winner = pickWinner();
    s.winner = winner;
    s.plungePath = generatePlungePath();
    s.plungeStart = performance.now();
    s.ballVisible = true;
    s.ballTrail = [];
    s.ballPos = { x: LANE_CX, y: DRAIN_Y - 20 };
    s.cycleSequence = buildCycleSequence(availableGames, winner);
    s.cycleIndex = 0;
    s.currentName = '';
    s.pullAmount = s.pulling ? s.pullAmount : 0.8; // visual spring-back
    s.pulling = false;
    s.phase = 'plunging';
    setPhase('plunging');
    setResult(null);
  }, [availableGames, pickWinner]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const s = state.current;
    if (s.phase !== 'idle') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (W / rect.width);
    const cy = (e.clientY - rect.top) * (H / rect.height);
    if (cx > LANE_X - 15 && cy > DRAIN_Y - 50) {
      s.pulling = true;
      s.pullStart = performance.now();
      s.phase = 'pulling';
      setPhase('pulling');
      canvas.setPointerCapture(e.pointerId);
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const s = state.current;
    if (s.phase !== 'pulling' || !s.pulling) return;
    if (s.pullAmount > 0.05) {
      startPlunge();
    } else {
      s.pulling = false;
      s.pullAmount = 0;
      s.phase = 'idle';
      setPhase('idle');
    }
    const canvas = canvasRef.current;
    if (canvas) canvas.releasePointerCapture(e.pointerId);
  }, [startPlunge]);

  const handlePlayAgain = useCallback(() => {
    const s = state.current;
    s.phase = 'idle';
    s.ballPos = { x: LANE_CX, y: DRAIN_Y - 20 };
    s.ballVisible = true;
    s.ballTrail = [];
    s.pullAmount = 0;
    s.pulling = false;
    s.pegHits.clear();
    s.currentName = '';
    s.ejectStarted = false;
    setPhase('idle');
    setResult(null);
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function render() {
      const s = state.current;
      const now = performance.now();

      // Cached background
      if (!bgRef.current) {
        bgRef.current = renderBackground(logoRef.current, roomName);
      }
      ctx.drawImage(bgRef.current, 0, 0);

      // --- Peg hit flashes ---
      for (const [idx, timer] of s.pegHits.entries()) {
        if (timer > 0) {
          const pos = PEG_POSITIONS[idx];
          if (pos) {
            ctx.beginPath();
            ctx.arc(pos[0], pos[1], PEG_R + 2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(0, 200, 255, ${timer * 0.06})`;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(pos[0], pos[1], PEG_R, 0, Math.PI * 2);
            ctx.fillStyle = C.pegHit;
            ctx.fill();
          }
          s.pegHits.set(idx, timer - 1);
          if (timer <= 1) s.pegHits.delete(idx);
        }
      }

      // --- Plunger pull ---
      if (s.phase === 'pulling' && s.pulling) {
        const elapsed = (now - s.pullStart) / 1000;
        s.pullAmount = Math.min(1, 1 - Math.exp(-elapsed * 1.8));
        s.ballPos.y = DRAIN_Y - 20 + s.pullAmount * 45;
      }
      // Spring-back
      if (s.phase === 'plunging' && s.pullAmount > 0) {
        s.pullAmount *= 0.82;
        if (s.pullAmount < 0.01) s.pullAmount = 0;
      }

      // Plunger visual
      const maxPull = 45;
      const pullOff = s.pullAmount * maxPull;
      const tipY = DRAIN_Y - 10 + pullOff;
      // Rod
      const rodGrad = ctx.createLinearGradient(LANE_CX - 4, 0, LANE_CX + 4, 0);
      rodGrad.addColorStop(0, '#666670');
      rodGrad.addColorStop(0.5, '#888890');
      rodGrad.addColorStop(1, '#555560');
      ctx.fillStyle = rodGrad;
      ctx.fillRect(LANE_CX - 4, tipY, 8, H - tipY - 20);
      // Spring coils
      if (s.pullAmount > 0.03) {
        ctx.strokeStyle = '#444450';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 5; i++) {
          const sy = DRAIN_Y - 10 + (i + 0.5) * (pullOff / 5);
          ctx.beginPath();
          ctx.moveTo(LANE_CX - 7, sy - 1);
          ctx.lineTo(LANE_CX + 7, sy + 1);
          ctx.stroke();
        }
      }
      // Tip
      const tipW = LANE_W - 6;
      const tipGrad = ctx.createLinearGradient(0, tipY - 3, 0, tipY + 5);
      tipGrad.addColorStop(0, '#bbbbcc');
      tipGrad.addColorStop(0.5, '#888898');
      tipGrad.addColorStop(1, '#555568');
      ctx.fillStyle = tipGrad;
      ctx.fillRect(LANE_CX - tipW / 2, tipY - 3, tipW, 7);

      // Power bar
      if (s.phase === 'pulling' && s.pullAmount > 0) {
        const bH = 60;
        const bX = PF_RIGHT + 3;
        const bY = DRAIN_Y - bH;
        ctx.fillStyle = '#ffffff08';
        ctx.fillRect(bX, bY, 6, bH);
        const fH = bH * s.pullAmount;
        const barColor = s.pullAmount < 0.5 ? C.cyan : s.pullAmount < 0.8 ? C.amber : '#ff4444';
        ctx.fillStyle = barColor;
        ctx.fillRect(bX, bY + bH - fH, 6, fH);
      }

      // --- Plunge animation ---
      if (s.phase === 'plunging') {
        const elapsed = now - s.plungeStart;
        const t = Math.min(1, elapsed / s.plungeDuration);
        const pos = interpolatePath(s.plungePath, t);
        s.ballPos = pos;

        // Flash pegs the ball passes near (visual bounce cue)
        for (let i = 0; i < PEG_POSITIONS.length; i++) {
          const pp = PEG_POSITIONS[i]!;
          const dx = pos.x - pp[0];
          const dy = pos.y - pp[1];
          if (Math.sqrt(dx * dx + dy * dy) < 18) {
            s.pegHits.set(i, 8);
          }
        }

        s.ballTrail.push({ ...pos });
        if (s.ballTrail.length > 12) s.ballTrail.shift();

        if (t >= 1) {
          playScoopCapture();
          s.ballVisible = false;
          s.phase = 'cycling';
          setPhase('cycling');
          s.cycleIndex = 0;
          s.cycleNextAt = now + s.cycleSequence[0]!.delay;
          s.currentName = s.cycleSequence[0]!.name;
        }
      }

      // --- Cycling ---
      if (s.phase === 'cycling') {
        if (now >= s.cycleNextAt && s.cycleIndex < s.cycleSequence.length - 1) {
          s.cycleIndex++;
          playDmdTick();
          s.currentName = s.cycleSequence[s.cycleIndex]!.name;
          s.cycleNextAt = now + s.cycleSequence[s.cycleIndex]!.delay;
        }
        if (s.cycleIndex >= s.cycleSequence.length - 1 && now >= s.cycleNextAt) {
          playWinnerFlash();
          s.phase = 'revealed';
          setPhase('revealed');
          s.revealStart = now;
          s.ejectPath = generateEjectPath();
          s.ejectStarted = false;
          s.flashOn = true;
          s.currentName = s.winner;
          setResult(s.winner);
        }
      }

      // --- Revealed ---
      if (s.phase === 'revealed') {
        const revealElapsed = now - s.revealStart;
        s.flashOn = Math.floor(revealElapsed / 250) % 2 === 0;

        if (revealElapsed > 1000 && !s.ejectStarted) {
          s.ejectStarted = true;
          s.ballVisible = true;
          s.ballTrail = [];
        }
        if (s.ejectStarted) {
          const ejectT = Math.min(1, (revealElapsed - 1000) / 1500);
          const pos = interpolatePath(s.ejectPath, ejectT);
          s.ballPos = pos;
          s.ballTrail.push({ ...pos });
          if (s.ballTrail.length > 8) s.ballTrail.shift();
          if (ejectT >= 1) s.ballVisible = false;
        }
      }

      // --- Draw ball ---
      if (s.ballVisible) {
        // Trail
        for (let i = 0; i < s.ballTrail.length; i++) {
          const tp = s.ballTrail[i]!;
          const a = (i + 1) / s.ballTrail.length * 0.2;
          const sz = BALL_R * (0.3 + 0.7 * (i + 1) / s.ballTrail.length);
          ctx.beginPath();
          ctx.arc(tp.x, tp.y, sz, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(160,180,200,${a})`;
          ctx.fill();
        }
        // Shadow
        ctx.beginPath();
        ctx.arc(s.ballPos.x + 2, s.ballPos.y + 2, BALL_R + 1, 0, Math.PI * 2);
        ctx.fillStyle = '#00000025';
        ctx.fill();
        // Chrome ball
        const ballGrad = ctx.createRadialGradient(
          s.ballPos.x - 2.5, s.ballPos.y - 2.5, 0.5,
          s.ballPos.x, s.ballPos.y, BALL_R
        );
        ballGrad.addColorStop(0, C.chromeBright);
        ballGrad.addColorStop(0.25, '#e0e0e8');
        ballGrad.addColorStop(0.5, C.chrome);
        ballGrad.addColorStop(0.85, C.chromeShadow);
        ballGrad.addColorStop(1, '#50505a');
        ctx.beginPath();
        ctx.arc(s.ballPos.x, s.ballPos.y, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = ballGrad;
        ctx.fill();
        ctx.strokeStyle = '#44444460';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        // Specular
        ctx.beginPath();
        ctx.arc(s.ballPos.x - 2, s.ballPos.y - 2, BALL_R * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fill();
      }

      // --- Scoop glow (active during cycling/revealed) ---
      if (s.phase === 'cycling' || s.phase === 'revealed') {
        const pulse = 0.3 + 0.3 * Math.sin(now * 0.006);
        ctx.save();
        ctx.shadowColor = C.cyanBright;
        ctx.shadowBlur = 15 + pulse * 10;
        ctx.beginPath();
        ctx.arc(PF_CX, SCOOP_Y, SCOOP_R + 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0, 200, 255, ${0.3 + pulse * 0.3})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // --- DMD Text (dynamic overlay) ---
      const dmdLeft = PF_LEFT + 10;
      const dmdRight = LANE_X - 10;
      const dmdW = dmdRight - dmdLeft;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(dmdLeft, DMD_TOP, dmdW, DMD_BOT - DMD_TOP, 2);
      ctx.clip();

      // Redraw DMD bg
      ctx.fillStyle = C.amberBg;
      ctx.fillRect(dmdLeft, DMD_TOP, dmdW, DMD_BOT - DMD_TOP);
      for (let y = DMD_TOP; y < DMD_BOT; y += 3) {
        ctx.fillStyle = '#00000018';
        ctx.fillRect(dmdLeft, y, dmdW, 1);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (s.phase === 'idle' || s.phase === 'pulling') {
        ctx.save();
        ctx.shadowColor = C.amberDim;
        ctx.shadowBlur = 4;
        ctx.fillStyle = C.amberDim;
        ctx.font = 'bold 11px "Courier New", monospace';
        ctx.fillText('PULL PLUNGER', DMD_CX, DMD_CY - 18);
        ctx.fillText('OR TAP AUTO-PLUNGE', DMD_CX, DMD_CY);
        if (s.phase === 'pulling') {
          const dots = Math.floor(now / 250) % 4;
          ctx.fillStyle = C.amber;
          ctx.shadowColor = C.amber;
          ctx.shadowBlur = 6;
          ctx.fillText('PULL' + '.'.repeat(dots), DMD_CX, DMD_CY + 22);
        }
        ctx.restore();
      } else if (s.phase === 'plunging') {
        ctx.save();
        ctx.shadowColor = C.amber;
        ctx.shadowBlur = 6;
        ctx.fillStyle = C.amber;
        ctx.font = 'bold 12px "Courier New", monospace';
        const dots = Math.floor(now / 150) % 4;
        ctx.fillText('BALL IN PLAY' + '.'.repeat(dots), DMD_CX, DMD_CY - 5);
        ctx.restore();
      } else if (s.phase === 'cycling') {
        ctx.save();
        ctx.shadowColor = C.amber;
        ctx.shadowBlur = 8;

        // Title
        ctx.fillStyle = C.amberDim;
        ctx.font = 'bold 9px "Courier New", monospace';
        ctx.fillText('MYSTERY AWARD', DMD_CX, DMD_TOP + 16);

        // Cycling name
        const name = s.currentName;
        let fontSize = 16;
        ctx.font = `bold ${fontSize}px "Courier New", monospace`;
        while (ctx.measureText(name).width > dmdW - 16 && fontSize > 8) {
          fontSize--;
          ctx.font = `bold ${fontSize}px "Courier New", monospace`;
        }
        ctx.fillStyle = C.amber;
        ctx.fillText(name, DMD_CX, DMD_CY + 2, dmdW - 12);

        // Progress dots
        const progress = s.cycleIndex / Math.max(1, s.cycleSequence.length - 1);
        const dotCount = 20;
        const dotY = DMD_BOT - 14;
        for (let i = 0; i < dotCount; i++) {
          const dotX = dmdLeft + 15 + (dmdW - 30) * (i / (dotCount - 1));
          ctx.fillStyle = i / dotCount <= progress ? C.amber : C.amberDim + '40';
          ctx.fillRect(dotX - 1, dotY - 1, 3, 3);
        }
        ctx.restore();
      } else if (s.phase === 'revealed') {
        ctx.save();
        ctx.fillStyle = C.amberBright;
        ctx.shadowColor = C.amber;
        ctx.shadowBlur = 12;
        ctx.font = 'bold 10px "Courier New", monospace';
        ctx.fillText('\u2605 WINNER \u2605', DMD_CX, DMD_TOP + 16);

        // Winner name (flashing)
        if (s.flashOn) {
          ctx.fillStyle = C.amberBright;
          ctx.shadowBlur = 18;
        } else {
          ctx.fillStyle = C.amber;
          ctx.shadowBlur = 6;
        }
        const name = s.winner;
        let fontSize = 16;
        ctx.font = `bold ${fontSize}px "Courier New", monospace`;
        while (ctx.measureText(name).width > dmdW - 16 && fontSize > 8) {
          fontSize--;
          ctx.font = `bold ${fontSize}px "Courier New", monospace`;
        }
        ctx.fillText(name, DMD_CX, DMD_CY + 2, dmdW - 12);

        // Full progress bar
        const dotCount = 20;
        const dotY = DMD_BOT - 14;
        for (let i = 0; i < dotCount; i++) {
          const dotX = dmdLeft + 15 + (dmdW - 30) * (i / (dotCount - 1));
          ctx.fillStyle = C.amberBright;
          ctx.fillRect(dotX - 1, dotY - 1, 3, 3);
        }
        ctx.restore();
      }

      ctx.restore(); // DMD clip

      // --- Status bar ---
      if (s.phase === 'idle') {
        ctx.fillStyle = C.cyanDim;
        ctx.font = '8px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('HOLD & RELEASE PLUNGER \u2014 OR TAP AUTO-PLUNGE', PF_CX, DMD_BOT + 16);
      }

      s.animId = requestAnimationFrame(render);
    }

    state.current.animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(state.current.animId);
  }, [logoLoaded]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-deep/90 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {/* Canvas container with glass/GI overlays */}
        <div className="relative rounded-lg overflow-hidden max-w-[92vw] max-h-[72vh]" style={{ aspectRatio: `${W}/${H}` }}>
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            className="w-full h-full cursor-pointer touch-none"
            style={{ imageRendering: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 60px rgba(0,200,255,0.08)' }}
          />
          {/* Glass reflection overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: 'linear-gradient(135deg, transparent 30%, rgba(255,255,255,0.04) 45%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.04) 55%, transparent 70%)',
            }}
          />
          {/* GI lighting pulse — warm amber wash */}
          <div
            className="absolute pointer-events-none"
            style={{
              top: 0, left: 0, right: 0, height: '35%',
              background: 'radial-gradient(ellipse at 50% 30%, rgba(255,136,0,0.08) 0%, transparent 70%)',
              animation: 'pinball-gi-pulse 4s ease-in-out infinite',
            }}
          />
          {/* Vignette */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ boxShadow: 'inset 0 0 60px rgba(0,0,0,0.4), inset 0 0 120px rgba(0,0,0,0.2)' }}
          />
        </div>
        {phase === 'revealed' && result && (
          <div className="text-center">
            <p className="text-xs text-neon-cyan uppercase tracking-wider mb-1">Mystery Award</p>
            <p className="text-lg font-display font-bold text-neon-green glow-green animate-pulse">{result}</p>
          </div>
        )}
        <div className="flex gap-3">
          {phase === 'idle' && (
            <NeonButton variant="primary" onClick={startPlunge}>
              Auto-Plunge
            </NeonButton>
          )}
          {phase === 'revealed' && onPickGame && result && (
            <NeonButton variant="primary" onClick={() => onPickGame(result)}>
              Add to Queue?
            </NeonButton>
          )}
          {phase === 'revealed' && (
            <NeonButton variant="ghost" onClick={handlePlayAgain}>
              Play Again
            </NeonButton>
          )}
          <NeonButton variant="ghost" onClick={onClose}>
            Close
          </NeonButton>
        </div>
      </div>
      <style>{`
        @keyframes pinball-gi-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
