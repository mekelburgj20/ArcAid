import { useRef, useState } from 'react';
import { Dialog } from './parts/Dialog';
import Button from './parts/Button';
import { TextInput } from './parts/Field';
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
 *
 * G23c (v2.271.0): the Arcaid dialog (`parts/Dialog`), a bottom sheet on a
 * phone, focus starting in the score field. The player is the title and the
 * old value the line under it; the field is the shared score `TextInput`.
 */
export default function CorrectScoreModal({ playerLabel, currentScore, onConfirm, onCancel }: {
  /** Who the score belongs to, already display-name resolved. */
  playerLabel: string;
  currentScore: number;
  onConfirm: (score: number) => void | Promise<void>;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
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

  const save = async () => {
    if (parsed === null) return;
    setBusy(true);
    try {
      await onConfirm(parsed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={next => { if (!next) onCancel(); }}
      tone="cyan"
      label="Correct score"
      title={playerLabel}
      description={`was ${currentScore.toLocaleString()}${oldMagnitude ? ` (${oldMagnitude})` : ''}`}
      sheet
      initialFocusRef={inputRef}
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>
            {busy ? 'Saving…' : 'Save correction'}
          </Button>
        </>
      )}
    >
      <TextInput
        ref={inputRef}
        id="correct-score-input"
        label="Corrected score"
        size="score"
        inputMode="numeric"
        value={value}
        onChange={e => setValue(formatScoreInput(e.target.value))}
        hint={magnitude || undefined}
        error={tooLarge ? 'That number is too large to record exactly.' : undefined}
      />
      {unchanged && <p className="text-xs text-muted mt-2">That is already the recorded score.</p>}
      <p className="text-xs text-muted mt-3">
        Changes the value in place — the score, its photo and its place in the player&apos;s
        history all stay. Nothing is announced.
      </p>
    </Dialog>
  );
}
