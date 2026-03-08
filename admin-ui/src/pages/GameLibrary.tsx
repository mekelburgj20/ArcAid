import { useEffect, useState } from 'react';
import Papa from 'papaparse';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import TournamentBadge from '../components/TournamentBadge';
import DataTable from '../components/DataTable';
import LoadingState from '../components/LoadingState';

interface GameRow {
  name: string;
  aliases: string;
  style_id: string;
  css_title: string;
  css_initials: string;
  css_scores: string;
  css_box: string;
  bg_color: string;
  tournament_types: string;
}

const emptyGame: GameRow = {
  name: '', aliases: '', style_id: '', css_title: '', css_initials: '',
  css_scores: '', css_box: '', bg_color: '', tournament_types: ''
};

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

export default function GameLibrary() {
  const { toast } = useToast();
  const [games, setGames] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newGame, setNewGame] = useState<GameRow>({ ...emptyGame });
  const [search, setSearch] = useState('');

  const fetchGames = async () => {
    try {
      setGames(await api.get<GameRow[]>('/game_library'));
    } catch {
      toast('Failed to load game library', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchGames(); }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          await api.post('/game_library/import', { games: results.data as GameRow[] });
          toast(`Imported ${results.data.length} games`, 'success');
          fetchGames();
        } catch {
          toast('Import failed', 'error');
        } finally {
          setImporting(false);
          e.target.value = '';
        }
      }
    });
  };

  const downloadTemplate = () => {
    const headers = ['name','aliases','style_id','tournament_types','css_title','css_initials','css_scores','css_box','bg_color'];
    const csv = headers.join(',') + '\n"Medieval Madness","MM","92025","DG,WG-VPXS","","","","",""';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'arcaid_games_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAddGame = async () => {
    if (!newGame.name.trim()) { toast('Game name required', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/game_library/import', { games: [newGame] });
      setNewGame({ ...emptyGame });
      setShowAddForm(false);
      toast('Game added', 'success');
      fetchGames();
    } catch {
      toast('Failed to save game', 'error');
    } finally {
      setSaving(false);
    }
  };

  const filteredGames = search
    ? games.filter(g => g.name.toLowerCase().includes(search.toLowerCase()) || g.tournament_types?.toLowerCase().includes(search.toLowerCase()))
    : games;

  if (loading) return <LoadingState message="Loading game library..." />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold">Game Library</h1>
        <div className="flex gap-2">
          <NeonButton onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? 'Cancel' : 'Add Game'}
          </NeonButton>
          <NeonButton variant="secondary" onClick={downloadTemplate}>CSV Template</NeonButton>
          <div>
            <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" id="csv-upload" disabled={importing} />
            <label htmlFor="csv-upload">
              <NeonButton variant="secondary" className="pointer-events-none" tabIndex={-1} as-child>
                {importing ? 'Importing...' : 'Import CSV'}
              </NeonButton>
            </label>
          </div>
        </div>
      </div>

      {showAddForm && (
        <NeonCard glowColor="cyan" className="mb-6 border-l-2 border-l-neon-cyan" title="Add New Game">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Game Name *</label>
              <input type="text" value={newGame.name} onChange={e => setNewGame({...newGame, name: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Tournament Types</label>
              <input type="text" placeholder="e.g. DG, WG-VR" value={newGame.tournament_types} onChange={e => setNewGame({...newGame, tournament_types: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Style ID</label>
              <input type="text" value={newGame.style_id} onChange={e => setNewGame({...newGame, style_id: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Aliases</label>
              <input type="text" value={newGame.aliases} onChange={e => setNewGame({...newGame, aliases: e.target.value})} className={inputClass} />
            </div>
          </div>
          <details className="mb-4 text-muted text-sm cursor-pointer">
            <summary className="hover:text-primary transition-colors">Advanced CSS Styling</summary>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
              {(['css_title','css_initials','css_scores','css_box','bg_color'] as const).map(field => (
                <div key={field}>
                  <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">{field.replace('css_','CSS ').replace('bg_','BG ')}</label>
                  <input type="text" value={newGame[field]} onChange={e => setNewGame({...newGame, [field]: e.target.value})} className={inputClass} />
                </div>
              ))}
            </div>
          </details>
          <NeonButton onClick={handleAddGame} disabled={saving}>
            {saving ? 'Saving...' : 'Save Game'}
          </NeonButton>
        </NeonCard>
      )}

      <NeonCard>
        <div className="mb-4">
          <input
            type="text" placeholder="Search games..." value={search} onChange={e => setSearch(e.target.value)}
            className={`${inputClass} max-w-sm`}
          />
        </div>
        <DataTable<GameRow>
          columns={[
            { key: 'name', header: 'Game', render: g => <span className="font-medium">{g.name}</span> },
            { key: 'tournament_types', header: 'Types', render: g => {
              if (!g.tournament_types) return <span className="text-faint text-sm">Any</span>;
              const types = g.tournament_types.startsWith('[')
                ? JSON.parse(g.tournament_types)
                : g.tournament_types.split(',').map((t: string) => t.trim());
              return <div className="flex gap-1 flex-wrap">{types.map((t: string) => <TournamentBadge key={t} type={t} />)}</div>;
            }},
            { key: 'style_id', header: 'Style ID', render: g => <span className="text-sm text-muted font-mono">{g.style_id || '-'}</span> },
            { key: 'aliases', header: 'Aliases', render: g => <span className="text-sm text-muted">{g.aliases || '-'}</span> },
          ]}
          data={filteredGames}
          keyExtractor={(g, i) => g.name || String(i)}
          emptyMessage="No games in the library."
        />
        <p className="text-faint text-xs mt-3">{filteredGames.length} game{filteredGames.length !== 1 ? 's' : ''}</p>
      </NeonCard>
    </div>
  );
}
