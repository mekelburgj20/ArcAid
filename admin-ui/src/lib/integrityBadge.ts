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
