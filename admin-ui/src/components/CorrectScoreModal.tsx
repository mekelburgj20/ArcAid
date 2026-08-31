import { useState } from 'react';
import { digitsOnly, formatMagnitude, formatScoreInput } from '../lib/scoreInput';

/**
 * Admin score correction dialog (owner incident 2026-08-30 — a mistyped score
 * on a table that had already rotated, with no edit path anywhere in the app).
 *
 * Shared by every surface that offers a correction: the Game Detail board rows
 * and per-player history rows, and the admin Leaderboard's Manage Scores modal.
 * It was local to `GameDetail` in v2.149.0 and lifted here in v2.149.1 when the
 * second call site arrived — one dialog, so the grouped input and the
 * before/after magnitudes cannot end up different in two places.
 *
 * Uses the SAME grouped entry as the submission sheet (`lib/scoreInput`),
 * because a correction dialog that shows bare digits is the exact surface that
 * produced the mistake being corrected. Both the old and the new magnitude are
 * shown so the admin compares two readable phrases rather than two long runs of
 * digits.
 *
 * Knows nothing about how the correction is sent — the caller owns the request
 * and the refresh, because the two pages reconcile different lists afterwards.
 */
export default function CorrectScoreModal({ playerLabel, currentScore, onConfirm, onCancel }: {
  /** Who the score belongs to, already display-name resolved. */
  playerLabel: string;
  currentScore: number;
  onConfirm: (score: number) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(() => formatScoreInput(String(currentScore)));
  const [busy, setBusy] = useState(false);
  const digits = digitsOnly(value);
  const parsed = digits === '' ? null : Number(digits);
  const magnitude = formatMagnitude(digits);
  const oldMagnitude = formatMagnitude(String(currentScore));
  // Number() past 2^53 is already lossy and the server refuses it — say so here
  // rather than letting the PATCH come back with a 400.
  const tooLarge = parsed !== null && !Number.isSafeInteger(parsed);
  const unchanged = parsed !== null && parsed === currentScore;
  const canSave = parsed !== null && !tooLarge && !unchanged && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border/50">
          <h2 className="font-display text-lg font-bold mb-0.5">Correct score</h2>
          <p className="text-xs text-muted">
            {playerLabel} · was {currentScore.toLocaleString()}
            {oldMagnitude ? ` (${oldMagnitude})` : ''}
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          <label htmlFor="correct-score-input" className="text-xs text-faint block">Corrected score</label>
          <input
            id="correct-score-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={e => setValue(formatScoreInput(e.target.value))}
            className="w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors"
          />
          {magnitude && <p className="text-xs text-faint">{magnitude}</p>}
          {tooLarge && <p className="text-xs text-neon-magenta">That number is too large to record exactly.</p>}
          {unchanged && <p className="text-xs text-faint">That is already the recorded score.</p>}
          <p className="text-xs text-muted pt-1">
            Changes the value in place — the score, its photo and its place in the player&apos;s
            history all stay. Nothing is announced.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-border/50 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-muted hover:text-primary transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={async () => {
              if (parsed === null) return;
              setBusy(true);
              try {
                await onConfirm(parsed);
              } finally {
                setBusy(false);
              }
            }}
            className="px-3 py-1.5 text-sm rounded bg-neon-cyan/15 text-neon-cyan border border-neon-cyan/40 hover:bg-neon-cyan/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </div>
    </div>
  );
}
