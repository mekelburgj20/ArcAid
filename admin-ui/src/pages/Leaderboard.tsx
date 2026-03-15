import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getSocket } from '../lib/websocket';
import NeonCard from '../components/NeonCard';
import TournamentBadge from '../components/TournamentBadge';
import ScoreDisplay from '../components/ScoreDisplay';
import LoadingState from '../components/LoadingState';

interface RankedEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  score: number;
}

interface Submission {
  iscored_username: string;
  score: number;
  timestamp: string;
  photo_url: string | null;
}

interface GameLeaderboard {
  gameId: string;
  gameName: string;
  tournamentName: string;
  tournamentType: string;
  rankings: RankedEntry[];
}

export default function Leaderboard() {
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = () => {
    api.get<GameLeaderboard[]>('/leaderboard')
      .then(setLeaderboards)
      .catch(() => setLeaderboards([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();

    const socket = getSocket();
    socket.on('leaderboard:updated', loadData);
    socket.on('score:new', loadData);

    return () => {
      socket.off('leaderboard:updated', loadData);
      socket.off('score:new', loadData);
    };
  }, []);

  if (loading) return <LoadingState message="Loading leaderboards..." />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Leaderboards</h1>

      {leaderboards.length === 0 ? (
        <NeonCard className="text-center py-8">
          <p className="text-muted">No active games with scores yet.</p>
        </NeonCard>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {leaderboards.map(lb => (
            <LeaderboardCard key={lb.gameId} lb={lb} />
          ))}
        </div>
      )}
    </div>
  );
}

function LeaderboardCard({ lb }: { lb: GameLeaderboard }) {
  const [expanded, setExpanded] = useState<string | null>(null); // username of expanded row
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);

  const toggleExpand = async (username: string) => {
    if (expanded === username) {
      setExpanded(null);
      return;
    }

    // Fetch submissions if not already loaded for this game
    if (submissions.length === 0) {
      setLoadingSubs(true);
      try {
        const subs = await api.get<Submission[]>(`/leaderboard/${lb.gameId}/submissions`);
        setSubmissions(subs);
      } catch {
        setSubmissions([]);
      } finally {
        setLoadingSubs(false);
      }
    }

    setExpanded(username);
  };

  const getPlayerSubmissions = (username: string): Submission[] => {
    return submissions
      .filter(s => s.iscored_username.toLowerCase() === username.toLowerCase())
      .sort((a, b) => b.score - a.score);
  };

  return (
    <NeonCard glowColor="cyan">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-bold text-lg">{lb.gameName}</h3>
          <p className="text-muted text-sm">{lb.tournamentName}</p>
        </div>
        <TournamentBadge type={lb.tournamentType || lb.tournamentName} />
      </div>

      {lb.rankings.length === 0 ? (
        <p className="text-faint text-sm">No scores submitted yet.</p>
      ) : (
        <div className="space-y-1">
          {lb.rankings.slice(0, 10).map((entry) => {
            const isExpanded = expanded === entry.iscored_username;
            const playerSubs = isExpanded ? getPlayerSubmissions(entry.iscored_username) : [];
            return (
              <div key={entry.discord_user_id}>
                <div
                  className={`flex items-center justify-between py-2 px-3 rounded cursor-pointer transition-colors ${
                    entry.rank === 1
                      ? 'bg-neon-amber/10 border border-neon-amber/30'
                      : entry.rank === 2
                      ? 'bg-neon-cyan/5 border border-border'
                      : entry.rank === 3
                      ? 'bg-neon-green/5 border border-border'
                      : 'border border-transparent hover:bg-raised/50'
                  }`}
                  onClick={() => toggleExpand(entry.iscored_username)}
                >
                  <div className="flex items-center gap-3">
                    <span className={`font-display font-bold w-8 text-center ${
                      entry.rank === 1 ? 'text-neon-amber text-lg' :
                      entry.rank === 2 ? 'text-neon-cyan' :
                      entry.rank === 3 ? 'text-neon-green' :
                      'text-muted'
                    }`}>
                      {entry.rank}
                    </span>
                    <span className="font-medium">{entry.iscored_username}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ScoreDisplay score={entry.score} size="sm" />
                    <span className={`text-faint text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                      ▼
                    </span>
                  </div>
                </div>

                {/* Expanded submissions */}
                {isExpanded && (
                  <div className="ml-11 mr-3 mb-1 border-l-2 border-border/50 pl-3">
                    {loadingSubs ? (
                      <p className="text-faint text-xs py-2">Loading...</p>
                    ) : playerSubs.length <= 1 ? (
                      <p className="text-faint text-xs py-2">No additional submissions</p>
                    ) : (
                      playerSubs.slice(1).map((sub, i) => (
                        <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                          <span className="text-faint text-xs">
                            {new Date(sub.timestamp).toLocaleDateString()}
                          </span>
                          <ScoreDisplay score={sub.score} size="sm" />
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </NeonCard>
  );
}
