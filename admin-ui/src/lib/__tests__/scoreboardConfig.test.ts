import { describe, it, expect } from 'vitest';
import { deriveScoreboardConfig, getCardWidth, normalizeQrPosition, deriveQrOffsetPx, qrEdgeMetrics, DEFAULT_QR_OFFSET_PX } from '../scoreboardConfig';

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

  // v2.31.0 (ranking-card restyle) — first coverage for rankingsStyle
  // derivation/validation; closes a pre-existing gap (this field previously
  // had no dedicated test).
  describe('rankingsStyle', () => {
    it('defaults to "match" when unset', () => {
      const cfg = deriveScoreboardConfig({});
      expect(cfg.rankingsStyle).toBe('match');
    });

    it('accepts each valid value', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_RANKINGS_STYLE: 'match' }).rankingsStyle).toBe('match');
      expect(deriveScoreboardConfig({ SCOREBOARD_RANKINGS_STYLE: 'plaque' }).rankingsStyle).toBe('plaque');
      expect(deriveScoreboardConfig({ SCOREBOARD_RANKINGS_STYLE: 'compact' }).rankingsStyle).toBe('compact');
      expect(deriveScoreboardConfig({ SCOREBOARD_RANKINGS_STYLE: 'sidebar' }).rankingsStyle).toBe('sidebar');
      // v2.9x — "ticker" treatment (full-width scrolling marquee strip).
      expect(deriveScoreboardConfig({ SCOREBOARD_RANKINGS_STYLE: 'ticker' }).rankingsStyle).toBe('ticker');
    });

    it('falls back to "match" for an unrecognized value', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_RANKINGS_STYLE: 'junk' }).rankingsStyle).toBe('match');
    });
  });

  // Style-system revamp Phase 1 — the Arcade card family. The style whitelist
  // is the gate a new style has to pass to reach CardRouter at all: an id
  // missing from it is silently coerced to banner, which looks like the card
  // component never shipped.
  describe('style whitelist', () => {
    it('accepts each shipped style, arcade included', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_STYLE: 'arcade' }).style).toBe('arcade');
      expect(deriveScoreboardConfig({ SCOREBOARD_STYLE: 'banner' }).style).toBe('banner');
      expect(deriveScoreboardConfig({ SCOREBOARD_STYLE: 'showcase' }).style).toBe('showcase');
      expect(deriveScoreboardConfig({ SCOREBOARD_STYLE: 'minimal' }).style).toBe('minimal');
    });

    it('falls back to banner for an unrecognized style', () => {
      // Deliberately NOT arcade: an unknown stored value is a data fault, and
      // promoting it to the new flagship would hide that behind the redesign.
      expect(deriveScoreboardConfig({ SCOREBOARD_STYLE: 'junk' }).style).toBe('banner');
    });

    it('still infers a legacy style when SCOREBOARD_STYLE is absent', () => {
      // The read-time legacy heuristic is untouched by Phase 1 — converting
      // styleless rooms is migration 144's job, done once and recorded, not
      // re-derived on every page load.
      expect(deriveScoreboardConfig({}).style).toBe('banner');
      expect(deriveScoreboardConfig({ SCOREBOARD_CARD_LAYOUT: 'fullart' }).style).toBe('showcase');
    });

    it('gives arcade the art-forward 380px card width', () => {
      expect(getCardWidth('arcade')).toBe(380);
      expect(getCardWidth('arcade')).toBe(getCardWidth('showcase'));
      expect(getCardWidth('banner')).toBe(280);
    });
  });

  // Owner podium redesign (2026-08-13): holo-steps REPLACES the old podium as
  // what showcase rooms see by default; pyramid/chip stay selectable via the
  // per-room setting rather than deleted.
  describe('podiumVariant', () => {
    it('defaults to holo-steps when SCOREBOARD_PODIUM_VARIANT is unset', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_STYLE: 'showcase' }).podiumVariant).toBe('holo-steps');
    });

    it('honors an explicit classic pin', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_PODIUM_VARIANT: 'pyramid' }).podiumVariant).toBe('pyramid');
      expect(deriveScoreboardConfig({ SCOREBOARD_PODIUM_VARIANT: 'chip' }).podiumVariant).toBe('chip');
      expect(deriveScoreboardConfig({ SCOREBOARD_PODIUM_VARIANT: 'holo-steps' }).podiumVariant).toBe('holo-steps');
    });

    it('coerces an unknown stored value back to holo-steps', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_PODIUM_VARIANT: 'junk' }).podiumVariant).toBe('holo-steps');
    });
  });
  // Owner call (2026-08-15): card background fill is ON unless a room turned
  // it off. Was default-OFF, which left table art confined to the header strip
  // on every room whose admin never found the toggle.
  describe('cardBgFill', () => {
    it('defaults to true when SCOREBOARD_CARD_BG_FILL is unset', () => {
      expect(deriveScoreboardConfig({}).cardBgFill).toBe(true);
      expect(deriveScoreboardConfig({ SCOREBOARD_STYLE: 'arcade' }).cardBgFill).toBe(true);
    });

    it('honors an explicit opt-out and ignores junk', () => {
      expect(deriveScoreboardConfig({ SCOREBOARD_CARD_BG_FILL: 'false' }).cardBgFill).toBe(false);
      expect(deriveScoreboardConfig({ SCOREBOARD_CARD_BG_FILL: 'true' }).cardBgFill).toBe(true);
      expect(deriveScoreboardConfig({ SCOREBOARD_CARD_BG_FILL: 'anything-else' }).cardBgFill).toBe(true);
    });
  });
  /**
   * Owner call, 2026-08-15: the QR anchors to an EDGE and is always centred
   * horizontally, and its distance from that edge is a SIGNED offset —
   * negative overlaps the border, positive pushes it away. The old vocabulary
   * (top-right / bottom-right / bottom-center + an unsigned "overlap" that
   * clamped at zero) is folded in at read time, not migrated.
   */
  describe('QR anchor + offset', () => {
    it('folds the retired corner positions onto the same edge', () => {
      expect(normalizeQrPosition('top-right')).toBe('top-center');
      expect(normalizeQrPosition('bottom-right')).toBe('bottom-center');
      // A room that chose the bottom must not silently jump to the top.
      expect(normalizeQrPosition('bottom-center')).toBe('bottom-center');
      expect(normalizeQrPosition('top-center')).toBe('top-center');
    });

    it('defaults to the top edge for unset or unrecognised values', () => {
      expect(normalizeQrPosition(undefined)).toBe('top-center');
      expect(normalizeQrPosition('')).toBe('top-center');
      expect(normalizeQrPosition('somewhere-else')).toBe('top-center');
    });

    it('defaults the offset to a 10px overlap, matching the old fixed behaviour', () => {
      expect(DEFAULT_QR_OFFSET_PX).toBe(-10);
      expect(deriveQrOffsetPx({})).toBe(-10);
      expect(deriveScoreboardConfig({}).qrOffsetPx).toBe(-10);
    });

    it('negates the legacy unsigned overlap key when only that is stored', () => {
      expect(deriveQrOffsetPx({ SCOREBOARD_QR_OVERLAP_PX: '6' })).toBe(-6);
      expect(deriveQrOffsetPx({ SCOREBOARD_QR_OVERLAP_PX: '0' })).toBe(0);
    });

    it('lets the new signed key win, including positive values the old one could not express', () => {
      expect(deriveQrOffsetPx({ SCOREBOARD_QR_OFFSET_PX: '14', SCOREBOARD_QR_OVERLAP_PX: '6' })).toBe(14);
      expect(deriveQrOffsetPx({ SCOREBOARD_QR_OFFSET_PX: '-2' })).toBe(-2);
      expect(deriveQrOffsetPx({ SCOREBOARD_QR_OFFSET_PX: '0' })).toBe(0);
    });

    it('splits a negative offset into overlap-inside and hang-outside', () => {
      const m = qrEdgeMetrics(30, true, 'bottom-center', -10);
      expect(m.peek).toBe(10);     // sits inside the card
      expect(m.outside).toBe(20);  // hangs past the edge
      expect(m.footerExtra).toBe(14);
    });

    it('treats a positive offset as a gap with nothing inside the card', () => {
      const m = qrEdgeMetrics(30, true, 'bottom-center', 12);
      expect(m.peek).toBe(0);
      expect(m.outside).toBe(42);
      expect(m.footerExtra).toBe(0);
    });

    it('adds no footer padding for a TOP-anchored QR — it overlaps the header, not the footer', () => {
      expect(qrEdgeMetrics(30, true, 'top-center', -10).footerExtra).toBe(0);
      expect(qrEdgeMetrics(30, true, 'top-center', -10).peek).toBe(10);
    });

    it('collapses to zero when QR is off or sizeless', () => {
      expect(qrEdgeMetrics(30, false, 'bottom-center', -10)).toEqual({ outside: 0, peek: 0, footerExtra: 0 });
      expect(qrEdgeMetrics(0, true, 'bottom-center', -10)).toEqual({ outside: 0, peek: 0, footerExtra: 0 });
    });

    it('never lets the overlap exceed the QR itself', () => {
      expect(qrEdgeMetrics(20, true, 'bottom-center', -500).peek).toBe(20);
      expect(qrEdgeMetrics(20, true, 'bottom-center', -500).outside).toBe(0);
    });
  });
});
