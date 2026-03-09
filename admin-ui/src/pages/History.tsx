import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import DataTable from '../components/DataTable';
import TournamentBadge from '../components/TournamentBadge';
import ScoreDisplay from '../components/ScoreDisplay';
import LoadingState from '../components/LoadingState';

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

interface Tournament {
  id: string;
  name: string;
  type: string;
}

export default function History() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [tournamentFilter, setTournamentFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const limit = 20;

  useEffect(() => {
    api.get<Tournament[]>('/tournaments').then(setTournaments).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (tournamentFilter) params.set('tournament_id', tournamentFilter);
    if (typeFilter) params.set('type', typeFilter);

    api.get<HistoryResponse>(`/history?${params}`)
      .then(setData)
      .catch(() => setData({ results: [], total: 0, page: 1, limit }))
      .finally(() => setLoading(false));
  }, [page, tournamentFilter, typeFilter]);

  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  const columns = [
    {
      key: 'game_name',
      header: 'Game',
      render: (item: HistoryEntry) => <span className="font-medium">{item.game_name}</span>,
    },
    {
      key: 'tournament_name',
      header: 'Tournament',
      render: (item: HistoryEntry) => (
        <div className="flex items-center gap-2">
          <TournamentBadge type={item.tournament_type} />
          <span className="text-sm">{item.tournament_name}</span>
        </div>
      ),
    },
    {
      key: 'winner_name',
      header: 'Winner',
      render: (item: HistoryEntry) => (
        <span className={item.winner_name ? 'text-neon-green font-medium' : 'text-faint'}>
          {item.winner_name || 'No submissions'}
        </span>
      ),
    },
    {
      key: 'winner_score',
      header: 'Score',
      render: (item: HistoryEntry) =>
        item.winner_score != null ? <ScoreDisplay score={item.winner_score} size="sm" /> : <span className="text-faint">—</span>,
    },
    {
      key: 'end_date',
      header: 'Completed',
      render: (item: HistoryEntry) => (
        <span className="text-muted text-sm">
          {item.end_date ? new Date(item.end_date).toLocaleDateString() : '—'}
        </span>
      ),
    },
  ];

  const tournamentTypes = [...new Set(tournaments.map(t => t.type))];

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">History</h1>

      {/* Filters */}
      <NeonCard className="mb-6">
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1">Tournament</label>
            <select
              value={tournamentFilter}
              onChange={e => { setTournamentFilter(e.target.value); setPage(1); }}
              className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-neon-cyan/60"
            >
              <option value="">All Tournaments</option>
              {tournaments.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1">Type</label>
            <select
              value={typeFilter}
              onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
              className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-neon-cyan/60"
            >
              <option value="">All Types</option>
              {tournamentTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div className="text-muted text-sm">
            {data ? `${data.total} completed game${data.total !== 1 ? 's' : ''}` : ''}
          </div>
        </div>
      </NeonCard>

      {/* Results */}
      <NeonCard>
        {loading ? (
          <LoadingState message="Loading history..." />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={data?.results ?? []}
              emptyMessage="No completed games found."
              keyExtractor={(item, i) => `${item.game_name}-${item.end_date}-${i}`}
            />

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-4 mt-4 border-t border-border">
                <span className="text-muted text-sm">
                  Page {page} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <NeonButton
                    variant="ghost"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  >
                    Previous
                  </NeonButton>
                  <NeonButton
                    variant="ghost"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                  >
                    Next
                  </NeonButton>
                </div>
              </div>
            )}
          </>
        )}
      </NeonCard>
    </div>
  );
}
