import type { CSSProperties } from 'react';

/**
 * Deterministic desync for the Global Scoreboard card's neon glitch (v2.67.0).
 *
 * Every card animates the same two keyframe rings (`.gg-card::before/::after`
 * in `index.css`); what stops forty of them flickering in unison is that each
 * gets its own period and its own pair of negative start offsets, derived here
 * from a hash of its `card_id`.
 *
 * It has to be a HASH, not `Math.random()`: the grid re-renders on every score
 * websocket, density toggle and pin flip, and fresh random values would restart
 * — and momentarily resynchronise — every animation on screen. FNV-1a is used
 * because it is four lines with no dependency; nothing here is security
 * sensitive.
 *
 * This lives in `lib/` rather than beside the card for the same reason
 * `scoreboardDensity.ts` does: it is a pure function with no React in it, and a
 * component module that also exports helpers breaks Fast Refresh.
 */

/** Cycle lengths, in seconds. No small common factor, so cards drifting past
 *  one another never settle into a beat. */
const GLITCH_PERIODS_S = [17, 21, 26];

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The custom properties `.gg-card`'s keyframes read. */
export function glitchVars(seed: string): CSSProperties {
  const h = fnv1a(seed);
  const period = GLITCH_PERIODS_S[h % GLITCH_PERIODS_S.length];
  // Centisecond resolution across the whole period: two cards have to collide
  // on the same 1/2100th slot AND the same period to start together. Negative,
  // so every card starts partway into its cycle rather than all waiting out a
  // first quiet stretch together.
  const delay = (bits: number) => -(((h >>> bits) % (period * 100)) / 100);
  return {
    '--gg-gl-dur': `${period}s`,
    '--gg-gl-delay': `${delay(5)}s`,
    '--gg-gl-delay-2': `${delay(15)}s`,
  } as CSSProperties;
}
