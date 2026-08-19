import { getDatabase } from '../database/database.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * Guarded self-claim of an iScored username (identity arc P1, 2026-08-18).
 *
 * WHAT THIS REPLACES. `/map-user` requires Administrator only when mapping
 * SOMEONE ELSE (`mapuser.ts` — "Optional: Add admin check if mapping *other*
 * users"). Mapping yourself was unguarded: any guild member could claim any
 * unclaimed iScored name, with no similarity check and no approval. That is not
 * cosmetic — `user_mappings` feeds `resolveSubmissionPlayerId`, the leaderboard
 * partition key, `IdentityCandidateService.playerKeys`, and since PR #239 the
 * pick cascade, so claiming a name absorbs its scores into your identity for
 * ranking, stats, and who gets offered the next pick.
 *
 * THE RULE (owner, 2026-08-17). A claim auto-approves ONLY on a
 * CASE-INSENSITIVE EXACT match against a name the claimant already answers to.
 * Separators and spaces are deliberately NOT normalized — `Chalata_Love` does
 * not match `ChalataLove`. That is the strictest option considered, which is
 * why the mod queue (P4) ships alongside rather than after: under case-only
 * matching, most genuine claims land in the queue.
 *
 * Identity expansion goes through `IdentityLinkService.expandCandidates`, the
 * declared single source of truth for the login-identity link graph. Note the
 * standing doctrine that login links and game-handle aliases are separate axes:
 * this READS the link graph to decide a claim and still writes the result to
 * `user_mappings` only.
 */

/** Owner ruling: at most three iScored aliases per account. */
export const MAX_ALIASES = 3;

export type ClaimOutcome =
    | { result: 'auto_approved'; matchedOn: string }
    | { result: 'pending'; claimId: number }
    | { result: 'already_yours' };

export class ClaimError extends Error {
    constructor(public code: string, message: string) {
        super(message);
    }
}

/**
 * The ONLY normalization applied. Case and surrounding whitespace, nothing
 * else — see the class doc. Widening this re-opens the hole through the
 * auto-approve door, so it must stay this boring.
 */
function normalizeForMatch(value: string): string {
    return value.trim().toLowerCase();
}

export class IdentityClaimService {
    /**
     * Every name this account already answers to, as normalized match keys
     * mapped to a human-readable reason for the audit trail.
     *
     * Sources (the owner's list): Arcaid username, Arcaid display name, aliases
     * already held, linked Discord username, linked Google username
     * (local-part only). The first, fourth and fifth collapse into "any linked
     * identity's stored username", which is why this walks the link graph
     * rather than special-casing providers.
     */
    static async knownNamesFor(userId: string): Promise<Map<string, string>> {
        const db = await getDatabase();
        const ids = Array.from(await IdentityLinkService.expandCandidates(userId));
        if (ids.length === 0) return new Map();
        const placeholders = ids.map(() => '?').join(', ');
        const out = new Map<string, string>();
        const add = (raw: unknown, reason: string) => {
            if (typeof raw !== 'string') return;
            const key = normalizeForMatch(raw);
            if (key && !out.has(key)) out.set(key, reason);
        };

        const profiles = await db.all(
            `SELECT username, display_name, email_local_part FROM user_profiles
             WHERE discord_user_id IN (${placeholders})`,
            ...ids,
        );
        for (const p of profiles) {
            add(p.display_name, 'your Arcaid display name');
            add(p.username, 'your account username');
            add(p.email_local_part, 'your linked Google account');
        }

        const aliases = await db.all(
            `SELECT iscored_username FROM user_mappings WHERE discord_user_id IN (${placeholders})`,
            ...ids,
        );
        for (const a of aliases) add(a.iscored_username, 'an iScored name you already hold');

        return out;
    }

    /** How many aliases this account (across all linked identities) already holds. */
    static async aliasCount(userId: string): Promise<number> {
        const db = await getDatabase();
        const ids = Array.from(await IdentityLinkService.expandCandidates(userId));
        if (ids.length === 0) return 0;
        const placeholders = ids.map(() => '?').join(', ');
        const row = await db.get(
            `SELECT COUNT(*) AS n FROM user_mappings WHERE discord_user_id IN (${placeholders})`,
            ...ids,
        );
        return row?.n ?? 0;
    }

    /**
     * Request an iScored name. Auto-approves on an exact (case-insensitive)
     * match against `knownNamesFor`; otherwise queues it for a room mod.
     *
     * Throws `ClaimError` for the refusals a caller should surface verbatim.
     */
    static async claim(userId: string, roomId: string | null, requestedRaw: string): Promise<ClaimOutcome> {
        const requested = requestedRaw.trim();
        if (!requested) throw new ClaimError('INVALID_NAME', 'An iScored name is required.');
        if (requested.length > 64) throw new ClaimError('INVALID_NAME', 'That name is too long.');

        const db = await getDatabase();

        // Already mapped? Keep the existing /map-user rule: a name belongs to at
        // most one account, and only its holder can release it.
        const existing = await db.get(
            'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
            requested,
        );
        if (existing) {
            const ids = await IdentityLinkService.expandCandidates(userId);
            if (ids.has(existing.discord_user_id)) return { result: 'already_yours' };
            throw new ClaimError('ALREADY_CLAIMED',
                'That iScored name is already linked to another account. If it is yours, ask a room admin.');
        }

        if (await this.aliasCount(userId) >= MAX_ALIASES) {
            throw new ClaimError('TOO_MANY_ALIASES',
                `You can hold at most ${MAX_ALIASES} iScored names. Remove one first.`);
        }

        const pending = await db.get(
            `SELECT id FROM identity_claims WHERE claimant_user_id = ?
               AND LOWER(iscored_username) = LOWER(?) AND status = 'pending'`,
            userId, requested,
        );
        if (pending) throw new ClaimError('ALREADY_PENDING', 'You already have a request pending for that name.');

        const matchedOn = (await this.knownNamesFor(userId)).get(normalizeForMatch(requested)) ?? null;

        if (matchedOn) {
            // Auto-approve. ON CONFLICT DO NOTHING mirrors every other
            // user_mappings writer — the UNIQUE(iscored_username) index is the
            // real guard against a race between two claimants.
            await db.run(
                `INSERT INTO user_mappings (discord_user_id, iscored_username, created_at)
                 VALUES (?, ?, datetime('now'))
                 ON CONFLICT(iscored_username) DO NOTHING`,
                userId, requested,
            );
            await db.run(
                `INSERT INTO identity_claims
                    (game_room_id, claimant_user_id, iscored_username, status, auto_matched_on, resolved_at, resolved_by)
                 VALUES (?, ?, ?, 'approved', ?, datetime('now'), 'auto')`,
                roomId, userId, requested, matchedOn,
            );
            logInfo(`Identity claim auto-approved: ${userId} -> "${requested}" (matched ${matchedOn})`);
            return { result: 'auto_approved', matchedOn };
        }

        // A pending claim needs a queue to sit in. Auto-approved ones do not,
        // which is why the room is only required at this point.
        if (!roomId) {
            throw new ClaimError('NO_REVIEW_ROOM',
                'We could not find a room to review this. Claim it from inside the room where those scores are.');
        }
        const res = await db.run(
            `INSERT INTO identity_claims (game_room_id, claimant_user_id, iscored_username, status)
             VALUES (?, ?, ?, 'pending')`,
            roomId, userId, requested,
        );
        logInfo(`Identity claim queued for review: ${userId} -> "${requested}" (room ${roomId})`);
        return { result: 'pending', claimId: res.lastID as number };
    }

    /**
     * P2 (2026-08-19) — should the submit response offer this player the name
     * they just submitted under?
     *
     * The case: a room synced its history from iScored, so the board already
     * carries scores under "ChalataLove" that belong to nobody. A player logs
     * in, submits under that same name, and today nothing connects the two —
     * they end up as two rows on the same board (the ChalataLove double-entry
     * that started this arc). Offering the claim at the exact moment the two
     * names coincide is the cheapest possible prompt.
     *
     * Returns null unless every condition holds, because an offer the player
     * cannot accept is worse than no offer:
     *   • the name is unclaimed by ANYONE (a claimed name is not on offer, and
     *     one already theirs needs no prompt),
     *   • it carries SYNCED scores in THIS room — `source = 'sync'` is the
     *     whole point (their own community/tournament rows are not evidence of
     *     a separate iScored identity), so this deliberately does NOT reuse the
     *     all-source counts in `listPending`/`resolveReviewRoom`,
     *   • they are under the alias cap,
     *   • they have no pending request for it already.
     *
     * Runs inline in a submit response, so any failure is swallowed: a broken
     * offer must never fail a score submission.
     */
    static async claimOfferForSubmit(
        userId: string,
        roomId: string,
        username: string,
    ): Promise<{ iscoredUsername: string; syncScoreCount: number } | null> {
        try {
            const name = (username ?? '').trim();
            if (!name) return null;

            const db = await getDatabase();

            const mapped = await db.get(
                'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
                name,
            );
            if (mapped) return null;

            // Stored casing comes from the rows themselves — the offer names the
            // identity as the board shows it, not as the player typed it.
            const synced = await db.get(
                `SELECT iscored_username, COUNT(*) AS n FROM score_history
                  WHERE game_room_id = ? AND source = 'sync' AND LOWER(iscored_username) = LOWER(?)
                  GROUP BY LOWER(iscored_username)`,
                roomId, name,
            );
            if (!synced?.n) return null;

            if (await this.aliasCount(userId) >= MAX_ALIASES) return null;

            // Same claimant-id semantics as `claim`'s ALREADY_PENDING check —
            // an offer that would bounce with "already pending" is not an offer.
            const pending = await db.get(
                `SELECT id FROM identity_claims WHERE claimant_user_id = ?
                   AND LOWER(iscored_username) = LOWER(?) AND status = 'pending'`,
                userId, name,
            );
            if (pending) return null;

            return { iscoredUsername: synced.iscored_username as string, syncScoreCount: synced.n as number };
        } catch (error) {
            logWarn('Identity claim offer could not be computed (submit continues):', error);
            return null;
        }
    }

    /**
     * Which room should review a claim filed from a global surface (Account
     * Settings has no room context, but a queue does).
     *
     * Routes to the room where the requested name actually HAS history — those
     * admins are the only ones who can meaningfully judge it, and it is their
     * leaderboard at stake. Falls back to a room the claimant belongs to so a
     * name with no scores anywhere is still reviewable, and returns null when
     * there is nowhere sensible to send it.
     */
    static async resolveReviewRoom(userId: string, requestedName: string): Promise<string | null> {
        const db = await getDatabase();

        const byHistory = await db.get(
            `SELECT game_room_id, COUNT(*) AS n FROM score_history
              WHERE LOWER(iscored_username) = LOWER(?) AND game_room_id IS NOT NULL
              GROUP BY game_room_id ORDER BY n DESC LIMIT 1`,
            requestedName,
        );
        if (byHistory?.game_room_id) return byHistory.game_room_id;

        const membership = await db.get(
            `SELECT room_id FROM room_members WHERE user_id = ? ORDER BY joined_at DESC LIMIT 1`,
            userId,
        );
        return membership?.room_id ?? null;
    }

    /**
     * Pending claims for a room's review queue, newest first.
     *
     * `scores_in_room` is the whole point of the review: it tells the mod how
     * much history the requested name actually carries here, which is the
     * difference between a harmless typo-fix and handing over a leaderboard.
     */
    static async listPending(roomId: string): Promise<any[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT c.id, c.claimant_user_id, c.iscored_username, c.requested_at,
                    p.display_name, p.username,
                    (SELECT COUNT(*) FROM score_history sh
                      WHERE sh.game_room_id = c.game_room_id
                        AND LOWER(sh.iscored_username) = LOWER(c.iscored_username)) AS scores_in_room
               FROM identity_claims c
               LEFT JOIN user_profiles p ON p.discord_user_id = c.claimant_user_id
              WHERE c.game_room_id = ? AND c.status = 'pending'
              ORDER BY c.requested_at DESC`,
            roomId,
        );
    }

    static async pendingCount(roomId: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT COUNT(*) AS n FROM identity_claims WHERE game_room_id = ? AND status = 'pending'`,
            roomId,
        );
        return row?.n ?? 0;
    }

    /**
     * Approve a queued claim. Re-checks the alias cap and the name's
     * availability at approval time — a queue can sit for days and both can
     * change underneath it.
     */
    static async approve(claimId: number, roomId: string, actor: string): Promise<void> {
        const db = await getDatabase();
        const claim = await db.get(
            `SELECT * FROM identity_claims WHERE id = ? AND game_room_id = ? AND status = 'pending'`,
            claimId, roomId,
        );
        if (!claim) throw new ClaimError('NOT_FOUND', 'That request is no longer pending.');

        const taken = await db.get(
            'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
            claim.iscored_username,
        );
        if (taken && taken.discord_user_id !== claim.claimant_user_id) {
            throw new ClaimError('ALREADY_CLAIMED', 'That name was claimed by someone else while this was pending.');
        }
        if (await this.aliasCount(claim.claimant_user_id) >= MAX_ALIASES) {
            throw new ClaimError('TOO_MANY_ALIASES', 'That player already holds the maximum number of iScored names.');
        }

        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username, created_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(iscored_username) DO NOTHING`,
            claim.claimant_user_id, claim.iscored_username,
        );
        await db.run(
            `UPDATE identity_claims SET status = 'approved', resolved_at = datetime('now'), resolved_by = ?
              WHERE id = ?`,
            actor, claimId,
        );
        logInfo(`Identity claim #${claimId} approved by ${actor}: ${claim.claimant_user_id} -> "${claim.iscored_username}"`);
    }

    static async reject(claimId: number, roomId: string, actor: string): Promise<void> {
        const db = await getDatabase();
        const res = await db.run(
            `UPDATE identity_claims SET status = 'rejected', resolved_at = datetime('now'), resolved_by = ?
              WHERE id = ? AND game_room_id = ? AND status = 'pending'`,
            actor, claimId, roomId,
        );
        if (!res.changes) throw new ClaimError('NOT_FOUND', 'That request is no longer pending.');
        logInfo(`Identity claim #${claimId} rejected by ${actor}`);
    }

    /**
     * Release an alias the caller holds, so they can stay under the cap.
     * Scoped to the caller's own linked identities — never someone else's.
     */
    static async releaseAlias(userId: string, iscoredUsername: string): Promise<boolean> {
        const db = await getDatabase();
        const ids = Array.from(await IdentityLinkService.expandCandidates(userId));
        if (ids.length === 0) return false;
        const placeholders = ids.map(() => '?').join(', ');
        const res = await db.run(
            `DELETE FROM user_mappings
              WHERE LOWER(iscored_username) = LOWER(?) AND discord_user_id IN (${placeholders})`,
            iscoredUsername, ...ids,
        );
        if (res.changes) {
            logWarn(`Identity alias released: ${userId} gave up "${iscoredUsername}"`);
            return true;
        }
        return false;
    }
}
