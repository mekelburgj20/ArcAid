/**
 * W49 (v2.187.0, castcade B16) — `quit` / `quit_ball` on `GET /api/witness/score`.
 *
 * The Castcade desktop companion says whether the player QUIT the game before
 * game over: `quit=1` (with `quit_ball=<1..10>` when the machine reports the
 * ball in play — absent on Stern SAM and on maps with no current ball),
 * `quit=0` when the game reached game over, nothing at all when it cannot tell
 * (older companions, basic mode with no `game_over` in the map).
 *
 * A quit game still posts and counts, and in Limited attempts still uses its
 * attempt (owner ruling 2026-10-27). BADGE, NEVER A GATE: nothing reads this to
 * rank, filter or refuse a score. Like every other evidence param, malformed is
 * DROPPED (null = unknown), never a 400.
 */
export type QuitEvidence = { quit: boolean; quitBall: number | null };

export const MAX_QUIT_BALL = 10;

export function parseQuitEvidence(query: Record<string, unknown>): QuitEvidence | null {
    const raw = query.quit;
    const flag = raw === 0 || raw === '0' ? 0 : raw === 1 || raw === '1' ? 1 : null;
    if (flag === null) return null;
    if (flag === 0) return { quit: false, quitBall: null };
    const b = query.quit_ball;
    let quitBall: number | null = null;
    if (typeof b === 'string' && /^\d{1,2}$/.test(b)) {
        const n = Number(b);
        if (n >= 1 && n <= MAX_QUIT_BALL) quitBall = n;
    } else if (typeof b === 'number' && Number.isInteger(b) && b >= 1 && b <= MAX_QUIT_BALL) {
        quitBall = b;
    }
    return { quit: true, quitBall };
}
