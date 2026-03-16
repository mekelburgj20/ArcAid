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
const RING_PEG_R = 2;

// Delta-time physics — constants tuned for 60fps, scaled each frame
const BASE_FPS = 60;
const GRAVITY = 0.045;
const FRICTION = 0.9985;
const PEG_DAMPING = 0.6;
const WALL_DAMPING = 0.55;
const TRAIL_LEN = 10;

// Playfield frame
const FRAME = 14;
const PF_LEFT = FRAME;
const PF_RIGHT = W - FRAME;
const PF_BOT = H - 75;

// Arch (elliptical top boundary)
const ARCH_CX = (PF_LEFT + PF_RIGHT) / 2;
const ARCH_RX = (PF_RIGHT - PF_LEFT) / 2;
const ARCH_RY = 75;
const ARCH_CY = 85;

// Plunger lane
const LANE_DIVIDER_X = PF_RIGHT - 30;
const LANE_RIGHT = PF_RIGHT;
const LANE_CX = (LANE_DIVIDER_X + LANE_RIGHT) / 2;
const LANE_TOP = ARCH_CY + 5;

// Drain
const DRAIN_Y = PF_BOT + 12;

// Colors
const WOOD_DARK = '#3a2518';
const WOOD_MID = '#5c3a24';
const WOOD_LIGHT = '#7a5438';
const WOOD_HIGHLIGHT = '#9a7858';
const GOLD_TRIM = '#b8962e';
const PLAYFIELD_BG = '#e8d8a8';
const PLAYFIELD_CREAM = '#f0e6c0';
const NAIL_COLOR = '#666666';
const NAIL_HIT = '#cccccc';
const NAIL_HIGHLIGHT = '#999999';
const BALL_COLOR = '#c0c0c8';
const BALL_HIGHLIGHT = '#ffffff';
const BALL_SHADOW = '#888890';
const TITLE_COLOR = '#2a2068';
const HOLE_DARK = '#0a0a0a';
const HOLE_RIM = '#444444';
const LABEL_COLOR = '#2a2068';
const DIAMOND_COLORS = [
  '#cc3333', '#3366cc', '#44aa44', '#8844aa',
  '#dd7722', '#cc3366', '#4488aa', '#66aa44',
];

const HOLES: Hole[] = [
  { x: 190, y: 170, r: 12, label: '100', ringR: 20, gapAngle: 0.75 },
  { x: 70,  y: 240, r: 11, label: '50',  ringR: 19, gapAngle: 0.75 },
  { x: 190, y: 250, r: 11, label: '150', ringR: 19, gapAngle: 0.75 },
  { x: 285, y: 240, r: 11, label: '50',  ringR: 19, gapAngle: 0.75 },
  { x: 120, y: 330, r: 12, label: '100', ringR: 20, gapAngle: 0.7 },
  { x: 240, y: 330, r: 12, label: '100', ringR: 20, gapAngle: 0.7 },
  { x: 190, y: 390, r: 13, label: '250', ringR: 22, gapAngle: 0.65 },
  { x: 55,  y: 440, r: 12, label: '200', ringR: 20, gapAngle: 0.7 },
  { x: 290, y: 440, r: 12, label: '200', ringR: 20, gapAngle: 0.7 },
  { x: 140, y: 490, r: 11, label: '150', ringR: 19, gapAngle: 0.75 },
  { x: 240, y: 490, r: 11, label: '150', ringR: 19, gapAngle: 0.75 },
  { x: 190, y: 545, r: 13, label: '400', ringR: 22, gapAngle: 0.65 },
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildRingPegs(hole: Hole): Vec2[] {
  const pegs: Vec2[] = [];
  const circumference = 2 * Math.PI * hole.ringR;
  const spacing = (RING_PEG_R * 2 + 2);
  const count = Math.floor(circumference / spacing);
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI / count) * i - Math.PI / 2;
    const fromTop = Math.abs(((angle + Math.PI / 2 + Math.PI) % (2 * Math.PI)) - Math.PI);
    if (fromTop < hole.gapAngle) continue;
    pegs.push({
      x: hole.x + Math.cos(angle) * hole.ringR,
      y: hole.y + Math.sin(angle) * hole.ringR,
    });
  }
  return pegs;
}

const ALL_RING_PEGS: Vec2[] = HOLES.flatMap(h => buildRingPegs(h));

function buildFieldPegs(): Peg[] {
  const pegs: Peg[] = [];
  const positions: [number, number][] = [
    [80, 130], [140, 125], [240, 125], [300, 130],
    [55, 155], [130, 150], [250, 150], [320, 155],
    [110, 200], [160, 205], [220, 205], [270, 200],
    [90, 280], [170, 285], [210, 285], [300, 280],
    [55, 300], [140, 300], [240, 300], [320, 300],
    [75, 340], [180, 350], [290, 340],
    [100, 370], [280, 370],
    [65, 410], [150, 415], [230, 415], [310, 410],
    [100, 465], [280, 465],
    [70, 480], [310, 480],
    [110, 520], [270, 520],
    [130, 570], [250, 570],
    [95, 580], [290, 580],
  ];

  for (const [x, y] of positions) {
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

function collideArch(pos: Vec2, vel: Vec2): boolean {
  if (pos.y >= ARCH_CY) return false;
  const nx = (pos.x - ARCH_CX) / ARCH_RX;
  const ny = (pos.y - ARCH_CY) / ARCH_RY;
  const d2 = nx * nx + ny * ny;
  if (d2 <= 1) return false;
  const d = Math.sqrt(d2);
  const nnx = nx / d;
  const nny = ny / d;
  const wnx = nnx / ARCH_RX;
  const wny = nny / ARCH_RY;
  const wlen = Math.sqrt(wnx * wnx + wny * wny);
  const fnx = wnx / wlen;
  const fny = wny / wlen;
  const penetration = (d - 1) * Math.min(ARCH_RX, ARCH_RY) * 0.5 + BALL_R;
  pos.x -= fnx * penetration;
  pos.y -= fny * penetration;
  const vDot = vel.x * fnx + vel.y * fny;
  if (vDot > 0) {
    vel.x -= 2 * vDot * fnx;
    vel.y -= 2 * vDot * fny;
    vel.x *= WALL_DAMPING;
    vel.y *= WALL_DAMPING;
  }
  return true;
}

function drawPlayfieldPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(PF_LEFT, PF_BOT + 20);
  ctx.lineTo(PF_LEFT, ARCH_CY);
  ctx.ellipse(ARCH_CX, ARCH_CY, ARCH_RX, ARCH_RY, 0, Math.PI, 0, false);
  ctx.lineTo(PF_RIGHT, PF_BOT + 20);
  ctx.closePath();
}

function collideLine(pos: Vec2, vel: Vec2, p1: Vec2, p2: Vec2, damping: number): boolean {
  const lx = p2.x - p1.x;
  const ly = p2.y - p1.y;
  const len = Math.sqrt(lx * lx + ly * ly);
  if (len < 0.1) return false;
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

/** Pre-render the static background (frame, playfield, diamonds, holes, text) */
function renderBackground(): HTMLCanvasElement {
  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  const ctx = bg.getContext('2d')!;

  // === 3D WOOD FRAME ===
  // Base dark wood
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(0, 0, W, H);

  // Mid-tone frame body with gradient
  const frameGrad = ctx.createLinearGradient(0, 0, W, H);
  frameGrad.addColorStop(0, WOOD_LIGHT);
  frameGrad.addColorStop(0.25, WOOD_MID);
  frameGrad.addColorStop(0.75, WOOD_MID);
  frameGrad.addColorStop(1, WOOD_DARK);
  ctx.fillStyle = frameGrad;
  ctx.fillRect(4, 4, W - 8, H - 8);

  // Beveled edges — light top/left, dark bottom/right
  // Top highlight
  const topBevel = ctx.createLinearGradient(0, 0, 0, 12);
  topBevel.addColorStop(0, WOOD_HIGHLIGHT + 'cc');
  topBevel.addColorStop(1, 'transparent');
  ctx.fillStyle = topBevel;
  ctx.fillRect(0, 0, W, 12);
  // Left highlight
  const leftBevel = ctx.createLinearGradient(0, 0, 12, 0);
  leftBevel.addColorStop(0, WOOD_HIGHLIGHT + '99');
  leftBevel.addColorStop(1, 'transparent');
  ctx.fillStyle = leftBevel;
  ctx.fillRect(0, 0, 12, H);
  // Bottom shadow
  const botBevel = ctx.createLinearGradient(0, H - 14, 0, H);
  botBevel.addColorStop(0, 'transparent');
  botBevel.addColorStop(1, '#1a0e08cc');
  ctx.fillStyle = botBevel;
  ctx.fillRect(0, H - 14, W, 14);
  // Right shadow
  const rightBevel = ctx.createLinearGradient(W - 14, 0, W, 0);
  rightBevel.addColorStop(0, 'transparent');
  rightBevel.addColorStop(1, '#1a0e0899');
  ctx.fillStyle = rightBevel;
  ctx.fillRect(W - 14, 0, 14, H);

  // Inner frame groove (dark line around playfield)
  ctx.strokeStyle = '#2a1808';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(FRAME - 2, FRAME - 2, W - (FRAME - 2) * 2, H - (FRAME - 2) * 2);

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

  // 3D playfield lighting — subtle top-to-bottom gradient for depth
  const pfLight = ctx.createLinearGradient(0, ARCH_CY - ARCH_RY, 0, PF_BOT + 20);
  pfLight.addColorStop(0, 'rgba(255,255,240,0.15)');
  pfLight.addColorStop(0.3, 'rgba(255,255,240,0.05)');
  pfLight.addColorStop(0.7, 'rgba(0,0,0,0.03)');
  pfLight.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = pfLight;
  ctx.fillRect(0, 0, W, H);

  ctx.restore();

  // Playfield border — gold trim with 3D bevel
  ctx.save();
  drawPlayfieldPath(ctx);
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  drawPlayfieldPath(ctx);
  ctx.strokeStyle = GOLD_TRIM;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  // Inner shadow along playfield edge
  ctx.save();
  drawPlayfieldPath(ctx);
  ctx.clip();
  drawPlayfieldPath(ctx);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.restore();

  // === PLUNGER LANE ===
  const laneTop = LANE_TOP;
  ctx.fillStyle = PLAYFIELD_BG;
  ctx.fillRect(LANE_DIVIDER_X, laneTop, LANE_RIGHT - LANE_DIVIDER_X, PF_BOT + 20 - laneTop);
  // Lane inner shadow
  const laneShadow = ctx.createLinearGradient(LANE_DIVIDER_X, 0, LANE_DIVIDER_X + 10, 0);
  laneShadow.addColorStop(0, 'rgba(0,0,0,0.12)');
  laneShadow.addColorStop(1, 'transparent');
  ctx.fillStyle = laneShadow;
  ctx.fillRect(LANE_DIVIDER_X, laneTop, 10, PF_BOT + 20 - laneTop);

  // Lane divider wall — 3D raised rail
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(LANE_DIVIDER_X, PF_BOT + 15);
  ctx.lineTo(LANE_DIVIDER_X, laneTop);
  ctx.stroke();
  ctx.strokeStyle = GOLD_TRIM + '88';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LANE_DIVIDER_X - 2, PF_BOT + 15);
  ctx.lineTo(LANE_DIVIDER_X - 2, laneTop);
  ctx.stroke();

  // Lane curve
  ctx.beginPath();
  ctx.arc(LANE_DIVIDER_X - 12, laneTop, 12, 0, -Math.PI / 2, true);
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 3;
  ctx.stroke();

  // === DRAIN GUIDES ===
  const drainGuideL1 = { x: PF_LEFT, y: PF_BOT - 15 };
  const drainGuideL2 = { x: ARCH_CX - 30, y: PF_BOT + 15 };
  const drainGuideR1 = { x: LANE_DIVIDER_X - 5, y: PF_BOT - 15 };
  const drainGuideR2 = { x: ARCH_CX + 30, y: PF_BOT + 15 };
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(drainGuideL1.x, drainGuideL1.y);
  ctx.lineTo(drainGuideL2.x, drainGuideL2.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(drainGuideR1.x, drainGuideR1.y);
  ctx.lineTo(drainGuideR2.x, drainGuideR2.y);
  ctx.stroke();
  // Shadow on drain guides
  ctx.strokeStyle = GOLD_TRIM + '55';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(drainGuideL1.x, drainGuideL1.y + 2);
  ctx.lineTo(drainGuideL2.x, drainGuideL2.y + 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(drainGuideR1.x, drainGuideR1.y + 2);
  ctx.lineTo(drainGuideR2.x, drainGuideR2.y + 2);
  ctx.stroke();

  ctx.fillStyle = '#66000060';
  ctx.font = 'bold 8px serif';
  ctx.textAlign = 'center';
  ctx.fillText('DRAIN', ARCH_CX, PF_BOT + 5);

  // === TITLE ===
  // Shadow
  ctx.fillStyle = '#00000030';
  ctx.font = 'bold 26px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('GAME', ARCH_CX + 1, ARCH_CY - ARCH_RY + 26);
  ctx.font = 'bold 20px serif';
  ctx.fillText('PICKER', ARCH_CX + 1, ARCH_CY - ARCH_RY + 49);
  // Text
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = 'bold 26px serif';
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

  // === HOLES (3D) ===
  for (const hole of HOLES) {
    // Outer shadow (larger, offset)
    ctx.beginPath();
    ctx.arc(hole.x + 1, hole.y + 2, hole.r + 4, 0, Math.PI * 2);
    ctx.fillStyle = '#00000025';
    ctx.fill();
    // Hole bevel ring (raised rim)
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.r + 2, 0, Math.PI * 2);
    const rimGrad = ctx.createLinearGradient(hole.x, hole.y - hole.r - 2, hole.x, hole.y + hole.r + 2);
    rimGrad.addColorStop(0, '#888888');
    rimGrad.addColorStop(0.4, '#555555');
    rimGrad.addColorStop(1, '#333333');
    ctx.fillStyle = rimGrad;
    ctx.fill();
    // Hole body (dark pit)
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
    const holeGrad = ctx.createRadialGradient(hole.x - 2, hole.y - 2, 0, hole.x, hole.y, hole.r);
    holeGrad.addColorStop(0, '#222222');
    holeGrad.addColorStop(0.6, HOLE_DARK);
    holeGrad.addColorStop(1, '#050505');
    ctx.fillStyle = holeGrad;
    ctx.fill();
    // Inner rim highlight (top-left light catch)
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.r - 1, -Math.PI * 0.8, -Math.PI * 0.2);
    ctx.strokeStyle = '#ffffff20';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Outer rim
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.r + 2, 0, Math.PI * 2);
    ctx.strokeStyle = HOLE_RIM;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label with shadow
    ctx.fillStyle = '#00000030';
    ctx.font = 'bold 12px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(hole.label, hole.x + 0.5, hole.y - hole.r - 4.5);
    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(hole.label, hole.x, hole.y - hole.r - 5);
    if (hole.label === '250') {
      ctx.font = '8px serif';
      ctx.textBaseline = 'top';
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText('FREE PLAY', hole.x, hole.y + hole.r + 4);
    }
  }

  // === STATIC RING PEGS ===
  for (const rp of ALL_RING_PEGS) {
    // Shadow
    ctx.beginPath();
    ctx.arc(rp.x + 0.5, rp.y + 0.5, RING_PEG_R + 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#00000030';
    ctx.fill();
    // Body
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, RING_PEG_R, 0, Math.PI * 2);
    ctx.fillStyle = NAIL_COLOR;
    ctx.fill();
    // Highlight
    ctx.beginPath();
    ctx.arc(rp.x - 0.3, rp.y - 0.3, RING_PEG_R * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = NAIL_HIGHLIGHT;
    ctx.fill();
  }

  // === STATIC FIELD PEGS (base appearance — will be overlaid when hit) ===
  const fieldPegs = buildFieldPegs();
  for (const peg of fieldPegs) {
    // Shadow
    ctx.beginPath();
    ctx.arc(peg.x + 0.7, peg.y + 0.7, PEG_R + 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#00000030';
    ctx.fill();
    // Body with 3D gradient
    const pegGrad = ctx.createRadialGradient(peg.x - 0.8, peg.y - 0.8, 0, peg.x, peg.y, PEG_R);
    pegGrad.addColorStop(0, NAIL_HIGHLIGHT);
    pegGrad.addColorStop(0.6, NAIL_COLOR);
    pegGrad.addColorStop(1, '#444444');
    ctx.beginPath();
    ctx.arc(peg.x, peg.y, PEG_R, 0, Math.PI * 2);
    ctx.fillStyle = pegGrad;
    ctx.fill();
    // Specular highlight
    ctx.beginPath();
    ctx.arc(peg.x - 0.5, peg.y - 0.5, PEG_R * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = '#bbbbbb';
    ctx.fill();
  }

  // === SCOREBOARD BACKGROUND ===
  // Shadow behind scoreboard
  ctx.fillStyle = '#00000040';
  ctx.fillRect(PF_LEFT + 2, PF_BOT + 27, PF_RIGHT - PF_LEFT, 38);
  // Board
  const sbGrad = ctx.createLinearGradient(0, PF_BOT + 25, 0, PF_BOT + 63);
  sbGrad.addColorStop(0, '#4a3020');
  sbGrad.addColorStop(0.3, WOOD_DARK);
  sbGrad.addColorStop(1, '#2a1508');
  ctx.fillStyle = sbGrad;
  ctx.fillRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 38);
  // Gold border
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(PF_LEFT, PF_BOT + 25, PF_RIGHT - PF_LEFT, 38);
  ctx.strokeStyle = GOLD_TRIM + '55';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(PF_LEFT + 1.5, PF_BOT + 26.5, PF_RIGHT - PF_LEFT - 3, 35);

  // === GLASS REFLECTION (subtle highlight across top) ===
  ctx.save();
  drawPlayfieldPath(ctx);
  ctx.clip();
  const glassGrad = ctx.createLinearGradient(PF_LEFT, ARCH_CY - ARCH_RY, PF_RIGHT * 0.6, ARCH_CY + 40);
  glassGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
  glassGrad.addColorStop(0.3, 'rgba(255,255,255,0.03)');
  glassGrad.addColorStop(0.5, 'transparent');
  ctx.fillStyle = glassGrad;
  ctx.fillRect(PF_LEFT, ARCH_CY - ARCH_RY, PF_RIGHT - PF_LEFT, 150);
  ctx.restore();

  return bg;
}

export default function PinballPicker({ availableGames, onClose }: PinballPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [score, setScore] = useState<string | null>(null);
  const [isDrain, setIsDrain] = useState(false);

  const stateRef = useRef({
    pos: { x: LANE_CX, y: PF_BOT - 15 } as Vec2,
    vel: { x: 0, y: 0 } as Vec2,
    trail: [] as Vec2[],
    pegs: buildFieldPegs(),
    ringPegHitTimers: new Map<number, number>(),
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
    lastFrameTime: 0,
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
    s.lastFrameTime = 0;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const s = stateRef.current;
    if (s.phase !== 'idle') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (W / rect.width);
    const cy = (e.clientY - rect.top) * (H / rect.height);
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
    s.pos = { x: LANE_CX, y: PF_BOT - 15 };
    const launchVel = 5 + power * 6;
    s.vel = { x: -0.2 - Math.random() * 0.4, y: -launchVel };
    s.phase = 'running';
    s.startTime = performance.now();
    s.lastFrameTime = performance.now();
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

    // Pre-render static background once
    if (!bgCanvasRef.current) {
      bgCanvasRef.current = renderBackground();
    }
    const bgCanvas = bgCanvasRef.current;

    const drainGuideL1: Vec2 = { x: PF_LEFT, y: PF_BOT - 15 };
    const drainGuideL2: Vec2 = { x: ARCH_CX - 30, y: PF_BOT + 15 };
    const drainGuideR1: Vec2 = { x: LANE_DIVIDER_X - 5, y: PF_BOT - 15 };
    const drainGuideR2: Vec2 = { x: ARCH_CX + 30, y: PF_BOT + 15 };

    function draw() {
      const s = stateRef.current;

      // Blit pre-rendered background (fast — single drawImage)
      ctx.drawImage(bgCanvas, 0, 0);

      // === DYNAMIC: Hit-flash pegs (only draw pegs that are currently flashing) ===
      for (const peg of s.pegs) {
        if (peg.hitTimer > 0) {
          ctx.beginPath();
          ctx.arc(peg.x, peg.y, PEG_R + 1, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${0.15 + peg.hitTimer * 0.04})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(peg.x, peg.y, PEG_R, 0, Math.PI * 2);
          ctx.fillStyle = NAIL_HIT;
          ctx.fill();
          peg.hitTimer--;
        }
      }

      // Hit-flash ring pegs
      for (const [i, timer] of s.ringPegHitTimers.entries()) {
        if (timer > 0) {
          const rp = ALL_RING_PEGS[i]!;
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, RING_PEG_R + 0.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${0.1 + timer * 0.04})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, RING_PEG_R, 0, Math.PI * 2);
          ctx.fillStyle = NAIL_HIT;
          ctx.fill();
          s.ringPegHitTimers.set(i, timer - 1);
          if (timer - 1 <= 0) s.ringPegHitTimers.delete(i);
        }
      }

      // === DYNAMIC: PLUNGER ===
      const maxPull = 55;
      const pullOff = s.plungerPull * maxPull;
      const tipY = PF_BOT - 20 + pullOff;
      // Rod
      const rodGrad = ctx.createLinearGradient(LANE_CX - 4, 0, LANE_CX + 4, 0);
      rodGrad.addColorStop(0, '#888888');
      rodGrad.addColorStop(0.5, '#aaaaaa');
      rodGrad.addColorStop(1, '#666666');
      ctx.fillStyle = rodGrad;
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
      // Plunger tip — 3D metal plate
      const tipW = LANE_RIGHT - LANE_DIVIDER_X - 6;
      const tipGrad = ctx.createLinearGradient(0, tipY - 3, 0, tipY + 5);
      tipGrad.addColorStop(0, '#cccccc');
      tipGrad.addColorStop(0.3, '#aaaaaa');
      tipGrad.addColorStop(0.7, '#888888');
      tipGrad.addColorStop(1, '#666666');
      ctx.fillStyle = tipGrad;
      ctx.fillRect(LANE_CX - tipW / 2, tipY - 3, tipW, 8);
      ctx.strokeStyle = '#55555580';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(LANE_CX - tipW / 2, tipY - 3, tipW, 8);

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

      // === DYNAMIC: BALL ===
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
        ctx.arc(s.pos.x + 2, s.pos.y + 2, BALL_R + 1, 0, Math.PI * 2);
        ctx.fillStyle = '#00000020';
        ctx.fill();
        // Body — 3D chrome ball
        const bg = ctx.createRadialGradient(s.pos.x - 2.5, s.pos.y - 2.5, 0.5, s.pos.x, s.pos.y, BALL_R);
        bg.addColorStop(0, BALL_HIGHLIGHT);
        bg.addColorStop(0.25, '#e0e0e4');
        bg.addColorStop(0.5, BALL_COLOR);
        bg.addColorStop(0.85, BALL_SHADOW);
        bg.addColorStop(1, '#606068');
        ctx.beginPath();
        ctx.arc(s.pos.x, s.pos.y, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.strokeStyle = '#77777760';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        // Specular highlight
        ctx.beginPath();
        ctx.arc(s.pos.x - 2, s.pos.y - 2, BALL_R * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fill();
      }

      // === DYNAMIC: SCOREBOARD TEXT ===
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
        // Delta-time: normalize to 60fps
        const now = performance.now();
        const rawDt = s.lastFrameTime > 0 ? (now - s.lastFrameTime) / (1000 / BASE_FPS) : 1;
        const dt = Math.min(rawDt, 4); // cap to prevent tunneling
        s.lastFrameTime = now;

        // Sub-step physics for large dt to prevent tunneling through pegs
        const steps = Math.max(1, Math.round(dt));
        const subDt = dt / steps;

        for (let step = 0; step < steps; step++) {
          // Gravity
          s.vel.y += GRAVITY * subDt;
          // Friction
          const frictionDt = Math.pow(FRICTION, subDt);
          s.vel.x *= frictionDt;
          s.vel.y *= frictionDt;

          s.pos.x += s.vel.x * subDt;
          s.pos.y += s.vel.y * subDt;

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

          // Ring peg collisions
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

          // Hole capture
          for (const hole of HOLES) {
            const dx = s.pos.x - hole.x;
            const dy = s.pos.y - hole.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
            if (dist < hole.r + 2 && speed < 4) {
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

          if (s.phase !== 'running') break;

          // Arch boundary
          collideArch(s.pos, s.vel);

          // Straight walls below the arch
          if (s.pos.y >= ARCH_CY) {
            if (s.pos.x - BALL_R < PF_LEFT) {
              s.pos.x = PF_LEFT + BALL_R;
              s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
            }
            if (s.pos.x + BALL_R > PF_RIGHT) {
              s.pos.x = PF_RIGHT - BALL_R;
              s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
            }
          }

          // Plunger lane divider wall — solid barrier below LANE_TOP
          if (s.pos.y > LANE_TOP) {
            const ballCenterInLane = s.pos.x > LANE_DIVIDER_X;
            if (!ballCenterInLane) {
              if (s.pos.x + BALL_R > LANE_DIVIDER_X) {
                s.pos.x = LANE_DIVIDER_X - BALL_R;
                s.vel.x = -Math.abs(s.vel.x) * WALL_DAMPING;
              }
            } else {
              if (s.pos.x - BALL_R < LANE_DIVIDER_X) {
                s.pos.x = LANE_DIVIDER_X + BALL_R;
                s.vel.x = Math.abs(s.vel.x) * WALL_DAMPING;
              }
              if (s.pos.y + BALL_R > PF_BOT + 15) {
                s.pos.y = PF_BOT + 15 - BALL_R;
                s.vel.y = -Math.abs(s.vel.y) * 0.2;
              }
            }
          }

          // Drain guide collisions
          collideLine(s.pos, s.vel, drainGuideL1, drainGuideL2, 0.9);
          collideLine(s.pos, s.vel, drainGuideR1, drainGuideR2, 0.9);

          // Drain detection
          if (s.pos.y + BALL_R > DRAIN_Y && s.pos.x > ARCH_CX - 35 && s.pos.x < ARCH_CX + 35 && s.pos.x < LANE_DIVIDER_X) {
            s.ballVisible = false;
            s.isDrain = true;
            s.landedHole = null;
            s.resultText = pickGame();
            s.phase = 'landed';
            setPhase('landed');
            setScore(null);
            setIsDrain(true);
            setResult(s.resultText);
            break;
          }

          // Re-plunge on failed launch
          if (s.pos.x > LANE_DIVIDER_X && s.pos.y > PF_BOT - 80 && s.vel.y >= 0) {
            const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
            if (speed < 1.5) {
              s.pos = { x: LANE_CX, y: PF_BOT - 15 };
              s.vel = { x: 0, y: 0 };
              s.trail = [];
              s.plungerPull = 0;
              s.startTime = 0;
              s.phase = 'idle';
              setPhase('idle');
              break;
            }
          }
        } // end sub-step loop

        // Trail (once per frame, not per sub-step)
        if (s.phase === 'running') {
          s.trail.push({ x: s.pos.x, y: s.pos.y });
          if (s.trail.length > TRAIL_LEN) s.trail.shift();
        }

        // Stuck ball timeout
        if (s.startTime > 0 && s.phase === 'running') {
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
