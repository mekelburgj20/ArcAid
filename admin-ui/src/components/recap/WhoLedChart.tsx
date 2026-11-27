import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAxisScore, yScaleFor } from '../../lib/chartScale';
import { formatRecapScore, formatRecapTime } from '../../lib/recapFormat';
import type { RecapLeadChange, RecapLeadStep, RecapPlayerRow, RunRecap } from '../../lib/runRecapTypes';
import { LEAD_VERB, leaderColors, nameForKey } from './recapNames';

/**
 * The "who led" step chart (B31.2): x = time, y = the leading score. One
 * horizontal segment per lead step, coloured by its leader (the eventual winner
 * is gold, others cycle through the theme's accents; coral is danger, never
 * used), risers neutral, a dot per lead change with a tooltip on hover, tap or
 * focus. Hand-rolled SVG like `ScoreHistoryChart`; colour only from theme
 * tokens. `LeadChangeList` under it is the text equivalent.
 */

/** Axis ends: 'Fri 11/20' once the run spans more than two days (a weekday alone repeats a week apart), else 'Fri 8:04 am'. */
function axisTimeLabel(ms: number, spanMs: number, timeZone: string): string {
  const iso = new Date(ms).toISOString();
  if (spanMs <= 2 * 86_400_000) return formatRecapTime(iso, timeZone);
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'numeric', day: 'numeric' }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.weekday} ${parts.month}/${parts.day}`;
}

const HEIGHT = 220;
const MARGIN = { top: 22, right: 14, bottom: 26, left: 52 };
const DEFAULT_WIDTH = 600;
export default function WhoLedChart({ steps, changes, players, run }: {
  steps: RecapLeadStep[];
  changes: RecapLeadChange[];
  players: RecapPlayerRow[];
  run: RunRecap['run'];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [active, setActive] = useState<number | null>(null);
  const [now] = useState(() => Date.now());

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

  const sorted = useMemo(
    () => steps
      .map(s => ({ ...s, t: Date.parse(s.at) }))
      .filter(s => Number.isFinite(s.t))
      .sort((a, b) => a.t - b.t),
    [steps],
  );
  const winnerKey = players[0]?.key;
  const colors = useMemo(() => leaderColors(sorted, winnerKey), [sorted, winnerKey]);

  if (sorted.length === 0) return null;

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const firstT = sorted[0]!.t;
  const startParsed = run.start_date ? Date.parse(run.start_date) : NaN;
  const tMin = Number.isFinite(startParsed) ? Math.min(startParsed, firstT) : firstT;
  const endParsed = run.end_date ? Date.parse(run.end_date) : NaN;
  const lastT = sorted[sorted.length - 1]!.t;
  let tMax = run.state === 'active' ? Math.max(now, lastT) : (Number.isFinite(endParsed) ? Math.max(endParsed, lastT) : lastT);
  if (tMax <= tMin) tMax = tMin + 1;
  const tSpan = tMax - tMin;

  const { lo, hi, ticks } = yScaleFor(sorted[0]!.score, sorted[sorted.length - 1]!.score);
  const yOf = (v: number) => MARGIN.top + (1 - (v - lo) / (hi - lo || 1)) * plotH;
  const xOf = (t: number) => MARGIN.left + ((t - tMin) / tSpan) * plotW;

  const segments = sorted.map((s, i) => {
    const x1 = xOf(s.t);
    const x2 = i + 1 < sorted.length ? xOf(sorted[i + 1]!.t) : xOf(tMax);
    return { ...s, x1, x2: Math.max(x2, x1 + 3), y: yOf(s.score), color: colors.get(s.player_key)! };
  });

  const dots = changes.map(c => {
    const t = Date.parse(c.at);
    return { c, x: xOf(Number.isFinite(t) ? t : tMin), y: yOf(c.score) };
  });
  const activeDot = active != null ? dots[active] : null;
  const dotLabel = (c: RecapLeadChange) =>
    `${formatRecapTime(c.at, run.timezone)}, ${nameForKey(players, c.player_key)} ${LEAD_VERB[c.kind]} with ${formatRecapScore(c.score)}`;

  return (
    <div ref={wrapRef} className="relative w-full text-muted" data-testid="who-led-chart">
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="group"
        aria-label="Who led over time"
        onMouseLeave={() => setActive(null)}
        onClick={() => setActive(null)}
      >
        {ticks.map(v => (
          <g key={`y-${v}`}>
            <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={yOf(v)} y2={yOf(v)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={MARGIN.left - 6} y={yOf(v)} dy="0.32em" textAnchor="end" fontSize={12} fill="currentColor">
              {formatAxisScore(v)}
            </text>
          </g>
        ))}
        <text x={MARGIN.left} y={HEIGHT - 8} textAnchor="start" fontSize={12} fill="currentColor">
          {axisTimeLabel(tMin, tSpan, run.timezone)}
        </text>
        <text x={MARGIN.left + plotW} y={HEIGHT - 8} textAnchor="end" fontSize={12} fill="currentColor">
          {axisTimeLabel(tMax, tSpan, run.timezone)}
        </text>

        {/* Risers: neutral */}
        {segments.slice(1).map((s, i) => (
          <line
            key={`r-${i}`}
            x1={s.x1} x2={s.x1} y1={segments[i]!.y} y2={s.y}
            stroke="var(--color-border)" strokeWidth={2}
          />
        ))}

        {segments.map((s, i) => (
          <g key={`s-${i}`}>
            <line
              data-testid="lead-segment"
              x1={s.x1} x2={s.x2} y1={s.y} y2={s.y}
              stroke={s.color} strokeWidth={4} strokeLinecap="round"
            />
            {s.x2 - s.x1 >= 64 && (
              <text x={s.x1 + 2} y={s.y - 8} fontSize={12} fill={s.color} style={{ fontWeight: 600 }}>
                {clip(nameForKey(players, s.player_key), Math.floor((s.x2 - s.x1) / 7))}
              </text>
            )}
          </g>
        ))}

        {dots.map(({ c, x, y }, idx) => (
          <g
            key={`${c.at}-${idx}`}
            data-testid="lead-dot"
            tabIndex={0}
            role="img"
            aria-label={dotLabel(c)}
            onMouseEnter={() => setActive(idx)}
            onFocus={() => setActive(idx)}
            onBlur={() => setActive(a => (a === idx ? null : a))}
            onClick={e => { e.stopPropagation(); setActive(idx); }}
            style={{ cursor: 'pointer', outline: 'none' }}
          >
            <circle cx={x} cy={y} r={14} fill="transparent" />
            <circle
              cx={x} cy={y} r={c.wins_it ? 6 : 4.5}
              fill={colors.get(c.player_key) ?? 'var(--color-neon-cyan)'}
              stroke={active === idx ? 'currentColor' : 'var(--color-surface)'}
              strokeWidth={active === idx ? 2 : 1.5}
            />
          </g>
        ))}
      </svg>

      {activeDot && (
        <div
          role="status"
          className="absolute pointer-events-none z-10 px-2 py-1 rounded border border-border bg-raised text-primary text-xs max-w-[16rem]"
          style={{
            left: `${(activeDot.x / width) * 100}%`,
            top: Math.max(0, activeDot.y - 56),
            transform: activeDot.x > width * 0.6 ? 'translateX(-100%)' : 'none',
          }}
        >
          {dotLabel(activeDot.c)}
        </div>
      )}
    </div>
  );
}

function clip(name: string, max: number): string {
  const chars = Array.from(name);
  return chars.length <= max ? name : chars.slice(0, Math.max(1, max - 1)).join('') + '…';
}
