import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';

type RankMethod = 'max_10' | 'average_rank' | 'best_game_papa' | 'best_game_linear';

interface RankingGroup {
  id: string;
  name: string;
  description: string;
  rank_method: RankMethod;
  best_n: number;
  min_games: number;
  is_active: boolean;
  tournament_ids: string[];
}

interface Tournament {
  id: string;
  name: string;
  type: string;
  is_active: number;
}

interface OverallRanking {
  rank: number;
  iscored_username: string;
  total_points: number;
  games_played: number;
  breakdown: Array<{ game_name: string; game_rank: number; points: number }>;
}

const RANK_METHODS: Record<RankMethod, { label: string; description: string }> = {
  max_10: {
    label: 'Max 10',
    description: 'Awards points to the top 10 players on each game (1st: 100, 2nd: 80, 3rd: 65, 4th: 50, 5th: 40, 6th: 30, 7th: 20, 8th: 15, 9th: 10, 10th: 5). Best N games count toward total.',
  },
  average_rank: {
    label: 'Average Rank',
    description: 'Ranks players by their average position across all game leaderboards. Lower is better. Players must meet the minimum games threshold to qualify.',
  },
  best_game_papa: {
    label: 'Best Game (PAPA)',
    description: 'Awards points based on rank (1st: 100, 2nd: 90, 3rd: 85, then each subsequent place is 1 point less). Best N games count toward total.',
  },
  best_game_linear: {
    label: 'Best Game (Linear)',
    description: 'Awards points based on rank (1st: 100, 2nd: 99, 3rd: 98, each subsequent place is 1 point less). Best N games count toward total.',
  },
};

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

export default function Rankings() {
  const { toast } = useToast();
  const [groups, setGroups] = useState<RankingGroup[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RankingGroup | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [rankings, setRankings] = useState<Record<string, OverallRanking[]>>({});
  const [recomputing, setRecomputing] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formMethod, setFormMethod] = useState<RankMethod>('best_game_papa');
  const [formBestN, setFormBestN] = useState(25);
  const [formMinGames, setFormMinGames] = useState(1);
  const [formTournamentIds, setFormTournamentIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [groupsData, tournamentsData] = await Promise.all([
        api.get<RankingGroup[]>('/ranking-groups'),
        api.get<Tournament[]>('/tournaments'),
      ]);
      setGroups(groupsData);
      setTournaments(tournamentsData);
    } catch {
      toast('Failed to load ranking groups', 'error');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormMethod('best_game_papa');
    setFormBestN(25);
    setFormMinGames(1);
    setFormTournamentIds([]);
    setEditingId(null);
    setShowForm(false);
  };

  const startEdit = (group: RankingGroup) => {
    setFormName(group.name);
    setFormDescription(group.description);
    setFormMethod(group.rank_method);
    setFormBestN(group.best_n);
    setFormMinGames(group.min_games);
    setFormTournamentIds(group.tournament_ids);
    setEditingId(group.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || formTournamentIds.length === 0) {
      toast('Name and at least one tournament are required', 'error');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/ranking-groups/${editingId}`, {
          name: formName.trim(),
          description: formDescription.trim(),
          rank_method: formMethod,
          best_n: formBestN,
          min_games: formMinGames,
          tournament_ids: formTournamentIds,
        });
        toast('Ranking group updated', 'success');
      } else {
        await api.post('/ranking-groups', {
          id: crypto.randomUUID(),
          name: formName.trim(),
          description: formDescription.trim(),
          rank_method: formMethod,
          best_n: formBestN,
          min_games: formMinGames,
          tournament_ids: formTournamentIds,
        });
        toast('Ranking group created', 'success');
      }
      resetForm();
      loadData();
    } catch {
      toast('Failed to save ranking group', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/ranking-groups/${deleteTarget.id}`);
      toast('Ranking group deleted', 'success');
      setDeleteTarget(null);
      loadData();
    } catch {
      toast('Failed to delete ranking group', 'error');
    }
  };

  const loadRankings = async (groupId: string) => {
    if (expandedGroup === groupId) {
      setExpandedGroup(null);
      return;
    }
    try {
      const data = await api.get<{ group: RankingGroup; rankings: OverallRanking[] }>(`/ranking-groups/${groupId}/rankings`);
      setRankings(prev => ({ ...prev, [groupId]: data.rankings }));
      setExpandedGroup(groupId);
    } catch {
      toast('Failed to load rankings', 'error');
    }
  };

  const handleRecompute = async (groupId: string) => {
    setRecomputing(groupId);
    try {
      await api.post(`/ranking-groups/${groupId}/recompute`, {});
      const data = await api.get<{ group: RankingGroup; rankings: OverallRanking[] }>(`/ranking-groups/${groupId}/rankings`);
      setRankings(prev => ({ ...prev, [groupId]: data.rankings }));
      toast('Rankings recomputed', 'success');
    } catch {
      toast('Failed to recompute rankings', 'error');
    } finally {
      setRecomputing(null);
    }
  };

  const toggleTournament = (id: string) => {
    setFormTournamentIds(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    );
  };

  if (loading) return <LoadingState message="Loading ranking groups..." />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold">Overall Rankings</h1>
        <NeonButton onClick={() => { resetForm(); setShowForm(true); }}>
          + New Ranking Group
        </NeonButton>
      </div>

      {/* Create/Edit Form */}
      {showForm && (
        <NeonCard glowColor="cyan" className="mb-6">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted mb-4">
            {editingId ? 'Edit Ranking Group' : 'New Ranking Group'}
          </h3>

          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-faint block mb-1">Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g. Daily Grind Overall"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="text-xs text-faint block mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  placeholder="Overall standings across all Daily Grind tournaments"
                  className={inputClass}
                />
              </div>
            </div>

            {/* Rank Method */}
            <div>
              <label className="text-xs text-faint block mb-1">Ranking Method</label>
              <select
                value={formMethod}
                onChange={e => setFormMethod(e.target.value as RankMethod)}
                className={inputClass}
              >
                {Object.entries(RANK_METHODS).map(([key, { label }]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <p className="text-xs text-muted mt-1">{RANK_METHODS[formMethod].description}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-faint block mb-1">Best N Games</label>
                <input
                  type="number"
                  value={formBestN}
                  onChange={e => setFormBestN(Number(e.target.value))}
                  min={1}
                  max={100}
                  className={inputClass}
                />
                <p className="text-xs text-muted mt-1">Number of top-scoring games counted toward each player's total.</p>
              </div>
              <div>
                <label className="text-xs text-faint block mb-1">Minimum Games{formMethod === 'average_rank' ? ' (required for Average Rank)' : ''}</label>
                <input
                  type="number"
                  value={formMinGames}
                  onChange={e => setFormMinGames(Number(e.target.value))}
                  min={1}
                  max={100}
                  className={inputClass}
                />
                <p className="text-xs text-muted mt-1">
                  {formMethod === 'average_rank'
                    ? 'Players must have played at least this many games to be included in the rankings.'
                    : 'Minimum games a player must have played to qualify.'}
                </p>
              </div>
            </div>

            {/* Tournament Selection */}
            <div>
              <label className="text-xs text-faint block mb-2">Included Tournaments</label>
              <div className="space-y-1 max-h-48 overflow-y-auto border border-border rounded p-2 bg-deep">
                {tournaments.map(t => (
                  <label
                    key={t.id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                      formTournamentIds.includes(t.id) ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-muted hover:bg-raised'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={formTournamentIds.includes(t.id)}
                      onChange={() => toggleTournament(t.id)}
                      className="accent-neon-cyan"
                    />
                    <span className="text-sm">{t.name}</span>
                    <span className="text-xs text-faint ml-auto">{t.type}</span>
                    {!t.is_active && <span className="text-xs text-neon-amber">(inactive)</span>}
                  </label>
                ))}
                {tournaments.length === 0 && (
                  <p className="text-xs text-faint text-center py-2">No tournaments found</p>
                )}
              </div>
              {formTournamentIds.length > 0 && (
                <p className="text-xs text-muted mt-1">{formTournamentIds.length} tournament{formTournamentIds.length !== 1 ? 's' : ''} selected</p>
              )}
            </div>

            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={resetForm}>Cancel</NeonButton>
              <NeonButton onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : (editingId ? 'Update' : 'Create')}
              </NeonButton>
            </div>
          </div>
        </NeonCard>
      )}

      {/* Groups List */}
      {groups.length === 0 && !showForm ? (
        <NeonCard>
          <div className="text-center py-12">
            <p className="text-muted mb-2">No ranking groups configured yet.</p>
            <p className="text-xs text-faint">Create a ranking group to compute overall player standings across tournaments.</p>
          </div>
        </NeonCard>
      ) : (
        <div className="space-y-4">
          {groups.map(group => (
            <NeonCard key={group.id} glowColor={group.is_active ? 'cyan' : 'none'}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-display font-bold text-base text-primary">{group.name}</h3>
                    {!group.is_active && (
                      <span className="text-xs bg-raised border border-border rounded px-1.5 py-0.5 text-faint">Inactive</span>
                    )}
                  </div>
                  {group.description && (
                    <p className="text-sm text-muted mb-2">{group.description}</p>
                  )}
                  <div className="flex flex-wrap gap-3 text-xs text-faint">
                    <span>Method: <span className="text-muted">{RANK_METHODS[group.rank_method].label}</span></span>
                    <span>Best {group.best_n} games</span>
                    {group.rank_method === 'average_rank' && <span>Min {group.min_games} games</span>}
                    <span>{group.tournament_ids.length} tournament{group.tournament_ids.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <NeonButton variant="ghost" onClick={() => loadRankings(group.id)}>
                    {expandedGroup === group.id ? 'Hide' : 'View'}
                  </NeonButton>
                  <NeonButton variant="secondary" onClick={() => handleRecompute(group.id)} disabled={recomputing === group.id}>
                    {recomputing === group.id ? '...' : 'Recompute'}
                  </NeonButton>
                  <NeonButton variant="ghost" onClick={() => startEdit(group)}>Edit</NeonButton>
                  <NeonButton variant="danger" onClick={() => setDeleteTarget(group)}>Delete</NeonButton>
                </div>
              </div>

              {/* Expanded Rankings */}
              {expandedGroup === group.id && rankings[group.id] && (
                <div className="mt-4 border-t border-border pt-4">
                  {rankings[group.id].length === 0 ? (
                    <p className="text-sm text-faint text-center py-4">No rankings yet — players need to submit scores to the included tournaments.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left">
                            <th className="py-2 pr-3 text-faint font-normal w-12">#</th>
                            <th className="py-2 pr-3 text-faint font-normal">Player</th>
                            <th className="py-2 pr-3 text-faint font-normal text-right">
                              {group.rank_method === 'average_rank' ? 'Avg Rank' : 'Points'}
                            </th>
                            <th className="py-2 text-faint font-normal text-right">Games</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rankings[group.id].map(r => (
                            <tr key={r.iscored_username} className="border-b border-border/30 last:border-0">
                              <td className={`py-2 pr-3 font-display font-bold ${
                                r.rank === 1 ? 'text-neon-amber' :
                                r.rank === 2 ? 'text-neon-cyan' :
                                r.rank === 3 ? 'text-neon-green' :
                                'text-faint'
                              }`}>
                                {r.rank}
                              </td>
                              <td className="py-2 pr-3 text-primary">{r.iscored_username}</td>
                              <td className={`py-2 pr-3 text-right font-display font-bold ${
                                r.rank === 1 ? 'text-neon-amber' : 'text-primary'
                              }`}>
                                {group.rank_method === 'average_rank'
                                  ? r.total_points.toFixed(2)
                                  : r.total_points.toLocaleString()}
                              </td>
                              <td className="py-2 text-right text-muted">{r.games_played}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </NeonCard>
          ))}
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <ConfirmModal
          title="Delete Ranking Group"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This will remove the group and all cached rankings.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
