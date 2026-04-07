import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, formatCountdown, GameQRCode } from '../ScoreboardComponents';
import GameInfoPopup from './GameInfoPopup';

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
  qrPosition?: string;
  cardBgFill?: boolean;
  titleFontSize?: number;
  onSubmitScore?: (lb: GameLeaderboard) => void;
}

function formatScore(score: number): string {
  if (score >= 1_000_000_000_000) return `${(score / 1_000_000_000_000).toFixed(1)}T`;
  return score.toLocaleString();
}

export default function MinimalCard({
  lb,
  slug,
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
}: MinimalCardProps) {
  const displayName = lb.displayName || lb.gameName;

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

  return (
    <div style={{ position: 'relative', maxWidth: 380 }}>
      {/* QR code — top-right, above the card */}
      {showQr && qrPosition !== 'bottom-right' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
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
              backgroundSize: 'cover', backgroundPosition: 'center',
            }}
          />
          <div className="absolute inset-0 z-0 bg-black/55" />
        </>
      )}
      {/* Title area */}
      <div className="px-5 pt-4 pb-3 relative z-[1]">
        {lb.gameStatus === 'COMPLETED' && (
          <span title="Completed" className="absolute right-4 top-4">
            <Lock size={14} className="text-neon-amber" />
          </span>
        )}
        <h3 className="font-display font-bold leading-tight truncate text-primary flex items-center gap-1 pr-5" style={{ fontSize: titleFontSize ? `${titleFontSize}px` : '1rem' }}>
          {displayName}
          <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={13} />
        </h3>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[11px] uppercase tracking-wider text-muted">
            {lb.tournamentName}
          </span>
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

              return (
                <div
                  key={`${entry.rank}-${entry.iscored_username}`}
                  className={`flex items-center gap-2.5 px-3 py-1.5 rounded ${
                    isViewerRow ? 'bg-neon-cyan/10' : ''
                  }`}
                >
                  <span className={`w-5 text-right text-[11px] font-semibold tabular-nums ${rankColor}`}>
                    {entry.rank}
                  </span>
                  <PlayerAvatar
                    username={entry.iscored_username}
                    discordUserId={entry.discord_user_id}
                    avatarHash={entry.avatar_hash}
                    size={22}
                  />
                  <span className="flex-1 text-sm truncate text-secondary">
                    {entry.iscored_username}
                  </span>
                  <span
                    className={`text-sm font-bold tabular-nums whitespace-nowrap ${isViewerRow ? 'text-neon-cyan' : 'text-primary'}`}
                    title={entry.score >= 1_000_000_000_000 ? entry.score.toLocaleString() : undefined}
                  >
                    {formatScore(entry.score)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border/30 px-5 py-2.5 flex justify-between items-center relative z-[1]">
        <a href={`/${slug}`} className="text-xs text-accent hover:text-accent/80 transition-colors">
          Full Leaderboard &rarr;
        </a>
        <span className="text-[11px] text-faint">
          {lb.rankings.length} player{lb.rankings.length !== 1 ? 's' : ''}
        </span>
      </div>

    </div>
      {/* QR code — bottom-right, below the card */}
      {showQr && qrPosition === 'bottom-right' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
        </div>
      )}
    </div>
  );
}
