import { useState } from 'react';
import { api } from '../lib/api';
import NeonButton from '../components/NeonButton';

const inputClass = "w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors mb-3";

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
      await api.post('/settings', { ...config, SETUP_COMPLETE: 'true' });
      onComplete();
    } catch {
      alert('Failed to save configuration.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-md">
        <h1 className="font-pixel text-neon-cyan text-center text-sm mb-1">ARCAID</h1>
        <p className="text-muted text-center text-sm mb-6">Setup Wizard</p>
        <div className="flex justify-center gap-2 mb-6">
          {[1, 2, 3].map(s => (
            <div key={s} className={`w-16 h-1 rounded ${s <= step ? 'bg-neon-cyan' : 'bg-border'}`} />
          ))}
        </div>

        {step === 1 && (
          <div>
            <h3 className="font-display text-lg font-bold mb-3">Terminology</h3>
            <p className="text-muted text-sm mb-4">Choose the naming convention for your server.</p>
            <select
              name="TERMINOLOGY_MODE"
              value={config.TERMINOLOGY_MODE}
              onChange={handleChange}
              className={inputClass}
            >
              <option value="generic">Generic (Games & Tournaments)</option>
              <option value="legacy">Pinball Legacy (Tables & Grinds)</option>
            </select>
            <NeonButton onClick={() => setStep(2)} className="w-full">Next: Discord Setup</NeonButton>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 className="font-display text-lg font-bold mb-3">Discord Credentials</h3>
            <input type="password" name="DISCORD_BOT_TOKEN" placeholder="Bot Token" value={config.DISCORD_BOT_TOKEN} onChange={handleChange} className={inputClass} />
            <input type="text" name="DISCORD_CLIENT_ID" placeholder="Client ID" value={config.DISCORD_CLIENT_ID} onChange={handleChange} className={inputClass} />
            <input type="text" name="DISCORD_GUILD_ID" placeholder="Guild ID" value={config.DISCORD_GUILD_ID} onChange={handleChange} className={inputClass} />
            <div className="flex gap-3">
              <NeonButton variant="ghost" onClick={() => setStep(1)}>Back</NeonButton>
              <NeonButton onClick={() => setStep(3)} className="flex-1">Next: iScored</NeonButton>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="font-display text-lg font-bold mb-3">iScored Account</h3>
            <input type="text" name="ISCORED_USERNAME" placeholder="iScored Username" value={config.ISCORED_USERNAME} onChange={handleChange} className={inputClass} />
            <input type="password" name="ISCORED_PASSWORD" placeholder="iScored Password" value={config.ISCORED_PASSWORD} onChange={handleChange} className={inputClass} />
            <div className="flex gap-3">
              <NeonButton variant="ghost" onClick={() => setStep(2)} disabled={saving}>Back</NeonButton>
              <NeonButton onClick={handleFinish} disabled={saving} className="flex-1">
                {saving ? 'Saving...' : 'Finish Setup'}
              </NeonButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
