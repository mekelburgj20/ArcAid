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
import { bgTransformStyle } from '../../lib/bgFraming';
import { formatScore } from '../../lib/format';
import { resolveRowClick, opensQuickView, QUICK_VIEW_HINT } from '../../lib/scoreGesture';
import { tournamentChipLabel } from './tournamentChip';

interface MinimalCardProps {
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
  /** v2.115.0 — accepted for CardRouter spread compat and deliberately inert:
   *  Minimal never renders header art, so there is nothing for it to hide. */
  gameHeaderEnabled?: boolean;
  titleFontSize?: number;
  gameTitleStyle?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
  /** v2.2.8 — title-click nav target. */
  titleLinkTo?: string;
  titleLinkOnClick?: (e: React.MouseEvent) => void;
  /** v2.109.0 (score-gesture-photos) — opens the game quick popup. */
  onOpenQuickView?: () => void;
}

export default function MinimalCard({
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
  titleFontSize,
  gameTitleStyle = 'default',
  onSubmitScore: _onSubmitScore,  // v2.2.8: unused (title is a Link); kept for CardRouter spread compat
  titleLinkTo,
  titleLinkOnClick,
  onOpenQuickView,
}: MinimalCardProps) {
  const displayName = lb.displayName || lb.gameName;
  const chipLabel = tournamentChipLabel(lb);
  const { expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple } = useScoreExpand(roomId, lb.gameId, lb.gameName, lb.rankings.length);

  // D1 (v2.34.0) — reserve a fixed two-line title box so a wrapping title
  // doesn't push the score area down vs sibling cards. Uses the SAME
  // default the title's fontSize style falls back to (1rem = 16px at the
  // app's default 16px root — no custom root font-size is set).
  const effectiveTitleFontSize = titleFontSize || 16;
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

  // Minimum height for score area (~30px per row)
  const scoreAreaMinHeight = minScores * 30;

  // Resolve background image for bg fill mode
  const bgImageUrl = (() => {
    if (!cardBgFill) return null;
    const effectiveBgId = (lb.bgStyleId && lb.bgHasBg !== 0) ? lb.bgStyleId
      : (lb.catalogueStyleId && lb.catHasBg !== 0) ? lb.catalogueStyleId : null;
    return effectiveBgId ? `/api/styles/images/backgrounds/${effectiveBgId}.png` : lb.imageUrl || null;
  })();

  const showQr = qrMode !== 'disabled';
  const qrMetrics = qrEdgeMetrics(qrSize, showQr, qrPosition, qrOffsetPx);

  return (
    // S21 — scoreboard-card-slot: forces width:100% at <=640px (see
    // BannerCard.tsx for the full rationale). MinimalCard has no explicit
    // width of its own (just this maxWidth cap), so without an explicit
    // width the mobile CSS override wouldn't have anything to widen —
    // the class supplies the mobile-only width:100% that's otherwise missing.
    <div className="scoreboard-card-slot" style={{ position: 'relative', maxWidth: 380 }}>
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
      className="bg-surface border border-border/40 rounded-lg overflow-hidden flex flex-col h-full relative"
    >
      {/* Card background fill */}
      {bgImageUrl && (
        <>
          <div
            className="absolute inset-0 z-0"
            style={{
              backgroundImage: `url(${bgImageUrl})`,
              backgroundSize: 'cover',
              ...bgTransformStyle(lb),
            }}
          />
          <div className="absolute inset-0 z-0 bg-black/55" />
        </>
      )}
      {/* Title area. v2.2.8: title is a Link to Room Game Detail. */}
      <div className="px-5 pt-4 pb-3 relative z-[1]">
        {titleLinkTo ? (
          <Link
            to={titleLinkTo}
            onClick={titleLinkOnClick}
            data-tour="game-card-title"
            className={`font-display font-bold leading-tight flex items-center gap-1 no-underline text-primary hover:text-neon-cyan transition-colors ${getTitleStyleClass(gameTitleStyle)}`}
            style={{ fontSize: titleFontSize ? `${titleFontSize}px` : '1rem', overflowWrap: 'break-word', wordBreak: 'break-word', minHeight: titleBoxMinHeight }}
          >
            <span style={titleClampStyle}>{displayName}</span>
            <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} roomId={roomId} gameName={lb.gameName} globalGameId={lb.globalGameId} size={13} />
          </Link>
        ) : (
          <h3 className={`font-display font-bold leading-tight text-primary flex items-center gap-1 ${getTitleStyleClass(gameTitleStyle)}`} style={{ fontSize: titleFontSize ? `${titleFontSize}px` : '1rem', overflowWrap: 'break-word', wordBreak: 'break-word', minHeight: titleBoxMinHeight }}>
            <span style={titleClampStyle}>{displayName}</span>
            <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} roomId={roomId} gameName={lb.gameName} globalGameId={lb.globalGameId} size={13} />
          </h3>
        )}
        <div className="flex items-center gap-3 mt-1">
          {lb.isPinned ? (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm bg-neon-cyan/10 text-neon-cyan/80 text-[10px] uppercase tracking-wider">
              Pinned
            </span>
          ) : chipLabel && (
            <span className="text-[11px] uppercase tracking-wider text-muted">
              {chipLabel}
            </span>
          )}
          {lb.gameStatus === 'COMPLETED' && (
            <Lock size={14} strokeWidth={2.5} className="text-neon-amber flex-shrink-0" />
          )}
          {showTimer && countdown && (
            <span className="text-[10px] text-faint">{countdown}</span>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="h-px mx-5 bg-border/30 relative z-[1]" />

      {/* Score list */}
      <div className="flex-1 px-2 py-2 relative z-[1]" style={{ minHeight: scoreAreaMinHeight }}>
        {lb.rankings.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-faint">No scores yet</p>
          </div>
        ) : (
          <div>
            {visibleEntries.map((entry) => {
              const isViewerRow = viewerUsername && entry.iscored_username.toLowerCase() === viewerUsername.toLowerCase();
              const rankColor = entry.rank === 1 ? 'text-neon-amber' :
                entry.rank === 2 ? 'text-neon-cyan' :
                entry.rank === 3 ? 'text-neon-green' : 'text-faint';
              const canExpand = hasMultiple(entry.iscored_username);
              const isExpanded = expandedPlayer === entry.iscored_username;
              const onRowClick = resolveRowClick(canExpand, isExpanded, () => togglePlayer(entry.iscored_username), onOpenQuickView);
              const showHint = opensQuickView(canExpand, isExpanded, !!onOpenQuickView);

              return (
                <div key={`${entry.rank}-${entry.iscored_username}`}>
                  <div
                    className={`flex items-center gap-2.5 px-3 py-1.5 rounded ${
                      isViewerRow ? 'bg-neon-cyan/10' : ''
                    } ${onRowClick ? 'cursor-pointer hover:bg-raised/30 transition-colors pointer-events-auto' : ''}`}
                    onClick={onRowClick}
                    title={showHint ? QUICK_VIEW_HINT : undefined}
                  >
                    <span className={`w-5 text-right text-[11px] font-semibold tabular-nums ${rankColor}`}>
                      {entry.rank}
                    </span>
                    <PlayerAvatar
                      username={playerName(entry)}
                      discordUserId={entry.discord_user_id}
                      avatarHash={entry.avatar_hash}
                      avatarUrl={entry.avatar_url}
                      size={22}
                    />
                    {/* v2.13.16: PlayerNameLink opens quick-view modal on
                        click; modifier-click falls through to full page. */}
                    <FitRowName origin="left" className="flex-1 text-sm sb-row-name min-w-0">
                      <PlayerNameLink
                        slug={slug}
                        entry={entry}
                        onClick={e => e.stopPropagation()}
                        className="text-secondary no-underline hover:text-neon-cyan transition-colors"
                      />
                    </FitRowName>
                    {entry.verified && (
                      <span className="inline-flex items-center text-neon-green flex-shrink-0" title="Verified by an admin" aria-label="Verified score">
                        <BadgeCheck size={13} />
                      </span>
                    )}
                    <span
                      className={`text-sm sb-row-score font-bold tabular-nums whitespace-nowrap ${isViewerRow ? 'text-neon-cyan' : 'text-primary'}`}
                      title={formatScore(entry.score).endsWith('T') ? entry.score.toLocaleString() : undefined}
                    >
                      {formatScore(entry.score)}
                    </span>
                    {canExpand && isExpanded ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); togglePlayer(entry.iscored_username); }}
                        className="p-1 -m-1 text-neon-cyan flex-shrink-0 cursor-pointer"
                        aria-label="Hide score history"
                        title="Hide score history"
                      >
                        <Minus size={12} />
                      </button>
                    ) : canExpand ? (
                      <Plus size={12} className="text-faint flex-shrink-0" />
                    ) : showHint ? (
                      <ChevronRight size={12} className="text-faint flex-shrink-0" aria-hidden />
                    ) : null}
                  </div>
                  {isExpanded && (
                    <div className="ml-10 mr-3 mt-0.5 mb-1 bg-deep/50 rounded px-3 py-1.5">
                      {historyLoading ? (
                        <p className="text-faint text-[10px] py-0.5">Loading...</p>
                      ) : playerHistory.length > 0 ? (
                        <div className="space-y-0.5">
                          {playerHistory.map(h => (
                            <div
                              key={h.id}
                              className={`flex items-center justify-between text-[11px] ${onOpenQuickView ? 'cursor-pointer' : ''}`}
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
      <div className="border-t border-border/30 px-5 flex justify-between items-start relative z-[1]" style={{ paddingTop: 10, paddingBottom: 10 + qrMetrics.footerExtra }}>
        <a href={`/${slug}/games/${encodeURIComponent(lb.gameName)}`} className="text-xs text-accent hover:text-accent/80 transition-colors">
          Full Leaderboard &rarr;
        </a>
        <span className="text-[11px] text-faint">
          {lb.rankings.length} player{lb.rankings.length !== 1 ? 's' : ''}
        </span>
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
