import { api } from '../../lib/api';
import type { CardEditSession } from './cardEditSession';

/**
 * v2.124.0 (C3) — the ONE Apply router for card art.
 *
 * Three endpoint families, and which one a save takes is decided from the
 * session, not from the page that hosts the editor. Before C3 that decision was
 * written out three times (Leaderboard's rail, GameLibrary's modal handler,
 * Tournaments' modal handler) and had already drifted: only the rail knew about
 * the `/framing` family, so on the other two pages a zoom-only edit either did
 * nothing or DELETEd the style.
 *
 * The rules that must not rot:
 *  - trap #2: send the FULL framing triple on every write. `normalizeFraming`
 *    reads an omitted axis as "unframed" and silently resets it.
 *  - trap #3: the `/image` family carries the framing separately from `/style`.
 *  - a pure framing edit takes `/framing`, which touches the three columns and
 *    no style id at all — so framing saves onto a card drawing plain catalogue
 *    art, which neither style schema would accept (both require an id).
 */

export type CardApplyTarget =
  /** An activated game row: `games.*`. The library twin is optional. */
  | { kind: 'game'; gameId: string; gameName: string }
  /** The room's per-game library default: `game_room_game_library.*`. */
  | { kind: 'library'; gameName: string };

/** Which branch ran — the caller words its own toast. */
export type CardApplyOutcome = 'framing' | 'cleared' | 'applied';

export interface CardApplyResult {
  outcome: CardApplyOutcome;
  /** The primary write succeeded but the library twin did not. */
  libraryError: boolean;
}

export async function applyCardEdits(opts: {
  roomId: string;
  target: CardApplyTarget;
  session: CardEditSession;
  /** The id Apply sends when a STYLE is what changed; null clears. */
  styleId: string | null;
  /** `isFramingOnlyEdit(session)` — passed in so the caller and the router
   *  can never disagree about which branch the UI just promised. */
  framingOnly: boolean;
  /** Game targets only: also write the room-library default for this game. */
  alsoSetLibraryDefault?: boolean;
}): Promise<CardApplyResult> {
  const { roomId, target, session, styleId, framingOnly } = opts;
  const framing = { bgZoom: session.framing.zoom, bgPosX: session.framing.posX, bgPosY: session.framing.posY };
  const perImage = session.applyAs !== 'both';
  const clearing = session.pick === null || !styleId;

  const libName = encodeURIComponent(target.gameName);
  const libBase = `/rooms/${roomId}/game_library/${libName}`;
  const base = target.kind === 'game'
    ? `/rooms/${roomId}/admin/games/${target.gameId}`
    : libBase;
  // A library target IS the default, so it never writes a twin of itself.
  const wantsTwin = target.kind === 'game' && !!opts.alsoSetLibraryDefault;

  if (framingOnly) {
    await api.put(`${base}/framing`, framing);
    let libraryError = false;
    if (wantsTwin) {
      try { await api.put(`${libBase}/framing`, framing); } catch { libraryError = true; }
    }
    return { outcome: 'framing', libraryError };
  }

  if (clearing) {
    await api.delete(`${base}/style`);
  } else if (perImage) {
    await api.put(`${base}/image`, { styleId, imageType: session.applyAs, ...framing });
  } else {
    await api.put(`${base}/style`, { catalogueStyleId: styleId, headerDisabled: session.headerDisabled, ...framing });
  }

  let libraryError = false;
  if (wantsTwin) {
    try {
      if (clearing) {
        await api.delete(`${libBase}/style`);
      } else if (perImage) {
        await api.put(`${libBase}/image`, { styleId, imageType: session.applyAs, ...framing });
      } else {
        await api.put(`${libBase}/style`, { catalogueStyleId: styleId, headerDisabled: session.headerDisabled, ...framing });
      }
    } catch { libraryError = true; }
  }

  return { outcome: clearing ? 'cleared' : 'applied', libraryError };
}
