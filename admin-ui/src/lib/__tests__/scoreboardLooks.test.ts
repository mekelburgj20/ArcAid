import { describe, it, expect } from 'vitest';
import { LOOK_DEFINITIONS, LOOK_KEYS, computeActiveLook } from '../scoreboardLooks';
import { STYLE_LABELS } from '../scoreboardThemes';

/**
 * Style-system revamp P1 — Looks replace the legacy PresetSelector.
 *
 * The behaviour most worth locking down is `computeActiveLook`'s
 * unset-is-not-divergence rule: every room that predates Looks stores a
 * SCOREBOARD_STYLE and nothing else in the bundle, and flagging all of them
 * as "customised" on release day would be both false and useless.
 */
describe('LOOK_DEFINITIONS', () => {
  it('covers all four card styles, Arcade first (flagship + seeded default)', () => {
    expect(LOOK_DEFINITIONS.map(l => l.id)).toEqual(['arcade', 'banner', 'showcase', 'minimal']);
  });

  it('reuses the shared STYLE_LABELS copy rather than a second set of names', () => {
    for (const look of LOOK_DEFINITIONS) {
      expect(look.label).toBe(STYLE_LABELS[look.id].label);
      expect(look.description).toBe(STYLE_LABELS[look.id].description);
    }
  });

  it('writes only declared bundle keys — no room identity, no policy keys', () => {
    for (const look of LOOK_DEFINITIONS) {
      for (const key of Object.keys(look.settings)) {
        expect(LOOK_KEYS).toContain(key);
      }
    }
    // Explicit guard on the exclusions that matter: a Look is a look, not a
    // rebrand, and not a policy change.
    const everyKeyWritten = LOOK_DEFINITIONS.flatMap(l => Object.keys(l.settings));
    for (const forbidden of [
      'SCOREBOARD_TITLE', 'LOGO_URL', 'SCOREBOARD_BG_URL',
      'SCOREBOARD_GAME_TITLE_STYLE', 'SCOREBOARD_TITLE_STYLE',
      'SCOREBOARD_QR_MODE', 'SCOREBOARD_MOBILE_SCALE', 'SCOREBOARD_ZOOM',
      'SCOREBOARD_RANKINGS_STYLE',
    ]) {
      expect(everyKeyWritten).not.toContain(forbidden);
    }
  });

  it('sets its own style key and a matching min/max card height', () => {
    for (const look of LOOK_DEFINITIONS) {
      expect(look.settings.SCOREBOARD_STYLE).toBe(look.id);
      // The bug this fixes: MIN_SCORES defaults to 20, so a card reserves
      // twenty rows of height no matter how few scores it shows.
      expect(look.settings.SCOREBOARD_MIN_SCORES).toBe(look.settings.SCOREBOARD_MAX_SCORES);
    }
  });

  it('gives Showcase a theme, since that family is the only one with themes', () => {
    const showcase = LOOK_DEFINITIONS.find(l => l.id === 'showcase')!;
    expect(showcase.settings.SCOREBOARD_THEME).toBeTruthy();
    for (const other of LOOK_DEFINITIONS.filter(l => l.id !== 'showcase')) {
      expect(other.settings.SCOREBOARD_THEME).toBeUndefined();
    }
  });
});

describe('computeActiveLook', () => {
  it('reports "unset" for a legacy room with no style at all', () => {
    expect(computeActiveLook({})).toBe('unset');
    expect(computeActiveLook({ SCOREBOARD_MAX_SCORES: '5' })).toBe('unset');
  });

  it('reports the Look for a room that stores only its style — NOT "custom"', () => {
    // The release-day case: every pre-Looks room looks like this.
    expect(computeActiveLook({ SCOREBOARD_STYLE: 'arcade' })).toBe('arcade');
    expect(computeActiveLook({ SCOREBOARD_STYLE: 'minimal' })).toBe('minimal');
  });

  it('reports the Look when the stored values match the bundle exactly', () => {
    const arcade = LOOK_DEFINITIONS.find(l => l.id === 'arcade')!;
    expect(computeActiveLook({ ...arcade.settings })).toBe('arcade');
  });

  it('reports "custom" once a bundle key is stored with a different value', () => {
    expect(computeActiveLook({ SCOREBOARD_STYLE: 'arcade', SCOREBOARD_CARD_SPACING: '48' })).toBe('custom');
    expect(computeActiveLook({ SCOREBOARD_STYLE: 'arcade', SCOREBOARD_MIN_SCORES: '20' })).toBe('custom');
  });

  it('ignores keys outside the bundle — tuning a QR size is not a custom Look', () => {
    expect(computeActiveLook({
      SCOREBOARD_STYLE: 'banner',
      SCOREBOARD_QR_SIZE: '48',
      SCOREBOARD_GAME_TITLE_STYLE: 'fire',
      SCOREBOARD_ZOOM: '130',
    })).toBe('banner');
  });

  it('treats an empty stored value as unset, not as a mismatch', () => {
    expect(computeActiveLook({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_CARD_SPACING: '' })).toBe('banner');
  });

  it('reports "custom" for an unrecognised stored style rather than guessing', () => {
    expect(computeActiveLook({ SCOREBOARD_STYLE: 'wheel' })).toBe('custom');
  });
});
