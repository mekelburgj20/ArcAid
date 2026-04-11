import { useState, useRef, useEffect } from 'react';
import { X, Camera, Trash2 } from 'lucide-react';
import NeonButton from './NeonButton';

interface Game {
  global_game_id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
}

interface Props {
  game: Game;
  playerToken: string;
  onClose: () => void;
  onSubmitted: () => void;
}

/**
 * Direct global score submission modal. Requires Discord login (playerToken is
 * expected to be present by the caller). Posts to /api/global/scores with a
 * multipart photo, score, and optional exclude-from-global flag.
 */
export default function GlobalScoreSubmitModal({ game, playerToken, onClose, onSubmitted }: Props) {
  const [score, setScore] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [excludeFromGlobal, setExcludeFromGlobal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const displayName = game.display_name || game.name;

  const handleFilePick = (file: File | null) => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    if (!file) {
      setPhotoFile(null);
      setPhotoPreview(null);
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleSubmit = async () => {
    setMessage(null);
    const scoreNum = parseInt(score.replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(scoreNum) || scoreNum <= 0) {
      setMessage({ text: 'Enter a valid score.', type: 'error' });
      return;
    }
    if (!photoFile) {
      setMessage({ text: 'A photo is required.', type: 'error' });
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('globalGameId', game.global_game_id);
      formData.append('score', String(scoreNum));
      formData.append('excludeFromGlobal', excludeFromGlobal ? 'true' : 'false');
      formData.append('photo', photoFile);

      const res = await fetch('/api/global/scores', {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Submission failed' }));
        throw new Error(err.error || 'Submission failed');
      }

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
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-muted hover:text-primary"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="font-display text-xl font-bold mb-1 pr-8">Submit Score</h2>
        <div className="text-sm text-muted mb-4">
          {displayName}
          {game.manufacturer ? ` · ${game.manufacturer}` : ''}
          {game.year ? ` · ${game.year}` : ''}
        </div>

        <div className="space-y-4">
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
            <label className="block text-xs text-muted mb-1">Photo proof (required)</label>
            {photoPreview ? (
              <div className="relative rounded border border-border overflow-hidden">
                <img src={photoPreview} alt="Score proof" className="w-full h-48 object-cover" />
                <button
                  onClick={() => handleFilePick(null)}
                  className="absolute top-2 right-2 p-1.5 rounded bg-black/70 text-white hover:bg-black"
                  aria-label="Remove photo"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-8 rounded border border-dashed border-border text-muted hover:border-neon-cyan hover:text-neon-cyan"
              >
                <Camera className="w-5 h-5" />
                Upload or take photo
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={e => handleFilePick(e.target.files?.[0] || null)}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={excludeFromGlobal}
              onChange={e => setExcludeFromGlobal(e.target.checked)}
              className="rounded border-border"
            />
            Don't post this score to the global scoreboard
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
