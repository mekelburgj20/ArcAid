import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Flame, Users, Trophy, Target, Medal, UserPlus, UserCheck, GitCompare } from 'lucide-react';
import { PlayerAvatar, playerName } from '../components/ScoreboardComponents';
import { Dialog } from '../components/parts/Dialog';
import Button, { ButtonLink } from '../components/parts/Button';
import { SkeletonTiles } from '../components/parts/Skeleton';
import { useViewerAuth } from './ViewerAuthContext';
import { roomFetch } from '../lib/roomFetch';

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
 *
 * G23c (v2.271.0): the modal is the Arcaid dialog (`components/parts/Dialog`),
 * a bottom sheet on a phone. The player's name is the title (and the dialog's
 * name); Follow and Compare sit at the end of the body, the two page links are
 * the actions. Escape, a press outside, the × and the sheet's drag close it.
 */
export interface PlayerEntryLike {
  iscored_username: string;
  display_name?: string | null;
  discord_user_id?: string | null;
  avatar_hash?: string | null;
  /** v2.74.0 (S24.1): full avatar URL (Google-linked users). */
  avatar_url?: string | null;
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
  /** May be absent on old cached responses. */
  achievements?: {
    tournamentWins: number;
    milestones: number;
    roomRecords: number;
    recent: Array<{
      type: 'tournament_win' | 'milestone' | 'room_record';
      game_name: string | null;
      earned_at: string;
      metadata: any;
    }>;
  };
  /** May be absent on old cached responses. */
  personalBests?: Array<{ game_name: string; best_score: number; room_rank: number; total_players: number; achieved_at: string }>;
  /** WP2 — S14 social loops. May be absent on stale caches. */
  participationStreak?: { currentWeeks: number; bestWeeks: number };
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
  const { discordUser, playerToken } = useViewerAuth();
  const [friendIds, setFriendIds] = useState<Set<string>>(new Set());
  const [followPending, setFollowPending] = useState(false);

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
        const r = await roomFetch(`/api/rooms/${room.id}/stats/enhanced/player/${encodeURIComponent(entry.iscored_username)}`);
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

  // Follow list — fetched once per viewer session (dep on the token string,
  // never a headers object; see v2.18.1 lesson).
  useEffect(() => {
    if (!discordUser?.discordId || !playerToken) { setFriendIds(new Set()); return; }
    let cancelled = false;
    fetch('/api/me/friends', { headers: { Authorization: `Bearer ${playerToken}` } })
      .then(r => r.ok ? r.json() : [])
      .then((list: Array<{ friend_user_id: string }>) => {
        if (!cancelled) setFriendIds(new Set(list.map(f => f.friend_user_id)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [discordUser?.discordId, playerToken]);

  const toggleFollow = async () => {
    if (!playerToken || !stats?.discordUserId || followPending) return;
    const targetId = stats.discordUserId;
    const wasFollowing = friendIds.has(targetId);
    setFollowPending(true);
    setFriendIds(prev => {
      const next = new Set(prev);
      if (wasFollowing) next.delete(targetId); else next.add(targetId);
      return next;
    });
    try {
      const res = wasFollowing
        ? await fetch(`/api/me/friends/${targetId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${playerToken}` },
          })
        : await fetch('/api/me/friends', {
            method: 'POST',
            headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendUserId: targetId }),
          });
      if (!res.ok) throw new Error('follow-toggle-failed');
    } catch {
      // Revert the optimistic toggle.
      setFriendIds(prev => {
        const next = new Set(prev);
        if (wasFollowing) next.add(targetId); else next.delete(targetId);
        return next;
      });
    } finally {
      setFollowPending(false);
    }
  };

  const display = playerName(entry);
  // Thread ?from + ?tab into the full-page link so PlayerDetail's back link
  // returns to the originating leaderboard view.
  const fullPlayerHref = `/${slug}/players/${encodeURIComponent(entry.iscored_username)}?from=${encodeURIComponent(slug)}${fromTab ? `&tab=${fromTab}` : ''}`;
  const allPlayersHref = `/${slug}/players${fromTab === 'all-games' ? '?tab=all-games' : ''}`;

  // WP2 — S14 social loops: Follow + Compare.
  const canFollow = !!discordUser?.discordId && !!stats?.discordUserId && discordUser.discordId !== stats.discordUserId;
  // (a) Unlinked-player affordance — mirrors PlayerDetail.tsx: a logged-in
  // viewer looking at a player who has no Discord identity previously saw no
  // Follow button at all. Show a disabled one with an explanatory tooltip.
  const showDisabledFollow = !!discordUser?.discordId && !!stats && !stats.discordUserId;
  const isFollowing = !!stats?.discordUserId && friendIds.has(stats.discordUserId);
  const compareIdentifier = entry.iscored_username;
  // Pre-fill side B with the viewer's Discord SNOWFLAKE — the compare
  // resolver accepts a snowflake or an iscored_username, NOT the raw
  // Discord username (check-agent catch).
  const viewerCompareIdentifier =
    discordUser?.discordId && stats?.discordUserId && discordUser.discordId !== stats.discordUserId
      ? discordUser.discordId
      : '';
  const compareHref = `/${slug}/compare?a=${encodeURIComponent(compareIdentifier)}${
    viewerCompareIdentifier ? `&b=${encodeURIComponent(viewerCompareIdentifier)}` : ''
  }`;

  return (
    <Dialog
      open
      onOpenChange={next => { if (!next) onClose(); }}
      tone="cyan"
      size="md"
      sheet
      label="Player"
      title={display}
      footer={(
        <>
          <ButtonLink to={allPlayersHref} variant="secondary" onClick={onClose}>
            <Users size={14} aria-hidden="true" />
            All Players
          </ButtonLink>
          <ButtonLink to={fullPlayerHref} variant="secondary" onClick={onClose}>View full player page</ButtonLink>
        </>
      )}
    >
      {/* The avatar row: the name wraps, never cut short. */}
      <div className="flex items-center gap-3 mb-4">
        <PlayerAvatar
          username={display}
          discordUserId={entry.discord_user_id || null}
          avatarHash={entry.avatar_hash || null}
          avatarUrl={entry.avatar_url || null}
          size={42}
        />
        <div className="flex-1 min-w-0">
          <p className="font-display text-lg font-bold text-primary [overflow-wrap:anywhere]">{display}</p>
          {entry.iscored_username && display !== entry.iscored_username && (
            <p className="text-faint text-xs [overflow-wrap:anywhere]">iScored: {entry.iscored_username}</p>
          )}
        </div>
      </div>

      {loading ? (
        <SkeletonTiles count={3} label="Loading player" />
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
              <p className="text-faint text-xs uppercase tracking-wider mb-0.5">Streak</p>
              <div className="flex items-center justify-center gap-1">
                {stats.champion_streak > 0 && <Flame size={14} className="text-neon-amber" />}
                <p className={`font-display font-bold text-base ${stats.champion_streak > 0 ? 'text-neon-amber' : 'text-faint'}`}>
                  {stats.champion_streak}
                </p>
              </div>
            </div>
          </div>

          {stats.participationStreak && (
            <p className="text-xs text-faint text-center -mt-2 mb-3">
              Weekly streak <span className="text-neon-blue font-bold">{stats.participationStreak.currentWeeks}</span>
              <span className="text-faint"> · best {stats.participationStreak.bestWeeks}</span>
            </p>
          )}

          {stats.achievements && (
            stats.achievements.tournamentWins > 0 ||
            stats.achievements.milestones > 0 ||
            stats.achievements.roomRecords > 0
          ) && (
            <div className="flex items-center justify-center gap-4 mb-3 py-2 border-y border-border/30">
              <span className="inline-flex items-center gap-1 text-sm font-display font-bold text-neon-amber">
                <Trophy size={14} />
                {stats.achievements.tournamentWins}
              </span>
              <span className="inline-flex items-center gap-1 text-sm font-display font-bold text-neon-magenta">
                <Target size={14} />
                {stats.achievements.milestones}
              </span>
              <span className="inline-flex items-center gap-1 text-sm font-display font-bold text-neon-green">
                <Medal size={14} />
                {stats.achievements.roomRecords}
              </span>
            </div>
          )}

          {stats.bestGame && (
            <div className="mb-3">
              <p className="font-display text-xs text-muted uppercase tracking-wider mb-1">Best Game</p>
              <p className="text-sm text-primary font-medium">{stats.bestGame}</p>
            </div>
          )}

          {stats.recentScores.length > 0 && (
            <div>
              <p className="font-display text-xs text-muted uppercase tracking-wider mb-1">Recent Scores</p>
              <div className="bg-raised/40 border border-border/30 rounded overflow-hidden">
                {stats.recentScores.slice(0, 5).map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-3 py-1.5 border-b border-border/20 last:border-0"
                  >
                    <span className="text-sm text-muted flex-1 min-w-0 mr-2">{s.game_name}</span>
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

      {/* WP2 — S14 social loops: Follow + Compare */}
      <div className="flex items-center gap-2 mt-4">
        {canFollow && (
          <Button
            variant={isFollowing ? 'secondary' : 'primary'}
            onClick={toggleFollow}
            disabled={followPending}
            className="flex-1"
          >
            {isFollowing ? <UserCheck size={14} aria-hidden="true" /> : <UserPlus size={14} aria-hidden="true" />}
            {isFollowing ? 'Following' : 'Follow'}
          </Button>
        )}
        {!canFollow && showDisabledFollow && (
          <Button
            variant="secondary"
            disabled
            title="This player hasn't linked Discord yet"
            aria-label="Follow — unavailable, this player hasn't linked Discord yet"
            className="flex-1"
          >
            <UserPlus size={14} aria-hidden="true" />
            Follow
          </Button>
        )}
        <ButtonLink to={compareHref} variant="secondary" onClick={onClose} className="flex-1">
          <GitCompare size={14} aria-hidden="true" />
          Compare
        </ButtonLink>
      </div>
    </Dialog>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-raised border border-border/50 rounded p-2 text-center">
      <p className="text-faint text-xs uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`font-display font-bold text-base ${color}`}>{value}</p>
    </div>
  );
}
