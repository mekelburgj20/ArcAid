import { useEffect, useMemo, useRef, useState } from 'react';
import { formatScore, parseServerDate } from '../lib/format';

/**
 * v2.157.0 — one player's scores on one game, over time.
 *
 * Opened from the Global game page by clicking a score. Hand-rolled inline SVG
 * in the spirit of `Sparkline` (the UI carries no charting library, and this
 * does not justify one), but a real chart: a TIME-scaled x axis (two scores a
 * day apart sit close, a month apart sit far), a score y axis with a few
 * abbreviated ticks, a line through the points with one dot per score, the
 * best score highlighted and marked by a light dashed rule, and a tooltip per
 * point on hover, tap or keyboard focus.
 *
 * Colour comes ONLY from the theme tokens (`--color-neon-cyan`, `--color-neon-
 * amber`, `--color-border`, and the inherited text colour for labels), so it
 * reads correctly in all 16 themes, light ones included.
 *
 * The SVG's coordinate width tracks the element's real pixel width (a
 * ResizeObserver) rather than scaling a fixed viewBox: scaling a 600-unit
 * drawing down to a 360px phone would shrink every label to ~6px.
 */

export interface ScoreHistoryPoint {
  id: string;
  score: number;
  submitted_at: string;
}

interface Props {
  scores: ScoreHistoryPoint[];
  /** Accessible name for the chart, e.g. "Alice's scores on Attack from Mars". */
  label?: string;
}

const HEIGHT = 200;
const MARGIN = { top: 14, right: 14, bottom: 26, left: 56 };
const DEFAULT_WIDTH = 600;
/** Horizontal nudge between points that share one timestamp, in px. */
const SAME_TIME_NUDGE = 7;

/**
 * Axis-tick abbreviation (K/M/B/T). Deliberately NOT `formatScore`, which
 * prints exact digits below 1T — right for a leaderboard cell, far too wide
 * for a tick label. Trailing ".0" is dropped; the label is never truncated.
 */
function formatAxisScore(n: number): string {
  const abs = Math.abs(n);
  const tiers: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of tiers) {
    if (abs >= size) {
      const v = n / size;
      const digits = Math.abs(v) >= 100 ? 0 : 1;
      return `${Number(v.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(n));
}

/** A "nice" step (1, 2 or 5 × 10^k) giving roughly `count` intervals. */
function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/** Y domain + ticks covering [min, max]; pads a flat series so it has height. */
function yScaleFor(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  let lo = min;
  let hi = max;
  if (lo === hi) {
    const pad = Math.max(Math.abs(hi) * 0.1, 1);
    lo = Math.max(0, lo - pad);
    hi = hi + pad;
  }
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

function formatDateShort(d: Date, withYear: boolean): string {
  return d.toLocaleDateString(undefined, withYear
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

function formatDateLong(d: Date): string {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function ScoreHistoryChart({ scores, label }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Oldest → newest. A row whose date will not parse is dropped from the chart
  // rather than pinned to the epoch (it would drag the whole x axis to 1970).
  const points = useMemo(() => {
    return scores
      .map((s, i) => ({ ...s, i, time: parseServerDate(s.submitted_at)?.getTime() ?? NaN }))
      .filter(p => Number.isFinite(p.time))
      .sort((a, b) => a.time - b.time || a.i - b.i);
  }, [scores]);

  if (points.length === 0) return null;

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const tMin = points[0]!.time;
  const tMax = points[points.length - 1]!.time;
  const tSpan = tMax - tMin;

  const values = points.map(p => p.score);
  const maxScore = Math.max(...values);
  const bestIndex = values.indexOf(maxScore); // earliest time the best was reached
  const { lo, hi, ticks } = yScaleFor(Math.min(...values), maxScore);

  const yOf = (v: number) => MARGIN.top + (1 - (v - lo) / (hi - lo || 1)) * plotH;
  // A single instant (one score, or several sharing a timestamp) has no span
  // to scale across, so it sits in the middle.
  const baseX = (t: number) => tSpan === 0
    ? MARGIN.left + plotW / 2
    : MARGIN.left + ((t - tMin) / tSpan) * plotW;

  // Points sharing a timestamp would sit exactly on top of each other and hide
  // every tooltip but the last. Fan them out a few px, centred on the instant.
  const groupSize = new Map<number, number>();
  for (const p of points) groupSize.set(p.time, (groupSize.get(p.time) ?? 0) + 1);
  const seen = new Map<number, number>();
  const placed = points.map(p => {
    const n = groupSize.get(p.time)!;
    const k = seen.get(p.time) ?? 0;
    seen.set(p.time, k + 1);
    const nudge = (k - (n - 1) / 2) * SAME_TIME_NUDGE;
    const x = Math.min(MARGIN.left + plotW, Math.max(MARGIN.left, baseX(p.time) + nudge));
    return { ...p, x, y: yOf(p.score) };
  });

  // X ticks: first + last date, plus a few evenly spaced instants between
  // them when there is room. Year shown whenever the span crosses a year.
  const crossesYear = new Date(tMin).getFullYear() !== new Date(tMax).getFullYear();
  const middleCount = tSpan === 0 ? 0 : width >= 520 ? 3 : 1;
  const xTicks: Array<{ t: number; anchor: 'start' | 'middle' | 'end' }> = tSpan === 0
    ? [{ t: tMin, anchor: 'middle' }]
    : [
        { t: tMin, anchor: 'start' },
        ...Array.from({ length: middleCount }, (_, j) => ({
          t: tMin + (tSpan * (j + 1)) / (middleCount + 1),
          anchor: 'middle' as const,
        })),
        { t: tMax, anchor: 'end' },
      ];

  const linePoints = placed.map(p => `${p.x},${p.y}`).join(' ');
  const bestY = yOf(maxScore);
  const activePoint = active != null ? placed[active] : null;

  return (
    <div ref={wrapRef} className="relative w-full text-muted" data-testid="score-history-chart">
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={label ?? 'Score history chart'}
        onMouseLeave={() => setActive(null)}
        onClick={() => setActive(null)}
      >
        {/* Y gridlines + tick labels */}
        {ticks.map(v => (
          <g key={`y-${v}`}>
            <line
              x1={MARGIN.left} x2={MARGIN.left + plotW} y1={yOf(v)} y2={yOf(v)}
              stroke="var(--color-border)" strokeWidth={1}
            />
            <text
              x={MARGIN.left - 6} y={yOf(v)} dy="0.32em" textAnchor="end"
              fontSize={11} fill="currentColor"
            >
              {formatAxisScore(v)}
            </text>
          </g>
        ))}

        {/* X tick labels */}
        {xTicks.map(({ t, anchor }, j) => (
          <text
            key={`x-${j}`}
            x={tSpan === 0 ? MARGIN.left + plotW / 2 : baseX(t)}
            y={HEIGHT - 8}
            textAnchor={anchor}
            fontSize={11}
            fill="currentColor"
          >
            {formatDateShort(new Date(t), crossesYear)}
          </text>
        ))}

        {/* The player's best, as a light dashed rule */}
        <line
          x1={MARGIN.left} x2={MARGIN.left + plotW} y1={bestY} y2={bestY}
          stroke="var(--color-neon-amber)" strokeWidth={1} strokeDasharray="4 4" opacity={0.6}
          data-testid="best-line"
        />

        {placed.length > 1 && (
          <polyline
            points={linePoints}
            fill="none"
            stroke="var(--color-neon-cyan)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {placed.map((p, idx) => {
          const isBest = idx === bestIndex;
          const dateLabel = formatDateLong(new Date(p.time));
          return (
            <g
              key={p.id}
              data-testid={isBest ? 'chart-point-best' : 'chart-point'}
              tabIndex={0}
              role="button"
              aria-label={`${formatScore(p.score)} on ${dateLabel}${isBest ? ' (best)' : ''}`}
              onMouseEnter={() => setActive(idx)}
              onFocus={() => setActive(idx)}
              onBlur={() => setActive(a => (a === idx ? null : a))}
              // SHOW, never toggle: a tap fires a synthetic mouseenter before
              // the click, so a toggle here would open and immediately close
              // the tooltip on every phone. Tapping empty chart space (the
              // svg's own onClick) is what clears it.
              onClick={e => { e.stopPropagation(); setActive(idx); }}
              style={{ cursor: 'pointer', outline: 'none' }}
            >
              {/* Generous invisible hit target for fingers */}
              <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
              <circle
                cx={p.x}
                cy={p.y}
                r={isBest ? 6 : 4}
                fill={isBest ? 'var(--color-neon-amber)' : 'var(--color-neon-cyan)'}
                stroke={active === idx ? 'currentColor' : 'var(--color-surface)'}
                strokeWidth={active === idx ? 2 : 1.5}
              />
            </g>
          );
        })}
      </svg>

      {activePoint && (
        <div
          role="status"
          className="absolute pointer-events-none z-10 px-2 py-1 rounded border border-border bg-raised text-primary text-xs whitespace-nowrap shadow"
          style={{
            left: `${(activePoint.x / width) * 100}%`,
            top: Math.max(0, activePoint.y - 44),
            transform: activePoint.x > width * 0.75
              ? 'translateX(-100%)'
              : activePoint.x < width * 0.25 ? 'none' : 'translateX(-50%)',
          }}
        >
          <div className="font-semibold tabular-nums">{formatScore(activePoint.score)}</div>
          <div className="text-muted">{formatDateLong(new Date(activePoint.time))}</div>
        </div>
      )}

      {placed.length === 1 && (
        <p className="text-faint text-xs mt-1" data-testid="single-point-caption">
          Only one score so far.
        </p>
      )}
    </div>
  );
}
