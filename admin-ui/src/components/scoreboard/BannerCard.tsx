import { useEffect, useState } from 'react';
import { Lock, Plus, Minus } from 'lucide-react';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, formatCountdown, GameQRCode, getTitleStyleClass } from '../ScoreboardComponents';
import GameInfoPopup from './GameInfoPopup';
import { useScoreExpand } from './useScoreExpand';

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
  qrPosition?: string;
  cardBgFill?: boolean;
  titleFontSize?: number;
  gameTitleStyle?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
}

function formatScore(score: number): string {
  if (score >= 1_000_000_000_000) return `${(score / 1_000_000_000_000).toFixed(1)}T`;
  return score.toLocaleString();
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
  qrSize = 24,
  qrPosition = 'top-right',
  cardBgFill = false,
  titleFontSize,
  gameTitleStyle = 'default',
  onSubmitScore,
}: BannerCardProps) {
  const { bgImage, styleHeaderUrl } = resolveImages(lb);
  const displayName = lb.displayName || lb.gameName;
  // When cardBgFill is on, the separate image area is hidden so identifier isn't visible — always show title
  const hasIdentifierImage = !!styleHeaderUrl && !cardBgFill;
  const borderColor = TOURNAMENT_BORDER_COLORS[lb.tournamentType?.toUpperCase()] ?? 'border-border';

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
  const qrBottomOverhang = showQr && qrPosition === 'bottom-center' ? qrSize * 0.8 : 0;

  return (
    <div style={{ position: 'relative', width: 280, display: 'flex', flexDirection: 'column', height: '100%', marginBottom: qrBottomOverhang || undefined }}>
      {/* QR code — top-right, above the card */}
      {showQr && qrPosition === 'top-right' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
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
          style={{
            backgroundImage: `url(${bgImage})`,
            backgroundSize: 'cover',
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'center',
          }}
        />
      )}
      {cardBgFill && bgImage && (
        <div className="absolute inset-0 z-[0] bg-black/50" />
      )}

      {/* Title area */}
      <div
        className={`px-4 py-3 text-center border-b border-border/30 relative ${onSubmitScore ? 'cursor-pointer hover:bg-raised/50 transition-colors' : ''}`}
        onClick={onSubmitScore ? () => onSubmitScore(lb) : undefined}
      >
        {!hasIdentifierImage && (
          <h3 className={`font-display font-bold leading-tight px-5 flex items-center justify-center gap-1 text-center ${getTitleStyleClass(gameTitleStyle)}`} style={{ fontSize: titleFontSize ? `${titleFontSize}px` : '0.875rem', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {displayName}
            <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={13} />
          </h3>
        )}
        {hasIdentifierImage && (lb.externalUrl || lb.notes) && (
          <div className="absolute left-3 top-3 z-[2]">
            <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={14} />
          </div>
        )}
        {(lb.tournamentName || lb.gameStatus === 'COMPLETED') && (
          <p className={`text-[11px] uppercase tracking-wider ${hasIdentifierImage ? '' : 'mt-0.5'} text-muted flex items-center justify-center gap-1`}>
            {lb.tournamentName}
            {lb.gameStatus === 'COMPLETED' && (
              <Lock size={11} className="text-neon-amber flex-shrink-0" />
            )}
          </p>
        )}
        {showTimer && countdown && (
          <p className="text-[10px] text-faint mt-0.5">{countdown}</p>
        )}
      </div>

      {/* Background image area (hidden when bg fill is on since image covers whole card) */}
      {bgImage && !cardBgFill && (
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
          {styleHeaderUrl && (
            <img src={styleHeaderUrl} alt="" className="absolute inset-0 w-full h-full object-contain z-[1]" />
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

              return (
                <div key={`${entry.rank}-${entry.iscored_username}`}>
                  <div
                    className={`flex items-center gap-1.5 ${canExpand ? 'cursor-pointer' : ''}`}
                    onClick={canExpand ? () => togglePlayer(entry.iscored_username) : undefined}
                  >
                    <span className={`w-6 text-right text-xs font-bold tabular-nums flex-shrink-0 ${rankColor}`}>
                      {entry.rank}
                    </span>
                    <div className={`flex-1 rounded-full px-3 py-1 relative ${
                      isViewerRow ? 'bg-neon-cyan/25' : 'bg-white/18'
                    }`}>
                      <div className="absolute left-2 top-1/2 -translate-y-1/2">
                        <PlayerAvatar
                          username={entry.iscored_username}
                          discordUserId={entry.discord_user_id}
                          avatarHash={entry.avatar_hash}
                          size={16}
                        />
                      </div>
                      <div className="text-center">
                        <span className="text-[11px] truncate text-secondary block">
                          {entry.iscored_username}
                        </span>
                        <span
                          className={`text-xs font-bold tabular-nums block ${scoreColor}`}
                          title={entry.score >= 1_000_000_000_000 ? entry.score.toLocaleString() : undefined}
                        >
                          {formatScore(entry.score)}
                        </span>
                      </div>
                    </div>
                    {canExpand && (
                      isExpanded
                        ? <Minus size={10} className="text-neon-cyan flex-shrink-0" />
                        : <Plus size={10} className="text-faint flex-shrink-0" />
                    )}
                  </div>
                  {isExpanded && (
                    <div className="ml-8 mr-2 mt-0.5 mb-1 bg-deep/50 rounded px-2 py-1">
                      {historyLoading ? (
                        <p className="text-faint text-[10px] py-0.5">Loading...</p>
                      ) : playerHistory.length > 0 ? (
                        <div className="space-y-0.5">
                          {playerHistory.map(h => (
                            <div key={h.id} className="flex items-center justify-between text-[10px]">
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
      <div className="border-t border-border/30 px-3 flex justify-between items-start text-[10px] text-faint" style={{ paddingTop: 8, paddingBottom: showQr && qrPosition === 'bottom-center' ? Math.round(qrSize * 0.25) + 8 : 8 }}>
        <a href={`/${slug}/games/${encodeURIComponent(lb.gameName)}`} className="text-neon-cyan/60 hover:text-neon-cyan transition-colors">
          Full Leaderboard &rarr;
        </a>
        <span>{lb.rankings.length} player{lb.rankings.length !== 1 ? 's' : ''}</span>
      </div>

    </div>
      {/* QR code — bottom-right, below the card */}
      {showQr && qrPosition === 'bottom-right' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
        </div>
      )}
      {/* QR code — bottom-center with 15% overhang */}
      {showQr && qrPosition === 'bottom-center' && (
        <div style={{ position: 'absolute', bottom: -(qrSize * 0.80), left: '50%', transform: 'translateX(-50%)', zIndex: 15 }}>
          <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
        </div>
      )}
    </div>
  );
}
