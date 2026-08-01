/**
 * RetroAchievements score-eligibility classifier (RA on-demand import,
 * contract §3).
 *
 * A pure function over a game's leaderboard list. No I/O, no DB, no config —
 * so it can be unit-tested exhaustively over every `Format` value, and so the
 * verdict a game carries is reproducible from the boards that produced it.
 *
 * ── What the verdict is FOR ─────────────────────────────────────────────────
 *
 * It is a HINT, never a gate. Arcaid's own submission model does not depend on
 * RA having a leaderboard: a player can post a Donkey Kong score whether or
 * not RA tracks one. The verdict exists so admin surfaces can show "RA thinks
 * this isn't score-based" next to a game, and so the §5 "not score-eligible"
 * review flow has a signal other than user reports. Import ALWAYS proceeds,
 * including for `novelty` and `time` — the owner may want time-attack games
 * later, and deleting on a guess is not recoverable.
 *
 * Consequently `unknown` (RA has no boards for this game) is NOT a "no". RA's
 * silence says nothing about whether a game keeps score; most of RA's
 * catalogue has achievement sets but no leaderboards at all.
 */

/** The verdict enum stored in `global_games.score_eligibility`. */
export type ScoreEligibility = 'score' | 'score_maybe' | 'time' | 'novelty' | 'unknown';

/** Just enough of an RA leaderboard for the classifier. */
export interface ClassifiableBoard {
    RankAsc?: boolean | null;
    Title?: string | null;
    Description?: string | null;
    Format?: string | null;
}

/**
 * Formats that measure TIME. Lower is better, so these are speedrun/time-attack
 * boards rather than score boards.
 *
 * The enum is not in RA's public API docs — it comes from RAWeb's source. Any
 * value NOT listed in either set is treated as unrecognised (→ `unknown` for
 * that board) rather than guessed at, so a format RA adds later shows up as
 * "we don't know" instead of being silently mis-filed as a score.
 */
export const TIME_FORMATS: ReadonlySet<string> = new Set([
    'TIME', 'MILLISECS', 'TIMESECS', 'MINUTES', 'SECS_AS_MINS',
]);

/** Formats that measure a NUMBER — the score-shaped ones. */
export const NUMERIC_FORMATS: ReadonlySet<string> = new Set([
    'SCORE', 'VALUE', 'UNSIGNED', 'TENS', 'HUNDREDS', 'THOUSANDS',
    'FIXED1', 'FIXED2', 'FIXED3',
]);

/**
 * Phrases that upgrade a numeric board from "might be a score" to "is a
 * score". RA board titles are author-written prose, so this is the difference
 * between "High Score" (unambiguous) and "Coins Collected" (a numeric board
 * that is not the game's score).
 *
 * `1cc` is a one-credit-clear, an arcade scoring convention.
 */
export const SCORE_KEYWORDS = /hi[- ]?score|high score|points|score attack|1cc/i;

/**
 * Verdict strength, strongest first. The game's verdict is the BEST of its
 * boards' verdicts: a game with one "High Score" board and forty speedrun
 * boards is a score game that also happens to be speedrun.
 */
const PRECEDENCE: ScoreEligibility[] = ['score', 'score_maybe', 'time', 'novelty', 'unknown'];

/** Rank of a verdict — lower is stronger. */
export function eligibilityRank(verdict: ScoreEligibility): number {
    const i = PRECEDENCE.indexOf(verdict);
    return i === -1 ? PRECEDENCE.length : i;
}

/**
 * Classifies ONE board. Rules apply in the order the contract lists them, and
 * the FIRST match wins — the order is the specification, not an optimisation:
 *
 *   1. a TIME format is a time board, full stop;
 *   2. otherwise `RankAsc` (lower-is-better on a non-time measure) means the
 *      board ranks something that is not a score — a novelty;
 *   3. otherwise a numeric format is a score board, promoted from
 *      `score_maybe` to `score` when the title/description says so;
 *   4. anything else is unrecognised.
 *
 * Note the consequence of rule 1 preceding rule 2: an ascending TIME board —
 * the ordinary speedrun shape — is `time`, not `novelty`. That is deliberate.
 * `novelty` is for ascending boards measuring something we have no name for
 * (deaths taken, damage received), which is a genuinely different thing from a
 * speedrun.
 */
export function classifyBoard(board: ClassifiableBoard): ScoreEligibility {
    const format = (board.Format ?? '').trim().toUpperCase();

    if (TIME_FORMATS.has(format)) return 'time';
    if (board.RankAsc === true) return 'novelty';

    if (NUMERIC_FORMATS.has(format)) {
        const text = `${board.Title ?? ''} ${board.Description ?? ''}`;
        return SCORE_KEYWORDS.test(text) ? 'score' : 'score_maybe';
    }

    return 'unknown';
}

/**
 * The game's verdict: the strongest verdict among its boards.
 *
 * No boards at all → `unknown`. RA's silence is not a "no" (see the module
 * note); the game stays importable and score-submittable.
 */
export function classifyGame(boards: ClassifiableBoard[]): ScoreEligibility {
    if (!boards || boards.length === 0) return 'unknown';

    let best: ScoreEligibility = 'unknown';
    for (const board of boards) {
        const verdict = classifyBoard(board);
        if (eligibilityRank(verdict) < eligibilityRank(best)) best = verdict;
    }
    return best;
}
