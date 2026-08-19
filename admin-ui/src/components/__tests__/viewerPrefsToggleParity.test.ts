import { describe, it, expect } from 'vitest';
import { TOGGLE_DEFAULT_ON, deriveScoreboardConfig } from '../../lib/scoreboardConfig';

/**
 * Drift lock between the UI that draws boolean scoreboard switches and the
 * renderer that acts on them.
 *
 * Any switch UI decides ON/OFF from `TOGGLE_DEFAULT_ON`; the scoreboard
 * decides how to actually behave from `deriveScoreboardConfig`. Both now live
 * in `lib/scoreboardConfig` so they cannot drift into separate files, and this
 * test pins the mapping between them. When they disagree, a viewer opens
 * Preferences
 * and sees a switch in the opposite position to what they are looking at on
 * the page — and "fixing" it takes two taps, because the first tap writes the
 * value it was already behaving as.
 *
 * That was live for SCOREBOARD_MOBILE_VERTICAL (owner report, 2026-08-15):
 * the renderer has always defaulted it on, the modal always drew it off.
 *
 * Every boolean pref the modal renders belongs in this table. Adding a toggle
 * without adding it here is the drift this test exists to stop.
 */
const TOGGLE_TO_CONFIG_FIELD = {
  SCOREBOARD_HIDE_EMPTY: 'hideEmpty',
  SCOREBOARD_TITLE_HIDDEN: 'titleHidden',
  SCOREBOARD_CARD_BG_FILL: 'cardBgFill',
  SCOREBOARD_GAME_HEADER_ENABLED: 'gameHeaderEnabled',
  SCOREBOARD_RANKINGS_STICKY: 'rankingsSticky',
  SCOREBOARD_SHOW_TIMER: 'showTimer',
  SCOREBOARD_MOBILE_VERTICAL: 'mobileVertical',
} as const;

describe('viewer prefs toggle defaults match the renderer', () => {
  const stockConfig = deriveScoreboardConfig({});

  for (const [key, field] of Object.entries(TOGGLE_TO_CONFIG_FIELD)) {
    it(`${key}: modal default matches deriveScoreboardConfig.${field}`, () => {
      const modalDefaultOn = TOGGLE_DEFAULT_ON.has(key);
      const rendererDefaultOn = stockConfig[field as keyof typeof stockConfig];
      expect(modalDefaultOn).toBe(rendererDefaultOn);
    });
  }

  it('pins the two owner-set defaults so a future edit is deliberate', () => {
    // Owner call, 2026-08-15.
    expect(TOGGLE_DEFAULT_ON.has('SCOREBOARD_MOBILE_VERTICAL')).toBe(true);
    expect(TOGGLE_DEFAULT_ON.has('SCOREBOARD_CARD_BG_FILL')).toBe(true);
    expect(stockConfig.mobileVertical).toBe(true);
    expect(stockConfig.cardBgFill).toBe(true);
  });

  it('leaves genuinely default-off toggles off', () => {
    expect(TOGGLE_DEFAULT_ON.has('SCOREBOARD_HIDE_EMPTY')).toBe(false);
    expect(TOGGLE_DEFAULT_ON.has('SCOREBOARD_TITLE_HIDDEN')).toBe(false);
    expect(TOGGLE_DEFAULT_ON.has('SCOREBOARD_RANKINGS_STICKY')).toBe(false);
  });
});
