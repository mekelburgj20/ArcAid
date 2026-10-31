/**
 * Integrity badge (v2.166.0, ADR 0027; Castcade ADR 0005) — the pure half of
 * the chip a room board draws next to a Castcade-witnessed score.
 *
 * `GET /rooms/:roomId/tournaments/:id/integrity` ships `verdicts`, a map from
 * `score_history.id` to what the Sanctioned rules said about that score's
 * evidence. This turns one row's entry into a chip spec, or nothing.
 *
 * Badge, never gate (ADR 0017/0020/0021): the caller renders the chip beside
 * the row it already has. Nothing here, and nothing that consumes it, may
 * filter a row or change a rank — a flagged score on an Open-play board is
 * still on the board, with a chip that says what was measured.
 */

export type IntegrityVerdictEntry = { verdict: 'pass' | 'flagged'; reasons: string[] };
export type IntegrityVerdictMap = Record<string, IntegrityVerdictEntry>;

/**
 * Quit badge (v2.189.0, W49, castcade B16): `GET .../integrity` also ships
 * `quits`, a SEPARATE map from `score_history.id` to `{ ball }` for the games
 * the player quit before game over. Separate from the verdicts because a
 * verdict is withheld for a cabinet or a desktop that sent no evidence, while
 * the quit fact is still known. Neutral and informational: a quit game still
 * counts, and in Limited attempts it still used its attempt.
 */
export type QuitMap = Record<string, { ball: number | null }>;

export interface QuitLabelSpec {
  label: string;
  title: string;
}

const QUIT_TITLE =
  'The player quit this game before game over (reported by the Witness: a desktop quit, or a cabinet game abandoned by a hold-Start restart). It still counts and, in Limited attempts, still used its attempt.';

/** `null` when the row has no quit entry — an absence of badge, never a badge of absence. */
export function quitLabelFor(
  quits: QuitMap | null | undefined,
  historyId: number | string | null | undefined,
): QuitLabelSpec | null {
  if (!quits || historyId == null) return null;
  const entry = quits[String(historyId)];
  if (!entry) return null;
  const ball = typeof entry.ball === 'number' && Number.isInteger(entry.ball) && entry.ball >= 1 ? entry.ball : null;
  return { label: ball != null ? `Quit on ball ${ball}` : 'Quit', title: QUIT_TITLE };
}

/**
 * Launcher-signed badge (W72, v2.205.0): `GET .../integrity` also ships
 * `signed`, a map from `score_history.id` to `{ by }` for the scores whose
 * launcher record (the Legends Unchained ScoreServer's own game record) was
 * forwarded by the Witness, carried a valid signature, and matched the score.
 * ADDITIVE: it sits beside any Sanctioned / Conditions-verified / Flagged chip
 * and never replaces or overrides it, and like every badge it never filters a
 * row or changes a rank.
 */
export type SignedMap = Record<string, { by: string }>;

export interface SignedLabelSpec {
  label: string;
  title: string;
}

const SIGNED_TITLE: Record<string, string> = {
  'lu-scoreserver':
    'Launcher-signed: the Legends Unchained launcher signed its own record of this game, and the record matches this score. It shows the score came from the launcher; it says nothing about the table or its settings.',
};
const SIGNED_TITLE_DEFAULT =
  'Launcher-signed: the record of this game carries a valid signature and matches this score.';

/** `null` when the row has no signed entry - an absence of badge, never a badge of absence. */
export function signedLabelFor(
  signed: SignedMap | null | undefined,
  historyId: number | string | null | undefined,
): SignedLabelSpec | null {
  if (!signed || historyId == null) return null;
  const entry = signed[String(historyId)];
  if (!entry || typeof entry.by !== 'string' || !entry.by) return null;
  return { label: 'Launcher-signed', title: SIGNED_TITLE[entry.by] ?? SIGNED_TITLE_DEFAULT };
}

/**
 * `signature_reason` for a genuine launcher signature over a DIFFERENT game of
 * the same sitting (the launcher signs one record per sitting, for its last
 * game). No badge; the score counts exactly as an unsigned one.
 */
export const SIGNED_RECORD_OTHER_GAME = 'signed_record_other_game';
export const SIGNED_OTHER_GAME_TEXT = 'Signed record covers a different game of this sitting';

/** The same words for a surface that only knows the signer (Where your plays went, the Integrity panel). */
export function signedTitleFor(by: string | null | undefined): string {
  return (by && SIGNED_TITLE[by]) || SIGNED_TITLE_DEFAULT;
}

export interface IntegrityChipSpec {
  tone: 'pass' | 'flagged';
  label: string;
  /** Tooltip — the reasons for a flag, a one-line explanation for a pass. */
  title: string;
}

const PASS_TITLE: Record<'open' | 'sanctioned', string> = {
  sanctioned: 'Sanctioned — Castcade measured the table, physics, machine adjustments and build for this score and every rule of this tournament passed',
  open: 'Conditions verified — Castcade measured the table, physics, machine adjustments and build for this score and the Sanctioned rules would have passed',
};

/**
 * `null` when the row has no verdict (a typed score, a cabinet score, a row
 * from before the companion sent evidence) — an absence of badge, never a
 * badge of absence.
 */
export function integrityChipFor(
  verdicts: IntegrityVerdictMap | null | undefined,
  historyId: number | string | null | undefined,
  mode: 'open' | 'sanctioned' | null | undefined,
): IntegrityChipSpec | null {
  if (!verdicts || historyId == null) return null;
  const entry = verdicts[String(historyId)];
  if (!entry) return null;
  if (entry.verdict === 'pass') {
    return {
      tone: 'pass',
      label: mode === 'sanctioned' ? 'Sanctioned' : 'Conditions verified',
      title: PASS_TITLE[mode === 'sanctioned' ? 'sanctioned' : 'open'],
    };
  }
  if (entry.verdict === 'flagged') {
    const reasons = Array.isArray(entry.reasons) ? entry.reasons.filter(r => typeof r === 'string' && r) : [];
    return {
      tone: 'flagged',
      label: 'Flagged',
      title: reasons.length > 0 ? reasons.join('; ') : 'Flagged — one of this tournament\'s conditions was not met',
    };
  }
  return null;
}
