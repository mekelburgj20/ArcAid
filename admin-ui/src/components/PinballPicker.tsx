import { useCallback, useEffect, useRef, useState } from 'react';
import NeonButton from './NeonButton';

interface PinballPickerProps {
  availableGames: string[];
  onClose: () => void;
}

type Phase = 'idle' | 'pulling' | 'running' | 'landed';

interface Vec2 { x: number; y: number }
interface Peg { x: number; y: number; hitTimer: number }
interface Hole { x: number; y: number; r: number; label: string; ringR: number; gapAngle: number }

// Canvas logical size
const W = 380;
const H = 700;
const BALL_R = 6;
const PEG_R = 3;
const RING_PEG_R = 2; // smaller ring pegs

// Tilted-table physics: table is ~6 degrees, gravity component is sin(6°)≈0.1 of full
const GRAVITY = 0.045;
const FRICTION = 0.9985; // rolling resistance per frame
const PEG_DAMPING = 0.6;
const WALL_DAMPING = 0.55;
const TRAIL_LEN = 10;

// Playfield frame
const FRAME = 14;
const PF_LEFT = FRAME;
const PF_RIGHT = W - FRAME;
const PF_BOT = H - 75;

// Arch (elliptical top boundary)
const ARCH_CX = (PF_LEFT + PF_RIGHT) / 2; // ~190
const ARCH_RX = (PF_RIGHT - PF_LEFT) / 2;  // ~176
const ARCH_RY = 75;
const ARCH_CY = 85; // y where straight walls transition to arch curve
// Top of arch = ARCH_CY - ARCH_RY = 10

// Plunger lane
const LANE_DIVIDER_X = PF_RIGHT - 30; // left wall of plunger lane
const LANE_RIGHT = PF_RIGHT;          // shares the right outer wall
const LANE_CX = (LANE_DIVIDER_X + LANE_RIGHT) / 2;
const LANE_TOP = ARCH_CY + 5; // divider wall stops here, ball enters arch above this

// Drain
const DRAIN_Y = PF_BOT + 12;

// Colors
const WOOD_DARK = '#3a2518';
const WOOD_MID = '#5c3a24';
const WOOD_LIGHT = '#7a5438';
const GOLD_TRIM = '#b8962e';
const PLAYFIELD_BG = '#e8d8a8';
const PLAYFIELD_CREAM = '#f0e6c0';
const NAIL_COLOR = '#777777';
const NAIL_HIT = '#cccccc';
const BALL_COLOR = '#c0c0c8';
const BALL_HIGHLIGHT = '#ffffff';
const BALL_SHADOW = '#888890';
const TITLE_COLOR = '#2a2068';
const HOLE_DARK = '#1a1a1a';
const HOLE_RIM = '#555555';
const LABEL_COLOR = '#2a2068';
const DIAMOND_COLORS = [
  '#cc3333', '#3366cc', '#44aa44', '#8844aa',
  '#dd7722', '#cc3366', '#4488aa', '#66aa44',
];

// Holes — ringR is the radius of the nail ring, gapAngle is half-gap in radians at the top
const HOLES: Hole[] = [
  { x: 190, y: 185, r: 13, label: '100', ringR: 22, gapAngle: 0.7 },
  { x: 65,  y: 265, r: 12, label: '100', ringR: 20, gapAngle: 0.7 },
  { x: 290, y: 265, r: 12, label: '100', ringR: 20, gapAngle: 0.7 },
  { x: 190, y: 370, r: 14, label: '250', ringR: 24, gapAngle: 0.65 },
  { x: 60,  y: 430, r: 13, label: '200', ringR: 22, gapAngle: 0.7 },
  { x: 285, y: 430, r: 13, label: '200', ringR: 22, gapAngle: 0.7 },
  { x: 190, y: 520, r: 14, label: '400', ringR: 24, gapAngle: 0.65 },
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Build ring peg positions for a hole — pegs placed around the ring with a gap at the top */
function buildRingPegs(hole: Hole): Vec2[] {
  const pegs: Vec2[] = [];
  const circumference = 2 * Math.PI * hole.ringR;
  const spacing = (RING_PEG_R * 2 + 2); // ~6px between peg centers
  const count = Math.floor(circumference / spacing);
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI / count) * i - Math.PI / 2; // start at top
    // Skip pegs in the gap zone (centered at top, i.e. angle near -PI/2)
    const fromTop = Math.abs(((angle + Math.PI / 2 + Math.PI) % (2 * Math.PI)) - Math.PI);
    if (fromTop < hole.gapAngle) continue;
    pegs.push({
      x: hole.x + Math.cos(angle) * hole.ringR,
      y: hole.y + Math.sin(angle) * hole.ringR,
    });
  }
  return pegs;
}

/** All ring peg positions (precomputed) */
const ALL_RING_PEGS: Vec2[] = HOLES.flatMap(h => buildRingPegs(h));

function buildFieldPegs(): Peg[] {
  const pegs: Peg[] = [];
  // Hand-placed nail pegs across the playfield
  const positions: [number, number][] = [
    // Upper field — spread across, avoiding holes
    [90, 135], [145, 130], [235, 130], [290, 135],
    [60, 165], [130, 160], [250, 160], [315, 165],
    // Between top hole and side holes
    [100, 210], [155, 215], [225, 215], [280, 210],
    [60, 230], [130, 240], [250, 240], [310, 230],
    // Mid field
    [100, 290], [160, 295], [220, 295], [275, 290],
    [75, 320], [140, 325], [240, 325], [300, 320],
    [110, 350], [160, 345], [220, 345], [265, 350],
    // Between center and side holes
    [75, 390], [310, 390],
    [130, 405], [250, 405],
    // Lower field
    [100, 460], [155, 460], [225, 460], [275, 460],
    [75, 490], [135, 485], [245, 485], [300, 490],
    [110, 515], [270, 515],
    // Below bottom hole
    [140, 550], [240, 550],
    [100, 565], [175, 560], [205, 560], [280, 565],
  ];

  for (const [x, y] of positions) {
    // Reject if too close to any hole center or ring peg
    let tooClose = false;
    for (const hole of HOLES) {
      const dx = x - hole.x;
      const dy = y - hole.y;
      if (Math.sqrt(dx * dx + dy * dy) < hole.ringR + PEG_R + 3) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      pegs.push({ x, y, hitTimer: 0 });
    }
  }
  return pegs;
}

/** Collide ball against the arch boundary, returns true if collision occurred */
function collideArch(pos: Vec2, vel: Vec2): boolean {
  if (pos.y >= ARCH_CY) return false;
  const nx = (pos.x - ARCH_CX) / ARCH_RX;
  const ny = (pos.y - ARCH_CY) / ARCH_RY;
  const d2 = nx * nx + ny * ny;
  if (d2 <= 1) return false; // inside
  // Push back inside along the ellipse normal
  const d = Math.sqrt(d2);
  const nnx = nx / d;
  const nny = ny / d;
  // World-space normal (account for ellipse scaling)
  const wnx = nnx / ARCH_RX;
  const wny = nny / ARCH_RY;
  const wlen = Math.sqrt(wnx * wnx + wny * wny);
  const fnx = wnx / wlen;
  const fny = wny / wlen;
  // Move ball to just inside
  const penetration = (d - 1) * Math.min(ARCH_RX, ARCH_RY) * 0.5 + BALL_R;
  pos.x -= fnx * penetration;
  pos.y -= fny * penetration;
  // Reflect velocity
  const vDot = vel.x * fnx + vel.y * fny;
  if (vDot > 0) {
    vel.x -= 2 * vDot * fnx;
    vel.y -= 2 * vDot * fny;
    vel.x *= WALL_DAMPING;
    vel.y *= WALL_DAMPING;
  }
  return true;
}

/** Draw the arch path for the playfield outline */
function drawPlayfieldPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(PF_LEFT, PF_BOT + 20);
  ctx.lineTo(PF_LEFT, ARCH_CY);
  // Arch (elliptical arc from left to right)
  ctx.ellipse(ARCH_CX, ARCH_CY, ARCH_RX, ARCH_RY, 0, Math.PI, 0, false);
  ctx.lineTo(PF_RIGHT, PF_BOT + 20);
  ctx.closePath();
}

/** Collide ball against a line segment, returns true if collision occurred */
function collideLine(pos: Vec2, vel: Vec2, p1: Vec2, p2: Vec2, damping: number): boolean {
  const lx = p2.x - p1.x;
  const ly = p2.y - p1.y;
  const len = Math.sqrt(lx * lx + ly * ly);
  if (len < 0.1) return false;
  // Line normal (pointing left of direction)
  const nx = -ly / len;
  const ny = lx / len;
  const dx = pos.x - p1.x;
  const dy = pos.y - p1.y;
  const dist = dx * nx + dy * ny;
  const t = (dx * lx + dy * ly) / (len * len);
  if (t < -0.05 || t > 1.05) return false;
  const absDist = Math.abs(dist);
  if (absDist >= BALL_R + 2) return false;
  const sign = dist >= 0 ? 1 : -1;
  pos.x += nx * sign * (BALL_R + 2 - absDist);
  pos.y += ny * sign * (BALL_R + 2 - absDist);
  const vDot = vel.x * nx * sign + vel.y * ny * sign;
  if (vDot < 0) {
    vel.x -= 2 * vDot * nx * sign;
    vel.y -= 2 * vDot * ny * sign;
    vel.x *= damping;
    vel.y *= damping;
  }
  return true;
}

export default function PinballPicker({ availableGames, onClose }: PinballPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [score, setScore] = useState<string | null>(null);
  const [isDrain, setIsDrain] = useState(false);

  const stateRef = useRef({
    pos: { x: LANE_CX, y: PF_BOT - 15 } as Vec2,
    vel: { x: 0, y: 0 } as Vec2,
    trail: [] as Vec2[],
    pegs: buildFieldPegs(),
    ringPegHitTimers: new Map<number, number>(), // index → frames remaining
    phase: 'idle' as Phase,
    startTime: 0,
    plungerPull: 0,
    animId: 0,
    landedHole: null as Hole | null,
    ballVisible: true,
    resultText: '',
    isDrain: false,
    pulling: false,
    pullStartTime: 0,
  });

  const pickGame = useCallback(() => {
    return shuffle(availableGames)[0] || 'No games available';
  }, [availableGames]);

  const resetBall = useCallback(() => {
    const s = stateRef.current;
    s.pos = { x: LANE_CX, y: PF_BOT - 15 };
    s.vel = { x: 0, y: 0 };
    s.trail = [];
    s.plungerPull = 0;
    s.pegs.forEach(p => (p.hitTimer = 0));
    s.ringPegHitTimers.clear();
    s.startTime = 0;
    s.landedHole = null;
    s.ballVisible = true;
    s.resultText = '';
    s.isDrain = false;
    s.pulling = false;
    s.pullStartTime = 0;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const s = stateRef.current;
    if (s.phase !== 'idle') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (W / rect.width);
    const cy = (e.clientY - rect.top) * (H / rect.height);
    // Hit test plunger area
    if (cx > LANE_DIVIDER_X - 20 && cx < PF_RIGHT + 20 && cy > PF_BOT - 60 && cy < H) {
      s.pulling = true;
      s.pullStartTime = performance.now();
      s.phase = 'pulling';
      setPhase('pulling');
      setResult(null);
      setScore(null);
      setIsDrain(false);
      canvas.setPointerCapture(e.pointerId);
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const s = stateRef.current;
    if (s.phase !== 'pulling' || !s.pulling) return;
    s.pulling = false;
    const power = s.plungerPull;
    if (power < 0.05) {
      s.plungerPull = 0;
      s.phase = 'idle';
      setPhase('idle');
      return;
    }
    // Half power clears the lane top; full power reaches the far top-left
    const launchVel = 5 + power * 6;
    s.vel = { x: -0.2 - Math.random() * 0.4, y: -launchVel };
    s.phase = 'running';
    s.startTime = performance.now();
    setPhase('running');
    const canvas = canvasRef.current;
    if (canvas) canvas.releasePointerCapture(e.pointerId);
  }, []);

  const handlePlayAgain = useCallback(() => {
    resetBall();
    stateRef.current.pegs = buildFieldPegs();
    stateRef.current.phase = 'idle';
    setPhase('idle');
    setResult(null);
    setScore(null);
    setIsDrain(false);
  }, [resetBall]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    // Drain guide lines (angled walls funneling to drain opening)
    const drainGuideL1: Vec2 = { x: PF_LEFT, y: PF_BOT - 15 };
    const drainGuideL2: Vec2 = { x: ARCH_CX - 30, y: PF_BOT + 15 };
    const drainGuideR1: Vec2 = { x: LANE_DIVIDER_X - 5, y: PF_BOT - 15 };
    const drainGuideR2: Vec2 = { x: ARCH_CX + 30, y: PF_BOT + 15 };

    function draw() {
      const s = stateRef.current;
      ctx.clearRect(0, 0, W, H);

      // === WOOD FRAME ===
      ctx.fillStyle = WOOD_DARK;
      ctx.fillRect(0, 0, W, H);
      const frameGrad = ctx.createLinearGradient(0, 0, W, H);
      frameGrad.addColorStop(0, WOOD_LIGHT);
      frameGrad.addColorStop(0.3, WOOD_MID);
      frameGrad.addColorStop(0.7, WOOD_MID);
      frameGrad.addColorStop(1, WOOD_DARK);
      ctx.fillStyle = frameGrad;
      ctx.fillRect(5, 5, W - 10, H - 10);

      // === PLAYFIELD ===
      ctx.save();
      drawPlayfieldPath(ctx);
      ctx.fillStyle = PLAYFIELD_BG;
      ctx.fill();
      ctx.restore();

      // Diamond pattern (clipped to playfield)
      ctx.save();
      drawPlayfieldPath(ctx);
      ctx.clip();
      const dSize = 42;
      for (let r = -1; r < Math.ceil(H / dSize) + 1; r++) {
        for (let c = -1; c < Math.ceil(W / dSize) + 1; c++) {
          const dx = c * dSize + (r % 2 === 0 ? 0 : dSize / 2);
          const dy = r * dSize * 0.7 + 30;
          ctx.beginPath();
          ctx.moveTo(dx, dy - dSize / 2);
          ctx.lineTo(dx + dSize / 2, dy);
          ctx.lineTo(dx, dy + dSize / 2);
          ctx.lineTo(dx - dSize / 2, dy);
          ctx.closePath();
          ctx.fillStyle = DIAMOND_COLORS[(r * 3 + c * 2 + (r + c)) % DIAMOND_COLORS.length]! + '28';
          ctx.fill();
        }
      }
      // Cream center diamond
      ctx.beginPath();
      ctx.moveTo(ARCH_CX, 130);
      ctx.lineTo(LANE_DIVIDER_X - 30, 340);
      ctx.lineTo(ARCH_CX, PF_BOT - 40);
      ctx.lineTo(PF_LEFT + 30, 340);
      ctx.closePath();
      ctx.fillStyle = PLAYFIELD_CREAM + '35';
      ctx.fill();
      ctx.restore();

      // Playfield border (gold trim)
      ctx.save();
      drawPlayfieldPath(ctx);
      ctx.strokeStyle = GOLD_TRIM;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();

      // === PLUNGER LANE ===
      // Lane background
      ctx.fillStyle = PLAYFIELD_BG;
      const laneTop = LANE_TOP;
      ctx.fillRect(LANE_DIVIDER_X, laneTop, LANE_RIGHT - LANE_DIVIDER_X, PF_BOT + 20 - laneTop);

      // Lane divider wall (stops at LANE_TOP to let ball enter arch)
      ctx.strokeStyle = GOLD_TRIM;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(LANE_DIVIDER_X, PF_BOT + 15);
      ctx.lineTo(LANE_DIVIDER_X, laneTop);
      ctx.stroke();
      // Curved guide at top of lane — curves leftward from divider top into the arch
      ctx.beginPath();
      ctx.arc(LANE_DIVIDER_X - 12, laneTop, 12, 0, -Math.PI / 2, true);
      ctx.strokeStyle = GOLD_TRIM;
      ctx.lineWidth = 2;
      ctx.stroke();

      // === DRAIN GUIDES ===
      ctx.strokeStyle = GOLD_TRIM;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(drainGuideL1.x, drainGuideL1.y);
      ctx.lineTo(drainGuideL2.x, drainGuideL2.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(drainGuideR1.x, drainGuideR1.y);
      ctx.lineTo(drainGuideR2.x, drainGuideR2.y);
      ctx.stroke();
      ctx.fillStyle = '#66000060';
      ctx.font = 'bold 8px serif';
      ctx.textAlign = 'center';
      ctx.fillText('DRAIN', ARCH_CX, PF_BOT + 5);

      // === TITLE ===
      ctx.fillStyle = TITLE_COLOR;
      ctx.font = 'bold 26px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GAME', ARCH_CX, ARCH_CY - ARCH_RY + 25);
      ctx.font = 'bold 20px serif';
      ctx.fillText('PICKER', ARCH_CX, ARCH_CY - ARCH_RY + 48);

      // Side text
      ctx.save();
      ctx.fillStyle = TITLE_COLOR + '50';
      ctx.font = 'bold 13px serif';
      ctx.textAlign = 'center';
      ctx.translate(PF_LEFT + 12, 330);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('ARCAID', 0, 0);
      ctx.restore();
      ctx.save();
      ctx.fillStyle = TITLE_COLOR + '50';
      ctx.font = 'bold 13px serif';
      ctx.textAlign = 'center';
      ctx.translate(LANE_DIVIDER_X - 10, 330);
      ctx.rotate(Math.PI / 2);
      ctx.fillText('ARCAID', 0, 0);
      ctx.restore();

      // === HOLES ===
      for (const hole of HOLES) {
        // Shadow
        ctx.beginPath();
        ctx.arc(hole.x, hole.y + 1, hole.r + 2, 0, Math.PI * 2);
        ctx.fillStyle = '#00000035';
        ctx.fill();
        // Hole body
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.fillStyle = HOLE_DARK;
        ctx.fill();
        // Rim
        ctx.strokeStyle = HOLE_RIM;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Inner bevel
        const hg = ctx.createRadialGradient(hole.x, hole.y - 2, 0, hole.x, hole.y, hole.r);
        hg.addColorStop(0, '#44444480');
        hg.addColorStop(1, '#00000000');
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.fillStyle = hg;
        ctx.fill();
        // Label
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = 'bold 12px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(hole.label, hole.x, hole.y - hole.r - 5);
        if (hole.label === '250') {
          ctx.font = '8px serif';
          ctx.textBaseline = 'top';
          ctx.fillText('FREE PLAY', hole.x, hole.y + hole.r + 4);
        }
      }

      // === RING PEGS (with gaps) ===
      for (let i = 0; i < ALL_RING_PEGS.length; i++) {
        const rp = ALL_RING_PEGS[i]!;
        const hit = s.ringPegHitTimers.get(i) || 0;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, RING_PEG_R, 0, Math.PI * 2);
        ctx.fillStyle = hit > 0 ? NAIL_HIT : NAIL_COLOR;
        ctx.fill();
        if (hit > 0) s.ringPegHitTimers.set(i, hit - 1);
      }

      // === FIELD PEGS ===
      for (const peg of s.pegs) {
        const bright = peg.hitTimer > 0;
        ctx.beginPath();
        ctx.arc(peg.x, peg.y, PEG_R, 0, Math.PI * 2);
        ctx.fillStyle = bright ? NAIL_HIT : NAIL_COLOR;
        ctx.fill();
        // Highlight dot
        ctx.beginPath();
        ctx.arc(peg.x - 0.5, peg.y - 0.5, PEG_R * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = bright ? '#ffffff' : '#aaaaaa';
        ctx.fill();
        if (bright) peg.hitTimer--;
      }

      // === PLUNGER ===
      const maxPull = 55;
      const pullOff = s.plungerPull * maxPull;
      const tipY = PF_BOT - 20 + pullOff;
      // Rod
      ctx.fillStyle = '#777777';
      ctx.fillRect(LANE_CX - 4, tipY, 8, H - tipY - 15);
      // Spring coils
      if (s.plungerPull > 0.03) {
        ctx.strokeStyle = '#555555';
        ctx.lineWidth = 1.5;
        const sTop = PF_BOT - 20;
        const sH = pullOff;
        for (let i = 0; i < 5; i++) {
          const y = sTop + (i + 0.5) * (sH / 5);
          ctx.beginPath();
          ctx.moveTo(LANE_CX - 7, y - 1.5);
          ctx.lineTo(LANE_CX + 7, y + 1.5);
          ctx.stroke();
        }
      }
      // Knob
      const kg = ctx.createRadialGradient(LANE_CX, tipY + 4, 2, LANE_CX, tipY + 4, 9);
      kg.addColorStop(0, '#dd2222');
      kg.addColorStop(1, '#881111');
      ctx.beginPath();
      ctx.arc(LANE_CX, tipY + 4, 8, 0, Math.PI * 2);
      ctx.fillStyle = kg;
      ctx.fill();
      ctx.strokeStyle = '#661111';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Power bar
      if (s.phase === 'pulling' && s.plungerPull > 0) {
        const bH = 70;
        const bX = LANE_RIGHT + 4;
        const bY = PF_BOT - bH;
        ctx.fillStyle = '#00000030';
        ctx.fillRect(bX, bY, 7, bH);
        const fH = bH * s.plungerPull;
        ctx.fillStyle = s.plungerPull < 0.5 ? '#44aa44' : s.plungerPull < 0.8 ? '#ddaa22' : '#cc3333';
        ctx.fillRect(bX, bY + bH - fH, 7, fH);
        ctx.strokeStyle = GOLD_TRIM;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(bX, bY, 7, bH);
      }

      // === BALL ===
      if (s.ballVisible) {
        // Trail
        for (let i = 0; i < s.trail.length; i++) {
          const t = s.trail[i]!;
          const a = (i + 1) / s.trail.length * 0.2;
          const sz = BALL_R * (0.3 + 0.7 * (i + 1) / s.trail.length);
          ctx.beginPath();
          ctx.arc(t.x, t.y, sz, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(170,170,178,${a})`;
          ctx.fill();
        }
        // Shadow
        ctx.beginPath();
        ctx.arc(s.pos.x + 1.5, s.pos.y + 1.5, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = '#00000025';
        ctx.fill();
        // Body
        const bg = ctx.createRadialGradient(s.pos.x - 2, s.pos.y - 2, 1, s.pos.x, s.pos.y, BALL_R);
        bg.addColorStop(0, BALL_HIGHLIGHT);
        bg.addColorStop(0.35, BALL_COLOR);
        bg.addColorStop(1, BALL_SHADOW);
        ctx.beginPath();
        ctx.arc(s.pos.x, s.pos.y, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.strokeStyle = '#99999960';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // === SCOREBOARD ===
      ctx.fillStyle = WOOD_DARK;
      ctx.fillRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 38);
      ctx.strokeStyle = GOLD_TRIM;
      ctx.lineWidth = 1;
      ctx.strokeRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 38);

      if (s.phase === 'landed' && s.landedHole) {
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 10px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${s.landedHole.label} PTS`, W / 2, PF_BOT + 36);
        ctx.fillStyle = '#ffeeaa';
        ctx.font = 'bold 12px serif';
        ctx.fillText(s.resultText, W / 2, PF_BOT + 51);
      } else if (s.phase === 'landed' && s.isDrain) {
        ctx.fillStyle = '#ff6666';
        ctx.font = 'bold 10px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('DRAIN!', W / 2, PF_BOT + 36);
        ctx.fillStyle = '#ffeeaa';
        ctx.font = 'bold 12px serif';
        ctx.fillText(s.resultText, W / 2, PF_BOT + 51);
      } else if (s.phase === 'idle') {
        ctx.fillStyle = '#ffcc0080';
        ctx.font = 'bold 12px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('HOLD & RELEASE PLUNGER', W / 2, PF_BOT + 44);
      } else if (s.phase === 'pulling') {
        const dots = Math.floor((performance.now() / 250) % 4);
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 12px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PULL' + '.'.repeat(dots), W / 2, PF_BOT + 44);
      } else {
        ctx.fillStyle = '#ffcc0050';
        ctx.font = '10px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2022 \u2022 \u2022', W / 2, PF_BOT + 44);
      }
    }

    function step() {
      const s = stateRef.current;

      const maxPull = 55;

      // Plunger pull
      if (s.phase === 'pulling' && s.pulling) {
        const elapsed = (performance.now() - s.pullStartTime) / 1000;
        s.plungerPull = Math.min(1, 1 - Math.exp(-elapsed * 1.8));
        s.pos.y = PF_BOT - 15 + s.plungerPull * maxPull;
      }

      // Spring-back
      if (s.phase === 'running' && s.plungerPull > 0) {
        s.plungerPull *= 0.82;
        if (s.plungerPull < 0.01) s.plungerPull = 0;
      }

      if (s.phase === 'running') {
        // Gravity (tilted table — ball rolls "down" toward player)
        s.vel.y += GRAVITY;
        // Friction
        s.vel.x *= FRICTION;
        s.vel.y *= FRICTION;

        s.pos.x += s.vel.x;
        s.pos.y += s.vel.y;

        // Trail
        s.trail.push({ x: s.pos.x, y: s.pos.y });
        if (s.trail.length > TRAIL_LEN) s.trail.shift();

        // --- COLLISIONS ---

        // Field peg collisions
        for (const peg of s.pegs) {
          const dx = s.pos.x - peg.x;
          const dy = s.pos.y - peg.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = BALL_R + PEG_R;
          if (dist < minDist && dist > 0) {
            const nx = dx / dist;
            const ny = dy / dist;
            s.pos.x = peg.x + nx * minDist;
            s.pos.y = peg.y + ny * minDist;
            const dot = s.vel.x * nx + s.vel.y * ny;
            s.vel.x = (s.vel.x - 2 * dot * nx) * PEG_DAMPING;
            s.vel.y = (s.vel.y - 2 * dot * ny) * PEG_DAMPING;
            s.vel.x += (Math.random() - 0.5) * 0.6;
            peg.hitTimer = 8;
          }
        }

        // Ring peg collisions (real physics — but gaps let the ball through)
        for (let i = 0; i < ALL_RING_PEGS.length; i++) {
          const rp = ALL_RING_PEGS[i]!;
          const dx = s.pos.x - rp.x;
          const dy = s.pos.y - rp.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = BALL_R + RING_PEG_R;
          if (dist < minDist && dist > 0) {
            const nx = dx / dist;
            const ny = dy / dist;
            s.pos.x = rp.x + nx * minDist;
            s.pos.y = rp.y + ny * minDist;
            const dot = s.vel.x * nx + s.vel.y * ny;
            s.vel.x = (s.vel.x - 2 * dot * nx) * PEG_DAMPING;
            s.vel.y = (s.vel.y - 2 * dot * ny) * PEG_DAMPING;
            s.vel.x += (Math.random() - 0.5) * 0.4;
            s.ringPegHitTimers.set(i, 6);
          }
        }

        // Hole capture — ball inside hole radius at moderate speed gets sucked in
        for (const hole of HOLES) {
          const dx = s.pos.x - hole.x;
          const dy = s.pos.y - hole.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
          if (dist < hole.r + 2 && speed < 4) {
            // Pull toward center
            s.vel.x += (hole.x - s.pos.x) * 0.08;
            s.vel.y += (hole.y - s.pos.y) * 0.08;
            if (dist < 5) {
              s.pos.x = hole.x;
              s.pos.y = hole.y;
              s.ballVisible = false;
              s.landedHole = hole;
              s.isDrain = false;
              s.resultText = pickGame();
              s.phase = 'landed';
              setPhase('landed');
              setScore(hole.label);
              setIsDrain(false);
              setResult(s.resultText);
              break;
            }
          }
        }

        // Arch boundary (elliptical top)
        collideArch(s.pos, s.vel);

        // Straight wall collisions (below the arch)
        if (s.pos.y >= ARCH_CY) {
          // Left wall
          if (s.pos.x - BALL_R < PF_LEFT) {
            s.pos.x = PF_LEFT + BALL_R;
            s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
          }
          // Right wall / plunger lane outer wall
          if (s.pos.x + BALL_R > PF_RIGHT) {
            s.pos.x = PF_RIGHT - BALL_R;
            s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
          }
        }

        // Plunger lane divider wall (only below LANE_TOP)
        if (s.pos.y > LANE_TOP) {
          // Ball coming from left, hitting the divider
          if (s.pos.x + BALL_R > LANE_DIVIDER_X && s.pos.x < LANE_DIVIDER_X + 5 && s.pos.y < PF_BOT) {
            s.pos.x = LANE_DIVIDER_X - BALL_R;
            s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
          }
          // Ball in the lane, hitting divider from right
          if (s.pos.x - BALL_R < LANE_DIVIDER_X && s.pos.x > LANE_DIVIDER_X - 5 && s.pos.x > LANE_CX - 15) {
            s.pos.x = LANE_DIVIDER_X + BALL_R;
            s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
          }
        }

        // Drain guide collisions — minimal damping so ball maintains speed rolling downhill
        collideLine(s.pos, s.vel, drainGuideL1, drainGuideL2, 0.9);
        collideLine(s.pos, s.vel, drainGuideR1, drainGuideR2, 0.9);

        // Drain detection
        if (s.pos.y + BALL_R > DRAIN_Y && s.pos.x > ARCH_CX - 35 && s.pos.x < ARCH_CX + 35) {
          s.ballVisible = false;
          s.isDrain = true;
          s.landedHole = null;
          s.resultText = pickGame();
          s.phase = 'landed';
          setPhase('landed');
          setScore(null);
          setIsDrain(true);
          setResult(s.resultText);
        }

        // Ball fell back into the plunger lane — allow re-plunge
        if (s.pos.x > LANE_DIVIDER_X && s.pos.y > PF_BOT - 60) {
          const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
          if (speed < 0.5) {
            // Reset to idle in the lane so user can plunge again
            s.pos = { x: LANE_CX, y: PF_BOT - 15 };
            s.vel = { x: 0, y: 0 };
            s.trail = [];
            s.plungerPull = 0;
            s.startTime = 0;
            s.phase = 'idle';
            setPhase('idle');
          }
        }

        // Stuck ball timeout
        if (s.startTime > 0) {
          const elapsed = (performance.now() - s.startTime) / 1000;
          if (elapsed > 30) {
            s.ballVisible = false;
            s.isDrain = true;
            s.landedHole = null;
            s.resultText = pickGame();
            s.phase = 'landed';
            setPhase('landed');
            setScore(null);
            setIsDrain(true);
            setResult(s.resultText);
          } else if (elapsed > 22) {
            s.vel.x += (Math.random() - 0.5) * 1.5;
            s.vel.y += 0.3;
          }
        }
      }

      draw();
      s.animId = requestAnimationFrame(step);
    }

    stateRef.current.animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(stateRef.current.animId);
  }, [pickGame]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-deep/90 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          className="rounded-lg cursor-pointer max-w-[92vw] max-h-[74vh] touch-none"
          style={{ imageRendering: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
        />
        {phase === 'landed' && result && (
          <div className="text-center">
            {isDrain ? (
              <p className="text-xs text-neon-coral uppercase tracking-wider mb-1">Drain!</p>
            ) : (
              <p className="text-xs text-muted uppercase tracking-wider mb-1">{score} Points</p>
            )}
            <p className="text-lg font-display font-bold text-neon-green glow-green animate-pulse">{result}</p>
          </div>
        )}
        <div className="flex gap-3">
          {phase === 'landed' && (
            <NeonButton variant="primary" onClick={handlePlayAgain}>
              Play Again
            </NeonButton>
          )}
          <NeonButton variant="ghost" onClick={onClose}>
            Close
          </NeonButton>
        </div>
      </div>
    </div>
  );
}
