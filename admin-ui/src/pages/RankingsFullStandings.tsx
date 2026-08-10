import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useRoom } from '../contexts/RoomContext';
import { PlayerAvatar, playerName, METHOD_LABELS } from '../components/ScoreboardComponents';

/**
 * `/:slug/rankings/:groupId` — the full-standings destination page for the
 * "ticker" SCOREBOARD_RANKINGS_STYLE treatment (RTX demo request). The
 * ticker/card treatments on the Scoreboard only ever show the top N
 * standings (RANKINGS_TOP_N=10 on cards, fewer on the ticker); this page is
 * the click-through target that shows every ranked player, no truncation.
 *
 * Minimal by design ("nothing fancy, it's a destination page") — no card
 * chrome, just the same public-page shell + a plain ranked list, modeled on
 * TournamentDetail.tsx's layout conventions. Uses the existing PUBLIC
 * `GET /rooms/:roomId/ranking-groups/:id/rankings` endpoint (no new BE
 * route needed — it was already unauthenticated).
 */

interface RankingRow {
  rank: number;
  iscored_username: string;
  display_name?: string | null;
  discord_user_id?: string;
  total_points: number;
  games_played: number;
  avatar_hash?: string | null;
  avatar_url?: string | null;
}

interface RankingGroupDetail {
  id: string;
  name: string;
  description: string;
  rank_method: string;
  best_n: number;
  min_games: number;
  tournaments?: { id: string; name: string; type: string }[];
}

interface RankingsResponse {
  group: RankingGroupDetail;
  rankings: RankingRow[];
}

export default function RankingsFullStandings() {
  const { roomSlug, roomId } = useRoom();
  const { groupId } = useParams<{ groupId: string }>();
  const [data, setData] = useState<RankingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!roomId || !groupId) return;
    setLoading(true);
    setNotFound(false);
    fetch(`/api/rooms/${roomId}/ranking-groups/${groupId}/rankings`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.ok ? r.json() : null;
      })
      .then((json: RankingsResponse | null) => setData(json))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [roomId, groupId]);

  const backLink = (
    <Link
      to={`/${roomSlug}`}
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-neon-cyan transition-colors no-underline"
    >
      <ChevronLeft size={16} />
      Scoreboard
    </Link>
  );

  if (loading) {
    return (
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        {backLink}
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      </main>
    );
  }

  if (notFound || !data) {
    return (
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        {backLink}
        <p className="text-muted text-center py-12">Ranking group not found.</p>
      </main>
    );
  }

  const { group, rankings } = data;
  const methodInfo = METHOD_LABELS[group.rank_method] || { label: group.rank_method, scoreLabel: 'Score' };
  const scoreDisplay = (r: RankingRow) =>
    group.rank_method === 'average_rank' ? r.total_points.toFixed(2) : r.total_points.toLocaleString();

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
      {backLink}

      <header className="mt-3 mb-6">
        <h1 className="font-display text-xl sm:text-2xl font-bold text-primary min-w-0 break-words">
          {group.name}
        </h1>
        {group.description && (
          <p className="mt-1 text-sm text-muted">{group.description}</p>
        )}
        <p className="mt-1 text-xs text-faint">
          {methodInfo.label} · Best {group.best_n} games
          {group.rank_method === 'average_rank' ? ` · Min ${group.min_games} games` : ''}
          {' · '}{rankings.length} player{rankings.length !== 1 ? 's' : ''}
        </p>
      </header>

      {rankings.length === 0 ? (
        <p className="text-muted text-center py-12">
          No ranked players yet — players need to submit scores to the included tournaments.
        </p>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="hidden sm:grid grid-cols-[48px_1fr_120px_90px] gap-2 px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
            <span className="text-center">#</span>
            <span>Player</span>
            <span className="text-right">{methodInfo.scoreLabel}</span>
            <span className="text-right">Games</span>
          </div>
          <div className="divide-y divide-border/20">
            {rankings.map(r => (
              <Link
                key={r.iscored_username}
                to={`/${roomSlug}/players/${encodeURIComponent(r.iscored_username)}`}
                className={`grid grid-cols-[36px_1fr_auto] sm:grid-cols-[48px_1fr_120px_90px] gap-2 sm:gap-3 px-4 py-2.5 items-center no-underline hover:bg-raised/50 transition-colors group ${r.rank === 1 ? 'bg-neon-amber/8' : ''}`}
              >
                <span className={`font-display font-bold text-sm text-center flex-shrink-0 tabular-nums ${
                  r.rank === 1 ? 'text-neon-amber' :
                  r.rank === 2 ? 'text-neon-cyan' :
                  r.rank === 3 ? 'text-neon-green' :
                  'text-faint'
                }`}>
                  {r.rank}
                </span>
                <span className="flex items-center gap-2.5 min-w-0">
                  <PlayerAvatar username={playerName(r)} discordUserId={r.discord_user_id} avatarHash={r.avatar_hash} avatarUrl={r.avatar_url} size={24} />
                  <span className={`truncate text-sm group-hover:text-neon-cyan transition-colors ${r.rank === 1 ? 'text-neon-amber font-medium' : 'text-primary'}`}>
                    {playerName(r)}
                  </span>
                </span>
                <span className={`hidden sm:block text-right font-display font-bold text-sm tabular-nums ${r.rank === 1 ? 'text-neon-amber' : 'text-primary'}`}>
                  {scoreDisplay(r)}
                </span>
                <span className="hidden sm:block text-right text-sm text-muted">{r.games_played}</span>
                {/* Mobile: score+games collapse into one right-aligned column */}
                <span className="sm:hidden text-right text-xs text-faint whitespace-nowrap">
                  {scoreDisplay(r)} · {r.games_played}g
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
