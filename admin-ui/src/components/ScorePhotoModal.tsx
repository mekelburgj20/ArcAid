import { X } from 'lucide-react';

interface ScorePhotoModalProps {
  playerName: string;
  score: number;
  photoUrl: string | null;
  onClose: () => void;
}

export default function ScorePhotoModal({ playerName, score, photoUrl, onClose }: ScorePhotoModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={onClose}>
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
              alt={`Score photo by ${playerName}`}
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
