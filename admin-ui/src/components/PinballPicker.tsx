import { useCallback, useEffect, useRef, useState } from 'react';
import NeonButton from './NeonButton';

interface PinballPickerProps {
  availableGames: string[];
  onClose: () => void;
}

type Phase = 'idle' | 'launching' | 'running' | 'landed';

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
const PF_TOP = 70; // below the arch
const PF_BOT = H - 80; // above result area

// Plunger lane
const PLUNGE_LANE_X = PF_RIGHT - 28;
const PLUNGE_LANE_W = 22;

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
  { x: W / 2, y: 175, r: 14, label: '100', pegRingR: 24 },        // top center (Bally Hole)
  { x: PF_LEFT + 55, y: 260, r: 13, label: '100', pegRingR: 22 }, // upper left
  { x: PF_RIGHT - 80, y: 260, r: 13, label: '100', pegRingR: 22 },// upper right
  { x: W / 2, y: 370, r: 15, label: '250', pegRingR: 26 },        // center (Free Play)
  { x: PF_LEFT + 50, y: 420, r: 14, label: '200', pegRingR: 24 }, // lower left
  { x: PF_RIGHT - 75, y: 420, r: 14, label: '200', pegRingR: 24 },// lower right
  { x: W / 2, y: 510, r: 15, label: '400', pegRingR: 26 },        // bottom center
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

  // Scattered nail pegs across the playfield — like the Ballyhoo photo
  // Cluster pegs around holes to deflect the ball, with gaps near holes
  const pegPositions: [number, number][] = [
    // Row near top
    [95, 145], [140, 140], [190, 130], [240, 140], [280, 145],
    // Around top hole
    [150, 175], [225, 175], [170, 155], [210, 155],
    // Between top and upper-side holes
    [80, 210], [130, 210], [180, 215], [230, 210], [280, 210],
    [105, 235], [160, 240], [220, 240], [260, 235],
    // Around upper side holes
    [80, 285], [130, 285], [230, 285], [280, 285],
    // Mid field
    [110, 310], [160, 310], [220, 310], [260, 310],
    [85, 340], [140, 340], [190, 335], [240, 340], [290, 340],
    // Around center hole
    [140, 365], [230, 365], [155, 395], [220, 395],
    // Around lower side holes
    [80, 395], [100, 445], [280, 395], [270, 445],
    // Lower field
    [140, 450], [190, 450], [230, 450],
    [110, 480], [160, 475], [220, 475], [270, 480],
    // Around bottom hole
    [140, 510], [230, 510], [155, 535], [215, 535],
    [120, 540], [250, 540],
  ];

  for (const [x, y] of pegPositions) {
    // Skip pegs that overlap with holes
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

  const stateRef = useRef({
    pos: { x: PLUNGE_LANE_X + PLUNGE_LANE_W / 2, y: PF_BOT - 20 } as Vec2,
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
  });

  const pickGame = useCallback(() => {
    return shuffle(availableGames)[0] || 'No games available';
  }, [availableGames]);

  const resetBall = useCallback(() => {
    const s = stateRef.current;
    s.pos = { x: PLUNGE_LANE_X + PLUNGE_LANE_W / 2, y: PF_BOT - 20 };
    s.vel = { x: 0, y: 0 };
    s.trail = [];
    s.plungerPull = 0;
    s.pegs.forEach(p => (p.hitTimer = 0));
    s.startTime = 0;
    s.landedHole = null;
    s.ballVisible = true;
  }, []);

  const launch = useCallback(() => {
    const s = stateRef.current;
    resetBall();
    s.phase = 'launching';
    s.plungerPull = 0;
    setPhase('launching');
    setResult(null);
    setScore(null);

    let pull = 0;
    const pullInterval = setInterval(() => {
      pull += 0.04;
      s.plungerPull = Math.min(pull, 1);
      if (pull >= 1) {
        clearInterval(pullInterval);
        s.vel = { x: -1.5 + Math.random() * -2, y: -(11 + Math.random() * 3) };
        s.phase = 'running';
        s.startTime = performance.now();
        setPhase('running');
      }
    }, 25);
  }, [resetBall]);

  // Main animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    // Precompute diamond pattern
    function drawDiamondPattern() {
      const size = 45;
      const rows = Math.ceil(H / size) + 1;
      const cols = Math.ceil(W / size) + 1;

      ctx.save();
      // Clip to playfield arch
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
      // Ring of tiny nails around the hole (like in the photo)
      const nailCount = Math.floor(hole.pegRingR * 1.2);
      for (let i = 0; i < nailCount; i++) {
        const angle = (Math.PI * 2 / nailCount) * i;
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
      // Outer frame
      ctx.fillStyle = WOOD_DARK;
      ctx.fillRect(0, 0, W, H);

      // Inner frame bevel
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

      // Gold arch border
      drawArch(ctx, PF_LEFT, PF_TOP - 50, PF_RIGHT - PF_LEFT, PF_BOT - PF_TOP + 80, 60);
      ctx.strokeStyle = '#b8962e';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();

      // Diamond pattern overlay
      drawDiamondPattern();

      // Cream center highlight (like Ballyhoo's light center area)
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

      // === TITLE (Ballyhoo-style) ===
      ctx.save();
      ctx.fillStyle = TITLE_COLOR;
      ctx.font = 'bold 28px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GAME', W / 2 - 1, PF_TOP - 18);
      ctx.font = 'bold 22px serif';
      ctx.fillText('PICKER', W / 2, PF_TOP + 8);
      ctx.restore();

      // Side text (like "BALLYHOO" vertically)
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
        // Nail ring
        drawHoleRing(hole);

        // Hole shadow
        ctx.beginPath();
        ctx.arc(hole.x, hole.y + 1, hole.r + 2, 0, Math.PI * 2);
        ctx.fillStyle = '#00000040';
        ctx.fill();

        // Hole body
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.fillStyle = HOLE_DARK;
        ctx.fill();

        // Hole rim
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.strokeStyle = HOLE_RIM;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Hole inner bevel
        const holeGrad = ctx.createRadialGradient(hole.x, hole.y - 2, 0, hole.x, hole.y, hole.r);
        holeGrad.addColorStop(0, '#33333380');
        holeGrad.addColorStop(1, '#00000000');
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        ctx.fillStyle = holeGrad;
        ctx.fill();

        // Point label above hole
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = 'bold 13px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(hole.label, hole.x, hole.y - hole.r - 6);

        // Special label for center hole
        if (hole.label === '250') {
          ctx.font = '9px serif';
          ctx.textBaseline = 'top';
          ctx.fillText('FREE PLAY', hole.x, hole.y + hole.r + 5);
        }
      }

      // === PEGS (nails) ===
      for (const peg of s.pegs) {
        const bright = peg.hitTimer > 0;
        // Nail base
        ctx.beginPath();
        ctx.arc(peg.x, peg.y, PEG_R, 0, Math.PI * 2);
        ctx.fillStyle = bright ? NAIL_HIT : NAIL_COLOR;
        ctx.fill();
        // Nail head highlight
        ctx.beginPath();
        ctx.arc(peg.x - 0.5, peg.y - 0.5, PEG_R * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = bright ? '#ffffff' : '#bbbbbb';
        ctx.fill();
        if (bright) peg.hitTimer--;
      }

      // === PLUNGER LANE ===
      ctx.fillStyle = PLAYFIELD_BG;
      ctx.fillRect(PLUNGE_LANE_X - 3, PF_TOP + 40, PLUNGE_LANE_W + 6, PF_BOT - PF_TOP - 20);
      // Lane walls
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

      // Plunger
      const plungerBaseY = PF_BOT + 10;
      const plungerH = 35;
      const pullOffset = s.plungerPull * 25;
      // Plunger rod
      ctx.fillStyle = '#888888';
      ctx.fillRect(PLUNGE_LANE_X + 6, plungerBaseY - plungerH + pullOffset - 30, PLUNGE_LANE_W - 12, 50);
      // Plunger knob
      const kGrad = ctx.createRadialGradient(
        PLUNGE_LANE_X + PLUNGE_LANE_W / 2, plungerBaseY - plungerH + pullOffset + 5, 2,
        PLUNGE_LANE_X + PLUNGE_LANE_W / 2, plungerBaseY - plungerH + pullOffset + 5, 10
      );
      kGrad.addColorStop(0, '#cc0000');
      kGrad.addColorStop(1, '#880000');
      ctx.beginPath();
      ctx.arc(PLUNGE_LANE_X + PLUNGE_LANE_W / 2, plungerBaseY - plungerH + pullOffset + 5, 9, 0, Math.PI * 2);
      ctx.fillStyle = kGrad;
      ctx.fill();
      ctx.strokeStyle = '#660000';
      ctx.lineWidth = 1.5;
      ctx.stroke();

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

        // Ball shadow
        ctx.beginPath();
        ctx.arc(s.pos.x + 1.5, s.pos.y + 1.5, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = '#00000030';
        ctx.fill();

        // Ball body — metallic silver
        const ballGrad = ctx.createRadialGradient(
          s.pos.x - 2, s.pos.y - 2, 1,
          s.pos.x, s.pos.y, BALL_R
        );
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
      // Dark scoreboard area
      ctx.fillStyle = WOOD_DARK;
      ctx.fillRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 40);
      ctx.strokeStyle = '#b8962e';
      ctx.lineWidth = 1;
      ctx.strokeRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 40);

      if (s.phase === 'landed' && s.landedHole) {
        // Show score + game name in the scoreboard area
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 11px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${s.landedHole.label} PTS`, W / 2, PF_BOT + 37);

        // Game name displayed below in a nice banner
        ctx.fillStyle = '#ffeeaa';
        ctx.font = 'bold 13px serif';
        ctx.fillText(stateRef.current.resultText || '', W / 2, PF_BOT + 53);
      } else if (s.phase === 'idle') {
        ctx.fillStyle = '#ffcc0090';
        ctx.font = 'bold 13px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('CLICK TO LAUNCH', W / 2, PF_BOT + 45);
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

        // Hole ring peg collisions (invisible physics pegs around holes)
        for (const hole of HOLES) {
          const nailCount = Math.floor(hole.pegRingR * 1.2);
          for (let i = 0; i < nailCount; i++) {
            const angle = (Math.PI * 2 / nailCount) * i;
            const nx2 = hole.x + Math.cos(angle) * hole.pegRingR;
            const ny2 = hole.y + Math.sin(angle) * hole.pegRingR;
            const dx = s.pos.x - nx2;
            const dy = s.pos.y - ny2;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = BALL_R + 1.5;
            if (dist < minDist && dist > 0) {
              const nnx = dx / dist;
              const nny = dy / dist;
              s.pos.x = nx2 + nnx * minDist;
              s.pos.y = ny2 + nny * minDist;
              const dot = s.vel.x * nnx + s.vel.y * nny;
              s.vel.x = (s.vel.x - 2 * dot * nnx) * PEG_DAMPING;
              s.vel.y = (s.vel.y - 2 * dot * nny) * PEG_DAMPING;
            }
          }
        }

        // Hole capture — ball falls in if close enough and slow enough
        for (const hole of HOLES) {
          const dx = s.pos.x - hole.x;
          const dy = s.pos.y - hole.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
          // Ball must be inside the hole radius and moving slowly enough
          if (dist < hole.r - 1 && speed < 3.5) {
            // Suck ball into center
            s.vel.x = (hole.x - s.pos.x) * 0.3;
            s.vel.y = (hole.y - s.pos.y) * 0.3;
            if (dist < 3) {
              s.pos.x = hole.x;
              s.pos.y = hole.y;
              s.ballVisible = false;
              s.landedHole = hole;
              s.phase = 'landed';
              stateRef.current.resultText = pickGame();
              setPhase('landed');
              setScore(hole.label);
              setResult(stateRef.current.resultText);
              break;
            }
          }
        }

        // Wall collisions (playfield arch shape approximated as rect + curved top)
        if (s.pos.x - BALL_R < PF_LEFT) {
          s.pos.x = PF_LEFT + BALL_R;
          s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
        }
        // Right wall — but not in plunger lane
        if (s.pos.x + BALL_R > PF_RIGHT && s.pos.x < PLUNGE_LANE_X - 3) {
          s.pos.x = PF_RIGHT - BALL_R;
          s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
        }
        // Plunger lane right wall
        if (s.pos.x + BALL_R > PLUNGE_LANE_X + PLUNGE_LANE_W + 3) {
          s.pos.x = PLUNGE_LANE_X + PLUNGE_LANE_W + 3 - BALL_R;
          s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
        }
        // Plunger lane left wall (only below the exit point)
        if (s.pos.y > PF_TOP + 40 && s.pos.x > PLUNGE_LANE_X - 3 - BALL_R && s.pos.x < PLUNGE_LANE_X + PLUNGE_LANE_W + 3) {
          if (s.pos.x < PLUNGE_LANE_X - 3 + BALL_R && s.vel.x > 0) {
            s.pos.x = PLUNGE_LANE_X - 3 - BALL_R;
            s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
          }
        }

        // Top boundary (arch)
        if (s.pos.y - BALL_R < PF_TOP - 40) {
          s.pos.y = PF_TOP - 40 + BALL_R;
          s.vel.y = Math.abs(s.vel.y) * WALL_DAMPING;
        }
        // Bottom boundary
        if (s.pos.y + BALL_R > PF_BOT + 15) {
          s.pos.y = PF_BOT + 15 - BALL_R;
          s.vel.y = -Math.abs(s.vel.y) * 0.3;
        }

        // Stuck ball timeout
        if (s.startTime > 0) {
          const elapsed = (performance.now() - s.startTime) / 1000;
          if (elapsed > 20) {
            // Force into nearest hole
            let nearest = HOLES[3]!; // center as default
            let nearDist = Infinity;
            for (const hole of HOLES) {
              const dx = s.pos.x - hole.x;
              const dy = s.pos.y - hole.y;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < nearDist) { nearDist = d; nearest = hole; }
            }
            s.pos.x = nearest.x;
            s.pos.y = nearest.y;
            s.ballVisible = false;
            s.landedHole = nearest;
            s.phase = 'landed';
            stateRef.current.resultText = pickGame();
            setPhase('landed');
            setScore(nearest.label);
            setResult(stateRef.current.resultText);
          } else if (elapsed > 15) {
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

  const handleCanvasClick = useCallback(() => {
    if (stateRef.current.phase === 'idle') {
      launch();
    }
  }, [launch]);

  const handlePlayAgain = useCallback(() => {
    resetBall();
    stateRef.current.pegs = buildPegs();
    launch();
  }, [launch, resetBall]);

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
          onClick={handleCanvasClick}
          className="rounded-lg cursor-pointer max-w-[92vw] max-h-[72vh]"
          style={{ imageRendering: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
        />

        {phase === 'landed' && result && (
          <div className="text-center">
            <p className="text-xs text-muted uppercase tracking-wider mb-1">{score} Points</p>
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
