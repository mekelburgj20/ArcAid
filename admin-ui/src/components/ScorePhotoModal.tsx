import { Dialog } from './parts/Dialog';
import { buttonClasses } from './parts/buttonClasses';
import ShareButton from './ShareButton';

interface ScorePhotoModalProps {
  playerName: string;
  score: number;
  photoUrl: string | null;
  onClose: () => void;
  /**
   * v2.147.0 — app-relative deep link to this exact score
   * (`/:slug/games/:gameName?score=<historyId>`). Optional: omitting it keeps
   * this modal byte-identical to its pre-share behavior (no Share button) for
   * any caller that hasn't threaded a `score_history.id` through yet.
   */
  sharePath?: string;
}

/**
 * Full-screen score-photo viewer. Shared by the legacy `GameCard`'s inline
 * per-player history expand (`ScoreboardComponents.tsx`) and, as of v2.109.0
 * (score-gesture-photos), the game quick popup's row-body click
 * (`GameQuickView.tsx`) — one lightbox idiom, not a second one.
 *
 * G23c (v2.271.0): the Arcaid dialog (`parts/Dialog`), centred on every
 * width: the player is the title, the score the line under it, the photo the
 * body and Share the one action. Escape, a press outside and the × close it;
 * opened over the game quick view it is rendered inside that dialog, so they
 * close the photo only.
 */
export default function ScorePhotoModal({ playerName, score, photoUrl, onClose, sharePath }: ScorePhotoModalProps) {
  const scoreText = score.toLocaleString();
  return (
    <Dialog
      open
      onOpenChange={next => { if (!next) onClose(); }}
      tone="cyan"
      label="Score photo"
      title={playerName}
      description={scoreText}
      size="md"
      footer={sharePath ? (
        <ShareButton
          title={`${playerName} on Arcaid`}
          text={`${playerName} — ${scoreText}`}
          path={sharePath}
          className={buttonClasses('secondary')}
        />
      ) : undefined}
    >
      {photoUrl ? (
        <img
          src={photoUrl}
          alt={`${playerName} — ${scoreText} photo evidence`}
          className="max-h-[70vh] object-contain w-full rounded"
        />
      ) : (
        <p className="text-muted">No photo submitted</p>
      )}
    </Dialog>
  );
}
