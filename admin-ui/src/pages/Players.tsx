import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

interface PlayerSummary {
  discord_user_id: string;
  iscored_username: string | null;
  games_played: number;
  wins: number;
  avg_finish_position: number;
  top5_rate: number;
  champion_streak: number;
}

export default function Players() {
  const { slug } = useParams<{ slug: string }>();
  const [players, setPlayers] = useState<PlayerSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ id: string; slug: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (!found) { setLoading(false); return; }
        return fetch(`/api/rooms/${found.id}/stats/enhanced/players`);
      })
      .then(r => r?.json())
      .then(data => { if (data) setPlayers(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  const filtered = players.filter(p =>
    (p.iscored_username || p.discord_user_id).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      {/* Page Header */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold">Players</h2>
        <input
          type="text"
          placeholder="Search players..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none w-full sm:w-60"
        />
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
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
                key={player.iscored_username || player.discord_user_id}
                to={`/${slug}/players/${encodeURIComponent(player.iscored_username || player.discord_user_id)}`}
                className="flex items-center justify-between bg-surface border border-border rounded-lg px-3 sm:px-5 py-3 sm:py-4 hover:border-neon-cyan/50 transition-all no-underline group"
              >
                <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                  <span className="text-faint font-display font-bold text-base sm:text-lg w-6 sm:w-8 text-center flex-shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-primary group-hover:text-neon-cyan transition-colors text-sm sm:text-base truncate">
                      {player.iscored_username || `User ${player.discord_user_id.slice(-4)}`}
                    </p>
                    <p className="text-faint text-xs">{player.games_played} games played</p>
                  </div>
                </div>
                <div className="flex gap-3 sm:gap-6 text-right flex-shrink-0">
                  <div>
                    <p className="text-xs text-faint">Avg Finish</p>
                    <p className="font-display font-bold text-neon-amber">{player.avg_finish_position.toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-faint">Top 5 %</p>
                    <p className="font-display font-bold text-muted">{Math.round(player.top5_rate * 100)}%</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
