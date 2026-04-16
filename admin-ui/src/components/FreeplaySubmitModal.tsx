import { useEffect, useRef, useState } from 'react';
import { Camera, Trash2, X } from 'lucide-react';
import NeonButton from './NeonButton';

export interface CatalogueGame {
  id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  type: string;
  local_image_path: string | null;
  wheel_image_path: string | null;
  image_url: string | null;
  platforms: string;
}

interface FreeplaySubmitModalProps {
  game: CatalogueGame;
  roomId: string;
  playerToken: string;
  discordUsername?: string;
  onClose: () => void;
  onSubmitted: () => void;
}

export default function FreeplaySubmitModal({
  game,
  roomId,
  playerToken,
  discordUsername,
  onClose,
  onSubmitted,
}: FreeplaySubmitModalProps) {
  const [username, setUsername] = useState(discordUsername || localStorage.getItem('arcaid-player-name') || '');
  const [score, setScore] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [excludeFromGlobal, setExcludeFromGlobal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [leaders, setLeaders] = useState<Array<{ iscored_username: string; best_score: number }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    return () => { if (photoPreview) URL.revokeObjectURL(photoPreview); };
  }, [photoPreview]);

  useEffect(() => {
    fetch(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(game.name)}/leaders?limit=5`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setLeaders(data))
      .catch(() => {});
  }, [roomId, game.name]);

  const displayName = game.display_name || game.name;

  const handleSubmit = async () => {
    const trimmedName = username.trim();
    const scoreNum = parseInt(score.replace(/[^0-9]/g, ''), 10);
    if (!trimmedName) { setMessage({ text: 'Enter your name.', type: 'error' }); return; }
    if (!Number.isFinite(scoreNum) || scoreNum <= 0) { setMessage({ text: 'Enter a valid score.', type: 'error' }); return; }
    if (!photoFile) { setMessage({ text: 'A photo is required for freeplay submissions.', type: 'error' }); return; }

    setSubmitting(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('globalGameId', game.id);
      formData.append('username', trimmedName);
      formData.append('score', String(scoreNum));
      formData.append('photo', photoFile);
      if (excludeFromGlobal) formData.append('excludeGlobal', 'true');

      const res = await fetch(`/api/rooms/${roomId}/freeplay-score`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Submission failed' }));
        throw new Error(err.error || 'Submission failed');
      }
      localStorage.setItem('arcaid-player-name', trimmedName);
      setMessage({ text: 'Score submitted!', type: 'success' });
      setTimeout(() => onSubmitted(), 900);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Submission failed', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onMouseUp={e => { if (backdropMouseDown.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-lg border border-border bg-surface p-6">
        <button onClick={onClose} className="absolute top-3 right-3 text-muted hover:text-primary" aria-label="Close">
          <X className="w-5 h-5" />
        </button>

        <h2 className="font-display text-xl font-bold mb-1 pr-8">Submit Freeplay Score</h2>
        <div className="text-sm text-muted mb-4">
          {displayName}
          {game.manufacturer ? ` · ${game.manufacturer}` : ''}
          {game.year ? ` · ${game.year}` : ''}
        </div>

        {leaders.length > 0 && (
          <div className="bg-raised/50 border border-border/30 rounded-lg px-3 py-2 mb-4">
            <span className="text-[10px] uppercase text-faint block mb-1">Current Leaders</span>
            {leaders.map((l, i) => (
              <div key={l.iscored_username} className="flex justify-between text-xs py-0.5">
                <span className="text-muted">
                  <span className={i === 0 ? 'text-neon-cyan' : 'text-faint'}>#{i + 1}</span>{' '}
                  {l.iscored_username}
                </span>
                <span className="text-primary font-mono">{l.best_score.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">Player name</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              maxLength={100}
              placeholder="Your name"
              className="w-full px-3 py-2 rounded border border-border bg-deep text-primary focus:outline-none focus:border-neon-cyan"
            />
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Score</label>
            <input
              type="text"
              inputMode="numeric"
              value={score}
              onChange={e => setScore(e.target.value)}
              placeholder="1,000,000"
              className="w-full px-3 py-2 rounded border border-border bg-deep text-primary font-mono focus:outline-none focus:border-neon-cyan"
            />
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Photo proof <span className="text-neon-amber">(required)</span></label>
            {photoPreview ? (
              <div className="relative rounded border border-border overflow-hidden">
                <img src={photoPreview} alt="Score proof" className="w-full h-48 object-cover" />
                <button
                  onClick={() => { if (photoPreview) URL.revokeObjectURL(photoPreview); setPhotoFile(null); setPhotoPreview(null); }}
                  className="absolute top-2 right-2 p-1.5 rounded bg-black/70 text-white hover:bg-black"
                  aria-label="Remove photo"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-8 rounded border border-dashed border-border text-muted hover:border-neon-cyan hover:text-neon-cyan cursor-pointer"
              >
                <Camera className="w-5 h-5" />
                Upload or take photo
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (photoPreview) URL.revokeObjectURL(photoPreview);
                setPhotoFile(file);
                setPhotoPreview(URL.createObjectURL(file));
              }}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={excludeFromGlobal}
              onChange={e => setExcludeFromGlobal(e.target.checked)}
              className="rounded border-border"
            />
            Don't post this score to the global ArcAid scoreboard
          </label>

          {message && (
            <div className={`text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
              {message.text}
            </div>
          )}

          <NeonButton onClick={handleSubmit} disabled={submitting} className="w-full">
            {submitting ? 'Submitting...' : 'Submit Score'}
          </NeonButton>
        </div>
      </div>
    </div>
  );
}
