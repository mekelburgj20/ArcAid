import { PickDispositionService } from '../services/PickDispositionService.js';

/**
 * pickResolution — who gets the pick when a tournament slot completes.
 *
 * This is the single implementation of the cascade specified by the owner on
 * 2026-08-17 (contract: docs/contracts/pick-delegation-contract.md §3). Both entry points
 * share it:
 *   - `TournamentEngine.processSlotMaintenance` runs it when a slot completes.
 *   - `TimeoutManager` runs it again, starting one place lower, when a pick
 *     window expires.
 * Keeping one implementation is the point — the pre-2026-08-17 code had the
 * disposition logic in `TournamentEngine.resolveNextPicker` and the runner-up
 * pivot in `TimeoutManager.pivotToRunnerUp`, which is how the two drifted.
 *
 * The place table this walks:
 *
 *   | place        | pick window?      | queue read? | disposition? |
 *   |--------------|-------------------|-------------|--------------|
 *   | 1st (winner) | yes (winner)      | yes         | yes          |
 *   | 2nd          | yes (runner-up)   | yes — used immediately | yes |
 *   | 3rd          | NO                | yes         | no           |
 *   | none left    | auto-pick                                      |
 *
 * A queue is that player's standing "pick if I win" — never a room-level
 * play-next list, so another player's queued game is never activated because
 * someone else won.
 */

/** Chain length cap for nominate → nominate → … hand-offs. */
export const MAX_CHAIN_DEPTH = 5;

/** How many places the cascade can consult (winner, runner-up, third). */
export const MAX_PLACES = 3;

export interface PickPlace {
    playerId: string;
    iscoredUsername: string | null;
}

export interface QueuedPick {
    id: string;
    name: string;
    [key: string]: any;
}

export type PickOutcome =
    /** Activate this player's own queued game right now. No window. */
    | { kind: 'activate'; playerId: string; game: QueuedPick }
    /** Give this player a pick window; expiry re-enters the cascade below them. */
    | {
          kind: 'window';
          playerId: string;
          iscoredUsername: string | null;
          pickerType: 'WINNER' | 'RUNNER_UP';
          /** Set when the picker isn't a room member yet, so the caller can run the onboarding hook. */
          onboardingNominee: string | null;
          /** Index in `places` this window was granted from — the resume point on timeout. */
          placeIndex: number;
      }
    /** Hand it to the auto-picker. */
    | { kind: 'auto' };

export interface PickResolution {
    outcome: PickOutcome;
    /**
     * Lines explaining any non-obvious hand-off, in order, for the announcement
     * embed. Empty when the winner simply used their own queue — the existing
     * "congrats, X is now active" copy already says that.
     */
    narrative: string[];
}

export interface PickResolutionDeps {
    tournamentId: string;
    /** Finishing order, already deduped by identity and stripped of unattributed rows. */
    places: PickPlace[];
    /** First cooldown-eligible queued game for this player, or null. */
    nextQueuedFor: (playerId: string) => Promise<QueuedPick | null>;
    /** Display label for announcements. */
    labelFor: (playerId: string) => Promise<string>;
    /** Whether this player is already a member of the room (onboarding hook gate). */
    isRoomMember: (playerId: string) => Promise<boolean>;
    /** `allow_dynasty = 0` and the winner also took the previous slot. */
    dynastyBlockedWinner?: boolean;
    /** Start the cascade at this place instead of the winner (timeout re-entry). */
    startPlaceIndex?: number;
}

/**
 * Walk the cascade and decide the outcome.
 *
 * Disposition lifetime (owner ruling, contract §5 Q2) is enforced here by
 * choosing `consume()` vs `get()`: only the player who actually WON, consulted
 * directly (not reached through someone else's nomination), can fire a one-shot
 * `nominate`. Everyone else is read without being consumed, so one person
 * winning never clears other people's settings.
 */
export async function resolvePick(deps: PickResolutionDeps): Promise<PickResolution> {
    const narrative: string[] = [];
    const places = deps.places.slice(0, MAX_PLACES);
    const start = deps.startPlaceIndex ?? 0;

    for (let placeIndex = start; placeIndex < places.length; placeIndex++) {
        const place = places[placeIndex];
        if (!place) break;

        // Third place is queue-only: it never receives a window, so a
        // disposition would have nothing to act on (contract §4.2).
        if (placeIndex >= 2) {
            const queued = await deps.nextQueuedFor(place.playerId);
            if (queued) {
                narrative.push(`${await deps.labelFor(place.playerId)} had **${queued.name}** queued in third — it takes the slot.`);
                return { outcome: { kind: 'activate', playerId: place.playerId, game: queued }, narrative };
            }
            break;
        }

        const outcome = await resolveAtPlace(deps, place, placeIndex, narrative);
        if (outcome) return { outcome, narrative };
        // null → this place declined; advance the pointer.
    }

    return { outcome: { kind: 'auto' }, narrative };
}

/**
 * Resolve one place, following any nomination chain out of it.
 * Returns null when the place declines and the cascade should advance.
 */
async function resolveAtPlace(
    deps: PickResolutionDeps,
    place: PickPlace,
    placeIndex: number,
    narrative: string[],
): Promise<PickOutcome | null> {
    const isWinnerPlace = placeIndex === 0;
    const pickerType: 'WINNER' | 'RUNNER_UP' = isWinnerPlace ? 'WINNER' : 'RUNNER_UP';

    let currentId = place.playerId;
    let currentIscored = place.iscoredUsername;
    let isDirect = true; // false once we've followed a nomination
    let depth = 0;
    const visited = new Set<string>();

    for (;;) {
        // Cycle guard: A nominates B, B nominates A (contract §4.1). No
        // inferable answer, so the chain is treated as a forfeit by the last
        // link and the cascade advances rather than dead-ending in auto-pick.
        if (visited.has(currentId) || depth > MAX_CHAIN_DEPTH) {
            narrative.push('The hand-off chain looped back on itself — the pick passes to the next place.');
            return null;
        }
        visited.add(currentId);

        // Only the actual winner, consulted directly, fires a one-shot.
        const disposition = isWinnerPlace && isDirect
            ? await PickDispositionService.consume(deps.tournamentId, currentId)
            : await PickDispositionService.get(deps.tournamentId, currentId);

        const label = await deps.labelFor(currentId);

        if (disposition?.disposition === 'auto') {
            narrative.push(`${label} chose to roll the dice — Arcaid picks the next game.`);
            return { kind: 'auto' };
        }

        if (disposition?.disposition === 'forfeit') {
            narrative.push(`${label} forfeited the pick.`);
            return null;
        }

        if (disposition?.disposition === 'nominate' && disposition.nominee_discord_id) {
            const nomineeId = disposition.nominee_discord_id;
            narrative.push(`${label} handed their pick to ${await deps.labelFor(nomineeId)}.`);
            currentId = nomineeId;
            currentIscored = null;
            isDirect = false;
            depth++;
            continue;
        }

        // --- No disposition: use-my-queue, else a window ---

        // Dynasty blocks the winner's OWN queue path only; a disposition set by
        // the winner is honored above and is unaffected by the rule.
        if (isWinnerPlace && isDirect && deps.dynastyBlockedWinner) {
            narrative.push(`${label} won back-to-back — the dynasty rule passes the pick on.`);
            return null;
        }

        const queued = await deps.nextQueuedFor(currentId);
        if (queued) {
            // A runner-up (or anyone below the winner) reaching their own queue
            // is worth saying out loud; the winner's own queue is already
            // covered by the standard "now active" copy.
            if (!isWinnerPlace || !isDirect) {
                narrative.push(`${label} already had **${queued.name}** queued — it takes the slot.`);
            }
            return { kind: 'activate', playerId: currentId, game: queued };
        }

        return {
            kind: 'window',
            playerId: currentId,
            iscoredUsername: currentIscored,
            pickerType,
            onboardingNominee: !isDirect && !(await deps.isRoomMember(currentId)) ? currentId : null,
            placeIndex,
        };
    }
}
