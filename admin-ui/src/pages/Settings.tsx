import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  useEffect(() => {
    api.get<Record<string, string>>('/settings')
      .then(data => {
        setSettings(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.post('/settings', settings);
      setMessage({ type: 'success', text: 'Settings saved successfully!' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Error saving settings. Check console.' });
    } finally {
      setSaving(false);
    }
  };

  // Allow adding new keys
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  
  const handleAddSetting = () => {
      if (!newKey.trim()) return;
      setSettings(prev => ({...prev, [newKey.trim().toUpperCase()]: newValue}));
      setNewKey('');
      setNewValue('');
  }

  if (loading) return <div className="page">Loading settings...</div>;

  return (
    <div className="page">
      <h1>Configuration Settings</h1>
      
      {message && (
        <div className={`card ${message.type === 'error' ? 'error-card' : ''}`} style={message.type === 'success' ? { backgroundColor: '#ecfdf5', borderColor: '#10b981' } : {}}>
            <p style={{ margin: 0, color: message.type === 'success' ? '#047857' : 'inherit' }}>{message.text}</p>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <p style={{ margin: 0 }}>Database-backed system configuration.</p>
            <button 
                onClick={handleSave} 
                disabled={saving}
                style={{ background: 'var(--primary-color)', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}
            >
                {saving ? 'Saving...' : 'Save All Changes'}
            </button>
        </div>
        
        <table className="data-table">
        <thead>
            <tr>
            <th>Key</th>
            <th>Value</th>
            </tr>
        </thead>
        <tbody>
            {Object.entries(settings).map(([key, value]) => (
            <tr key={key}>
                <td style={{ width: '30%' }}><code>{key}</code></td>
                <td>
                    <input 
                        type="text" 
                        value={value} 
                        onChange={(e) => handleChange(key, e.target.value)}
                        style={{ width: '100%', padding: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                    />
                </td>
            </tr>
            ))}
            {/* Add new row */}
            <tr>
                <td>
                    <input 
                        type="text" 
                        placeholder="NEW_KEY" 
                        value={newKey} 
                        onChange={(e) => setNewKey(e.target.value)}
                        style={{ width: '100%', padding: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                    />
                </td>
                <td style={{ display: 'flex', gap: '0.5rem' }}>
                     <input 
                        type="text" 
                        placeholder="Value" 
                        value={newValue} 
                        onChange={(e) => setNewValue(e.target.value)}
                        style={{ flex: 1, padding: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                    />
                    <button 
                        onClick={handleAddSetting}
                        style={{ background: '#e2e8f0', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}
                    >
                        Add
                    </button>
                </td>
            </tr>
        </tbody>
        </table>
      </div>
    </div>
  );
}
