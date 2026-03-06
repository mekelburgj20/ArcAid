import { useEffect, useState } from 'react';
import Papa from 'papaparse';

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

  const fetchGames = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/game_library');
      const data = await res.json();
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
                const res = await fetch('http://localhost:3001/api/game_library/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ games: parsedGames }),
                });
                
                if (res.ok) {
                    alert(`Successfully imported ${parsedGames.length} games!`);
                    fetchGames();
                } else {
                    alert('Failed to import games. Check console.');
                }
              } catch (err) {
                  console.error(err);
                  alert('Network error during import.');
              } finally {
                  setImporting(false);
                  // clear input
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

  if (loading) return <div className="page">Loading library...</div>;

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1>Game Library Master List</h1>
          <div style={{ display: 'flex', gap: '1rem' }}>
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
                    {importing ? 'Importing...' : 'Import from CSV'}
                </label>
             </div>
          </div>
      </div>
      
      <div className="card">
        <p style={{ marginTop: 0 }}>This is the master list of all games available to be played. When a game is picked for a tournament, the system will look here for its styling configuration and tournament eligibility (e.g. ensuring a VR game is only picked for the VR tournament type).</p>
        
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
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>No games in the library. Download the template and import your games!</td></tr>
                )}
            </tbody>
        </table>
      </div>
    </div>
  );
}

const btnStyle = { background: 'var(--primary-color)', color: 'white', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 };
