import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Trophy } from 'lucide-react';
import { formatScore } from '../lib/format';

interface HistoryEntry {
  game_name: string;
  tournament_name: string;
  tournament_type: string;
  start_date: string;
  end_date: string;
  winner_name: string | null;
  winner_score: number | null;
}

interface HistoryResponse {
  results: HistoryEntry[];
  total: number;
  page: number;
  limit: number;
}

// Colors mirror TournamentBadge (admin History) — kept local since this page
// intentionally avoids the admin component set.
const typeColors: Record<string, string> = {
  DG: 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/30',
  'WG-VPXS': 'bg-neon-blue/15 text-neon-blue border-neon-blue/30',
  'WG-VR': 'bg-neon-purple/15 text-neon-purple border-neon-purple/30',
  MG: 'bg-neon-coral/15 text-neon-coral border-neon-coral/30',
};

function TypeBadge({ type }: { type: string }) {
  const colors = typeColors[type.toUpperCase()] || 'bg-border/30 text-muted border-border';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider border ${colors}`}>
      {type}
    </span>
  );
}

export default function PublicHistory() {
  const { slug } = useParams<{ slug: string }>();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const limit = 20;

  useEffect(() => {
    if (!slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ id: string; slug: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (found) setRoomId(found.id);
      })
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    if (!roomId) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (typeFilter) params.set('type', typeFilter);

    fetch(`/api/rooms/${roomId}/history?${params}`)
      .then(r => r.ok ? r.json() : { results: [], total: 0, page: 1, limit })
      .then(setData)
      .catch(() => setData({ results: [], total: 0, page: 1, limit }))
      .finally(() => setLoading(false));
  }, [roomId, page, typeFilter]);

  const totalPages = data ? Math.ceil(data.total / limit) : 0;
  // Static list (matches TypeBadge's known types) rather than deriving from
  // the current page's results — deriving from paginated/filtered data would
  // make the filter's own options shrink once a filter is applied.
  const tournamentTypes = Object.keys(typeColors);

  return (
    <div>
      {/* Page Header + filter */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2 flex flex-col gap-3 sm:flex-row sm:items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-xl font-bold">History</h2>
          <span className="text-xs text-muted">
            {data ? `${data.total} completed game${data.total !== 1 ? 's' : ''}` : ''}
          </span>
        </div>
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-neon-cyan/60 w-full sm:w-auto"
        >
          <option value="">All Types</option>
          {tournamentTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : !data || data.results.length === 0 ? (
          <p className="text-muted text-center py-12">No completed games found.</p>
        ) : (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="hidden sm:grid grid-cols-[1fr_1fr_140px_100px_90px] gap-2 px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
              <span>Game</span>
              <span>Tournament</span>
              <span>Winner</span>
              <span className="text-center">Score</span>
              <span className="text-center">Completed</span>
            </div>
            {data.results.map((item, i) => (
              <div
                key={`${item.game_name}-${item.end_date}-${i}`}
                className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_140px_100px_90px] gap-2 px-4 py-3 border-b border-border/20 last:border-0 items-center"
              >
                <span className="font-medium text-sm text-primary truncate">{item.game_name}</span>
                <span className="flex items-center gap-2 min-w-0">
                  <TypeBadge type={item.tournament_type} />
                  <span className="text-sm text-muted truncate">{item.tournament_name}</span>
                </span>
                <span className={`hidden sm:flex items-center gap-1 text-sm truncate ${item.winner_name ? 'text-neon-green font-medium' : 'text-faint'}`}>
                  {item.winner_name ? <Trophy size={12} className="flex-shrink-0" /> : null}
                  {item.winner_name || 'No submissions'}
                </span>
                <span className="hidden sm:block text-center text-sm font-display text-neon-amber" title={item.winner_score != null ? item.winner_score.toLocaleString() : undefined}>
                  {item.winner_score != null ? formatScore(item.winner_score) : '—'}
                </span>
                <span className="hidden sm:block text-center text-xs text-faint">
                  {item.end_date ? new Date(item.end_date).toLocaleDateString() : '—'}
                </span>
                <span className="sm:hidden text-xs text-faint text-right">
                  {item.winner_name || 'No submissions'} · {item.winner_score != null ? formatScore(item.winner_score) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 mt-4">
            <span className="text-muted text-sm">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 text-sm rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 text-sm rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
