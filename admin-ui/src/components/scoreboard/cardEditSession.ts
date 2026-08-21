import type { GameLeaderboard } from '../ScoreboardComponents';
import type { ArtPackStyle, CardFraming, ImageApplyType } from './CardStyleEditor';
import { resolveFraming, DEFAULT_BG_ZOOM, DEFAULT_BG_POS } from '../../lib/bgFraming';

/**
 * v2.124.0 (C3) — the per-card edit session, lifted verbatim out of
 * `pages/Leaderboard.tsx` so the sheet that replaced `StylePicker` on
 * GameLibrary/Tournaments runs the SAME state machine as the admin
 * Leaderboard's rail.
 *
 * There is exactly one card in a session, and the session is the ONLY place its
 * pending changes live: the overlay handed to whatever renders the card is
 * DERIVED from it on every render (`buildGameCardOverlay`) rather than stored.
 * On the Leaderboard that is what makes the preview survive a
 * `leaderboard:updated` refetch — the refetch replaces the `leaderboards`
 * array, and the next render simply re-merges the same session over the fresh
 * row (build trap #8). In the sheet the mock row is rebuilt from props the same
 * way, so the rule holds for free.
 */
export interface CardEditSession {
  kind: 'game' | 'ranking';
  /** gameId, library game name, or ranking-group id. */
  id: string;
  name: string;
  /** `undefined` = art untouched · `null` = "Clear style" staged · else the pick. */
  pick?: ArtPackStyle | null;
  applyAs: ImageApplyType;
  headerDisabled: boolean;
  framing: CardFraming;
  setAsDefault: boolean;
  libraryHasDefault: boolean;
  /** Anything edited at all — drives the switch-card / apply-profile guards.
   *  NOT Apply's enabled state: see `baseline`. */
  touched: boolean;
  /**
   * v2.122.1 — the card's state when the session opened, so Apply can enable on
   * a REAL change instead of on any interaction. The v1 rule ANDed `touched`
   * with "there is an art-pack id to hang framing on", which left Apply dead
   * after a zoom-only edit; framing now has its own endpoint, so the id is no
   * longer a precondition and the honest question is simply "did anything
   * move?".
   */
  baseline: { applyAs: ImageApplyType; headerDisabled: boolean; framing: CardFraming; setAsDefault: boolean };
}

/** The subset of a leaderboard row the card editor can move. */
export type CardStyleDraft = Partial<Pick<GameLeaderboard,
  'catalogueStyleId' | 'logoStyleId' | 'bgStyleId' | 'styleHeaderDisabled' |
  'bgZoom' | 'bgPosX' | 'bgPosY' | 'bgHasBg' | 'logoHasHeader' | 'catHasBg' | 'catHasHeader'
>>;

/**
 * Session → the fields the CARDS actually read.
 *
 * Build trap #6: `resolveImages` gates on `bgHasBg`/`catHasBg`/`logoHasHeader`/
 * `catHasHeader`, not on the ids, so a preview that set only the id would show
 * the old art (or none) and lie about what Apply is going to do. The picked
 * style carries `has_background`/`has_header`, so the flags come free.
 *
 * The three branches mirror the three endpoint families exactly — see
 * `applyCardEdits`.
 */
export function buildGameCardOverlay(s: CardEditSession): CardStyleDraft {
  const d: CardStyleDraft = {
    styleHeaderDisabled: s.headerDisabled,
    bgZoom: s.framing.zoom,
    bgPosX: s.framing.posX,
    bgPosY: s.framing.posY,
  };
  if (s.pick === null) {
    // DELETE .../style === `removeFromGame`: catalogue style, header flag and
    // framing all go; the independent logo/bg overrides survive.
    d.catalogueStyleId = null;
    d.catHasBg = null;
    d.catHasHeader = null;
    d.styleHeaderDisabled = false;
    d.bgZoom = null;
    d.bgPosX = null;
    d.bgPosY = null;
  } else if (s.pick) {
    if (s.applyAs === 'both') {
      d.catalogueStyleId = s.pick.id;
      d.catHasBg = s.pick.has_background;
      d.catHasHeader = s.pick.has_header;
    } else if (s.applyAs === 'background') {
      d.bgStyleId = s.pick.id;
      d.bgHasBg = s.pick.has_background;
    } else {
      d.logoStyleId = s.pick.id;
      d.logoHasHeader = s.pick.has_header;
    }
  }
  return d;
}

/** Did the framing actually move? Both sides are already defaults-applied. */
export function framingMoved(a: CardFraming, b: CardFraming): boolean {
  return a.zoom !== b.zoom || a.posX !== b.posX || a.posY !== b.posY;
}

/**
 * A pure framing edit — no art pack picked or cleared, no identifier toggle,
 * no Apply-as change. That is the case the `/framing` endpoints exist for:
 * they write `bg_zoom/bg_pos_x/bg_pos_y` and nothing else, so zoom and
 * position apply to ANY card rather than only to art-pack ones.
 */
export function isFramingOnlyEdit(s: CardEditSession | null): boolean {
  return !!s && s.kind === 'game'
    && s.pick === undefined
    && s.applyAs === s.baseline.applyAs
    && s.headerDisabled === s.baseline.headerDisabled;
}

/** Apply's enabled state: a real difference from the opening state. */
export function isCardEditDirty(s: CardEditSession | null): boolean {
  if (!s) return false;
  if (s.kind === 'ranking') return s.touched;
  return s.pick !== undefined
    || s.applyAs !== s.baseline.applyAs
    || s.headerDisabled !== s.baseline.headerDisabled
    || s.setAsDefault !== s.baseline.setAsDefault
    || framingMoved(s.framing, s.baseline.framing);
}

/**
 * A session opened on a card's CURRENT values.
 *
 * `resolveFraming` applies the 100/50/50 defaults, so an unframed card and a
 * card framed AT the defaults compare equal — which is what "did anything
 * move?" means to an admin.
 */
export function newGameCardSession(opts: {
  id: string;
  name: string;
  headerDisabled: boolean;
  framing: { bgZoom?: number | null; bgPosX?: number | null; bgPosY?: number | null };
  libraryHasDefault: boolean;
  /** The library row IS the default, so its own session never offers the twin. */
  setAsDefault?: boolean;
}): CardEditSession {
  const f = resolveFraming(opts.framing);
  const framing: CardFraming = { zoom: f.zoom, posX: f.posX, posY: f.posY };
  const setAsDefault = opts.setAsDefault ?? !opts.libraryHasDefault;
  return {
    kind: 'game', id: opts.id, name: opts.name,
    applyAs: 'both', headerDisabled: opts.headerDisabled,
    framing,
    setAsDefault, libraryHasDefault: opts.libraryHasDefault, touched: false,
    baseline: { applyAs: 'both', headerDisabled: opts.headerDisabled, framing, setAsDefault },
  };
}

/** Ranking groups have one background slot and no framing, per
 *  `AssignRankingGroupStyleSchema` ({ styleId } and nothing else). */
export function newRankingCardSession(id: string, name: string): CardEditSession {
  const framing: CardFraming = { zoom: DEFAULT_BG_ZOOM, posX: DEFAULT_BG_POS, posY: DEFAULT_BG_POS };
  return {
    kind: 'ranking', id, name,
    applyAs: 'both', headerDisabled: false,
    framing,
    setAsDefault: false, libraryHasDefault: false, touched: false,
    baseline: { applyAs: 'both', headerDisabled: false, framing, setAsDefault: false },
  };
}
