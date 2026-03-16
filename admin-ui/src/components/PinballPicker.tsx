import { useCallback, useEffect, useRef, useState } from 'react';
import NeonButton from './NeonButton';

interface PinballPickerProps {
  availableGames: string[];
  onClose: () => void;
}

type Phase = 'idle' | 'launching' | 'running' | 'landed';

interface Vec2 { x: number; y: number }

interface Peg { x: number; y: number; hitTimer: number }

const W = 380;
const H = 600;
const BALL_R = 7;
const PEG_R = 5;
const GRAVITY = 0.15;
const PEG_DAMPING = 0.7;
const WALL_DAMPING = 0.5;
const TRAIL_LEN = 15;
const SLOT_COUNT = 7;
const SLOT_Y = 460;
const SLOT_H = 50;
const DIVIDER_TOP = SLOT_Y;
const DIVIDER_BOT = SLOT_Y + SLOT_H;
const PLUNGE_X = 345;
const PLUNGE_W = 25;
const LEFT_WALL = 15;
const RIGHT_WALL = W - 15;
const TOP_RAIL = 30;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function resolveColor(prop: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
}

function buildPegs(): Peg[] {
  const pegs: Peg[] = [];
  const rows = 9;
  const startY = 130;
  const rowSpacing = 35;
  const xMin = 35;
  const xMax = 320;

  for (let r = 0; r < rows; r++) {
    const cols = r % 2 === 0 ? 8 : 7;
    const offset = r % 2 === 0 ? 0 : (xMax - xMin) / (8 - 1) / 2;
    for (let c = 0; c < cols; c++) {
      const x = xMin + offset + c * ((xMax - xMin) / (cols - 1 || 1));
      pegs.push({ x, y: startY + r * rowSpacing, hitTimer: 0 });
    }
  }
  // Top arc guide pegs
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI * 0.15 + (Math.PI * 0.7 / 5) * i;
    pegs.push({
      x: W / 2 + Math.cos(angle) * 150,
      y: TOP_RAIL + 30 - Math.sin(angle) * 50,
      hitTimer: 0,
    });
  }
  return pegs;
}

export default function PinballPicker({ availableGames, onClose }: PinballPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [, setSlotGames] = useState<string[]>([]);

  const stateRef = useRef({
    pos: { x: PLUNGE_X + PLUNGE_W / 2, y: H - 30 } as Vec2,
    vel: { x: 0, y: 0 } as Vec2,
    trail: [] as Vec2[],
    pegs: buildPegs(),
    phase: 'idle' as Phase,
    slotGames: [] as string[],
    startTime: 0,
    plungerPull: 0,
    animId: 0,
  });

  const colorsRef = useRef({
    deep: '#0a0a14',
    surface: '#12121f',
    border: '#2a2a4a',
    neonCyan: '#00d4ff',
    neonGreen: '#39ff14',
    neonPurple: '#aa00ff',
    neonAmber: '#ffaa00',
    primary: '#e0e0ff',
  });

  // Read theme colors on mount
  useEffect(() => {
    const c = colorsRef.current;
    c.deep = resolveColor('--color-deep') || c.deep;
    c.surface = resolveColor('--color-surface') || c.surface;
    c.border = resolveColor('--color-border') || c.border;
    c.neonCyan = resolveColor('--color-neon-cyan') || c.neonCyan;
    c.neonGreen = resolveColor('--color-neon-green') || c.neonGreen;
    c.neonPurple = resolveColor('--color-neon-purple') || c.neonPurple;
    c.neonAmber = resolveColor('--color-neon-amber') || c.neonAmber;
    c.primary = resolveColor('--color-primary') || c.primary;
  }, []);

  const assignSlots = useCallback(() => {
    const count = Math.min(SLOT_COUNT, availableGames.length);
    const picked = shuffle(availableGames).slice(0, count);
    setSlotGames(picked);
    stateRef.current.slotGames = picked;
    return picked;
  }, [availableGames]);

  const resetBall = useCallback(() => {
    const s = stateRef.current;
    s.pos = { x: PLUNGE_X + PLUNGE_W / 2, y: H - 30 };
    s.vel = { x: 0, y: 0 };
    s.trail = [];
    s.plungerPull = 0;
    s.pegs.forEach(p => (p.hitTimer = 0));
    s.startTime = 0;
  }, []);

  const launch = useCallback(() => {
    const s = stateRef.current;
    resetBall();
    assignSlots();
    s.phase = 'launching';
    s.plungerPull = 0;
    setPhase('launching');
    setResult(null);

    // Animate plunger pull then release
    let pull = 0;
    const pullInterval = setInterval(() => {
      pull += 0.05;
      s.plungerPull = Math.min(pull, 1);
      if (pull >= 1) {
        clearInterval(pullInterval);
        // Release!
        s.vel = { x: -0.5 + Math.random() * -1.5, y: -(12 + Math.random() * 3) };
        s.phase = 'running';
        s.startTime = performance.now();
        setPhase('running');
      }
    }, 30);
  }, [assignSlots, resetBall]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const slotWidth = (RIGHT_WALL - LEFT_WALL - PLUNGE_W - 5) / SLOT_COUNT;
    const slotLeft = LEFT_WALL;

    function getSlotIndex(x: number): number {
      const idx = Math.floor((x - slotLeft) / slotWidth);
      return Math.max(0, Math.min(SLOT_COUNT - 1, idx));
    }

    function draw() {
      const s = stateRef.current;
      const c = colorsRef.current;

      ctx.clearRect(0, 0, W, H);

      // Background
      ctx.fillStyle = c.deep;
      ctx.fillRect(0, 0, W, H);

      // Walls with neon glow
      ctx.strokeStyle = c.neonPurple;
      ctx.lineWidth = 3;
      ctx.shadowColor = c.neonPurple;
      ctx.shadowBlur = 10;

      // Left wall
      ctx.beginPath();
      ctx.moveTo(LEFT_WALL, DIVIDER_BOT);
      ctx.lineTo(LEFT_WALL, TOP_RAIL);
      ctx.stroke();

      // Top rail
      ctx.beginPath();
      ctx.moveTo(LEFT_WALL, TOP_RAIL);
      ctx.lineTo(RIGHT_WALL, TOP_RAIL);
      ctx.stroke();

      // Right wall (with plunge lane gap)
      ctx.beginPath();
      ctx.moveTo(RIGHT_WALL, TOP_RAIL);
      ctx.lineTo(RIGHT_WALL, DIVIDER_BOT);
      ctx.stroke();

      // Plunge lane left wall
      ctx.beginPath();
      ctx.moveTo(PLUNGE_X - 5, TOP_RAIL + 60);
      ctx.lineTo(PLUNGE_X - 5, DIVIDER_BOT);
      ctx.stroke();

      ctx.shadowBlur = 0;

      // Pegs
      for (const peg of s.pegs) {
        const bright = peg.hitTimer > 0;
        ctx.beginPath();
        ctx.arc(peg.x, peg.y, PEG_R, 0, Math.PI * 2);
        if (bright) {
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = c.neonCyan;
          ctx.shadowBlur = 15;
          peg.hitTimer--;
        } else {
          ctx.fillStyle = c.neonCyan;
          ctx.shadowColor = c.neonCyan;
          ctx.shadowBlur = 4;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Slot dividers and labels
      const games = s.slotGames.length > 0 ? s.slotGames : [];
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 2;
      for (let i = 0; i <= SLOT_COUNT; i++) {
        const x = slotLeft + i * slotWidth;
        ctx.beginPath();
        ctx.moveTo(x, DIVIDER_TOP);
        ctx.lineTo(x, DIVIDER_BOT);
        ctx.stroke();
      }
      // Bottom of slots
      ctx.beginPath();
      ctx.moveTo(slotLeft, DIVIDER_BOT);
      ctx.lineTo(slotLeft + SLOT_COUNT * slotWidth, DIVIDER_BOT);
      ctx.stroke();

      // Slot labels
      ctx.fillStyle = c.primary;
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < games.length; i++) {
        const cx = slotLeft + (i + 0.5) * slotWidth;
        // Draw rotated text to fit
        ctx.save();
        ctx.translate(cx, SLOT_Y + SLOT_H / 2);
        ctx.rotate(-Math.PI / 6);
        ctx.fillText(truncate(games[i]!, 12), 0, 0);
        ctx.restore();
      }

      // Plunger
      const plungerBaseY = H - 10;
      const plungerH = 40;
      const pullOffset = s.plungerPull * 30;
      ctx.fillStyle = c.neonAmber;
      ctx.shadowColor = c.neonAmber;
      ctx.shadowBlur = 6;
      ctx.fillRect(PLUNGE_X, plungerBaseY - plungerH + pullOffset, PLUNGE_W, plungerH);
      ctx.shadowBlur = 0;

      // Ball trail
      for (let i = 0; i < s.trail.length; i++) {
        const t = s.trail[i]!;
        const alpha = (i + 1) / s.trail.length * 0.5;
        const size = BALL_R * (0.3 + 0.7 * (i + 1) / s.trail.length);
        ctx.beginPath();
        ctx.arc(t.x, t.y, size, 0, Math.PI * 2);
        ctx.fillStyle = c.neonGreen + Math.round(alpha * 255).toString(16).padStart(2, '0');
        ctx.fill();
      }

      // Ball
      if (s.phase !== 'idle' || true) {
        ctx.beginPath();
        ctx.arc(s.pos.x, s.pos.y, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = c.neonGreen;
        ctx.shadowColor = c.neonGreen;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Specular highlight
        ctx.beginPath();
        ctx.arc(s.pos.x - 2, s.pos.y - 2, BALL_R * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fill();
      }

      // "CLICK TO LAUNCH" text in idle
      if (s.phase === 'idle') {
        ctx.fillStyle = c.neonAmber;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.shadowColor = c.neonAmber;
        ctx.shadowBlur = 8;
        ctx.fillText('CLICK TO LAUNCH', W / 2, H / 2 + 60);
        ctx.shadowBlur = 0;
      }

      // Title
      ctx.fillStyle = c.neonCyan;
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = c.neonCyan;
      ctx.shadowBlur = 8;
      ctx.fillText('PINBALL GAME PICKER', W / 2, TOP_RAIL - 8);
      ctx.shadowBlur = 0;
    }

    function step() {
      const s = stateRef.current;

      if (s.phase === 'running') {
        // Gravity
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
            // Push out
            const nx = dx / dist;
            const ny = dy / dist;
            s.pos.x = peg.x + nx * minDist;
            s.pos.y = peg.y + ny * minDist;
            // Reflect
            const dot = s.vel.x * nx + s.vel.y * ny;
            s.vel.x = (s.vel.x - 2 * dot * nx) * PEG_DAMPING;
            s.vel.y = (s.vel.y - 2 * dot * ny) * PEG_DAMPING;
            // Random lateral perturbation
            s.vel.x += (Math.random() - 0.5) * 1.2;
            peg.hitTimer = 8;
          }
        }

        // Wall collisions
        // Left wall
        if (s.pos.x - BALL_R < LEFT_WALL) {
          s.pos.x = LEFT_WALL + BALL_R;
          s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
        }
        // Right wall
        if (s.pos.x + BALL_R > RIGHT_WALL) {
          s.pos.x = RIGHT_WALL - BALL_R;
          s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
        }
        // Top rail
        if (s.pos.y - BALL_R < TOP_RAIL) {
          s.pos.y = TOP_RAIL + BALL_R;
          s.vel.y = Math.abs(s.vel.y) * WALL_DAMPING;
        }
        // Plunge lane left wall (only when ball is below the arc exit)
        if (s.pos.y > TOP_RAIL + 60 && s.pos.x > PLUNGE_X - 5 - BALL_R && s.pos.x < PLUNGE_X - 5 + BALL_R) {
          if (s.vel.x > 0) {
            s.pos.x = PLUNGE_X - 5 - BALL_R;
            s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
          }
        }

        // Slot divider collisions
        for (let i = 0; i <= SLOT_COUNT; i++) {
          const dx = slotLeft + i * slotWidth;
          if (s.pos.y + BALL_R > DIVIDER_TOP && s.pos.y - BALL_R < DIVIDER_BOT) {
            if (Math.abs(s.pos.x - dx) < BALL_R + 1) {
              if (s.pos.x < dx) {
                s.pos.x = dx - BALL_R - 1;
                s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
              } else {
                s.pos.x = dx + BALL_R + 1;
                s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
              }
            }
          }
        }

        // Slot bottom
        if (s.pos.y + BALL_R > DIVIDER_BOT) {
          s.pos.y = DIVIDER_BOT - BALL_R;
          s.vel.y = -Math.abs(s.vel.y) * 0.3;
        }

        // Landing detection
        const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
        if (s.pos.y >= DIVIDER_BOT - BALL_R - 2 && speed < 0.8) {
          const idx = getSlotIndex(s.pos.x);
          const game = s.slotGames[idx];
          if (game) {
            s.phase = 'landed';
            setPhase('landed');
            setResult(game);
          }
        }

        // Stuck ball timeout
        if (s.startTime > 0) {
          const elapsed = (performance.now() - s.startTime) / 1000;
          if (elapsed > 20) {
            // Force land
            const idx = getSlotIndex(s.pos.x);
            const game = s.slotGames[idx] || s.slotGames[0];
            s.phase = 'landed';
            setPhase('landed');
            setResult(game!);
          } else if (elapsed > 15) {
            // Nudge
            s.vel.x += (Math.random() - 0.5) * 3;
            s.vel.y += 1;
          }
        }
      }

      draw();
      s.animId = requestAnimationFrame(step);
    }

    stateRef.current.animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(stateRef.current.animId);
  }, []);

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

  // Initialize slots on first render
  useEffect(() => {
    assignSlots();
  }, [assignSlots]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-deep/90 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          onClick={handleCanvasClick}
          className="rounded-lg border border-border cursor-pointer max-w-[90vw] max-h-[70vh]"
          style={{ imageRendering: 'auto' }}
        />

        {phase === 'landed' && result && (
          <div className="text-center animate-pulse">
            <p className="text-xs text-muted uppercase tracking-wider mb-1">Selected Game</p>
            <p className="text-xl font-display font-bold text-neon-green glow-green">{result}</p>
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
