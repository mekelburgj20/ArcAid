import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, ExternalLink } from 'lucide-react';
import type { GameLeaderboard } from './ScoreboardComponents';
import { PlayerAvatar, playerName } from './ScoreboardComponents';
import { getPlatformDisplay } from '../lib/platforms';

/**
 * v2.13.12 — lightweight popup preview of a game's top scores + metadata,
 * triggered by clicking a game card title on the public scoreboard. Replaces
 * direct navigation to GameDetail so users can peek without losing tab
 * context. Falls through to the full GameDetail page via "View full info →"
 * or to the global catalogue page via "Global Leaderboard →".
 *
 * Middle-click / ctrl-click / cmd-click on the card title still navigates
 * directly (the click handler that opens this modal preventDefaults only
 * plain left-click — see Scoreboard.tsx).
 */
interface GlobalGameMeta {
  manufacturer: string | null;
  year: number | null;
  platforms: string[];
}

interface Props {
  lb: GameLeaderboard;
  slug: string;
  /** Tab the user came from. Threaded into "View full info" and "Global Leaderboard"
   *  links so GameDetail's back link returns to the correct tab. */
  fromTab?: string | null;
  onClose: () => void;
}

export default function GameQuickView({ lb, slug, fromTab, onClose }: Props) {
  const [meta, setMeta] = useState<GlobalGameMeta | null>(null);
  const backdropMouseDown = useRef(false);

  // Pull catalogue metadata for the subtitle. Optional — if there's no
  // globalGameId or the fetch fails, the modal just shows the tournament name.
  useEffect(() => {
    if (!lb.globalGameId) return;
    let cancelled = false;
    fetch(`/api/global/games/${lb.globalGameId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(g => {
        if (!cancelled && g) {
          setMeta({
            manufacturer: g.manufacturer || null,
            year: g.year || null,
            platforms: Array.isArray(g.platforms) ? g.platforms : [],
          });
        }
      })
      .catch(() => { /* swallow */ });
    return () => { cancelled = true; };
  }, [lb.globalGameId]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Compose links so GameDetail's back link returns to the originating tab.
  const tabSuffix = fromTab && fromTab !== 'tournaments'
    ? `?tab=${fromTab === 'all-games' ? 'room' : fromTab}`
    : '';
  const fullInfoHref = `/${slug}/games/${encodeURIComponent(lb.gameName)}${tabSuffix}`;
  const globalHref = lb.globalGameId
    ? `/games/${lb.globalGameId}?from=${encodeURIComponent(slug)}${fromTab ? `&tab=${fromTab}` : ''}`
    : null;

  const topScores = lb.rankings.slice(0, 10);

  const subtitleParts: string[] = [];
  if (meta?.manufacturer) subtitleParts.push(meta.manufacturer);
  if (meta?.year) subtitleParts.push(String(meta.year));
  if (meta?.platforms?.length) {
    subtitleParts.push(meta.platforms.map(getPlatformDisplay).join(', '));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
      // mousedown-on-backdrop + mouseup-on-backdrop required to dismiss; prevents
      // accidental close when text-selection drags off the inner card.
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}
    >
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with optional image background */}
        <div
          className="relative px-5 py-5 border-b border-border"
          style={lb.imageUrl ? {
            backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0.45), rgba(0,0,0,0.85)), url(${lb.imageUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'top center',
          } : undefined}
        >
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full p-1.5 backdrop-blur-sm border-0 cursor-pointer transition-colors"
          >
            <X size={16} />
          </button>
          <h2 className={`font-display text-lg font-bold pr-8 leading-tight ${lb.imageUrl ? 'text-white' : 'text-primary'}`}>
            {lb.gameName}
          </h2>
          {subtitleParts.length > 0 && (
            <p className={`text-xs mt-1.5 ${lb.imageUrl ? 'text-white/70' : 'text-muted'}`}>
              {subtitleParts.join(' · ')}
            </p>
          )}
          {lb.tournamentName && (
            <p className={`text-[10px] uppercase tracking-wider mt-1.5 ${lb.imageUrl ? 'text-white/50' : 'text-faint'}`}>
              {lb.tournamentName}
            </p>
          )}
        </div>

        {/* Top scores */}
        <div className="px-5 py-3">
          {topScores.length === 0 ? (
            <p className="text-sm text-faint text-center py-6">No scores yet</p>
          ) : (
            topScores.map((entry) => (
              <div
                key={`${entry.iscored_username}-${entry.rank}`}
                className="flex items-center gap-3 py-2 border-b border-border/30 last:border-0"
              >
                <span
                  className={`font-display font-bold text-sm w-5 text-right tabular-nums flex-shrink-0 ${
                    entry.rank === 1 ? 'text-neon-amber'
                      : entry.rank === 2 ? 'text-neon-cyan'
                      : entry.rank === 3 ? 'text-neon-green'
                      : 'text-faint'
                  }`}
                >
                  {entry.rank}
                </span>
                <PlayerAvatar
                  username={playerName(entry)}
                  discordUserId={entry.discord_user_id}
                  avatarHash={entry.avatar_hash}
                  size={22}
                />
                <span className="flex-1 text-sm text-secondary truncate">
                  {playerName(entry)}
                </span>
                <span
                  className={`text-sm font-bold tabular-nums flex-shrink-0 ${
                    entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                  }`}
                >
                  {entry.score.toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Footer links */}
        <div className="px-5 py-3 border-t border-border flex flex-col gap-2">
          <Link
            to={fullInfoHref}
            onClick={onClose}
            className="inline-flex items-center justify-between gap-1 px-3 py-2 rounded border border-border text-sm text-muted hover:text-primary hover:border-neon-cyan/40 no-underline transition-colors"
          >
            <span>View full info</span>
            <ExternalLink size={14} />
          </Link>
          {globalHref && (
            <Link
              to={globalHref}
              onClick={onClose}
              className="inline-flex items-center justify-between gap-1 px-3 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 no-underline transition-colors"
            >
              <span>Global Leaderboard</span>
              <ExternalLink size={14} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
