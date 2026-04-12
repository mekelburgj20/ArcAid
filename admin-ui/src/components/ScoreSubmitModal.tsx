import { useState, useRef, useEffect } from 'react';
import { X, Camera, Trash2, Keyboard } from 'lucide-react';
import NeonButton from './NeonButton';
import OnScreenKeyboard from './OnScreenKeyboard';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

interface ScoreSubmitModalProps {
  gameName: string;
  roomId: string;
  gameStatus?: string;
  requirePhoto: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}

export default function ScoreSubmitModal({ gameName, roomId, gameStatus, requirePhoto, onClose, onSubmitted }: ScoreSubmitModalProps) {
  const { discordUser } = useViewerAuth();
  const [username, setUsername] = useState(
    discordUser?.username || localStorage.getItem('arcaid-player-name') || ''
  );
  const [score, setScore] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [excludeFromGlobal, setExcludeFromGlobal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [activeField, setActiveField] = useState<'username' | 'score' | null>(null);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const scoreRef = useRef<HTMLInputElement>(null);
  const backdropMouseDown = useRef(false);

  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const clearPhoto = () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    const trimmedName = username.trim();
    const scoreNum = parseInt(score, 10);
    if (!trimmedName || isNaN(scoreNum) || scoreNum < 0) return;
    if (requirePhoto && !photoFile) return;

    setSubmitting(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('username', trimmedName);
      formData.append('score', String(scoreNum));
      if (excludeFromGlobal) formData.append('excludeGlobal', 'true');
      if (photoFile) formData.append('photo', photoFile);

      const headers: Record<string, string> = {};
      const userId = localStorage.getItem('arcaid_anon_id');
      if (userId) headers['x-user-id'] = userId;

      const res = await fetch(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`, {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Submission failed' }));
        throw new Error(data.error || 'Submission failed');
      }

      localStorage.setItem('arcaid-player-name', trimmedName);
      setMessage({ text: 'Score submitted!', type: 'success' });
      setTimeout(() => {
        onSubmitted();
        onClose();
      }, 1500);
    } catch (err: any) {
      setMessage({ text: err.message || 'Submission failed', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyPress = (key: string) => {
    if (activeField === 'username') {
      setUsername(prev => prev + key);
      usernameRef.current?.focus();
    } else if (activeField === 'score') {
      if (/\d/.test(key)) setScore(prev => prev + key);
      scoreRef.current?.focus();
    }
  };

  const handleBackspace = () => {
    if (activeField === 'username') setUsername(prev => prev.slice(0, -1));
    else if (activeField === 'score') setScore(prev => prev.slice(0, -1));
  };

  const handleDone = () => {
    setActiveField(null);
    setShowKeyboard(false);
  };

  const canSubmit = username.trim() && score && !isNaN(parseInt(score, 10)) && parseInt(score, 10) >= 0
    && (!requirePhoto || !!photoFile) && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-deep/80 backdrop-blur-sm" onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }} onClick={e => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}>
      <div
        className="bg-surface border border-border rounded-t-xl sm:rounded-lg shadow-2xl w-full sm:max-w-md overflow-hidden flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <h3 className="font-display font-bold text-primary truncate">{gameName}</h3>
          <button onClick={onClose} className="text-muted hover:text-primary transition-colors cursor-pointer">
            <X size={20} />
          </button>
        </div>

        {/* Locked state */}
        {gameStatus && gameStatus !== 'ACTIVE' ? (
          <div className="px-4 py-8 text-center">
            <div className="text-3xl mb-3">&#128274;</div>
            <p className="text-yellow-400 text-sm font-display">This game is locked. Scores can no longer be submitted.</p>
          </div>
        ) : <>
        {/* Form */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* Username */}
          <div>
            <label className="text-xs text-faint block mb-1">Player Name</label>
            <div className="flex gap-1">
              <input
                ref={usernameRef}
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                onFocus={() => { setActiveField('username'); if (isTouchDevice) setShowKeyboard(true); }}
                placeholder="Your name"
                className="flex-1 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                maxLength={100}
              />
              {!isTouchDevice && (
                <button
                  type="button"
                  onClick={() => { setActiveField('username'); setShowKeyboard(!showKeyboard); }}
                  className="px-2 text-muted hover:text-neon-cyan transition-colors cursor-pointer"
                  title="Toggle on-screen keyboard"
                >
                  <Keyboard size={18} />
                </button>
              )}
            </div>
          </div>

          {/* Score */}
          <div>
            <label className="text-xs text-faint block mb-1">Score</label>
            <div className="flex gap-1">
              <input
                ref={scoreRef}
                type="number"
                inputMode="numeric"
                value={score}
                onChange={e => setScore(e.target.value)}
                onFocus={() => { setActiveField('score'); if (isTouchDevice) setShowKeyboard(true); }}
                placeholder="0"
                min="0"
                className="flex-1 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
              />
              {!isTouchDevice && (
                <button
                  type="button"
                  onClick={() => { setActiveField('score'); setShowKeyboard(!showKeyboard); }}
                  className="px-2 text-muted hover:text-neon-cyan transition-colors cursor-pointer"
                  title="Toggle on-screen keyboard"
                >
                  <Keyboard size={18} />
                </button>
              )}
            </div>
          </div>

          {/* Photo */}
          <div>
            <label className="text-xs text-faint block mb-1">
              Photo {requirePhoto ? <span className="text-neon-amber">(required)</span> : '(optional)'}
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoChange}
              className="hidden"
            />
            {photoPreview ? (
              <div className="relative inline-block">
                <img src={photoPreview} alt="Score photo" className="w-full max-h-48 object-contain rounded-lg border border-border" />
                <button
                  type="button"
                  onClick={clearPhoto}
                  className="absolute top-1 right-1 bg-deep/80 rounded-full p-1 text-muted hover:text-neon-amber transition-colors cursor-pointer"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 px-4 py-6 border-2 border-dashed border-border rounded-lg text-muted hover:text-neon-cyan hover:border-neon-cyan/30 transition-colors cursor-pointer"
              >
                <Camera size={20} />
                <span className="text-sm">Take or choose photo</span>
              </button>
            )}
            {requirePhoto && !photoFile && (
              <p className="text-xs text-neon-amber mt-1">A photo is required to submit your score.</p>
            )}
          </div>

          {/* Global opt-out */}
          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={excludeFromGlobal}
              onChange={e => setExcludeFromGlobal(e.target.checked)}
              className="rounded border-border"
            />
            Don't post this score to the global ArcAid scoreboard
          </label>

          {/* Message */}
          {message && (
            <p className={`text-sm text-center ${message.type === 'success' ? 'text-neon-green' : 'text-neon-amber'}`}>
              {message.text}
            </p>
          )}

          {/* Submit */}
          <NeonButton onClick={handleSubmit} disabled={!canSubmit} className="w-full">
            {submitting ? 'Submitting...' : 'Submit Score'}
          </NeonButton>
        </div>

        {/* On-screen keyboard */}
        {showKeyboard && activeField && (
          <OnScreenKeyboard
            mode={activeField === 'score' ? 'numeric' : 'alpha'}
            onKeyPress={handleKeyPress}
            onBackspace={handleBackspace}
            onDone={handleDone}
          />
        )}
        </>}
      </div>
    </div>
  );
}
