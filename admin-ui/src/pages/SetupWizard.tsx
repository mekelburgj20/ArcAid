import { useState } from 'react';
import { api, setToken } from '../lib/api';
import NeonButton from '../components/NeonButton';

const inputClass = "w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors mb-3";

function toSlug(name: string): string {
  return name.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
}

export default function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [gameRoomName, setGameRoomName] = useState('');
  const [gameRoomSlug, setGameRoomSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [config, setConfig] = useState({
    DISCORD_BOT_TOKEN: '',
    DISCORD_CLIENT_ID: '',
    DISCORD_GUILD_ID: '',
    ISCORED_USERNAME: '',
    ISCORED_PASSWORD: '',
  });
  const [saving, setSaving] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfig({ ...config, [e.target.name]: e.target.value });
  };

  const handleNameChange = (value: string) => {
    setGameRoomName(value);
    if (!slugEdited) {
      setGameRoomSlug(toSlug(value));
    }
  };

  const handleSetPassword = async () => {
    setPasswordError('');
    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }
    try {
      const result = await api.post<{ token: string }>('/auth/login', { password });
      setToken(result.token);
      setStep(2);
    } catch {
      setPasswordError('Failed to set password. Please try again.');
    }
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      await api.post('/settings', {
        ...config,
        GAME_ROOM_NAME: gameRoomName.trim(),
        GAME_ROOM_SLUG: gameRoomSlug.trim() || toSlug(gameRoomName),
        SETUP_COMPLETE: 'true',
      });
      onComplete();
    } catch {
      alert('Failed to save configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const totalSteps = 4;

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-md">
        <h1 className="font-pixel text-neon-cyan text-center text-sm mb-1">ARCAID</h1>
        <p className="text-muted text-center text-sm mb-6">Setup Wizard</p>
        <div className="flex justify-center gap-2 mb-6">
          {Array.from({ length: totalSteps }, (_, i) => i + 1).map(s => (
            <div key={s} className={`w-12 h-1 rounded ${s <= step ? 'bg-neon-cyan' : 'bg-border'}`} />
          ))}
        </div>

        {step === 1 && (
          <div>
            <h3 className="font-display text-lg font-bold mb-3">Admin Password</h3>
            <p className="text-muted text-sm mb-4">Set a password to protect the admin console.</p>
            <input
              type="password" placeholder="Password (min 8 characters)" value={password}
              onChange={e => setPassword(e.target.value)} className={inputClass}
            />
            <input
              type="password" placeholder="Confirm password" value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)} className={inputClass}
            />
            {passwordError && <p className="text-neon-magenta text-sm mb-3">{passwordError}</p>}
            <NeonButton onClick={handleSetPassword} disabled={!password} className="w-full">
              Next: Game Room
            </NeonButton>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 className="font-display text-lg font-bold mb-3">Game Room</h3>
            <p className="text-muted text-sm mb-4">
              Name your game room. This appears on the public player portal and generates the URL path.
            </p>
            <input
              type="text"
              placeholder="Game Room Name (e.g. RTX Pinball)"
              value={gameRoomName}
              onChange={e => handleNameChange(e.target.value)}
              className={inputClass}
            />
            <div className="mb-3">
              <label className="text-faint text-xs block mb-1">URL Slug (auto-generated)</label>
              <input
                type="text"
                value={gameRoomSlug}
                onChange={e => { setGameRoomSlug(e.target.value); setSlugEdited(true); }}
                placeholder="RTX_Pinball"
                className={inputClass}
              />
              {gameRoomSlug && (
                <p className="text-faint text-xs">
                  Portal URL: <span className="text-neon-cyan">/{gameRoomSlug}</span>
                </p>
              )}
            </div>
            <div className="flex gap-3">
              <NeonButton variant="ghost" onClick={() => setStep(1)}>Back</NeonButton>
              <NeonButton onClick={() => setStep(3)} className="flex-1" disabled={!gameRoomName.trim()}>
                Next: Discord
              </NeonButton>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="font-display text-lg font-bold mb-3">Discord Credentials</h3>
            <p className="text-muted text-sm mb-4">These are already configured in your .env file — only fill in if you want to override.</p>
            <input type="password" name="DISCORD_BOT_TOKEN" placeholder="Bot Token (optional override)" value={config.DISCORD_BOT_TOKEN} onChange={handleChange} className={inputClass} />
            <input type="text" name="DISCORD_CLIENT_ID" placeholder="Client ID (optional override)" value={config.DISCORD_CLIENT_ID} onChange={handleChange} className={inputClass} />
            <input type="text" name="DISCORD_GUILD_ID" placeholder="Guild ID (optional override)" value={config.DISCORD_GUILD_ID} onChange={handleChange} className={inputClass} />
            <div className="flex gap-3">
              <NeonButton variant="ghost" onClick={() => setStep(2)}>Back</NeonButton>
              <NeonButton onClick={() => setStep(4)} className="flex-1">Next: iScored</NeonButton>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h3 className="font-display text-lg font-bold mb-3">iScored Account</h3>
            <p className="text-muted text-sm mb-4">Credentials for iScored.info automation (optional — can be added later in Settings).</p>
            <input type="text" name="ISCORED_USERNAME" placeholder="iScored Username" value={config.ISCORED_USERNAME} onChange={handleChange} className={inputClass} />
            <input type="password" name="ISCORED_PASSWORD" placeholder="iScored Password" value={config.ISCORED_PASSWORD} onChange={handleChange} className={inputClass} />
            <div className="flex gap-3">
              <NeonButton variant="ghost" onClick={() => setStep(3)} disabled={saving}>Back</NeonButton>
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
