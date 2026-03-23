import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, Minus } from 'lucide-react';

// --- Shared interfaces ---

export interface RankedEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  score: number;
}

export interface GameLeaderboard {
  gameId: string;
  gameName: string;
  tournamentName: string;
  tournamentType: string;
  imageUrl: string | null;
  gameStatus: string;
  catalogueStyleId: string | null;
  styleHeaderDisabled: boolean;
  rankings: RankedEntry[];
}

export interface RankingGroupData {
  group: {
    id: string;
    name: string;
    description: string;
    rank_method: string;
    best_n: number;
    min_games: number;
  };
  rankings: Array<{
    rank: number;
    iscored_username: string;
    total_points: number;
    games_played: number;
  }>;
}

// --- Constants ---

export const TOURNAMENT_COLORS: Record<string, string> = {
  DG:       'border-neon-magenta/50',
  'WG-VPXS': 'border-neon-blue/50',
  'WG-VR':  'border-neon-purple/50',
  MG:       'border-neon-coral/50',
};

export const RANKINGS_TOP_N = 10;

export const METHOD_LABELS: Record<string, { label: string; scoreLabel: string }> = {
  max_10: { label: 'Max 10', scoreLabel: 'Points' },
  average_rank: { label: 'Average Rank', scoreLabel: 'Avg Rank' },
  best_game_papa: { label: 'Best Game (PAPA)', scoreLabel: 'Points' },
  best_game_linear: { label: 'Best Game (Linear)', scoreLabel: 'Points' },
};

// --- Helper functions ---

export function getTournamentBorderColor(type: string): string {
  if (!type) return 'border-border';
  const upper = type.toUpperCase();
  return TOURNAMENT_COLORS[upper] ?? 'border-border';
}

export function getTitleStyleClass(style: string): string {
  switch (style) {
    case 'glow': return 'title-glow';
    case 'retro': return 'title-retro';
    case 'pixel': return 'title-pixel';
    default: return '';
  }
}

export function getTitleSizeClass(size: string): string {
  switch (size) {
    case 'xs': return 'text-xs';
    case 'sm': return 'text-sm';
    case 'base': return 'text-base';
    case 'lg': return 'text-lg';
    case 'xl': return 'text-xl';
    case '2xl': return 'text-2xl';
    case '3xl': return 'text-3xl';
    case '4xl': return 'text-4xl';
    default: return 'text-sm';
  }
}

// --- Components ---

interface ScoreHistoryEntry {
  id: number;
  score: number;
  source: string;
  created_at: string;
}

export function GameCard({ lb, slug, maxScores, roomId }: { lb: GameLeaderboard; slug: string; maxScores: number; roomId?: string }) {
  const borderColor = getTournamentBorderColor(lb.tournamentType);
  const [scoreCounts, setScoreCounts] = useState<Record<string, number>>({});
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [playerHistory, setPlayerHistory] = useState<ScoreHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Fetch score counts for this game to know which players have multiple scores
  useEffect(() => {
    if (!roomId || !lb.gameId || lb.rankings.length === 0) return;
    fetch(`/api/rooms/${roomId}/score-counts/${lb.gameId}`)
      .then(r => r.ok ? r.json() : {})
      .then(setScoreCounts)
      .catch(() => {});
  }, [roomId, lb.gameId, lb.rankings.length]);

  const togglePlayer = (username: string) => {
    if (expandedPlayer === username) {
      setExpandedPlayer(null);
      setPlayerHistory([]);
      return;
    }
    if (!roomId) return;
    setExpandedPlayer(username);
    setHistoryLoading(true);
    fetch(`/api/rooms/${roomId}/score-history/${encodeURIComponent(lb.gameName)}/player/${encodeURIComponent(username)}`)
      .then(r => r.ok ? r.json() : [])
      .then(setPlayerHistory)
      .catch(() => setPlayerHistory([]))
      .finally(() => setHistoryLoading(false));
  };

  // Catalogue style takes priority over imageUrl
  const styleBgUrl = lb.catalogueStyleId ? `/api/styles/images/backgrounds/${lb.catalogueStyleId}.png` : null;
  const styleHeaderUrl = lb.catalogueStyleId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${lb.catalogueStyleId}.png` : null;
  const bgImage = styleBgUrl || lb.imageUrl || null;

  return (
    <div className={`bg-surface border-2 ${borderColor} rounded-lg overflow-hidden flex flex-col`}>
      {/* Title area */}
      <div className="px-4 py-3 text-center border-b border-border/30">
        <h3 className="font-display font-bold text-base leading-tight truncate flex items-center justify-center gap-1.5">
          {lb.gameName}
          {lb.gameStatus === 'COMPLETED' && <span title="Completed"><Lock size={14} className="text-faint flex-shrink-0" /></span>}
        </h3>
        <p className="text-[11px] text-muted uppercase tracking-wider mt-0.5">{lb.tournamentName}</p>
      </div>

      {/* Background image area */}
      {bgImage && (
        <div className="relative h-28 bg-raised">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${bgImage})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
          {styleHeaderUrl && (
            <img src={styleHeaderUrl} alt="" className="absolute inset-0 w-full h-full object-contain z-[1]" />
          )}
        </div>
      )}

      {/* Scores */}
      <div className="flex-1">
        {lb.rankings.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-faint text-sm">No scores yet</p>
          </div>
        ) : (
          <div>
            {/* Header row */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
              <span>Player</span>
              <span>Score</span>
            </div>
            {lb.rankings.slice(0, maxScores).map((entry) => {
              const hasMultiple = scoreCounts[entry.iscored_username.toLowerCase()] > 1;
              const isExpanded = expandedPlayer === entry.iscored_username;
              return (
                <div key={entry.discord_user_id}>
                  <div
                    className={`flex items-center justify-between px-4 py-2.5 border-b border-border/20 last:border-0 ${
                      entry.rank === 1 ? 'bg-neon-amber/8' : ''
                    } ${hasMultiple ? 'cursor-pointer hover:bg-raised/50 transition-colors' : ''}`}
                    onClick={hasMultiple ? () => togglePlayer(entry.iscored_username) : undefined}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`font-display font-bold text-sm w-6 text-center flex-shrink-0 ${
                        entry.rank === 1 ? 'text-neon-amber' :
                        entry.rank === 2 ? 'text-neon-cyan' :
                        entry.rank === 3 ? 'text-neon-green' :
                        'text-faint'
                      }`}>
                        {entry.rank}
                      </span>
                      <span className="text-sm truncate">{entry.iscored_username}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`font-display font-bold text-sm flex-shrink-0 ${
                        entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                      }`}>
                        {entry.score.toLocaleString()}
                      </span>
                      {hasMultiple && (
                        isExpanded
                          ? <Minus size={12} className="text-neon-cyan flex-shrink-0" />
                          : <Plus size={12} className="text-faint flex-shrink-0" />
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="bg-deep/50 border-b border-border/20 px-4 py-2">
                      {historyLoading ? (
                        <p className="text-faint text-xs py-1">Loading...</p>
                      ) : playerHistory.length > 0 ? (
                        <div className="space-y-1">
                          {playerHistory.map(h => (
                            <div key={h.id} className="flex items-center justify-between text-xs">
                              <span className="text-muted">{h.score.toLocaleString()}</span>
                              <span className="text-faint">{new Date(h.created_at).toLocaleDateString()}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-faint text-xs py-1">No additional scores recorded.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer link */}
      <div className="border-t border-border/50 px-4 py-2.5">
        <Link
          to={`/${slug}/games/${encodeURIComponent(lb.gameName)}`}
          className="text-xs text-neon-cyan hover:text-neon-cyan/80 no-underline transition-colors"
        >
          Full Leaderboard &rarr;
        </Link>
      </div>
    </div>
  );
}

export function RankingGroupCard({ group, rankings }: { group: RankingGroupData['group']; rankings: RankingGroupData['rankings'] }) {
  const methodInfo = METHOD_LABELS[group.rank_method] || { label: group.rank_method, scoreLabel: 'Score' };

  return (
    <div className="bg-neon-purple/5 border border-neon-purple/20 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-neon-purple/15 bg-neon-purple/10">
        <h3 className="font-display font-bold text-base text-primary">{group.name}</h3>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[11px] text-muted uppercase tracking-wider">{methodInfo.label}</span>
          {group.description && (
            <span className="text-[11px] text-faint">{group.description}</span>
          )}
        </div>
      </div>

      {/* Rankings */}
      {rankings.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-faint text-sm">No qualified players yet</p>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between px-4 py-2 border-b border-neon-purple/10 text-[10px] text-faint uppercase tracking-wider">
            <span>Player</span>
            <div className="flex gap-6">
              <span className="w-12 text-right">Games</span>
              <span className="w-16 text-right">{methodInfo.scoreLabel}</span>
            </div>
          </div>
          {rankings.slice(0, RANKINGS_TOP_N).map((entry) => (
            <div
              key={entry.iscored_username}
              className={`flex items-center justify-between px-4 py-2.5 border-b border-neon-purple/10 last:border-0 ${
                entry.rank === 1 ? 'bg-neon-amber/8' : ''
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className={`font-display font-bold text-sm w-6 text-center flex-shrink-0 ${
                  entry.rank === 1 ? 'text-neon-amber' :
                  entry.rank === 2 ? 'text-neon-cyan' :
                  entry.rank === 3 ? 'text-neon-green' :
                  'text-faint'
                }`}>
                  {entry.rank}
                </span>
                <span className="text-sm truncate">{entry.iscored_username}</span>
              </div>
              <div className="flex gap-6">
                <span className="text-sm text-muted w-12 text-right">{entry.games_played}</span>
                <span className={`font-display font-bold text-sm w-16 text-right ${
                  entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                }`}>
                  {group.rank_method === 'average_rank'
                    ? entry.total_points.toFixed(2)
                    : entry.total_points.toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RankingsColumn({ rankingGroups }: { rankingGroups: RankingGroupData[] }) {
  return (
    <div className="w-full lg:w-80 flex-shrink-0 lg:sticky lg:top-6">
      <p className="font-display text-muted text-sm uppercase tracking-widest mb-4">Overall Rankings</p>
      <div className="flex flex-col gap-5">
        {rankingGroups.map(({ group, rankings }) => (
          <RankingGroupCard key={group.id} group={group} rankings={rankings} />
        ))}
      </div>
    </div>
  );
}

export function RankingsRow({ rankingGroups }: { rankingGroups: RankingGroupData[] }) {
  return (
    <div className="mb-6">
      <p className="font-display text-muted text-sm uppercase tracking-widest mb-4">Overall Rankings</p>
      <div className="flex gap-5 overflow-x-auto pb-2">
        {rankingGroups.map(({ group, rankings }) => (
          <div key={group.id} className="w-80 flex-shrink-0">
            <RankingGroupCard group={group} rankings={rankings} />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Layout helpers ---

export const cardWidthMap: Record<string, number> = { small: 240, medium: 288, large: 360 };
