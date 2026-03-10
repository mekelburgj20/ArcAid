import { useEffect, useState } from 'react';
import Papa from 'papaparse';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import DataTable from '../components/DataTable';
import LoadingState from '../components/LoadingState';

interface GameRow {
  name: string;
  aliases: string;
  style_id: string;
  mode: string;
  css_title: string;
  css_initials: string;
  css_scores: string;
  css_box: string;
  bg_color: string;
  platforms: string;
}

const emptyGame: GameRow = {
  name: '', aliases: '', style_id: '', mode: 'pinball', css_title: '', css_initials: '',
  css_scores: '', css_box: '', bg_color: '', platforms: ''
};

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

function parsePlatforms(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

function PlatformChips({ platforms: raw }: { platforms: string }) {
  const list = parsePlatforms(raw);
  if (list.length === 0) return <span className="text-faint text-sm">None</span>;
  return (
    <div className="flex gap-1 flex-wrap">
      {list.map(p => (
        <span key={p} className="text-xs px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30">{p}</span>
      ))}
    </div>
  );
}

export default function GameLibrary() {
  const { toast } = useToast();
  const [games, setGames] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newGame, setNewGame] = useState<GameRow>({ ...emptyGame });
  const [search, setSearch] = useState('');
  const [showPinball, setShowPinball] = useState(true);
  const [showVideoGame, setShowVideoGame] = useState(true);
  const [editTarget, setEditTarget] = useState<GameRow | null>(null);
  const [editGame, setEditGame] = useState<GameRow>({ ...emptyGame });
  const [editSaving, setEditSaving] = useState(false);
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
    const headers = ['name','aliases','style_id','mode','platforms','css_title','css_initials','css_scores','css_box','bg_color'];
    const csv = headers.join(',') + '\n"Medieval Madness","MM","92025","pinball","AtGames,VPXS","","","","",""';
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

  const openEdit = (g: GameRow) => {
    setEditTarget(g);
    const plats = parsePlatforms(g.platforms).join(', ');
    setEditGame({ ...g, platforms: plats });
  };

  const handleEditSave = async () => {
    if (!editTarget || !editGame.name.trim()) return;
    setEditSaving(true);
    try {
      await api.put(`/game_library/${encodeURIComponent(editTarget.name)}`, editGame);
      toast('Game updated', 'success');
      setEditTarget(null);
      fetchGames();
    } catch {
      toast('Failed to update game', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const filteredGames = games.filter(g => {
    if (!showPinball && (g.mode || 'pinball') === 'pinball') return false;
    if (!showVideoGame && g.mode === 'videogame') return false;
    if (search) {
      const q = search.toLowerCase();
      return g.name.toLowerCase().includes(q) || (g.platforms || '').toLowerCase().includes(q);
    }
    return true;
  });

  if (loading) return <LoadingState message="Loading game library..." />;

  const selectClass = `${inputClass} cursor-pointer`;

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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 mb-4">
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Game Name *</label>
              <input type="text" value={newGame.name} onChange={e => setNewGame({...newGame, name: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Mode</label>
              <select value={newGame.mode} onChange={e => setNewGame({...newGame, mode: e.target.value})} className={selectClass}>
                <option value="pinball">Pinball</option>
                <option value="videogame">Video Game</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Platforms</label>
              <input type="text" placeholder="e.g. AtGames, VPXS" value={newGame.platforms} onChange={e => setNewGame({...newGame, platforms: e.target.value})} className={inputClass} />
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
        <div className="flex items-center gap-4 mb-4">
          <input
            type="text" placeholder="Search games..." value={search} onChange={e => setSearch(e.target.value)}
            className={`${inputClass} max-w-sm`}
          />
          <label className="flex items-center gap-1.5 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={showPinball} onChange={e => setShowPinball(e.target.checked)} className="accent-neon-amber" />
            Pinball
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={showVideoGame} onChange={e => setShowVideoGame(e.target.checked)} className="accent-neon-cyan" />
            Video Games
          </label>
        </div>
        <DataTable<GameRow>
          columns={[
            { key: 'name', header: 'Game', render: g => <span className="font-medium">{g.name}</span> },
            { key: 'mode', header: 'Mode', render: g => (
              <span className={`text-xs px-2 py-0.5 rounded ${(g.mode || 'pinball') === 'pinball' ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan'}`}>
                {(g.mode || 'pinball') === 'pinball' ? 'Pinball' : 'Video Game'}
              </span>
            )},
            { key: 'platforms', header: 'Platforms', render: g => <PlatformChips platforms={g.platforms} /> },
            { key: 'style_id', header: 'Style ID', render: g => <span className="text-sm text-muted font-mono">{g.style_id || '-'}</span> },
            { key: 'actions', header: '', render: g => (
              <div className="flex justify-end">
                <NeonButton variant="ghost" onClick={() => openEdit(g)} className="text-xs px-2 py-1">Edit</NeonButton>
              </div>
            ), className: 'text-right' },
          ]}
          data={filteredGames}
          keyExtractor={(g, i) => g.name || String(i)}
          emptyMessage="No games in the library."
        />
        <p className="text-faint text-xs mt-3">{filteredGames.length} game{filteredGames.length !== 1 ? 's' : ''}</p>
      </NeonCard>

      {editTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="font-display text-lg font-bold mb-4">Edit Game</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 mb-4">
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Game Name *</label>
                <input type="text" value={editGame.name} onChange={e => setEditGame({...editGame, name: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Mode</label>
                <select value={editGame.mode || 'pinball'} onChange={e => setEditGame({...editGame, mode: e.target.value})} className={selectClass}>
                  <option value="pinball">Pinball</option>
                  <option value="videogame">Video Game</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Platforms</label>
                <input type="text" placeholder="e.g. AtGames, VPXS" value={editGame.platforms} onChange={e => setEditGame({...editGame, platforms: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Style ID</label>
                <input type="text" value={editGame.style_id} onChange={e => setEditGame({...editGame, style_id: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Aliases</label>
                <input type="text" value={editGame.aliases} onChange={e => setEditGame({...editGame, aliases: e.target.value})} className={inputClass} />
              </div>
            </div>
            <details className="mb-4 text-muted text-sm cursor-pointer">
              <summary className="hover:text-primary transition-colors">Advanced CSS Styling</summary>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
                {(['css_title','css_initials','css_scores','css_box','bg_color'] as const).map(field => (
                  <div key={field}>
                    <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">{field.replace('css_','CSS ').replace('bg_','BG ')}</label>
                    <input type="text" value={editGame[field]} onChange={e => setEditGame({...editGame, [field]: e.target.value})} className={inputClass} />
                  </div>
                ))}
              </div>
            </details>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</NeonButton>
              <NeonButton onClick={handleEditSave} disabled={editSaving || !editGame.name.trim()}>
                {editSaving ? 'Saving...' : 'Save Changes'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
