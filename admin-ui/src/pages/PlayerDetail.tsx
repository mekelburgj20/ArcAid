import { Fragment, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Flame, Trophy, Target, Medal, UserPlus, UserCheck, GitCompare, Flag, Search } from 'lucide-react';
import ShareButton from '../components/ShareButton';
import ReportContentModal from '../components/ReportContentModal';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useRoom } from '../contexts/RoomContext';
import { formatScore, scoreTitle } from '../lib/format';

interface Achievements {
  tournamentWins: number;
  milestones: number;
  roomRecords: number;
  recent: Array<{
    type: 'tournament_win' | 'milestone' | 'room_record';
    game_name: string | null;
    earned_at: string;
    metadata: any;
  }>;
}

interface PersonalBest {
  game_name: string;
  best_score: number;
  room_rank: number;
  total_players: number;
  achieved_at: string;
}

interface PlayerStats {
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
  achievements?: Achievements;
  /** May be absent on old cached responses. */
  personalBests?: PersonalBest[];
  /** WP2 — S14 social loops. May be absent on stale caches. */
  participationStreak?: { currentWeeks: number; bestWeeks: number };
}

const ACHIEVEMENT_LABELS: Record<Achievements['recent'][number]['type'], string> = {
  tournament_win: 'Tournament Win',
  milestone: 'Milestone',
  room_record: 'Room Record',
};

function AchievementIcon({ type, size = 14 }: { type: Achievements['recent'][number]['type']; size?: number }) {
  if (type === 'tournament_win') return <Trophy size={size} className="text-neon-amber" />;
  if (type === 'milestone') return <Target size={size} className="text-neon-magenta" />;
  return <Medal size={size} className="text-neon-green" />;
}

export default function PlayerDetail() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  // v2.13.16 — read ?from + ?tab so the back link can return to the
  // originating leaderboard view instead of always defaulting to All Players.
  const [searchParams] = useSearchParams();
  const fromSlug = searchParams.get('from');
  const fromTab = searchParams.get('tab');
  const backToLeaderboardHref = fromSlug
    ? `/${fromSlug}${fromTab === 'all-games' ? '?tab=all-games' : ''}`
    : null;
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const { discordUser, playerToken } = useViewerAuth();
  const [friendIds, setFriendIds] = useState<Set<string>>(new Set());
  const [followPending, setFollowPending] = useState(false);
  const { roomId } = useRoom();
  // S22 Phase 1 (v2.43.0) — discreet, signed-in-only "report this name" affordance.
  const [showReportName, setShowReportName] = useState(false);

  useEffect(() => {
    if (!id || !roomId) return;
    fetch(`/api/rooms/${roomId}/stats/enhanced/player/${encodeURIComponent(id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setStats(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [roomId, id]);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        Player not found.
      </div>
    );
  }

  const displayName = stats.iscoredUsername || `Player ${stats.discordUserId.slice(-4)}`;
  const canFollow = !!discordUser?.discordId && !!stats.discordUserId && discordUser.discordId !== stats.discordUserId;
  const isFollowing = !!stats.discordUserId && friendIds.has(stats.discordUserId);
  const compareIdentifier = id || stats.iscoredUsername || stats.discordUserId;
  // Snowflake, not username — the compare resolver only accepts a Discord
  // snowflake or an iscored_username (check-agent catch).
  const viewerCompareIdentifier =
    discordUser?.discordId && discordUser.discordId !== stats.discordUserId ? discordUser.discordId : '';
  const compareHref = `/${slug}/compare?a=${encodeURIComponent(compareIdentifier)}${
    viewerCompareIdentifier ? `&b=${encodeURIComponent(viewerCompareIdentifier)}` : ''
  }`;

  return (
    <div>
      {/* Page Header */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2">
        {/* v2.13.16 — primary back link returns to the originating leaderboard
            when ?from is present (set by PlayerNameLink); secondary "All
            Players" link is always available. */}
        <div className="flex items-center gap-4 text-xs">
          {backToLeaderboardHref ? (
            <>
              <Link to={backToLeaderboardHref} className="text-faint hover:text-muted no-underline transition-colors">
                &larr; Back to Leaderboard
              </Link>
              <Link to={`/${slug}/players`} className="text-faint hover:text-muted no-underline transition-colors">
                All Players
              </Link>
            </>
          ) : (
            <Link to={`/${slug}/players`} className="text-faint hover:text-muted no-underline transition-colors">
              &larr; All Players
            </Link>
          )}
        </div>
        <h2 className="font-display text-xl font-bold mt-1">{displayName}</h2>
        {stats.iscoredUsername && (
          <p className="text-faint text-xs mt-0.5">iScored: {stats.iscoredUsername}</p>
        )}

        {/* WP2 — S14 social loops: Follow + Compare */}
        <div className="flex items-center gap-2 mt-3">
          {canFollow && (
            <button
              onClick={toggleFollow}
              disabled={followPending}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                isFollowing
                  ? 'border-neon-green/40 bg-neon-green/10 text-neon-green hover:bg-neon-green/20'
                  : 'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20'
              }`}
            >
              {isFollowing ? <UserCheck size={14} /> : <UserPlus size={14} />}
              {isFollowing ? 'Following' : 'Follow'}
            </button>
          )}
          <Link
            to={compareHref}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-xs font-medium text-muted hover:text-primary hover:border-neon-cyan/40 no-underline transition-colors"
          >
            <GitCompare size={14} />
            Compare
          </Link>
          {/* S16 — Web Share (clipboard fallback). Compare's muted treatment so
              Follow stays the row's single cyan primary action. */}
          <ShareButton
            title={`${displayName} · Arcaid`}
            text={`Check out ${displayName}'s scores and stats on Arcaid!`}
            path={`/${slug}/players/${encodeURIComponent(id || '')}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-xs font-medium text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors cursor-pointer"
          />
          {discordUser && (
            <button
              onClick={() => setShowReportName(true)}
              title="Report this name"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-xs font-medium text-muted hover:text-neon-magenta hover:border-neon-magenta/40 transition-colors cursor-pointer bg-transparent"
            >
              <Flag size={14} />
            </button>
          )}
        </div>
      </div>

      {showReportName && (
        <ReportContentModal
          title="Report this name"
          targetLabel={displayName}
          endpoint="/global/report-name"
          extraBody={{
            roomId: roomId || undefined,
            targetUserId: stats.discordUserId || undefined,
            targetName: id || displayName,
          }}
          onClose={() => setShowReportName(false)}
        />
      )}

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
          <StatCard label="Games Played" value={stats.totalGamesPlayed.toString()} color="text-neon-cyan" />
          <StatCard label="Wins" value={stats.totalWins.toString()} color="text-neon-green" />
          <StatCard label="Win %" value={`${stats.winPercentage}%`} color="text-neon-amber" />
          <StatCard label="Avg Finish" value={stats.avg_finish_position.toFixed(1)} color="text-muted" />
          <StatCard label="Top 5 %" value={`${Math.round(stats.top5_rate * 100)}%`} color="text-neon-magenta" />
          <div className="bg-surface border border-border rounded-lg p-4 text-center">
            <p className="text-faint text-xs uppercase tracking-wider mb-1">Streak</p>
            <div className="flex items-center justify-center gap-1">
              {stats.champion_streak > 0 && <Flame size={18} className="text-neon-amber" />}
              <p className={`font-display font-bold text-2xl ${stats.champion_streak > 0 ? 'text-neon-amber' : 'text-faint'}`}>
                {stats.champion_streak}
              </p>
            </div>
          </div>
          {stats.participationStreak && (
            <div className="bg-surface border border-border rounded-lg p-4 text-center">
              <p className="text-faint text-xs uppercase tracking-wider mb-1">Weekly Streak</p>
              <p className="font-display font-bold text-2xl text-neon-blue">
                {stats.participationStreak.currentWeeks}
              </p>
              <p className="text-faint text-[10px] mt-0.5">best {stats.participationStreak.bestWeeks}</p>
            </div>
          )}
        </div>

        {/* Trophies */}
        {stats.achievements && (
          stats.achievements.tournamentWins > 0 ||
          stats.achievements.milestones > 0 ||
          stats.achievements.roomRecords > 0
        ) && (
          <div className="mb-8">
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Trophies</h2>
            <div className="grid grid-cols-3 gap-4 mb-3">
              <div className="bg-surface border border-border rounded-lg p-4 text-center">
                <p className="text-faint text-xs uppercase tracking-wider mb-1">Tournament Wins</p>
                <div className="flex items-center justify-center gap-1">
                  <Trophy size={18} className="text-neon-amber" />
                  <p className="font-display font-bold text-2xl text-neon-amber">{stats.achievements.tournamentWins}</p>
                </div>
              </div>
              <div className="bg-surface border border-border rounded-lg p-4 text-center">
                <p className="text-faint text-xs uppercase tracking-wider mb-1">Milestones</p>
                <div className="flex items-center justify-center gap-1">
                  <Target size={18} className="text-neon-magenta" />
                  <p className="font-display font-bold text-2xl text-neon-magenta">{stats.achievements.milestones}</p>
                </div>
              </div>
              <div className="bg-surface border border-border rounded-lg p-4 text-center">
                <p className="text-faint text-xs uppercase tracking-wider mb-1">Room Records</p>
                <div className="flex items-center justify-center gap-1">
                  <Medal size={18} className="text-neon-green" />
                  <p className="font-display font-bold text-2xl text-neon-green">{stats.achievements.roomRecords}</p>
                </div>
              </div>
            </div>
            {stats.achievements.recent.length > 0 && (
              <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {stats.achievements.recent.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-5 py-2.5 border-b border-border/30 last:border-0"
                  >
                    <AchievementIcon type={a.type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-primary text-sm font-medium truncate">
                        {ACHIEVEMENT_LABELS[a.type]}
                        {a.game_name ? ` · ${a.game_name}` : ''}
                      </p>
                      <p className="text-faint text-xs">{new Date(a.earned_at).toLocaleDateString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Best Game */}
        {stats.bestGame && (
          <div className="mb-8">
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Best Game</h2>
            <Link
              to={`/${slug}/games/${encodeURIComponent(stats.bestGame)}`}
              className="inline-block bg-surface border border-border rounded-lg px-5 py-3 text-primary hover:text-neon-cyan no-underline transition-colors font-medium"
            >
              {stats.bestGame}
            </Link>
          </div>
        )}

        {/* Recent Scores */}
        {stats.recentScores.length > 0 && (
          <div>
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Recent Scores</h2>
            {/* Stacks on phones for the same reason Personal Bests does: a
                game name sharing its line with a 12-digit score truncates to
                nothing. Line 1 is the name across the full width, line 2 is
                the date left and the score right. From `sm` the three sit on
                one line — name yields, number never does. */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {stats.recentScores.map((s, i) => (
                <div
                  key={i}
                  className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 px-5 py-3 border-b border-border/30 last:border-0"
                >
                  <Link
                    to={`/${slug}/games/${encodeURIComponent(s.game_name)}`}
                    className="min-w-0 sm:flex-1 truncate text-primary hover:text-neon-cyan no-underline transition-colors font-medium"
                  >
                    {s.game_name}
                  </Link>
                  <div className="flex items-baseline gap-3 min-w-0 sm:flex-shrink-0">
                    <span className="min-w-0 truncate text-faint text-xs">
                      {new Date(s.date).toLocaleDateString()}
                    </span>
                    <span
                      className="ml-auto font-display font-bold text-neon-amber flex-shrink-0 whitespace-nowrap tabular-nums"
                      title={scoreTitle(s.score)}
                    >
                      {formatScore(s.score)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Personal Bests */}
        <PersonalBestsSection personalBests={stats.personalBests} slug={slug} />
      </main>
    </div>
  );
}

/**
 * Shared header/row grid template. `grid-cols-4` (four equal fractions) used to
 * let a 10+ digit Best bleed into the Room Rank column at 390px.
 *
 * The score, rank and date tracks are `auto` — i.e. `minmax(min-content,
 * max-content)`, so they are never squeezed below the number they hold. A `rem`
 * floor was tried first and is wrong: `minmax(5.5rem, auto)` still lets the
 * track shrink to 5.5rem when space is tight, which clipped a 12-digit score at
 * 390px. The game name is the one flexible track (`minmax(0,1fr)`) and it
 * truncates instead — a truncated title is readable, a truncated number is not.
 *
 * Four content-sized columns plus a 12-digit score do not fit on a 390px phone
 * at all: the name track collapsed to 0 and the titles vanished. A first pass
 * reflowed to two columns (Game | Best) with rank + date as a caption, but the
 * name still shared its line with the number and truncated to "Attack from
 * Mar…". So below `sm` each row now STACKS: line 1 is the game name across
 * both tracks, line 2 is the rank/date caption left and the score right. Same
 * shape History uses; the number keeps its own space either way.
 *
 * One grid still holds both lines — a separate mobile list would duplicate
 * every game link in the DOM, which the section's tests count. `col-span-2`
 * on the name cell is what makes line 1 full-width, and the two desktop-only
 * cells simply drop out of flow.
 *
 * Column gaps come from per-cell padding, not `gap-x`: the row divider lives on
 * each cell (a shared grid has no row element to hang it on), and a column gap
 * would chop that divider into disconnected segments. The divider sits on the
 * row's LAST line, so on phones the name cell carries no rule (`sm:border-b`
 * only) and the line-2 cells carry it instead.
 */
const PERSONAL_BESTS_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]';

/** Header-strip cell: a grid child, so the row chrome lives on the cell.
 *  Hidden on phones — the stacked layout has no columns to label. */
const PB_HEAD = 'hidden sm:block py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider truncate';

/** Rows shown by default before the "Show all N" toggle is used. */
const PERSONAL_BESTS_DEFAULT_VISIBLE = 20;
/** Below this many rows a search box is more clutter than help. */
const PERSONAL_BESTS_SEARCH_THRESHOLD = 5;

/**
 * Searchable Personal Bests (ROADMAP line 11). The list arrives already
 * ordered by `room_rank ASC` from `StatsService.getPersonalBests` — never
 * re-sort it here. Filtering is deliberately client-side (the endpoint takes
 * no search param); the BE limit was raised to 1000 so the list the FE filters
 * over is effectively complete.
 *
 * Collapse/expand applies to the UNFILTERED view only — while a query is
 * active every match is shown, because a hidden match is exactly the failure
 * mode the search exists to prevent.
 */
export function PersonalBestsSection({
  personalBests,
  slug,
}: {
  personalBests?: PersonalBest[];
  slug?: string;
}) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  const all = personalBests ?? [];
  const trimmed = query.trim();
  const filtering = trimmed.length > 0;

  const matches = useMemo(() => {
    if (!filtering) return all;
    const needle = trimmed.toLowerCase();
    return all.filter(pb => pb.game_name.toLowerCase().includes(needle));
  }, [all, filtering, trimmed]);

  if (all.length === 0) return null;

  const collapsed = !filtering && !showAll && matches.length > PERSONAL_BESTS_DEFAULT_VISIBLE;
  const visible = collapsed ? matches.slice(0, PERSONAL_BESTS_DEFAULT_VISIBLE) : matches;
  const showSearch = all.length > PERSONAL_BESTS_SEARCH_THRESHOLD;

  return (
    <div className="mt-8">
      <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Personal Bests</h2>

      {showSearch && (
        <div className="relative mb-3 max-w-sm">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search your games…"
            aria-label="Search your personal bests"
            className="w-full bg-surface border border-border rounded pl-8 pr-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none"
          />
        </div>
      )}

      {filtering && (
        <p className="text-faint text-xs mb-2">
          {matches.length} of {all.length} games
        </p>
      )}

      {/* Header and rows share ONE grid so the header labels sit over the
          columns they name. Two sibling grids (the previous shape) size their
          tracks independently, so the moment the score track grew for a long
          value the header drifted off it. */}
      <div className={`bg-surface border border-border rounded-lg overflow-hidden ${PERSONAL_BESTS_GRID} gap-y-0`}>
        <span className={`${PB_HEAD} pl-5 pr-3`}>Game</span>
        <span className={`${PB_HEAD} pr-5 sm:pr-4 text-right`}>Best</span>
        <span className={`${PB_HEAD} hidden sm:block pr-4 text-right`}>Room Rank</span>
        <span className={`${PB_HEAD} hidden sm:block pr-5 text-right`}>Date</span>
        {visible.length === 0 ? (
          <div className="col-span-2 sm:col-span-4 px-5 py-4 text-muted text-sm">No games match &ldquo;{trimmed}&rdquo;</div>
        ) : (
          visible.map((pb, i) => {
            const last = i === visible.length - 1;
            // Class strings are whole literals, never concatenated fragments —
            // Tailwind's scanner only sees complete utility names in source.
            const rule = last ? '' : 'border-b border-border/30';
            // Line 1 on phones: no rule (the row continues below); the rule
            // returns from `sm` up, where line 1 IS the row.
            const nameCell = `flex items-center pt-3 pb-1 sm:py-3 ${last ? '' : 'sm:border-b sm:border-border/30'}`;
            // Line 2 on phones: carries the row's rule.
            const lineTwo = `flex items-center pb-3 pt-0 sm:py-3 ${rule}`;
            const cell = `flex items-center py-3 ${rule}`;
            return (
              <Fragment key={i}>
                <span className={`${nameCell} col-span-2 sm:col-span-1 pl-5 pr-5 sm:pr-3 min-w-0`}>
                  <Link
                    to={`/${slug}/games/${encodeURIComponent(pb.game_name)}`}
                    className="max-w-full truncate text-primary hover:text-neon-cyan no-underline transition-colors font-medium"
                  >
                    {pb.game_name}
                  </Link>
                </span>
                {/* Phone-only caption carrying the two columns the reflow drops. */}
                <span className={`${lineTwo} sm:hidden pl-5 pr-3 min-w-0 text-faint text-[11px]`}>
                  <span className="min-w-0 truncate">
                    #{pb.room_rank} of {pb.total_players} · {new Date(pb.achieved_at).toLocaleDateString()}
                  </span>
                </span>
                <span
                  className={`${lineTwo} justify-end pr-5 sm:pr-4 font-display font-bold text-neon-amber whitespace-nowrap tabular-nums`}
                  title={scoreTitle(pb.best_score)}
                >
                  {formatScore(pb.best_score)}
                </span>
                <span className={`${cell} hidden sm:flex justify-end pr-4 text-muted text-sm whitespace-nowrap`}>
                  #{pb.room_rank} of {pb.total_players}
                </span>
                <span className={`${cell} hidden sm:flex justify-end pr-5 text-faint text-xs whitespace-nowrap`}>
                  {new Date(pb.achieved_at).toLocaleDateString()}
                </span>
              </Fragment>
            );
          })
        )}
      </div>

      {!filtering && matches.length > PERSONAL_BESTS_DEFAULT_VISIBLE && (
        <button
          type="button"
          onClick={() => setShowAll(v => !v)}
          className="mt-2 text-xs text-muted hover:text-neon-cyan transition-colors bg-transparent border-0 cursor-pointer p-0"
        >
          {showAll ? 'Show fewer' : `Show all ${matches.length}`}
        </button>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 text-center">
      <p className="text-faint text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-display font-bold text-2xl ${color}`}>{value}</p>
    </div>
  );
}
