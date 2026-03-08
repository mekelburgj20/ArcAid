import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { api } from '../lib/api';

interface CadenceConfig {
    cron: string;
    autoRotate: boolean;
    autoLock: boolean;
}

interface Tournament {
    id: string;
    name: string;
    type: string;
    cadence: string; // JSON string from DB
    guild_id?: string;
    discord_channel_id?: string;
    discord_role_id?: string;
    is_active: number;
}

export default function Tournaments() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);

  // New Tournament State
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('daily');
  const [newCron, setNewCron] = useState('0 0 * * *');
  const [newChannel, setNewChannel] = useState('');

  const fetchTournaments = async () => {
    try {
      const data = await api.get<Tournament[]>('/tournaments');
      setTournaments(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTournaments();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;

    const cadence: CadenceConfig = {
        cron: newCron,
        autoRotate: true,
        autoLock: true
    };

    const newTourney = {
        id: uuidv4(),
        name: newName,
        type: newType,
        cadence: cadence,
        guild_id: '', // Would normally come from context/settings
        discord_channel_id: newChannel,
        discord_role_id: '',
        is_active: true
    };

    try {
      await api.post('/tournaments', newTourney);
      setNewName('');
      fetchTournaments();
    } catch (err) {
      console.error(err);
      alert('Failed to create tournament');
    }
  };

  const handleDelete = async (id: string) => {
      if (!confirm('Are you sure you want to delete this tournament?')) return;
      try {
          await api.delete(`/tournaments/${id}`);
          fetchTournaments();
      } catch (err) {
          console.error(err);
      }
  }

  if (loading) return <div className="page">Loading tournaments...</div>;

  return (
    <div className="page">
      <h1>Tournament Configurations</h1>
      
      <div className="card">
        <h3>Create New Tournament</h3>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div style={{ flex: 1, minWidth: '200px' }}>
                <label className="label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Tournament Name</label>
                <input type="text" placeholder="e.g. The Daily Grind" value={newName} onChange={e => setNewName(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ flex: 1, minWidth: '150px' }}>
                 <label className="label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Type / Tag</label>
                 <input type="text" placeholder="e.g. DG" value={newType} onChange={e => setNewType(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ flex: 1, minWidth: '200px' }}>
                 <label className="label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Cron Schedule</label>
                 <input type="text" placeholder="0 0 * * *" value={newCron} onChange={e => setNewCron(e.target.value)} style={inputStyle} />
            </div>
             <div style={{ flex: 1, minWidth: '200px' }}>
                 <label className="label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Discord Channel ID</label>
                 <input type="text" placeholder="Optional" value={newChannel} onChange={e => setNewChannel(e.target.value)} style={inputStyle} />
            </div>
        </div>
        <button onClick={handleCreate} style={btnStyle}>Create Tournament</button>
      </div>

      <div className="card">
        <h3>Active Tournaments</h3>
        <table className="data-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Type/Tag</th>
                    <th>Schedule</th>
                    <th>Channel ID</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                {tournaments.map(t => {
                    let cadenceObj: any = {};
                    try { cadenceObj = JSON.parse(t.cadence); } catch (e) {}
                    
                    return (
                        <tr key={t.id}>
                            <td><strong>{t.name}</strong></td>
                            <td><span style={{ background: '#e2e8f0', padding: '0.25rem 0.5rem', borderRadius: '4px', fontSize: '0.875rem' }}>{t.type}</span></td>
                            <td><code>{cadenceObj.cron || 'None'}</code></td>
                            <td>{t.discord_channel_id || 'Not set'}</td>
                            <td>
                                <button onClick={() => handleDelete(t.id)} style={{ ...btnStyle, background: '#ef4444', padding: '0.5rem' }}>Delete</button>
                            </td>
                        </tr>
                    );
                })}
                {tournaments.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-muted)' }}>No tournaments configured yet.</td></tr>
                )}
            </tbody>
        </table>
      </div>
    </div>
  );
}

const inputStyle = { width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color)', boxSizing: 'border-box' as const };
const btnStyle = { background: 'var(--primary-color)', color: 'white', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 };
