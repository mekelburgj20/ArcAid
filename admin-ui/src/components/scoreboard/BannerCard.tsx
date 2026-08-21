import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, Minus, BadgeCheck, ChevronRight } from 'lucide-react';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, formatCountdown, GameQRCode, getTitleStyleClass, playerName } from '../ScoreboardComponents';
import PlayerNameLink from '../PlayerNameLink';
import FitRowName from './FitRowName';
import GameInfoPopup from './GameInfoPopup';
import { useScoreExpand } from './useScoreExpand';
import { qrEdgeMetrics, DEFAULT_QR_OFFSET_PX } from '../../lib/scoreboardConfig';
import { useCoverFraming } from './useCoverFraming';
import { formatScore } from '../../lib/format';
import { resolveRowClick, opensQuickView, QUICK_VIEW_HINT } from '../../lib/scoreGesture';
import { tournamentChipLabel } from './tournamentChip';

interface BannerCardProps {
  lb: GameLeaderboard;
  slug: string;
  roomId?: string;
  maxScores: number;
  minScores?: number;
  showTimer?: boolean;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
  qrSize?: number;
  qrPosition?: 'top-center' | 'bottom-center';
  /** Signed distance from the anchored edge; negative overlaps into the card. */
  qrOffsetPx?: number;
  cardBgFill?: boolean;
  /** v2.115.0 — when false the art strip and the identifier image are dropped;
   *  the title area (and its plain-text title) always renders. */
  gameHeaderEnabled?: boolean;
  titleFontSize?: number;
  gameTitleStyle?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
  /** v2.2.8 — title-click nav target (replaces the GameCard Link overlay). */
  titleLinkTo?: string;
  titleLinkOnClick?: (e: React.MouseEvent) => void;
  /** v2.109.0 (score-gesture-photos) — opens the game quick popup. */
  onOpenQuickView?: () => void;
}

function resolveImages(lb: GameLeaderboard) {
  const effectiveBgId = (lb.bgStyleId && lb.bgHasBg !== 0) ? lb.bgStyleId
    : (lb.catalogueStyleId && lb.catHasBg !== 0) ? lb.catalogueStyleId : null;
  const effectiveLogoId = (lb.logoStyleId && lb.logoHasHeader !== 0) ? lb.logoStyleId
    : (lb.catalogueStyleId && lb.catHasHeader !== 0) ? lb.catalogueStyleId : null;
  const styleBgUrl = effectiveBgId ? `/api/styles/images/backgrounds/${effectiveBgId}.png` : null;
  const styleHeaderUrl = effectiveLogoId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${effectiveLogoId}.png` : null;
  const bgImage = styleBgUrl || lb.imageUrl || null;
  return { bgImage, styleHeaderUrl };
}

const TOURNAMENT_BORDER_COLORS: Record<string, string> = {
  DG:       'border-neon-magenta/50',
  'WG-VPXS': 'border-neon-blue/50',
  'WG-VR':  'border-neon-purple/50',
  MG:       'border-neon-coral/50',
};

export default function BannerCard({
  lb,
  slug,
  roomId,
  maxScores,
  minScores = 20,
  showTimer = true,
  viewerUsername,
  viewerEntry,
  qrMode = 'disabled',
  qrSize = 30,
  qrPosition = 'top-center',
  qrOffsetPx = DEFAULT_QR_OFFSET_PX,
  cardBgFill = false,
  gameHeaderEnabled = true,
  titleFontSize,
  gameTitleStyle = 'default',
  onSubmitScore: _onSubmitScore,  // v2.2.8: no longer used here (title is a Link); kept in props for CardRouter spread compat
  titleLinkTo,
  titleLinkOnClick,
  onOpenQuickView,
}: BannerCardProps) {
  const { bgImage, styleHeaderUrl } = resolveImages(lb);
  // v2.122.1 — the fill layer's framing. Hook, not a style helper: the model
  // needs the image's intrinsic size and the layer's measured box.
  const bgLayer = useCoverFraming(cardBgFill ? bgImage : null, lb);
  const displayName = lb.displayName || lb.gameName;
  // When cardBgFill is on, the separate image area is hidden so identifier isn't visible — always show title.
  // v2.115.0: art switched off is the same situation — no identifier renders,
  // so the title must be the plain-text one rather than the art-mode overlay.
  const hasIdentifierImage = !!styleHeaderUrl && !cardBgFill && gameHeaderEnabled;
  const borderColor = TOURNAMENT_BORDER_COLORS[lb.tournamentType?.toUpperCase()] ?? 'border-border';
  const chipLabel = tournamentChipLabel(lb);

  // D1 (v2.34.0) — reserve a fixed two-line title box so a wrapping title
  // doesn't push the score area down vs sibling cards. Uses the SAME
  // default the title's fontSize style falls back to (0.875rem = 14px at
  // the app's default 16px root — no custom root font-size is set).
  const effectiveTitleFontSize = titleFontSize || 14;
  // 1.25 = Tailwind `leading-tight`, the line-height this title actually renders at.
  const titleBoxMinHeight = effectiveTitleFontSize * 1.25 * 2;
  const titleClampStyle: React.CSSProperties = {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
  };

  const [countdown, setCountdown] = useState<string | null>(
    lb.nextMaintenanceAt ? formatCountdown(lb.nextMaintenanceAt) : null
  );

  useEffect(() => {
    if (!lb.nextMaintenanceAt) { setCountdown(null); return; }
    setCountdown(formatCountdown(lb.nextMaintenanceAt));
    const interval = setInterval(() => {
      setCountdown(formatCountdown(lb.nextMaintenanceAt!));
    }, 60000);
    return () => clearInterval(interval);
  }, [lb.nextMaintenanceAt]);

  const { expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple } = useScoreExpand(roomId, lb.gameId, lb.gameName, lb.rankings.length);

  // Build visible entries with viewer injection
  let visibleEntries = lb.rankings.slice(0, maxScores);
  if (viewerEntry && viewerUsername) {
    const lowerViewer = viewerUsername.toLowerCase();
    const viewerInVisible = visibleEntries.some(
      e => e.iscored_username.toLowerCase() === lowerViewer
    );
    if (!viewerInVisible && viewerEntry.rank > maxScores) {
      visibleEntries = [...visibleEntries.slice(0, maxScores - 1), viewerEntry];
    }
  }

  // Minimum height for score area based on minScores setting (~30px per row)
  const scoreAreaMinHeight = minScores * 30;

  const showQr = qrMode !== 'disabled';
  const qrMetrics = qrEdgeMetrics(qrSize, showQr, qrPosition, qrOffsetPx);

  // S21 — scoreboard-card-slot: at <=640px the page's mobile-vertical CSS
  // forces this to width:100% so the card actually fills the full-width
  // mobile column (the outer layout wrapper alone isn't enough — this
  // inner div is where the fixed 280px lives).
  return (
    <div className="scoreboard-card-slot" style={{ position: 'relative', width: 280, maxWidth: '100%', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* QR — top edge, horizontally centred. In flow (not absolute) so the
          slot reserves the space itself: a box of `qrSize` with a marginBottom
          of `qrOffsetPx` leaves exactly `qrSize + qrOffsetPx` above the card.
          A negative offset therefore pulls the QR down over the card's top
          edge; a positive one opens a gap. */}
      {showQr && qrPosition === 'top-center' && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: qrOffsetPx, position: 'relative', zIndex: 15 }}>
          <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
        </div>
      )}
    <div
      className={`relative border-2 ${borderColor} rounded-lg overflow-hidden flex flex-col flex-1`}
    >
      {/* Background layer */}
      <div className="absolute inset-0 bg-surface" />

      {/* Card background fill */}
      {cardBgFill && bgImage && (
        <div
          className="absolute inset-0 z-[0]"
          ref={bgLayer.ref}
          {...bgLayer.data}
          style={{ backgroundImage: `url(${bgImage})`, ...bgLayer.style }}
        />
      )}
      {cardBgFill && bgImage && (
        <div className="absolute inset-0 z-[0] bg-black/50" />
      )}

      {/* Title area. v2.2.8: click on the title navigates to the Room Game
          Detail (via titleLinkTo). Previously the whole title area was a
          submit trigger when onSubmitScore was set — redundant with the
          explicit + button and confusing (title should behave like a link). */}
      <div className="px-4 py-3 text-center border-b border-border/30 relative">
        {!hasIdentifierImage && (
          titleLinkTo ? (
            <Link
              to={titleLinkTo}
              onClick={titleLinkOnClick}
              data-tour="game-card-title"
              className={`font-display font-bold leading-tight px-5 flex items-center justify-center gap-1 text-center no-underline text-primary hover:text-neon-cyan transition-colors ${getTitleStyleClass(gameTitleStyle)}`}
              style={{ fontSize: titleFontSize ? `${titleFontSize}px` : '0.875rem', overflowWrap: 'break-word', wordBreak: 'break-word', minHeight: titleBoxMinHeight }}
            >
              <span style={titleClampStyle}>{displayName}</span>
              <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} roomId={roomId} gameName={lb.gameName} globalGameId={lb.globalGameId} size={13} />
            </Link>
          ) : (
            <h3 className={`font-display font-bold leading-tight px-5 flex items-center justify-center gap-1 text-center ${getTitleStyleClass(gameTitleStyle)}`} style={{ fontSize: titleFontSize ? `${titleFontSize}px` : '0.875rem', overflowWrap: 'break-word', wordBreak: 'break-word', minHeight: titleBoxMinHeight }}>
              <span style={titleClampStyle}>{displayName}</span>
              <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} roomId={roomId} gameName={lb.gameName} globalGameId={lb.globalGameId} size={13} />
            </h3>
          )
        )}
        {/* Header-art mode hides the title row, so the "i" moves to a corner
            overlay. No longer gated on notes/url: the bubble now also answers
            "what engines and hardware does this tournament allow", which every
            card has, so gating it would hide the thing players are told to
            look for. `GameInfoPopup` still self-hides when it has nothing. */}
        {hasIdentifierImage && (
          <div className="absolute left-3 top-3 z-[2]">
            <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} roomId={roomId} gameName={lb.gameName} globalGameId={lb.globalGameId} size={13} />
          </div>
        )}
        {(chipLabel || lb.gameStatus === 'COMPLETED' || lb.isPinned) && (
          <p className={`text-[11px] sb-fs-11 uppercase tracking-wider ${hasIdentifierImage ? '' : 'mt-0.5'} text-muted flex items-center justify-center gap-1`}>
            {lb.isPinned ? (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm bg-neon-cyan/10 text-neon-cyan/80 text-[10px] sb-fs-10 tracking-normal normal-case">
                Pinned
              </span>
            ) : (
              chipLabel
            )}
            {lb.gameStatus === 'COMPLETED' && (
              <Lock size={14} strokeWidth={2.5} className="text-neon-amber flex-shrink-0" />
            )}
          </p>
        )}
        {showTimer && countdown && (
          <p className="text-[10px] sb-fs-10 text-faint mt-0.5">{countdown}</p>
        )}
      </div>

      {/* Background image area (hidden when bg fill is on since image covers
          whole card, and when the room switched the game art off). */}
      {bgImage && !cardBgFill && gameHeaderEnabled && (
        <div className="relative h-28 bg-raised">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${bgImage})`,
              backgroundSize: 'cover',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'top center',
            }}
          />
          {/* Eager: card-header art on the always-visible scoreboard wall. */}
          {styleHeaderUrl && (
            <img src={styleHeaderUrl} alt="" decoding="async" className="absolute inset-0 w-full h-full object-contain z-[1]" />
          )}
        </div>
      )}

      {/* Scores */}
      <div className="flex-1 relative" style={{ minHeight: scoreAreaMinHeight }}>
        {lb.rankings.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-faint">No scores yet</p>
          </div>
        ) : (
          <div className="space-y-1 py-1 px-2">
            {visibleEntries.map((entry) => {
              const isViewerRow = viewerUsername && entry.iscored_username.toLowerCase() === viewerUsername.toLowerCase();
              const rankColor = entry.rank === 1 ? 'text-neon-amber' :
                entry.rank === 2 ? 'text-neon-cyan' :
                entry.rank === 3 ? 'text-neon-green' : 'text-faint';
              const scoreColor = entry.rank === 1 ? 'text-neon-amber' : isViewerRow ? 'text-neon-cyan' : 'text-primary';
              const canExpand = hasMultiple(entry.iscored_username);
              const isExpanded = expandedPlayer === entry.iscored_username;
              const onRowClick = resolveRowClick(canExpand, isExpanded, () => togglePlayer(entry.iscored_username), onOpenQuickView);
              const showHint = opensQuickView(canExpand, isExpanded, !!onOpenQuickView);

              return (
                <div key={`${entry.rank}-${entry.iscored_username}`}>
                  <div
                    className={`flex items-center gap-1.5 ${onRowClick ? 'cursor-pointer pointer-events-auto' : ''}`}
                    onClick={onRowClick}
                    title={showHint ? QUICK_VIEW_HINT : undefined}
                  >
                    <span className={`w-6 text-right text-xs font-bold tabular-nums flex-shrink-0 ${rankColor}`}>
                      {entry.rank}
                    </span>
                    {/* min-w-0: without it the pill's min-content (driven by the
                        widest score) would widen the whole row rather than the
                        pill absorbing the available space. Mobile-polish batch
                        (2026-08-12): avatar used to sit absolutely-positioned at
                        the pill's left edge while the name centered across the
                        FULL pill width — the two drifted apart as separate
                        elements instead of reading as one unit. Now the avatar
                        lives inside the same centered flex row as the name, so
                        they move (and center) together; only the score stays on
                        its own line below. */}
                    <div className={`flex-1 min-w-0 rounded-full px-3 py-1 ${
                      isViewerRow ? 'bg-neon-cyan/25' : 'bg-white/18'
                    }`}>
                      <div className="text-center">
                        {/* v2.13.16: PlayerNameLink opens quick-view modal on
                            click; modifier-click falls through to full page. */}
                        <div className="flex items-center justify-center gap-1.5 min-w-0">
                          <PlayerAvatar
                            username={playerName(entry)}
                            discordUserId={entry.discord_user_id}
                            avatarHash={entry.avatar_hash}
                            avatarUrl={entry.avatar_url}
                            size={16}
                          />
                          <FitRowName className="text-[11px] sb-row-name min-w-0">
                            <PlayerNameLink
                              slug={slug}
                              entry={entry}
                              onClick={e => e.stopPropagation()}
                              className="text-secondary no-underline hover:text-neon-cyan transition-colors"
                            />
                          </FitRowName>
                          {entry.verified && (
                            <span className="inline-flex items-center text-neon-green flex-shrink-0" title="Verified by an admin" aria-label="Verified score">
                              <BadgeCheck size={11} />
                            </span>
                          )}
                        </div>
                        <span
                          className={`text-xs sb-row-score font-bold tabular-nums whitespace-nowrap block ${scoreColor}`}
                          title={formatScore(entry.score).endsWith('T') ? entry.score.toLocaleString() : undefined}
                        >
                          {formatScore(entry.score)}
                        </span>
                      </div>
                    </div>
                    {canExpand && isExpanded ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); togglePlayer(entry.iscored_username); }}
                        className="p-1 -m-1 text-neon-cyan flex-shrink-0 cursor-pointer"
                        aria-label="Hide score history"
                        title="Hide score history"
                      >
                        <Minus size={10} />
                      </button>
                    ) : canExpand ? (
                      <Plus size={10} className="text-faint flex-shrink-0" />
                    ) : showHint ? (
                      <ChevronRight size={10} className="text-faint flex-shrink-0" aria-hidden />
                    ) : null}
                  </div>
                  {isExpanded && (
                    <div className="ml-8 mr-2 mt-0.5 mb-1 bg-deep/50 rounded px-2 py-1">
                      {historyLoading ? (
                        <p className="text-faint text-[10px] py-0.5">Loading...</p>
                      ) : playerHistory.length > 0 ? (
                        <div className="space-y-0.5">
                          {playerHistory.map(h => (
                            <div
                              key={h.id}
                              className={`flex items-center justify-between text-[10px] ${onOpenQuickView ? 'cursor-pointer' : ''}`}
                              onClick={onOpenQuickView}
                            >
                              <span className="text-muted">{h.score.toLocaleString()}</span>
                              <span className="text-faint">{new Date(h.created_at).toLocaleDateString()}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-faint text-[10px] py-0.5">No additional scores.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border/30 px-3 flex justify-between items-start text-[10px] sb-fs-10 text-faint" style={{ paddingTop: 8, paddingBottom: 8 + qrMetrics.footerExtra }}>
        <a href={`/${slug}/games/${encodeURIComponent(lb.gameName)}`} className="text-neon-cyan/60 hover:text-neon-cyan transition-colors">
          Full Leaderboard &rarr;
        </a>
        <span>{lb.rankings.length} player{lb.rankings.length !== 1 ? 's' : ''}</span>
      </div>

    </div>
      {/* QR — bottom edge, horizontally centred. Mirrors the top placement:
          marginTop of `qrOffsetPx` means a negative offset overlaps the card's
          bottom edge and a positive one pushes the QR away from it. */}
      {showQr && qrPosition === 'bottom-center' && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: qrOffsetPx, position: 'relative', zIndex: 15 }}>
          <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
        </div>
      )}
    </div>
  );
}
