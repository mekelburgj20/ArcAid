import { useEffect, useState, type ReactNode } from 'react';
import ScoreCardGrid from '../ScoreCardGrid';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { api } from '../../lib/api';
import { getPortal } from '../../lib/portal';
import { deriveScoreboardConfig, deriveCardProps, getCardWidth } from '../../lib/scoreboardConfig';
import type { CardStyleDraft } from './cardEditSession';

/**
 * v2.124.0 (C3) — ONE card, rendered exactly the way this room renders it, for
 * the pages that have no board to point at.
 *
 * The admin Leaderboard's card editor previews on the real card because the
 * real card is right there. GameLibrary and Tournaments edit art for games that
 * are not on screen, and `StylePicker` "solved" that with a 128px-tall strip
 * that shared neither the card's aspect ratio nor its style, theme or fill
 * setting — the structural reason "the framing doesn't look like the card
 * sizing" was unavoidable there.
 *
 * So this builds a MOCK row and hands it to `ScoreCardGrid`, the same one-card
 * path the public Scores tabs use. Everything that decides how the card looks
 * comes from the room: `GET /rooms/:roomId/scoreboard-config` is the same
 * allowlisted map the public board reads (Style, Theme, fill, spacing, scores
 * per card…), and the room's PUBLIC theme is scoped onto the subtree, because
 * `/:slug/admin/*` runs on the admin's personal theme and an otherwise-perfect
 * preview in the wrong colours is still a lie.
 *
 * Only the PLAYERS are fake. Six deterministic rows, no real names — a preview
 * that showed real people would invite an admin to read it as data.
 */

/** Six rows: enough to fill a card at the default "scores per card" without
 *  pretending to be a leaderboard anybody should act on. */
export const PLACEHOLDER_ROWS: RankedEntry[] = [
  { rank: 1, discord_user_id: '', iscored_username: 'Player One', score: 123_456_789 },
  { rank: 2, discord_user_id: '', iscored_username: 'Player Two', score: 98_765_432 },
  { rank: 3, discord_user_id: '', iscored_username: 'Player Three', score: 76_543_210 },
  { rank: 4, discord_user_id: '', iscored_username: 'Player Four', score: 54_321_098 },
  { rank: 5, discord_user_id: '', iscored_username: 'Player Five', score: 32_109_876 },
  { rank: 6, discord_user_id: '', iscored_username: 'Player Six', score: 10_987_654 },
];

/** The art-bearing fields of whatever row is being edited — a library row, an
 *  active game row, anything with the same four ids and a framing triple. */
export interface SyntheticCardSource {
  gameName: string;
  displayName?: string | null;
  /** Catalogue art, the card's background when the style carries none. */
  imageUrl?: string | null;
  catalogueStyleId: string | null;
  logoStyleId?: string | null;
  bgStyleId?: string | null;
  catHasBg?: number | null;
  catHasHeader?: number | null;
  bgHasBg?: number | null;
  logoHasHeader?: number | null;
  styleHeaderDisabled: boolean;
  bgZoom?: number | null;
  bgPosX?: number | null;
  bgPosY?: number | null;
  /** Real values when the target is an activated game; omitted for a library
   *  row, which gets a neutral "Room default" chip instead of a borrowed tag. */
  tournamentName?: string | null;
  tournamentType?: string | null;
}

export function buildSyntheticLeaderboard(src: SyntheticCardSource, overlay?: CardStyleDraft): GameLeaderboard {
  const lb: GameLeaderboard = {
    gameId: `preview-${src.gameName}`,
    gameName: src.gameName,
    displayName: src.displayName ?? null,
    // The chip names the tournament tag, falling back to the name. A library
    // row belongs to no tournament, so it says so rather than borrowing a tag
    // it does not have.
    tournamentName: src.tournamentName || 'Room default',
    tournamentType: src.tournamentType || '',
    imageUrl: src.imageUrl ?? null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: src.catalogueStyleId,
    logoStyleId: src.logoStyleId ?? null,
    bgStyleId: src.bgStyleId ?? null,
    styleHeaderDisabled: !!src.styleHeaderDisabled,
    // The `has_*` flags decide whether the ids draw anything at all
    // (`resolveImages`, build trap #6). A source that doesn't track them —
    // `games.catalogue_style_id` has no companion columns — is assumed to
    // carry both, which is what the real card assumes for the same row.
    catHasBg: src.catHasBg ?? (src.catalogueStyleId ? 1 : null),
    catHasHeader: src.catHasHeader ?? (src.catalogueStyleId ? 1 : null),
    bgHasBg: src.bgHasBg ?? (src.bgStyleId ? 1 : null),
    logoHasHeader: src.logoHasHeader ?? (src.logoStyleId ? 1 : null),
    bgZoom: src.bgZoom ?? null,
    bgPosX: src.bgPosX ?? null,
    bgPosY: src.bgPosY ?? null,
    notes: null,
    rankings: PLACEHOLDER_ROWS,
  };
  // Merged exactly as the Leaderboard page merges a draft into a real row: the
  // overlay is DERIVED from the edit session on every render, never stored.
  return overlay ? { ...lb, ...overlay } : lb;
}

export interface SyntheticCardPreviewProps {
  roomId: string;
  source: SyntheticCardSource;
  /** The live edit session's overlay, merged before render. */
  overlay?: CardStyleDraft;
  /**
   * Skips the fetch. Tests pass it; so could a host that already holds the
   * room's config. `null` means "still loading".
   */
  config?: Record<string, string> | null;
  roomName?: string;
  slug?: string;
  /** Reports the room config once it lands — the editor needs
   *  `SCOREBOARD_CARD_BG_FILL` to be honest about framing. */
  onConfig?: (config: Record<string, string>) => void;
  /** The framing drag overlay, rendered as a sibling ON the card. */
  children?: ReactNode;
}

export default function SyntheticCardPreview({
  roomId,
  source,
  overlay,
  config: configProp,
  roomName,
  slug,
  onConfig,
  children,
}: SyntheticCardPreviewProps) {
  const [fetched, setFetched] = useState<Record<string, string> | null>(null);
  const [roomTheme, setRoomTheme] = useState<string | null>(null);

  useEffect(() => {
    if (configProp !== undefined) return;
    let cancelled = false;
    api.get<Record<string, string>>(`/rooms/${roomId}/scoreboard-config`)
      .then(c => { if (!cancelled) { setFetched(c); onConfig?.(c); } })
      .catch(() => { if (!cancelled) setFetched({}); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, configProp === undefined]);

  useEffect(() => {
    if (configProp) onConfig?.(configProp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configProp]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    getPortal(slug)
      .then(p => { if (!cancelled) setRoomTheme(p.public_theme || p.ui_theme || 'dark'); })
      .catch(() => { if (!cancelled) setRoomTheme('dark'); });
    return () => { cancelled = true; };
  }, [slug]);

  const config = configProp !== undefined ? configProp : fetched;

  if (!config) {
    return (
      <div data-testid="synthetic-card-preview" className="flex justify-center py-10">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  const lb = buildSyntheticLeaderboard(source, overlay);
  // The wrapper is pinned to the card's own width so the drag overlay's
  // `inset-0` is the CARD, not the column it is centred in — `ScoreCardGrid`
  // centres a lone card inside whatever space it is given.
  const cardWidth = config.SCOREBOARD_STYLE
    ? getCardWidth(deriveScoreboardConfig(config, roomName).style)
    : deriveCardProps(config, roomName).cardWidth;

  // `sb-theme-scope` restates the default dark tokens so the preview stays dark
  // even when this admin's own UI theme is light (see index.css).
  const themeClass = `sb-theme-scope${roomTheme && roomTheme !== 'dark' ? ` theme-${roomTheme}` : ''}`;

  return (
    <div data-testid="synthetic-card-preview" className={themeClass}>
      <div className="relative mx-auto w-full" style={{ maxWidth: `${cardWidth}px` }}>
        <ScoreCardGrid
          cards={[lb]}
          slug={slug || 'preview'}
          roomId={roomId}
          config={config}
          roomName={roomName || ''}
          loading={false}
          emptyState={null}
          linkFor={() => '#'}
          onSubmit={() => {}}
          /* Swallows the title click: a card inside a modal must not navigate
             the page out from under the edit session. */
          onTitleClick={() => {}}
        />
        {children}
      </div>
      <p className="mt-2 text-[10px] text-faint text-center">
        Sample players — the art, style and theme are this room’s real settings.
      </p>
    </div>
  );
}
