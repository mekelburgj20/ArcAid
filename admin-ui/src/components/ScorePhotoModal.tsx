import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ScorePhotoModalProps {
  playerName: string;
  score: number;
  photoUrl: string | null;
  onClose: () => void;
}

/**
 * Full-screen score-photo viewer. Shared by the legacy `GameCard`'s inline
 * per-player history expand (`ScoreboardComponents.tsx`) and, as of v2.109.0
 * (score-gesture-photos), the game quick popup's row-body click
 * (`GameQuickView.tsx`) — one lightbox idiom, not a second one.
 */
export default function ScorePhotoModal({ playerName, score, photoUrl, onClose }: ScorePhotoModalProps) {
  const backdropMouseDown = useRef(false);

  // v2.109.0 — Esc closes, matching every other modal in the app (GameQuickView,
  // ConfirmModal's dialog neighbors).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }} onClick={e => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}>
      <div className="bg-surface border border-border rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <div>
            <p className="font-display font-bold text-primary">{playerName}</p>
            <p className="text-neon-amber text-sm font-medium">{score.toLocaleString()}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-primary transition-colors cursor-pointer">
            <X size={20} />
          </button>
        </div>
        <div className="p-4">
          {photoUrl ? (
            <img
              src={photoUrl}
              alt={`${playerName} — ${score.toLocaleString()} photo evidence`}
              className="w-full rounded-lg object-contain max-h-[70vh]"
            />
          ) : (
            <div className="text-center py-12 text-muted">
              <p>No photo submitted</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
