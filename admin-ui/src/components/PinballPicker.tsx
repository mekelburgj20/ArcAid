import { useCallback, useEffect, useRef, useState } from 'react';
import NeonButton from './NeonButton';

interface PinballPickerProps {
  availableGames: string[];
  onClose: () => void;
}

type Phase = 'idle' | 'pulling' | 'running' | 'landed' | 'draining';

interface Vec2 { x: number; y: number }
interface Peg { x: number; y: number; hitTimer: number }
interface Hole { x: number; y: number; r: number; label: string; pegRingR: number }

// Canvas logical size
const W = 380;
const H = 680;
const BALL_R = 6;
const PEG_R = 3;
const GRAVITY = 0.12;
const PEG_DAMPING = 0.65;
const WALL_DAMPING = 0.4;
const TRAIL_LEN = 12;

// Playfield boundaries (inside the wood frame)
const FRAME = 16;
const PF_LEFT = FRAME;
const PF_RIGHT = W - FRAME;
const PF_TOP = 70;
const PF_BOT = H - 80;

// Plunger lane
const PLUNGE_LANE_X = PF_RIGHT - 28;
const PLUNGE_LANE_W = 22;
const PLUNGE_CX = PLUNGE_LANE_X + PLUNGE_LANE_W / 2;

// Drain zone — bottom of playfield
const DRAIN_Y = PF_BOT + 10;

// Colors — Ballyhoo-inspired palette
const WOOD_DARK = '#3a2518';
const WOOD_MID = '#5c3a24';
const WOOD_LIGHT = '#7a5438';
const PLAYFIELD_BG = '#e8d8a8';
const PLAYFIELD_CREAM = '#f0e6c0';
const NAIL_COLOR = '#888888';
const NAIL_HIT = '#dddddd';
const BALL_COLOR = '#c0c0c8';
const BALL_HIGHLIGHT = '#ffffff';
const BALL_SHADOW = '#888890';
const TITLE_COLOR = '#2a2068';
const HOLE_DARK = '#1a1a1a';
const HOLE_RIM = '#444444';
const LABEL_COLOR = '#2a2068';

// Diamond pattern colors
const DIAMOND_COLORS = [
  '#cc3333', '#3366cc', '#44aa44', '#8844aa',
  '#dd7722', '#cc3366', '#4488aa', '#66aa44',
];

// Hole definitions (positions on the playfield)
const HOLES: Hole[] = [
  { x: W / 2, y: 175, r: 14, label: '100', pegRingR: 24 },
  { x: PF_LEFT + 55, y: 260, r: 13, label: '100', pegRingR: 22 },
  { x: PF_RIGHT - 80, y: 260, r: 13, label: '100', pegRingR: 22 },
  { x: W / 2, y: 370, r: 15, label: '250', pegRingR: 26 },
  { x: PF_LEFT + 50, y: 420, r: 14, label: '200', pegRingR: 24 },
  { x: PF_RIGHT - 75, y: 420, r: 14, label: '200', pegRingR: 24 },
  { x: W / 2, y: 510, r: 15, label: '400', pegRingR: 26 },
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildPegs(): Peg[] {
  const pegs: Peg[] = [];
  const pegPositions: [number, number][] = [
    [95, 145], [140, 140], [190, 130], [240, 140], [280, 145],
    [150, 175], [225, 175], [170, 155], [210, 155],
    [80, 210], [130, 210], [180, 215], [230, 210], [280, 210],
    [105, 235], [160, 240], [220, 240], [260, 235],
    [80, 285], [130, 285], [230, 285], [280, 285],
    [110, 310], [160, 310], [220, 310], [260, 310],
    [85, 340], [140, 340], [190, 335], [240, 340], [290, 340],
    [140, 365], [230, 365], [155, 395], [220, 395],
    [80, 395], [100, 445], [280, 395], [270, 445],
    [140, 450], [190, 450], [230, 450],
    [110, 480], [160, 475], [220, 475], [270, 480],
    [140, 510], [230, 510], [155, 535], [215, 535],
    [120, 540], [250, 540],
  ];

  for (const [x, y] of pegPositions) {
    let tooClose = false;
    for (const hole of HOLES) {
      const dx = x - hole.x;
      const dy = y - hole.y;
      if (Math.sqrt(dx * dx + dy * dy) < hole.pegRingR + 4) {
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

function drawArch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, archH: number) {
  const left = x;
  const right = x + w;
  const bottom = y + h;
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(left, y + archH);
  ctx.arcTo(left, y, x + w / 2, y, w / 2);
  ctx.arcTo(right, y, right, y + archH, w / 2);
  ctx.lineTo(right, bottom);
  ctx.closePath();
}

export default function PinballPicker({ availableGames, onClose }: PinballPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [score, setScore] = useState<string | null>(null);
  const [isDrain, setIsDrain] = useState(false);

  const stateRef = useRef({
    pos: { x: PLUNGE_CX, y: PF_BOT - 20 } as Vec2,
    vel: { x: 0, y: 0 } as Vec2,
    trail: [] as Vec2[],
    pegs: buildPegs(),
    phase: 'idle' as Phase,
    startTime: 0,
    plungerPull: 0,
    animId: 0,
    landedHole: null as Hole | null,
    ballVisible: true,
    resultText: '',
    isDrain: false,
    // Plunger hold state
    pulling: false,
    pullStartTime: 0,
    drainTimer: 0,
  });

  const pickGame = useCallback(() => {
    return shuffle(availableGames)[0] || 'No games available';
  }, [availableGames]);

  const resetBall = useCallback(() => {
    const s = stateRef.current;
    s.pos = { x: PLUNGE_CX, y: PF_BOT - 20 };
    s.vel = { x: 0, y: 0 };
    s.trail = [];
    s.plungerPull = 0;
    s.pegs.forEach(p => (p.hitTimer = 0));
    s.startTime = 0;
    s.landedHole = null;
    s.ballVisible = true;
    s.resultText = '';
    s.isDrain = false;
    s.pulling = false;
    s.pullStartTime = 0;
    s.drainTimer = 0;
  }, []);

  // Handle plunger hold — mousedown/touchstart starts pulling
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const s = stateRef.current;
    if (s.phase !== 'idle') return;

    // Check if click is in plunger area (bottom-right of canvas)
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    // Plunger hit area — generous zone around the plunger knob
    if (cx > PLUNGE_LANE_X - 15 && cx < PLUNGE_LANE_X + PLUNGE_LANE_W + 15 &&
        cy > PF_BOT - 40 && cy < H) {
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
    const power = s.plungerPull; // 0..1

    if (power < 0.05) {
      // Too weak — snap back to idle
      s.plungerPull = 0;
      s.phase = 'idle';
      setPhase('idle');
      return;
    }

    // Launch! Power determines velocity
    const launchVel = 7 + power * 8; // 7..15
    s.vel = { x: -1 + Math.random() * -1.5, y: -launchVel };
    s.phase = 'running';
    s.startTime = performance.now();
    setPhase('running');

    const canvas = canvasRef.current;
    if (canvas) canvas.releasePointerCapture(e.pointerId);
  }, []);

  const handlePlayAgain = useCallback(() => {
    resetBall();
    stateRef.current.pegs = buildPegs();
    stateRef.current.phase = 'idle';
    setPhase('idle');
    setResult(null);
    setScore(null);
    setIsDrain(false);
  }, [resetBall]);

  // Main animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function drawDiamondPattern() {
      const size = 45;
      const rows = Math.ceil(H / size) + 1;
      const cols = Math.ceil(W / size) + 1;
      ctx.save();
      drawArch(ctx, PF_LEFT, PF_TOP - 50, PF_RIGHT - PF_LEFT, PF_BOT - PF_TOP + 50, 60);
      ctx.clip();
      for (let r = -1; r < rows; r++) {
        for (let c = -1; c < cols; c++) {
          const cx = c * size + (r % 2 === 0 ? 0 : size / 2);
          const cy = r * size * 0.7 + 40;
          ctx.beginPath();
          ctx.moveTo(cx, cy - size / 2);
          ctx.lineTo(cx + size / 2, cy);
          ctx.lineTo(cx, cy + size / 2);
          ctx.lineTo(cx - size / 2, cy);
          ctx.closePath();
          ctx.fillStyle = DIAMOND_COLORS[(r * 3 + c * 2 + (r + c)) % DIAMOND_COLORS.length]! + '30';
          ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawHoleRing(hole: Hole) {
      // Draw nail ring with a gap at the top so ball can enter
      const nailCount = Math.floor(hole.pegRingR * 1.2);
      const gapAngle = Math.PI * 0.35; // ~63 degree gap at top
      for (let i = 0; i < nailCount; i++) {
        const angle = (Math.PI * 2 / nailCount) * i;
        // Skip nails in the top gap (around -PI/2 i.e. straight up)
        const normAngle = ((angle + Math.PI * 2.5) % (Math.PI * 2)); // shift so 0 = top
        if (normAngle < gapAngle || normAngle > Math.PI * 2 - gapAngle) continue;
        const nx = hole.x + Math.cos(angle) * hole.pegRingR;
        const ny = hole.y + Math.sin(angle) * hole.pegRingR;
        ctx.beginPath();
        ctx.arc(nx, ny, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = NAIL_COLOR;
        ctx.fill();
      }
    }

    function draw() {
      const s = stateRef.current;
      ctx.clearRect(0, 0, W, H);

      // === WOOD FRAME ===
      ctx.fillStyle = WOOD_DARK;
      ctx.fillRect(0, 0, W, H);
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, WOOD_LIGHT);
      grad.addColorStop(0.5, WOOD_MID);
      grad.addColorStop(1, WOOD_DARK);
      ctx.fillStyle = grad;
      ctx.fillRect(6, 6, W - 12, H - 12);

      // === PLAYFIELD with arch top ===
      ctx.save();
      drawArch(ctx, PF_LEFT, PF_TOP - 50, PF_RIGHT - PF_LEFT, PF_BOT - PF_TOP + 80, 60);
      ctx.fillStyle = PLAYFIELD_BG;
      ctx.fill();
      drawArch(ctx, PF_LEFT, PF_TOP - 50, PF_RIGHT - PF_LEFT, PF_BOT - PF_TOP + 80, 60);
      ctx.strokeStyle = '#b8962e';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();

      // Diamond pattern overlay
      drawDiamondPattern();

      // Cream center diamond highlight
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(W / 2, PF_TOP + 20);
      ctx.lineTo(PF_RIGHT - 50, H / 2);
      ctx.lineTo(W / 2, PF_BOT - 30);
      ctx.lineTo(PF_LEFT + 50, H / 2);
      ctx.closePath();
      ctx.fillStyle = PLAYFIELD_CREAM + '40';
      ctx.fill();
      ctx.restore();

      // === DRAIN ZONE — opening at the bottom center ===
      // Draw two angled guides that funnel toward the drain
      ctx.strokeStyle = '#b8962e';
      ctx.lineWidth = 3;
      // Left guide
      ctx.beginPath();
      ctx.moveTo(PF_LEFT, PF_BOT - 10);
      ctx.lineTo(W / 2 - 35, PF_BOT + 18);
      ctx.stroke();
      // Right guide
      ctx.beginPath();
      ctx.moveTo(PLUNGE_LANE_X - 8, PF_BOT - 10);
      ctx.lineTo(W / 2 + 35, PF_BOT + 18);
      ctx.stroke();
      // Drain label
      ctx.fillStyle = '#88000080';
      ctx.font = 'bold 9px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('DRAIN', W / 2, PF_BOT + 4);

      // === TITLE ===
      ctx.save();
      ctx.fillStyle = TITLE_COLOR;
      ctx.font = 'bold 28px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GAME', W / 2 - 1, PF_TOP - 18);
      ctx.font = 'bold 22px serif';
      ctx.fillText('PICKER', W / 2, PF_TOP + 8);
      ctx.restore();

      // Side text
      ctx.save();
      ctx.fillStyle = TITLE_COLOR + '60';
      ctx.font = 'bold 14px serif';
      ctx.textAlign = 'center';
      ctx.translate(PF_LEFT + 14, H / 2 - 40);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('ARCAID', 0, 0);
      ctx.restore();
      ctx.save();
      ctx.fillStyle = TITLE_COLOR + '60';
      ctx.font = 'bold 14px serif';
      ctx.textAlign = 'center';
      ctx.translate(PF_RIGHT - 14, H / 2 - 40);
      ctx.rotate(Math.PI / 2);
      ctx.fillText('ARCAID', 0, 0);
      ctx.restore();

      // === HOLES ===
      for (const hole of HOLES) {
        drawHoleRing(hole);
        ctx.beginPath();
        ctx.arc(hole.x, hole.y + 1, hole.r + 2, 0, Math.PI * 2);
        ctx.fillStyle = '#00000040';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.fillStyle = HOLE_DARK;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.strokeStyle = HOLE_RIM;
        ctx.lineWidth = 2;
        ctx.stroke();
        const holeGrad = ctx.createRadialGradient(hole.x, hole.y - 2, 0, hole.x, hole.y, hole.r);
        holeGrad.addColorStop(0, '#33333380');
        holeGrad.addColorStop(1, '#00000000');
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.fillStyle = holeGrad;
        ctx.fill();
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = 'bold 13px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(hole.label, hole.x, hole.y - hole.r - 6);
        if (hole.label === '250') {
          ctx.font = '9px serif';
          ctx.textBaseline = 'top';
          ctx.fillText('FREE PLAY', hole.x, hole.y + hole.r + 5);
        }
      }

      // === PEGS ===
      for (const peg of s.pegs) {
        const bright = peg.hitTimer > 0;
        ctx.beginPath();
        ctx.arc(peg.x, peg.y, PEG_R, 0, Math.PI * 2);
        ctx.fillStyle = bright ? NAIL_HIT : NAIL_COLOR;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(peg.x - 0.5, peg.y - 0.5, PEG_R * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = bright ? '#ffffff' : '#bbbbbb';
        ctx.fill();
        if (bright) peg.hitTimer--;
      }

      // === PLUNGER LANE ===
      ctx.fillStyle = PLAYFIELD_BG;
      ctx.fillRect(PLUNGE_LANE_X - 3, PF_TOP + 40, PLUNGE_LANE_W + 6, PF_BOT - PF_TOP - 20);
      ctx.strokeStyle = '#b8962e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PLUNGE_LANE_X - 3, PF_TOP + 40);
      ctx.lineTo(PLUNGE_LANE_X - 3, PF_BOT + 20);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(PLUNGE_LANE_X + PLUNGE_LANE_W + 3, PF_TOP + 40);
      ctx.lineTo(PLUNGE_LANE_X + PLUNGE_LANE_W + 3, PF_BOT + 20);
      ctx.stroke();

      // Plunger — pull amount controls position
      const maxPull = 50;
      const pullOffset = s.plungerPull * maxPull;
      const plungerTipY = PF_BOT - 25 + pullOffset;

      // Rod
      ctx.fillStyle = '#888888';
      ctx.fillRect(PLUNGE_LANE_X + 6, plungerTipY, PLUNGE_LANE_W - 12, H - plungerTipY - 20);
      // Spring coils (visual when pulled)
      if (s.plungerPull > 0.05) {
        ctx.strokeStyle = '#666666';
        ctx.lineWidth = 1.5;
        const coils = 5;
        const springTop = PF_BOT - 25;
        const springBot = plungerTipY;
        const springH = springBot - springTop;
        for (let i = 0; i < coils; i++) {
          const y = springTop + (i + 0.5) * (springH / coils);
          ctx.beginPath();
          ctx.moveTo(PLUNGE_LANE_X + 4, y - 2);
          ctx.lineTo(PLUNGE_LANE_X + PLUNGE_LANE_W - 4, y + 2);
          ctx.stroke();
        }
      }
      // Knob
      const kGrad = ctx.createRadialGradient(PLUNGE_CX, plungerTipY + 5, 2, PLUNGE_CX, plungerTipY + 5, 10);
      kGrad.addColorStop(0, '#cc0000');
      kGrad.addColorStop(1, '#880000');
      ctx.beginPath();
      ctx.arc(PLUNGE_CX, plungerTipY + 5, 9, 0, Math.PI * 2);
      ctx.fillStyle = kGrad;
      ctx.fill();
      ctx.strokeStyle = '#660000';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Power indicator when pulling
      if (s.phase === 'pulling' && s.plungerPull > 0) {
        const barH = 80;
        const barX = PLUNGE_LANE_X + PLUNGE_LANE_W + 12;
        const barY = PF_BOT - barH;
        // Background
        ctx.fillStyle = '#00000040';
        ctx.fillRect(barX, barY, 8, barH);
        // Fill
        const fillH = barH * s.plungerPull;
        const powerColor = s.plungerPull < 0.5 ? '#44aa44' : s.plungerPull < 0.8 ? '#ddaa22' : '#cc3333';
        ctx.fillStyle = powerColor;
        ctx.fillRect(barX, barY + barH - fillH, 8, fillH);
        ctx.strokeStyle = '#b8962e';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, barY, 8, barH);
      }

      // === BALL ===
      if (s.ballVisible) {
        // Trail
        for (let i = 0; i < s.trail.length; i++) {
          const t = s.trail[i]!;
          const alpha = (i + 1) / s.trail.length * 0.25;
          const size = BALL_R * (0.4 + 0.6 * (i + 1) / s.trail.length);
          ctx.beginPath();
          ctx.arc(t.x, t.y, size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(180,180,188,${alpha})`;
          ctx.fill();
        }
        // Shadow
        ctx.beginPath();
        ctx.arc(s.pos.x + 1.5, s.pos.y + 1.5, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = '#00000030';
        ctx.fill();
        // Metallic ball
        const ballGrad = ctx.createRadialGradient(s.pos.x - 2, s.pos.y - 2, 1, s.pos.x, s.pos.y, BALL_R);
        ballGrad.addColorStop(0, BALL_HIGHLIGHT);
        ballGrad.addColorStop(0.4, BALL_COLOR);
        ballGrad.addColorStop(1, BALL_SHADOW);
        ctx.beginPath();
        ctx.arc(s.pos.x, s.pos.y, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = ballGrad;
        ctx.fill();
        ctx.strokeStyle = '#99999980';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // === RESULT AREA at bottom of table ===
      ctx.fillStyle = WOOD_DARK;
      ctx.fillRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 40);
      ctx.strokeStyle = '#b8962e';
      ctx.lineWidth = 1;
      ctx.strokeRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 40);

      if (s.phase === 'landed' && s.landedHole) {
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 11px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${s.landedHole.label} PTS`, W / 2, PF_BOT + 37);
        ctx.fillStyle = '#ffeeaa';
        ctx.font = 'bold 13px serif';
        ctx.fillText(s.resultText, W / 2, PF_BOT + 53);
      } else if (s.phase === 'landed' && s.isDrain) {
        ctx.fillStyle = '#ff6666';
        ctx.font = 'bold 11px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('DRAIN!', W / 2, PF_BOT + 37);
        ctx.fillStyle = '#ffeeaa';
        ctx.font = 'bold 13px serif';
        ctx.fillText(s.resultText, W / 2, PF_BOT + 53);
      } else if (s.phase === 'idle') {
        ctx.fillStyle = '#ffcc0090';
        ctx.font = 'bold 13px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('HOLD & RELEASE PLUNGER', W / 2, PF_BOT + 45);
      } else if (s.phase === 'pulling') {
        const dots = Math.floor((performance.now() / 300) % 4);
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 13px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PULL' + '.'.repeat(dots), W / 2, PF_BOT + 45);
      } else {
        ctx.fillStyle = '#ffcc0060';
        ctx.font = '11px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2022 \u2022 \u2022', W / 2, PF_BOT + 45);
      }
    }

    function step() {
      const s = stateRef.current;

      // Plunger pull animation — increases over time while holding
      if (s.phase === 'pulling' && s.pulling) {
        const elapsed = (performance.now() - s.pullStartTime) / 1000;
        // Ease-out: fast at start, slows near max. Full pull in ~1.5s
        s.plungerPull = Math.min(1, 1 - Math.exp(-elapsed * 2));
        // Ball follows plunger
        s.pos.y = PF_BOT - 20 + s.plungerPull * 50;
      }

      // Spring-back animation after release (plunger returns to resting position)
      if (s.phase === 'running' && s.plungerPull > 0) {
        s.plungerPull *= 0.85;
        if (s.plungerPull < 0.01) s.plungerPull = 0;
      }

      if (s.phase === 'running') {
        s.vel.y += GRAVITY;
        s.pos.x += s.vel.x;
        s.pos.y += s.vel.y;

        // Trail
        s.trail.push({ x: s.pos.x, y: s.pos.y });
        if (s.trail.length > TRAIL_LEN) s.trail.shift();

        // Peg collisions
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
            s.vel.x += (Math.random() - 0.5) * 1.0;
            peg.hitTimer = 8;
          }
        }

        // Hole capture — ring pegs are decorative only, ball rolls in freely
        for (const hole of HOLES) {
          const dx = s.pos.x - hole.x;
          const dy = s.pos.y - hole.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
          if (dist < hole.r && speed < 5) {
            // Gravity-suck the ball toward center
            s.vel.x = (hole.x - s.pos.x) * 0.4;
            s.vel.y = (hole.y - s.pos.y) * 0.4;
            if (dist < 4) {
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

        // Wall collisions
        if (s.pos.x - BALL_R < PF_LEFT) {
          s.pos.x = PF_LEFT + BALL_R;
          s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
        }
        if (s.pos.x + BALL_R > PF_RIGHT && s.pos.x < PLUNGE_LANE_X - 3) {
          s.pos.x = PF_RIGHT - BALL_R;
          s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
        }
        if (s.pos.x + BALL_R > PLUNGE_LANE_X + PLUNGE_LANE_W + 3) {
          s.pos.x = PLUNGE_LANE_X + PLUNGE_LANE_W + 3 - BALL_R;
          s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
        }
        // Plunger lane left wall
        if (s.pos.y > PF_TOP + 40 && s.pos.x > PLUNGE_LANE_X - 3 - BALL_R && s.pos.x < PLUNGE_LANE_X + PLUNGE_LANE_W + 3) {
          if (s.pos.x < PLUNGE_LANE_X - 3 + BALL_R && s.vel.x > 0) {
            s.pos.x = PLUNGE_LANE_X - 3 - BALL_R;
            s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
          }
        }
        // Top boundary
        if (s.pos.y - BALL_R < PF_TOP - 40) {
          s.pos.y = PF_TOP - 40 + BALL_R;
          s.vel.y = Math.abs(s.vel.y) * WALL_DAMPING;
        }

        // Drain guide collisions — angled walls at bottom
        // Left guide: from (PF_LEFT, PF_BOT-10) to (W/2-35, PF_BOT+18)
        // Right guide: from (PLUNGE_LANE_X-8, PF_BOT-10) to (W/2+35, PF_BOT+18)
        const guideLines: [Vec2, Vec2][] = [
          [{ x: PF_LEFT, y: PF_BOT - 10 }, { x: W / 2 - 35, y: PF_BOT + 18 }],
          [{ x: PLUNGE_LANE_X - 8, y: PF_BOT - 10 }, { x: W / 2 + 35, y: PF_BOT + 18 }],
        ];
        for (const [p1, p2] of guideLines) {
          const lx = p2.x - p1.x;
          const ly = p2.y - p1.y;
          const len = Math.sqrt(lx * lx + ly * ly);
          const nx = -ly / len; // normal
          const ny = lx / len;
          // Distance from ball center to line
          const dx = s.pos.x - p1.x;
          const dy = s.pos.y - p1.y;
          const d = dx * nx + dy * ny;
          // Project ball center onto line segment
          const t = (dx * lx + dy * ly) / (len * len);
          if (t >= -0.1 && t <= 1.1 && Math.abs(d) < BALL_R + 1.5) {
            // Push ball out
            const sign = d > 0 ? 1 : -1;
            s.pos.x = s.pos.x + nx * sign * (BALL_R + 1.5 - Math.abs(d));
            s.pos.y = s.pos.y + ny * sign * (BALL_R + 1.5 - Math.abs(d));
            // Reflect velocity
            const vDot = s.vel.x * nx * sign + s.vel.y * ny * sign;
            if (vDot < 0) {
              s.vel.x -= 2 * vDot * nx * sign;
              s.vel.y -= 2 * vDot * ny * sign;
              s.vel.x *= WALL_DAMPING;
              s.vel.y *= WALL_DAMPING;
            }
          }
        }

        // === DRAIN DETECTION — ball reaches the drain opening at bottom ===
        if (s.pos.y + BALL_R > DRAIN_Y && s.pos.x > W / 2 - 40 && s.pos.x < W / 2 + 40) {
          // Ball drained — animate it falling out
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

        // Stuck ball timeout
        if (s.startTime > 0) {
          const elapsed = (performance.now() - s.startTime) / 1000;
          if (elapsed > 25) {
            // Force drain
            s.ballVisible = false;
            s.isDrain = true;
            s.landedHole = null;
            s.resultText = pickGame();
            s.phase = 'landed';
            setPhase('landed');
            setScore(null);
            setIsDrain(true);
            setResult(s.resultText);
          } else if (elapsed > 18) {
            s.vel.x += (Math.random() - 0.5) * 2;
            s.vel.y += 0.5;
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
          className="rounded-lg cursor-pointer max-w-[92vw] max-h-[72vh] touch-none"
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
