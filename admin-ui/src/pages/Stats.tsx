import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import DataTable from '../components/DataTable';
import ScoreDisplay from '../components/ScoreDisplay';
import LoadingState from '../components/LoadingState';

interface PlayerSummary {
  discord_user_id: string;
  iscored_username: string | null;
  games_played: number;
  best_score: number;
  avg_score: number;
}

interface PlayerDetail {
  discordUserId: string;
  iscoredUsername: string | null;
  totalGamesPlayed: number;
  totalWins: number;
  winPercentage: number;
  averageScore: number;
  bestScore: number;
  bestGame: string | null;
  recentScores: Array<{ game_name: string; score: number; date: string }>;
}

interface GameDetail {
  gameName: string;
  timesPlayed: number;
  averageScore: number;
  allTimeHigh: number;
  allTimeHighHolder: string;
  recentResults: Array<{ tournament_name: string; winner_name: string; winner_score: number; end_date: string }>;
}

type View = 'players' | 'player-detail' | 'game-detail';

export default function Stats() {
  const [view, setView] = useState<View>('players');
  const [players, setPlayers] = useState<PlayerSummary[]>([]);
  const [playerDetail, setPlayerDetail] = useState<PlayerDetail | null>(null);
  const [gameDetail, setGameDetail] = useState<GameDetail | null>(null);
  const [gameSearch, setGameSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<PlayerSummary[]>('/stats/players')
      .then(setPlayers)
      .catch(() => setPlayers([]))
      .finally(() => setLoading(false));
  }, []);

  const viewPlayer = async (discordUserId: string) => {
    setLoading(true);
    try {
      const detail = await api.get<PlayerDetail>(`/stats/player/${discordUserId}`);
      setPlayerDetail(detail);
      setView('player-detail');
    } catch { /* ignore */ }
    setLoading(false);
  };

  const searchGame = async () => {
    if (!gameSearch.trim()) return;
    setLoading(true);
    try {
      const detail = await api.get<GameDetail>(`/stats/game/${encodeURIComponent(gameSearch.trim())}`);
      setGameDetail(detail);
      setView('game-detail');
    } catch { setGameDetail(null); }
    setLoading(false);
  };

  const playerColumns = [
    {
      key: 'iscored_username',
      header: 'Player',
      render: (item: PlayerSummary) => (
        <button
          onClick={() => viewPlayer(item.discord_user_id)}
          className="text-neon-cyan hover:underline bg-transparent border-none cursor-pointer font-medium"
        >
          {item.iscored_username || item.discord_user_id}
        </button>
      ),
    },
    {
      key: 'games_played',
      header: 'Games Played',
      render: (item: PlayerSummary) => <span className="text-muted">{item.games_played}</span>,
    },
    {
      key: 'best_score',
      header: 'Best Score',
      render: (item: PlayerSummary) => <ScoreDisplay score={item.best_score} size="sm" />,
    },
    {
      key: 'avg_score',
      header: 'Avg Score',
      render: (item: PlayerSummary) => <span className="text-muted">{item.avg_score.toLocaleString()}</span>,
    },
  ];

  if (loading) return <LoadingState message="Loading stats..." />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold">
          {view === 'players' ? 'Player Stats' : view === 'player-detail' ? 'Player Detail' : 'Game Stats'}
        </h1>
        {view !== 'players' && (
          <NeonButton variant="ghost" onClick={() => setView('players')}>
            Back to Players
          </NeonButton>
        )}
      </div>

      {/* Game search */}
      {view === 'players' && (
        <NeonCard className="mb-6">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1">Game Lookup</label>
              <input
                type="text"
                placeholder="Enter game name..."
                value={gameSearch}
                onChange={e => setGameSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchGame()}
                className="w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan/60"
              />
            </div>
            <NeonButton onClick={searchGame} disabled={!gameSearch.trim()}>Search</NeonButton>
          </div>
        </NeonCard>
      )}

      {/* Players list */}
      {view === 'players' && (
        <NeonCard>
          <DataTable
            columns={playerColumns}
            data={players}
            emptyMessage="No player data available yet. Scores will appear after players submit via Discord."
            keyExtractor={(item) => item.discord_user_id}
          />
        </NeonCard>
      )}

      {/* Player detail */}
      {view === 'player-detail' && playerDetail && (
        <div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <NeonCard glowColor="cyan">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">Games Played</p>
              <p className="font-display text-2xl font-bold text-neon-cyan">{playerDetail.totalGamesPlayed}</p>
            </NeonCard>
            <NeonCard glowColor="green">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">Wins</p>
              <p className="font-display text-2xl font-bold text-neon-green">{playerDetail.totalWins}</p>
            </NeonCard>
            <NeonCard glowColor="amber">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">Win Rate</p>
              <p className="font-display text-2xl font-bold text-neon-amber">{playerDetail.winPercentage}%</p>
            </NeonCard>
            <NeonCard glowColor="magenta">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">Best Score</p>
              <ScoreDisplay score={playerDetail.bestScore} size="md" />
            </NeonCard>
          </div>

          {playerDetail.bestGame && (
            <NeonCard className="mb-6">
              <p className="text-muted text-sm">
                Best game: <span className="text-primary font-medium">{playerDetail.bestGame}</span>
                {' | '}Average score: <span className="text-primary font-medium">{playerDetail.averageScore.toLocaleString()}</span>
              </p>
            </NeonCard>
          )}

          {playerDetail.recentScores.length > 0 && (
            <NeonCard title="Recent Scores">
              <div className="space-y-2">
                {playerDetail.recentScores.map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <span className="text-sm">{s.game_name}</span>
                    <div className="flex items-center gap-4">
                      <ScoreDisplay score={s.score} size="sm" />
                      <span className="text-faint text-xs">{new Date(s.date).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </NeonCard>
          )}
        </div>
      )}

      {/* Game detail */}
      {view === 'game-detail' && gameDetail && (
        <div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <NeonCard glowColor="cyan">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">Times Played</p>
              <p className="font-display text-2xl font-bold text-neon-cyan">{gameDetail.timesPlayed}</p>
            </NeonCard>
            <NeonCard glowColor="amber">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">All-Time High</p>
              <ScoreDisplay score={gameDetail.allTimeHigh} size="md" />
            </NeonCard>
            <NeonCard glowColor="green">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">Record Holder</p>
              <p className="font-display text-lg font-bold text-neon-green">{gameDetail.allTimeHighHolder}</p>
            </NeonCard>
            <NeonCard glowColor="magenta">
              <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">Avg Score</p>
              <p className="font-display text-2xl font-bold text-neon-magenta">{gameDetail.averageScore.toLocaleString()}</p>
            </NeonCard>
          </div>

          {gameDetail.recentResults.length > 0 && (
            <NeonCard title="Recent Results">
              <div className="space-y-2">
                {gameDetail.recentResults.map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <div>
                      <span className="text-sm font-medium">{r.winner_name || 'No winner'}</span>
                      <span className="text-faint text-xs ml-2">{r.tournament_name}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      {r.winner_score && <ScoreDisplay score={r.winner_score} size="sm" />}
                      <span className="text-faint text-xs">{r.end_date ? new Date(r.end_date).toLocaleDateString() : '—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </NeonCard>
          )}
        </div>
      )}

      {view === 'game-detail' && !gameDetail && (
        <NeonCard className="text-center py-8">
          <p className="text-muted">Game not found. Check the name and try again.</p>
        </NeonCard>
      )}
    </div>
  );
}
