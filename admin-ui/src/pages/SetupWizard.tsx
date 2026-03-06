import { useState } from 'react';

export default function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [config, setConfig] = useState({
    TERMINOLOGY_MODE: 'generic',
    DISCORD_BOT_TOKEN: '',
    DISCORD_CLIENT_ID: '',
    DISCORD_GUILD_ID: '',
    ISCORED_USERNAME: '',
    ISCORED_PASSWORD: '',
  });
  const [saving, setSaving] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setConfig({ ...config, [e.target.name]: e.target.value });
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      await fetch('http://localhost:3001/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, SETUP_COMPLETE: 'true' }),
      });
      onComplete();
    } catch (err) {
      console.error(err);
      alert('Failed to save configuration.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: 'var(--bg-color)' }}>
      <div className="card" style={{ width: '500px', padding: '2rem' }}>
        <h2 style={{ marginTop: 0, color: 'var(--primary-color)' }}>ArcAid Setup Wizard</h2>
        <div style={{ marginBottom: '1.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
          Step {step} of 3
        </div>

        {step === 1 && (
          <div>
            <h3>1. Terminology</h3>
            <p className="small">Choose the naming convention for your server.</p>
            <select 
              name="TERMINOLOGY_MODE" 
              value={config.TERMINOLOGY_MODE} 
              onChange={handleChange}
              style={{ width: '100%', padding: '0.75rem', borderRadius: '4px', border: '1px solid var(--border-color)', marginBottom: '1rem' }}
            >
              <option value="generic">Generic (Games & Tournaments)</option>
              <option value="legacy">Pinball Legacy (Tables & Grinds)</option>
            </select>
            <button onClick={() => setStep(2)} style={btnStyle}>Next: Discord Setup</button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3>2. Discord Credentials</h3>
            <input type="password" name="DISCORD_BOT_TOKEN" placeholder="Bot Token" value={config.DISCORD_BOT_TOKEN} onChange={handleChange} style={inputStyle} />
            <input type="text" name="DISCORD_CLIENT_ID" placeholder="Client ID (Application ID)" value={config.DISCORD_CLIENT_ID} onChange={handleChange} style={inputStyle} />
            <input type="text" name="DISCORD_GUILD_ID" placeholder="Guild ID (Server ID)" value={config.DISCORD_GUILD_ID} onChange={handleChange} style={inputStyle} />
            
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button onClick={() => setStep(1)} style={{ ...btnStyle, background: 'var(--text-muted)' }}>Back</button>
              <button onClick={() => setStep(3)} style={{ ...btnStyle, flex: 1 }}>Next: iScored Setup</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3>3. iScored Account</h3>
            <input type="text" name="ISCORED_USERNAME" placeholder="iScored Username" value={config.ISCORED_USERNAME} onChange={handleChange} style={inputStyle} />
            <input type="password" name="ISCORED_PASSWORD" placeholder="iScored Password" value={config.ISCORED_PASSWORD} onChange={handleChange} style={inputStyle} />
            
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button onClick={() => setStep(2)} style={{ ...btnStyle, background: 'var(--text-muted)' }} disabled={saving}>Back</button>
              <button onClick={handleFinish} disabled={saving} style={{ ...btnStyle, flex: 1 }}>
                {saving ? 'Saving...' : 'Finish Setup'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = { width: '100%', padding: '0.75rem', borderRadius: '4px', border: '1px solid var(--border-color)', marginBottom: '1rem', boxSizing: 'border-box' as const };
const btnStyle = { background: 'var(--primary-color)', color: 'white', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 };
