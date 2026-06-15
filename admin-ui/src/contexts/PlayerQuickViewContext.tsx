import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { X, ExternalLink, Flame, Users } from 'lucide-react';
import { PlayerAvatar, playerName } from '../components/ScoreboardComponents';

/**
 * v2.13.16 — public-side player quick-view modal context.
 *
 * Wrap children in `<PlayerQuickViewProvider>` (typically inside PublicLayout)
 * so any descendant can call `usePlayerQuickView().open({ slug, entry, fromTab })`
 * to pop a lightweight player preview. Same UX pattern as GameQuickView:
 * left-click on a player name shows the modal; modifier-click on the
 * underlying PlayerNameLink falls through to the full /:slug/players/:id page.
 *
 * Modal contents mirror the full PlayerDetail page at a glance — header with
 * avatar + name, stats grid (Games/Wins/Win%/Avg Finish/Top 5%/Streak),
 * Best Game, recent scores list — plus footer links to the full player
 * page (carrying ?from + ?tab for the back link) and the room's All Players
 * page.
 */
export interface PlayerEntryLike {
  iscored_username: string;
  display_name?: string | null;
  discord_user_id?: string | null;
  avatar_hash?: string | null;
}

interface OpenArgs {
  slug: string;
  entry: PlayerEntryLike;
  /** The tab the user came from (e.g., 'tournaments' / 'all-games'), so the
   *  modal's "View full player page" link threads it through to PlayerDetail's
   *  back-link. */
  fromTab?: string | null;
}

interface ContextValue {
  open: (args: OpenArgs) => void;
}

const Ctx = createContext<ContextValue | null>(null);

/** Hook for triggering the player quick-view modal from any descendant of
 *  PlayerQuickViewProvider. Returns `null` when no provider is mounted — the
 *  quick-view is an optional public-page enhancement, and player-name links are
 *  reused on admin pages (Settings preview, admin Leaderboard) that deliberately
 *  don't mount the provider. Consumers must treat a null result as "no
 *  quick-view" and fall back to plain navigation rather than crashing the page. */
export function usePlayerQuickView(): ContextValue | null {
  return useContext(Ctx);
}

interface Stats {
  discordUserId: string;
  iscoredUsername: string | null;
  totalGamesPlayed: number;
  totalWins: number;
  winPercentage: number;
  avg_finish_position: number;
  top5_rate: number;
  champion_streak: number;
  bestGame: string | null;
  recentScores: Array<{ game_name: string; score: number; date: string }>;
}

export function PlayerQuickViewProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OpenArgs | null>(null);

  const open = useCallback((args: OpenArgs) => setState(args), []);
  const close = useCallback(() => setState(null), []);

  // useMemo so consumers using `usePlayerQuickView()` don't see a new object
  // identity on every provider re-render.
  const value = useMemo(() => ({ open }), [open]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {state && <PlayerQuickViewModal {...state} onClose={close} />}
    </Ctx.Provider>
  );
}

function PlayerQuickViewModal({ slug, entry, fromTab, onClose }: OpenArgs & { onClose: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const backdropMouseDown = useRef(false);

  // Fetch player stats. Same pattern as PlayerDetail.tsx — find the room by
  // slug first, then hit the enhanced player-stats endpoint.
  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setLoading(true);
    setNotFound(false);
    (async () => {
      try {
        const roomsRes = await fetch('/api/rooms');
        const rooms: Array<{ id: string; slug: string }> = await roomsRes.json();
        const room = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (!room) {
          if (!cancelled) { setNotFound(true); setLoading(false); }
          return;
        }
        const r = await fetch(`/api/rooms/${room.id}/stats/enhanced/player/${encodeURIComponent(entry.iscored_username)}`);
        if (!r.ok) {
          if (!cancelled) { setNotFound(true); setLoading(false); }
          return;
        }
        const data: Stats = await r.json();
        if (!cancelled) { setStats(data); setLoading(false); }
      } catch {
        if (!cancelled) { setNotFound(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [slug, entry.iscored_username]);

  // Esc to close + lock background scroll while modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const display = playerName(entry);
  // Thread ?from + ?tab into the full-page link so PlayerDetail's back link
  // returns to the originating leaderboard view.
  const fullPlayerHref = `/${slug}/players/${encodeURIComponent(entry.iscored_username)}?from=${encodeURIComponent(slug)}${fromTab ? `&tab=${fromTab}` : ''}`;
  const allPlayersHref = `/${slug}/players${fromTab === 'all-games' ? '?tab=all-games' : ''}`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-deep/80 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto"
      onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={e => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}
    >
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md my-3 sm:my-8 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <PlayerAvatar
            username={display}
            discordUserId={entry.discord_user_id || null}
            avatarHash={entry.avatar_hash || null}
            size={42}
          />
          <div className="flex-1 min-w-0">
            <h2 className="font-display text-lg font-bold text-primary truncate">{display}</h2>
            {entry.iscored_username && display !== entry.iscored_username && (
              <p className="text-faint text-xs truncate">iScored: {entry.iscored_username}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer p-1 flex-shrink-0"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
            </div>
          ) : notFound ? (
            <p className="text-muted text-sm text-center py-6">Player not found in this room.</p>
          ) : stats ? (
            <>
              <div className="grid grid-cols-3 gap-2 mb-4">
                <Stat label="Games" value={String(stats.totalGamesPlayed)} color="text-neon-cyan" />
                <Stat label="Wins" value={String(stats.totalWins)} color="text-neon-green" />
                <Stat label="Win %" value={`${stats.winPercentage}%`} color="text-neon-amber" />
                <Stat label="Avg Finish" value={stats.avg_finish_position.toFixed(1)} color="text-muted" />
                <Stat label="Top 5 %" value={`${Math.round(stats.top5_rate * 100)}%`} color="text-neon-magenta" />
                <div className="bg-raised border border-border/50 rounded p-2 text-center">
                  <p className="text-faint text-[10px] uppercase tracking-wider mb-0.5">Streak</p>
                  <div className="flex items-center justify-center gap-1">
                    {stats.champion_streak > 0 && <Flame size={14} className="text-neon-amber" />}
                    <p className={`font-display font-bold text-base ${stats.champion_streak > 0 ? 'text-neon-amber' : 'text-faint'}`}>
                      {stats.champion_streak}
                    </p>
                  </div>
                </div>
              </div>

              {stats.bestGame && (
                <div className="mb-3">
                  <p className="font-display text-[10px] text-muted uppercase tracking-wider mb-1">Best Game</p>
                  <p className="text-sm text-primary font-medium truncate">{stats.bestGame}</p>
                </div>
              )}

              {stats.recentScores.length > 0 && (
                <div>
                  <p className="font-display text-[10px] text-muted uppercase tracking-wider mb-1">Recent Scores</p>
                  <div className="bg-raised/40 border border-border/30 rounded overflow-hidden">
                    {stats.recentScores.slice(0, 5).map((s, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between px-3 py-1.5 border-b border-border/20 last:border-0"
                      >
                        <span className="text-sm text-secondary truncate flex-1 mr-2">{s.game_name}</span>
                        <span className="text-sm font-bold tabular-nums text-neon-amber flex-shrink-0">
                          {s.score.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex flex-col gap-2">
          <Link
            to={fullPlayerHref}
            onClick={onClose}
            className="inline-flex items-center justify-between gap-1 px-3 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 no-underline transition-colors"
          >
            <span>View full player page</span>
            <ExternalLink size={14} />
          </Link>
          <Link
            to={allPlayersHref}
            onClick={onClose}
            className="inline-flex items-center justify-between gap-1 px-3 py-2 rounded border border-border text-sm text-muted hover:text-primary hover:border-neon-cyan/40 no-underline transition-colors"
          >
            <span className="inline-flex items-center gap-1.5">
              <Users size={14} />
              All Players
            </span>
            <ExternalLink size={14} />
          </Link>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-raised border border-border/50 rounded p-2 text-center">
      <p className="text-faint text-[10px] uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`font-display font-bold text-base ${color}`}>{value}</p>
    </div>
  );
}
