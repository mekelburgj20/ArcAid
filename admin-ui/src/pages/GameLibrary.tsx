import { useEffect, useState } from 'react';
import Papa from 'papaparse';
import { api } from '../lib/api';

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

export default function GameLibrary() {
  const [games, setGames] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // New game state
  const [newGame, setNewGame] = useState<GameRow>({
      name: '', aliases: '', style_id: '', css_title: '', css_initials: '', css_scores: '', css_box: '', bg_color: '', tournament_types: ''
  });

  const fetchGames = async () => {
    try {
      const data = await api.get<GameRow[]>('/game_library');
      setGames(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGames();
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setImporting(true);

      Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: async (results) => {
              const parsedGames = results.data as GameRow[];
              
              try {
                await api.post('/game_library/import', { games: parsedGames });
                alert(`Successfully imported ${parsedGames.length} games!`);
                fetchGames();
              } catch (err) {
                  console.error(err);
                  alert('Network error during import.');
              } finally {
                  setImporting(false);
                  e.target.value = '';
              }
          }
      });
  }

  const downloadTemplate = () => {
      const headers = ['name', 'aliases', 'style_id', 'tournament_types', 'css_title', 'css_initials', 'css_scores', 'css_box', 'bg_color'];
      const csvContent = headers.join(',') + '\n' + 
                         '"Medieval Madness","MM, MMadness","92025","DG,WG-VPXS","","","","",""';
                         
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", "arcaid_games_template.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  }

  const handleAddGame = async () => {
      if (!newGame.name.trim()) {
          alert('Game Name is required.');
          return;
      }

      setSaving(true);
      try {
          await api.post('/game_library/import', { games: [newGame] });
          setNewGame({ name: '', aliases: '', style_id: '', css_title: '', css_initials: '', css_scores: '', css_box: '', bg_color: '', tournament_types: '' });
          setShowAddForm(false);
          fetchGames();
      } catch (err) {
          console.error(err);
          alert('Network error while saving.');
      } finally {
          setSaving(false);
      }
  };

  if (loading) return <div className="page">Loading library...</div>;

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1>Game Library Master List</h1>
          <div style={{ display: 'flex', gap: '1rem' }}>
             <button onClick={() => setShowAddForm(!showAddForm)} style={{ ...btnStyle, background: 'var(--primary-color)' }}>
                {showAddForm ? 'Cancel' : 'Add Game Manually'}
             </button>
             <button onClick={downloadTemplate} style={{ ...btnStyle, background: 'var(--text-muted)' }}>Download CSV Template</button>
             <div>
                <input 
                    type="file" 
                    accept=".csv" 
                    onChange={handleFileUpload} 
                    style={{ display: 'none' }} 
                    id="csv-upload"
                    disabled={importing}
                />
                <label htmlFor="csv-upload" style={{ ...btnStyle, display: 'inline-block' }}>
                    {importing ? 'Importing...' : 'Bulk Import CSV'}
                </label>
             </div>
          </div>
      </div>
      
      {showAddForm && (
          <div className="card" style={{ borderLeft: '4px solid var(--primary-color)' }}>
              <h3>Add New Game</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
                  <div>
                      <label className="label" style={labelStyle}>Game Name *</label>
                      <input type="text" value={newGame.name} onChange={e => setNewGame({...newGame, name: e.target.value})} style={inputStyle} />
                  </div>
                  <div>
                      <label className="label" style={labelStyle}>Tournament Types (Tags)</label>
                      <input type="text" placeholder="e.g. DG, WG-VR" value={newGame.tournament_types} onChange={e => setNewGame({...newGame, tournament_types: e.target.value})} style={inputStyle} />
                  </div>
                  <div>
                      <label className="label" style={labelStyle}>iScored Style ID</label>
                      <input type="text" value={newGame.style_id} onChange={e => setNewGame({...newGame, style_id: e.target.value})} style={inputStyle} />
                  </div>
                  <div>
                      <label className="label" style={labelStyle}>Aliases</label>
                      <input type="text" value={newGame.aliases} onChange={e => setNewGame({...newGame, aliases: e.target.value})} style={inputStyle} />
                  </div>
              </div>
              <details style={{ marginBottom: '1rem', cursor: 'pointer', color: 'var(--text-muted)' }}>
                  <summary>Advanced CSS Styling (Optional)</summary>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
                      <div><label style={labelStyle}>CSS Title</label><input type="text" value={newGame.css_title} onChange={e => setNewGame({...newGame, css_title: e.target.value})} style={inputStyle} /></div>
                      <div><label style={labelStyle}>CSS Initials</label><input type="text" value={newGame.css_initials} onChange={e => setNewGame({...newGame, css_initials: e.target.value})} style={inputStyle} /></div>
                      <div><label style={labelStyle}>CSS Scores</label><input type="text" value={newGame.css_scores} onChange={e => setNewGame({...newGame, css_scores: e.target.value})} style={inputStyle} /></div>
                      <div><label style={labelStyle}>CSS Box</label><input type="text" value={newGame.css_box} onChange={e => setNewGame({...newGame, css_box: e.target.value})} style={inputStyle} /></div>
                      <div><label style={labelStyle}>Background Color</label><input type="text" value={newGame.bg_color} onChange={e => setNewGame({...newGame, bg_color: e.target.value})} style={inputStyle} /></div>
                  </div>
              </details>
              <button onClick={handleAddGame} disabled={saving} style={btnStyle}>
                  {saving ? 'Saving...' : 'Save Game'}
              </button>
          </div>
      )}

      <div className="card">
        <p style={{ marginTop: 0 }}>This is the master list of all games available to be played. When a game is picked for a tournament, the system will look here for its styling configuration and tournament eligibility.</p>
        
        <table className="data-table">
            <thead>
                <tr>
                    <th>Game Name</th>
                    <th>Eligible Tournaments (Tags)</th>
                    <th>Style ID</th>
                    <th>Aliases</th>
                </tr>
            </thead>
            <tbody>
                {games.map((g, i) => (
                    <tr key={i}>
                        <td><strong>{g.name}</strong></td>
                        <td>
                            {g.tournament_types ? g.tournament_types.split(',').map(tag => (
                                <span key={tag} style={{ background: '#e2e8f0', padding: '0.2rem 0.4rem', borderRadius: '4px', fontSize: '0.75rem', marginRight: '0.25rem' }}>{tag.trim()}</span>
                            )) : <span style={{ color: 'var(--text-muted)' }}>Any</span>}
                        </td>
                        <td>{g.style_id || '-'}</td>
                        <td>{g.aliases || '-'}</td>
                    </tr>
                ))}
                {games.length === 0 && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>No games in the library.</td></tr>
                )}
            </tbody>
        </table>
      </div>
    </div>
  );
}

const btnStyle = { background: 'var(--primary-color)', color: 'white', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 };
const inputStyle = { width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color)', boxSizing: 'border-box' as const };
const labelStyle = { display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' };
