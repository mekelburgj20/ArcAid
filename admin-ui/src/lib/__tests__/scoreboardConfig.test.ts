import { describe, it, expect } from 'vitest';
import { deriveScoreboardConfig } from '../scoreboardConfig';

// S21 — first coverage for scoreboardConfig.ts. Covers the mobileScale
// opt-in-densifier default flip (0.85 -> 1.0), the new kioskZoom fallback
// chain (KIOSK_ZOOM -> SCOREBOARD_ZOOM -> 100), and defensive clamping for
// both, added as part of the true-mobile-layout work.
describe('deriveScoreboardConfig', () => {
  describe('mobileScale', () => {
    it('defaults to 1.0 when SCOREBOARD_MOBILE_SCALE is unset', () => {
      const cfg = deriveScoreboardConfig({});
      expect(cfg.mobileScale).toBe(1.0);
    });

    it('parses an explicit value in range', () => {
      const cfg = deriveScoreboardConfig({ SCOREBOARD_MOBILE_SCALE: '0.6' });
      expect(cfg.mobileScale).toBe(0.6);
    });

    it('clamps a too-small value up to the 0.3 floor', () => {
      const cfg = deriveScoreboardConfig({ SCOREBOARD_MOBILE_SCALE: '0.2' });
      expect(cfg.mobileScale).toBe(0.3);
    });

    it('clamps a too-large value down to the 1.0 ceiling', () => {
      const cfg = deriveScoreboardConfig({ SCOREBOARD_MOBILE_SCALE: '5' });
      expect(cfg.mobileScale).toBe(1.0);
    });

    it('falls back to 1.0 for a non-numeric value', () => {
      const cfg = deriveScoreboardConfig({ SCOREBOARD_MOBILE_SCALE: 'not-a-number' });
      expect(cfg.mobileScale).toBe(1.0);
    });
  });

  describe('kioskZoom fallback chain', () => {
    it('defaults to 100 when neither KIOSK_ZOOM nor SCOREBOARD_ZOOM is set', () => {
      const cfg = deriveScoreboardConfig({});
      expect(cfg.kioskZoom).toBe(100);
    });

    it('falls back to SCOREBOARD_ZOOM when KIOSK_ZOOM is unset', () => {
      const cfg = deriveScoreboardConfig({ SCOREBOARD_ZOOM: '130' });
      expect(cfg.kioskZoom).toBe(130);
    });

    it('KIOSK_ZOOM wins over SCOREBOARD_ZOOM when both are set', () => {
      const cfg = deriveScoreboardConfig({ SCOREBOARD_ZOOM: '130', KIOSK_ZOOM: '150' });
      expect(cfg.kioskZoom).toBe(150);
    });

    it('uses KIOSK_ZOOM alone when SCOREBOARD_ZOOM is unset', () => {
      const cfg = deriveScoreboardConfig({ KIOSK_ZOOM: '175' });
      expect(cfg.kioskZoom).toBe(175);
    });

    it('clamps a too-small KIOSK_ZOOM up to the 50 floor', () => {
      const cfg = deriveScoreboardConfig({ KIOSK_ZOOM: '20' });
      expect(cfg.kioskZoom).toBe(50);
    });

    it('clamps a too-large KIOSK_ZOOM down to the 300 ceiling', () => {
      const cfg = deriveScoreboardConfig({ KIOSK_ZOOM: '999' });
      expect(cfg.kioskZoom).toBe(300);
    });

    it('does not let an out-of-range SCOREBOARD_ZOOM fallback escape clamping', () => {
      const cfg = deriveScoreboardConfig({ SCOREBOARD_ZOOM: '999' });
      expect(cfg.kioskZoom).toBe(300);
    });

    it('cascades to SCOREBOARD_ZOOM when KIOSK_ZOOM is set but unparseable', () => {
      const cfg = deriveScoreboardConfig({ KIOSK_ZOOM: 'abc', SCOREBOARD_ZOOM: '130' });
      expect(cfg.kioskZoom).toBe(130);
    });
  });

  describe('mobileVertical', () => {
    it('defaults to true when unset', () => {
      const cfg = deriveScoreboardConfig({});
      expect(cfg.mobileVertical).toBe(true);
    });

    it('is false only when explicitly set to the string "false"', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_MOBILE_VERTICAL: 'false' }).mobileVertical).toBe(false);
      expect(deriveScoreboardConfig({ SCOREBOARD_MOBILE_VERTICAL: 'true' }).mobileVertical).toBe(true);
      expect(deriveScoreboardConfig({ SCOREBOARD_MOBILE_VERTICAL: 'anything-else' }).mobileVertical).toBe(true);
    });
  });
});
