import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

interface PlayerSummary {
  discord_user_id: string;
  iscored_username: string | null;
  games_played: number;
  best_score: number;
  avg_score: number;
}

export default function Players() {
  const [players, setPlayers] = useState<PlayerSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats/players')
      .then(r => r.json())
      .then(setPlayers)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = players.filter(p =>
    (p.iscored_username || p.discord_user_id).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-deep text-primary relative">
      {/* Header */}
      <header className="border-b border-border bg-surface/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <Link to="/scoreboard" className="text-faint text-xs hover:text-muted no-underline transition-colors">
              &larr; Scoreboard
            </Link>
            <h1 className="font-pixel text-neon-cyan text-lg tracking-wider mt-1">PLAYERS</h1>
          </div>
          <input
            type="text"
            placeholder="Search players..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none w-60"
          />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted text-center py-12">No players found.</p>
        ) : (
          <div className="grid gap-3">
            {filtered.map((player, i) => (
              <Link
                key={player.discord_user_id}
                to={`/players/${player.discord_user_id}`}
                className="flex items-center justify-between bg-surface border border-border rounded-lg px-5 py-4 hover:border-neon-cyan/50 transition-all no-underline group"
              >
                <div className="flex items-center gap-4">
                  <span className="text-faint font-display font-bold text-lg w-8 text-center">
                    {i + 1}
                  </span>
                  <div>
                    <p className="font-medium text-primary group-hover:text-neon-cyan transition-colors">
                      {player.iscored_username || `User ${player.discord_user_id.slice(-4)}`}
                    </p>
                    <p className="text-faint text-xs">{player.games_played} games played</p>
                  </div>
                </div>
                <div className="flex gap-6 text-right">
                  <div>
                    <p className="text-xs text-faint">Best</p>
                    <p className="font-display font-bold text-neon-amber">{player.best_score.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-faint">Avg</p>
                    <p className="font-display font-bold text-muted">{player.avg_score.toLocaleString()}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
