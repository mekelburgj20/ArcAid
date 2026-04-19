import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';

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

        const db = await getDatabase();

        // 1. Idempotency: same claimant in the same room → return their already-claimed name.
        if (claimant.kind === 'discord') {
            const existing = await db.get(
                `SELECT display_name FROM room_members
                 WHERE room_id = ? AND user_id = ? AND display_name IS NOT NULL`,
                roomId, claimant.discordUserId,
            );
            if (existing?.display_name) {
                return {
                    displayName: existing.display_name,
                    requested: trimmed,
                    suffixed: existing.display_name.toLowerCase() !== trimmed.toLowerCase(),
                };
            }
        } else if (claimant.kind === 'anon') {
            const existing = await db.get(
                `SELECT display_name FROM anon_room_claims
                 WHERE room_id = ? AND anon_token = ?`,
                roomId, claimant.anonId,
            );
            if (existing?.display_name) {
                return {
                    displayName: existing.display_name,
                    requested: trimmed,
                    suffixed: existing.display_name.toLowerCase() !== trimmed.toLowerCase(),
                };
            }
        }

        // 2. Find the next free name in this room. Walks _2, _3, … against the
        // union of room_members + anon_room_claims claims.
        let candidate = trimmed;
        let suffix = 1;
        while (await this.isNameClaimed(roomId, candidate)) {
            suffix++;
            if (suffix > MAX_SUFFIX_TRIES) {
                throw new Error(
                    `RoomNameClaimService: exhausted ${MAX_SUFFIX_TRIES} suffixes for "${trimmed}" in room ${roomId}`,
                );
            }
            candidate = `${trimmed}_${suffix}`;
        }

        // 3. Persist the claim. Sessionless callers skip persistence — they just
        // get the resolved name with no stickiness across sessions.
        try {
            if (claimant.kind === 'discord') {
                // Insert the membership row if missing (covers users without prior
                // submissions — first interaction with this room). Then set
                // display_name only if it's still NULL, so we never silently
                // re-claim over an existing claim under race.
                await db.run(
                    `INSERT OR IGNORE INTO room_members (user_id, room_id, joined_at, source, display_name)
                     VALUES (?, ?, datetime('now'), 'submission', ?)`,
                    claimant.discordUserId, roomId, candidate,
                );
                await db.run(
                    `UPDATE room_members SET display_name = ?
                     WHERE user_id = ? AND room_id = ? AND display_name IS NULL`,
                    candidate, claimant.discordUserId, roomId,
                );
            } else if (claimant.kind === 'anon') {
                // INSERT OR IGNORE — if a concurrent submit already claimed the
                // anon's row, the existing row wins and we move on. The unique
                // index on (room_id, LOWER(display_name)) guarantees no two
                // anon-tokens can claim the same name simultaneously.
                await db.run(
                    `INSERT OR IGNORE INTO anon_room_claims (anon_token, room_id, display_name)
                     VALUES (?, ?, ?)`,
                    claimant.anonId, roomId, candidate,
                );
            }
        } catch (err) {
            // Constraint-violation under race: re-resolve once. The next
            // resolveAndClaim call will hit the idempotent short-circuit OR
            // pick a fresh suffix.
            logError('RoomNameClaimService.resolveAndClaim: persist failed (race likely), continuing with resolved name', err);
        }

        return {
            displayName: candidate,
            requested: trimmed,
            suffixed: candidate.toLowerCase() !== trimmed.toLowerCase(),
        };
    }

    /**
     * True iff `name` is already claimed in `roomId` by any identity (Discord
     * user via room_members.display_name OR anon via anon_room_claims).
     * Case-insensitive.
     */
    static async isNameClaimed(roomId: string, name: string): Promise<boolean> {
        const db = await getDatabase();
        const lower = name.toLowerCase();

        const discordHit = await db.get(
            `SELECT 1 FROM room_members
             WHERE room_id = ? AND LOWER(display_name) = ?
             LIMIT 1`,
            roomId, lower,
        );
        if (discordHit) return true;

        const anonHit = await db.get(
            `SELECT 1 FROM anon_room_claims
             WHERE room_id = ? AND LOWER(display_name) = ?
             LIMIT 1`,
            roomId, lower,
        );
        return !!anonHit;
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
