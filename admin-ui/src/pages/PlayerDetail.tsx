import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Flame, Trophy, Target, Medal, UserPlus, UserCheck, GitCompare, Flag } from 'lucide-react';
import ShareButton from '../components/ShareButton';
import ReportContentModal from '../components/ReportContentModal';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useRoom } from '../contexts/RoomContext';

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
            title={`${displayName} · ArcAid`}
            text={`Check out ${displayName}'s scores and stats on ArcAid!`}
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
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {stats.recentScores.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-5 py-3 border-b border-border/30 last:border-0"
                >
                  <div>
                    <Link
                      to={`/${slug}/games/${encodeURIComponent(s.game_name)}`}
                      className="text-primary hover:text-neon-cyan no-underline transition-colors font-medium"
                    >
                      {s.game_name}
                    </Link>
                    <p className="text-faint text-xs">{new Date(s.date).toLocaleDateString()}</p>
                  </div>
                  <span className="font-display font-bold text-neon-amber">{s.score.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Personal Bests */}
        {stats.personalBests && stats.personalBests.length > 0 && (
          <div className="mt-8">
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Personal Bests</h2>
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              <div className="grid grid-cols-4 gap-2 px-5 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                <span>Game</span>
                <span className="text-right">Best</span>
                <span className="text-right">Room Rank</span>
                <span className="text-right">Date</span>
              </div>
              {stats.personalBests.map((pb, i) => (
                <div
                  key={i}
                  className="grid grid-cols-4 gap-2 items-center px-5 py-3 border-b border-border/30 last:border-0"
                >
                  <Link
                    to={`/${slug}/games/${encodeURIComponent(pb.game_name)}`}
                    className="text-primary hover:text-neon-cyan no-underline transition-colors font-medium truncate"
                  >
                    {pb.game_name}
                  </Link>
                  <span className="text-right font-display font-bold text-neon-amber">
                    {pb.best_score.toLocaleString()}
                  </span>
                  <span className="text-right text-muted text-sm">
                    #{pb.room_rank} of {pb.total_players}
                  </span>
                  <span className="text-right text-faint text-xs">
                    {new Date(pb.achieved_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
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
