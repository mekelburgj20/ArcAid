/**
 * Pick-window deadline math — the SINGLE source of truth for "when does this
 * picker's window close".
 *
 * Three consumers must agree exactly or the UI lies to players:
 *   1. `TimeoutManager.handleTieredTimeout` — the code that actually ENFORCES
 *      the window (pivot to runner-up / auto-select).
 *   2. `TournamentEngine`'s `emitPickerAssigned` websocket ticker payload.
 *   3. The `pick_prompt` lobby-feed event, whose metadata carries the deadline
 *      that the public feed counts down against.
 *
 * Before this module, (2) computed `Date.now() + window` inline while (1)
 * compared elapsed-minutes against `picker_designated_at` — equivalent only
 * because the emit happened in the same tick as the INSERT. Deriving all three
 * from `picker_designated_at` here removes the coincidence.
 *
 * NOTE ON SEMANTICS: expiry of a WINNER window does NOT mean auto-pick. It
 * means the slot pivots to the runner-up (who then gets their own, shorter
 * window) — auto-pick only happens when the runner-up window expires, or when
 * no runner-up can be resolved. `pickWindowFallback()` names which one applies
 * so copy can be accurate rather than assuming auto-pick.
 */

/** `tournaments.winner_pick_window_min` default (migration 031). */
export const DEFAULT_WINNER_PICK_WINDOW_MIN = 60;
/** `tournaments.runnerup_pick_window_min` default (migration 032). */
export const DEFAULT_RUNNERUP_PICK_WINDOW_MIN = 30;

export type PickerType = 'WINNER' | 'RUNNER_UP';
/** What happens when the window closes without a pick. */
export type PickWindowFallback = 'runner_up' | 'autopick';

function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

/**
 * The instant a picker's window closes.
 * `designatedAt` is the row's `picker_designated_at` (reset on pivot, so the
 * runner-up's clock restarts from the pivot — matching TimeoutManager).
 */
export function computePickDeadline(designatedAt: Date | string, windowMin: number): Date {
    return new Date(toDate(designatedAt).getTime() + windowMin * 60_000);
}

/**
 * Whether the window has closed. This is the exact predicate TimeoutManager
 * enforces with — elapsed minutes >= window is the same comparison as
 * now >= designatedAt + window, just without the float division.
 */
export function isPickWindowExpired(
    designatedAt: Date | string,
    windowMin: number,
    now: Date = new Date(),
): boolean {
    return now.getTime() >= computePickDeadline(designatedAt, windowMin).getTime();
}

/**
 * Which window applies to a picker row.
 * WINNER rows use the winner window; RUNNER_UP rows the (shorter) runner-up one.
 */
export function windowMinForPicker(
    pickerType: PickerType | string | null | undefined,
    windows: { winnerWindowMin?: number | null; runnerUpWindowMin?: number | null },
): number {
    if (pickerType === 'RUNNER_UP') {
        return windows.runnerUpWindowMin ?? DEFAULT_RUNNERUP_PICK_WINDOW_MIN;
    }
    return windows.winnerWindowMin ?? DEFAULT_WINNER_PICK_WINDOW_MIN;
}

/**
 * What happens if this picker lets the clock run out.
 *
 * A WINNER only pivots to a runner-up when the slot knows which game was won
 * (`won_game_id`) — TimeoutManager.pivotToRunnerUp bails straight to
 * auto-selection without it. Note a pivot can still *degrade* to auto-select
 * later (no 2nd-place submission, or no Discord mapping for that player); this
 * returns the intended next step, which is what player-facing copy should say.
 */
export function pickWindowFallback(
    pickerType: PickerType | string | null | undefined,
    wonGameId: string | null | undefined,
): PickWindowFallback {
    if (pickerType === 'RUNNER_UP') return 'autopick';
    return wonGameId ? 'runner_up' : 'autopick';
}

/**
 * "45 minutes" / "1h 20m" / "less than a minute".
 *
 * Byte-for-byte the rule `FeedItem.tsx`'s `formatRemaining` uses for the lobby
 * pick_prompt countdown. Duplicated rather than shared because the frontend
 * copy of it is inside a React component in a separate ESM build — but the two
 * must read identically, because the same player sees both for the same window.
 */
export function formatPickRemaining(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    if (totalMinutes < 1) return 'less than a minute';
    if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** What the player loses by letting the clock run out, in words. */
export function pickFallbackPhrase(fallback: PickWindowFallback): string {
    return fallback === 'runner_up' ? 'the runner-up gets the pick' : 'autopick';
}

/**
 * Push-notification body for a pick prompt.
 *
 * Deliberately DERIVED FROM THE DEADLINE rather than handed the configured
 * window: the deadline is the instant TimeoutManager actually enforces, so a
 * push composed a moment after the row was written says what is left, not what
 * was granted. Same reason the lobby event carries a deadline instead of a
 * baked "N minutes".
 *
 * The tray title already says "Your turn to pick!", so the body carries only
 * the two things the title cannot: WHICH tournament, and WHAT IS LOST by
 * ignoring it. That second half is why `pickWindowFallback` exists — a winner
 * window expiring pivots to the runner-up, it does NOT auto-pick, and telling
 * a player otherwise is a lie they can check.
 */
export function pickPromptPushBody(
    tournamentName: string | null | undefined,
    deadline: Date,
    fallback: PickWindowFallback,
    now: Date = new Date(),
): string {
    const remaining = formatPickRemaining(Math.max(0, deadline.getTime() - now.getTime()));
    const where = tournamentName ? `${tournamentName} — ` : '';
    return `${where}${remaining} before ${pickFallbackPhrase(fallback)}`;
}
