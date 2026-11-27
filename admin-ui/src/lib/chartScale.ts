/**
 * Chart scale helpers shared by the hand-rolled SVG charts (ScoreHistoryChart,
 * the run recap's who-led chart). Moved out of ScoreHistoryChart.tsx unchanged (B31.2).
 */

/**
 * Axis-tick abbreviation (K/M/B/T). Deliberately NOT `formatScore`, which
 * prints exact digits below 1T — right for a leaderboard cell, far too wide
 * for a tick label. Trailing ".0" is dropped; the label is never truncated.
 */
export function formatAxisScore(n: number): string {
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
export function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/** Y domain + ticks covering [min, max]; pads a flat series so it has height. */
export function yScaleFor(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
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
