import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { assertNameAllowed } from '../utils/contentBlocklist.js';

/**
 * v2.2.0 — first-claim-wins identity service.
 *
 * Resolves and persists a display name for a (claimant, room) pair. The first
 * identity to use a name in a room owns it; later arrivals get auto-suffixed
 * (`Bob`, `Bob_2`, `Bob_3` …). Same claimant re-submitting always gets the
 * same name back — the resolution is idempotent.
 *
 * Two claimant kinds:
 *   • `discord` — keyed on `discord_user_id`. Display stored on
 *     `room_members.display_name`.
 *   • `anon`    — keyed on `anonId` (the localStorage `arcaid_anon_id` UUID
 *     surfaced via the `x-user-id` header). Display stored on
 *     `anon_room_claims`.
 *
 * Pre-v2.2.0 submissions aren't backfilled — the user's stated stance is that
 * legacy data will be scrubbed at GA. As a result, a freshly-claimed name in
 * v2.2.0 may still group with a legacy submission under the same name on the
 * leaderboard until the scrub runs. The admin merge tool handles real-world
 * collisions if any slip through.
 */
export type ClaimantId =
    | { kind: 'discord'; discordUserId: string }
    | { kind: 'anon'; anonId: string }
    | { kind: 'sessionless' };  // No token at all (curl, embeds) — no claim row written.

export interface ResolvedDisplayName {
    /** The actual display name to persist on score rows. */
    displayName: string;
    /** What the user originally typed. */
    requested: string;
    /** True if the system added a `_N` suffix because the requested name was taken. */
    suffixed: boolean;
}

const MAX_SUFFIX_TRIES = 1000;

export class RoomNameClaimService {
    /**
     * Idempotent for the same (roomId, claimant). New claimants get the
     * requested name if free, or the next available `_N` suffix if not.
     *
     * Throws only on totally pathological input (empty name, suffix exhaustion).
     * Storage failures are logged and the resolved name is still returned so
     * the submission flow continues — the leaderboard's correctness depends on
     * the score row, not on the claim row.
     */
    static async resolveAndClaim(
        roomId: string,
        requestedName: string,
        claimant: ClaimantId,
    ): Promise<ResolvedDisplayName> {
        const trimmed = requestedName.trim();
        if (!trimmed) throw new Error('RoomNameClaimService.resolveAndClaim: requestedName is empty');
        if (!roomId) throw new Error('RoomNameClaimService.resolveAndClaim: roomId is required');
        // S22 Phase 1 (v2.43.0) — reject the DESIRED name before the
        // claim/suffix loop, both Discord + anon paths. Throws NAME_NOT_ALLOWED.
        assertNameAllowed(trimmed, 'room_member_name');

        const db = await getDatabase();

        // v2.2.3: removed the token→name idempotent short-circuit. Previously
        // any submission from a browser that had already claimed a name was
        // collapsed back to that first claim — so typing "Bob_2" from the same
        // browser as an earlier "Bob" was silently re-stored as "Bob". The
        // token now proves ownership OF SPECIFIC NAMES you've claimed, not
        // ownership of a single name forever. Multiple names per token per
        // room are allowed (migration 066 widens the PK).
        //
        // Suffix loop: walk _2, _3, … until we find a name that's either free
        // or already owned by this claimant. Discord claimants get the same
        // treatment — they can rotate their per-room display name too.
        let candidate = trimmed;
        let suffix = 1;
        while (true) {
            const owner = await this.findClaimOwner(roomId, candidate);
            if (!owner) break;                          // Free — we can claim it
            if (this.isOwnedByClaimant(owner, claimant)) break;  // Already ours — reuse
            suffix++;
            if (suffix > MAX_SUFFIX_TRIES) {
                throw new Error(
                    `RoomNameClaimService: exhausted ${MAX_SUFFIX_TRIES} suffixes for "${trimmed}" in room ${roomId}`,
                );
            }
            candidate = `${trimmed}_${suffix}`;
        }

        // Persist the claim. Sessionless callers skip persistence — they just
        // get the resolved name with no stickiness across sessions.
        try {
            if (claimant.kind === 'discord') {
                // Ensure the membership row exists first.
                await db.run(
                    `INSERT OR IGNORE INTO room_members (user_id, room_id, joined_at, source, display_name)
                     VALUES (?, ?, datetime('now'), 'submission', ?)`,
                    claimant.discordUserId, roomId, candidate,
                );
                // Update their per-room display name unconditionally. room_members
                // is one row per (user, room), so a Discord user has exactly one
                // display name per room at any time. Changing it doesn't rewrite
                // historical score_history/submissions rows — those stay keyed
                // on whatever name was stored at submit time.
                await db.run(
                    `UPDATE room_members SET display_name = ?
                     WHERE user_id = ? AND room_id = ?`,
                    candidate, claimant.discordUserId, roomId,
                );
            } else if (claimant.kind === 'anon') {
                // Post-migration 066: multiple rows per (anon_token, room_id)
                // keyed on display_name. INSERT OR IGNORE so concurrent
                // submissions with the same (token, name) don't fight.
                await db.run(
                    `INSERT OR IGNORE INTO anon_room_claims (anon_token, room_id, display_name)
                     VALUES (?, ?, ?)`,
                    claimant.anonId, roomId, candidate,
                );
            }
        } catch (err) {
            logError('RoomNameClaimService.resolveAndClaim: persist failed (race likely), continuing with resolved name', err);
        }

        return {
            displayName: candidate,
            requested: trimmed,
            suffixed: candidate.toLowerCase() !== trimmed.toLowerCase(),
        };
    }

    /**
     * Look up who owns a display name in the room. Returns:
     *   - `{ kind: 'discord', discordUserId }` when owned by a Discord user
     *   - `{ kind: 'anon', anonToken }` when owned by a guest claim
     *   - `null` when the name is free
     *
     * Case-insensitive name comparison. Both claim stores are checked; if both
     * have a match (which shouldn't happen thanks to the unique indexes), the
     * Discord claim wins.
     */
    static async findClaimOwner(
        roomId: string,
        name: string,
    ): Promise<{ kind: 'discord'; discordUserId: string } | { kind: 'anon'; anonToken: string } | null> {
        const db = await getDatabase();
        const lower = name.toLowerCase();

        const discordHit = await db.get(
            `SELECT user_id FROM room_members
             WHERE room_id = ? AND LOWER(display_name) = ?
             LIMIT 1`,
            roomId, lower,
        );
        if (discordHit?.user_id) {
            return { kind: 'discord', discordUserId: discordHit.user_id };
        }

        const anonHit = await db.get(
            `SELECT anon_token FROM anon_room_claims
             WHERE room_id = ? AND LOWER(display_name) = ?
             LIMIT 1`,
            roomId, lower,
        );
        if (anonHit?.anon_token) {
            return { kind: 'anon', anonToken: anonHit.anon_token };
        }

        return null;
    }

    /** True iff the claim owner matches the submitting claimant. */
    private static isOwnedByClaimant(
        owner: { kind: 'discord'; discordUserId: string } | { kind: 'anon'; anonToken: string },
        claimant: ClaimantId,
    ): boolean {
        if (owner.kind === 'discord' && claimant.kind === 'discord') {
            return owner.discordUserId === claimant.discordUserId;
        }
        if (owner.kind === 'anon' && claimant.kind === 'anon') {
            return owner.anonToken === claimant.anonId;
        }
        return false;
    }

    /**
     * True iff `name` is already claimed in `roomId` by any identity.
     * Case-insensitive. Kept for backward compatibility — new callers should
     * use `findClaimOwner` which tells them *who* owns it.
     */
    static async isNameClaimed(roomId: string, name: string): Promise<boolean> {
        return (await this.findClaimOwner(roomId, name)) !== null;
    }

    /**
     * v2.2.5 — dry-run availability check used by the SubmissionSheet pre-submit
     * collision prompt. Returns whether the requested name is free for the
     * submitting claimant (either unclaimed, or already owned by them), and if
     * not, the next available suffix the server *would* assign on submit.
     *
     * Does not persist anything. Callers use it to show a "name taken, try X"
     * UX before the user commits to submission.
     */
    static async checkAvailability(
        roomId: string,
        requestedName: string,
        claimant: ClaimantId,
    ): Promise<{ available: boolean; suggestion: string }> {
        const trimmed = requestedName.trim();
        if (!trimmed) throw new Error('RoomNameClaimService.checkAvailability: requestedName is empty');
        if (!roomId) throw new Error('RoomNameClaimService.checkAvailability: roomId is required');
        // S22 Phase 1 (v2.43.0) — same blocklist check as resolveAndClaim, so
        // the FE pre-submit check learns about a blocked name before the user
        // commits to submitting (rather than failing only at claim time).
        assertNameAllowed(trimmed, 'room_member_name');

        const ownerOfRequested = await this.findClaimOwner(roomId, trimmed);
        if (!ownerOfRequested || this.isOwnedByClaimant(ownerOfRequested, claimant)) {
            return { available: true, suggestion: trimmed };
        }

        let candidate = trimmed;
        let suffix = 1;
        while (true) {
            const owner = await this.findClaimOwner(roomId, candidate);
            if (!owner || this.isOwnedByClaimant(owner, claimant)) break;
            suffix++;
            if (suffix > MAX_SUFFIX_TRIES) {
                throw new Error(
                    `RoomNameClaimService.checkAvailability: exhausted ${MAX_SUFFIX_TRIES} suffixes for "${trimmed}" in room ${roomId}`,
                );
            }
            candidate = `${trimmed}_${suffix}`;
        }

        return { available: false, suggestion: candidate };
    }

    /**
     * Build the right ClaimantId for a submission given the request context.
     * Centralizes the discord-vs-anon-vs-sessionless decision so all submission
     * paths agree on it.
     */
    static buildClaimant(opts: {
        discordUserId?: string | null;
        anonToken?: string | null;
    }): ClaimantId {
        if (opts.discordUserId) {
            return { kind: 'discord', discordUserId: opts.discordUserId };
        }
        if (opts.anonToken) {
            return { kind: 'anon', anonId: opts.anonToken };
        }
        return { kind: 'sessionless' };
    }
}
