import { getDatabase } from '../database/database.js';
import { IdentityClaimService, MATCH_REASON } from './IdentityClaimService.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { isGoogleUserId } from '../utils/identityProvider.js';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * Auto-link an UNCLAIMED iScored name to the account that already answers to it
 * (identity arc, owner ruling 2026-08-20: "soggybacon should've auto linked").
 *
 * WHY. P1 (v2.112.0) made claiming an iScored name safe, but it still required
 * the player to go and DO something. On 2026-08-20 the rtx_pinball Daily Grind
 * rotated with its top TWO scorers unlinked; the pick cascade strips
 * unattributed rows, so it skipped both and activated fourth place's queued
 * game. One of them (DennisB) fixed it 59 minutes later by setting a display
 * name — an exact match, which auto-approved instantly. That is the tell: the
 * system already trusted the match, it just waited for a human to ask.
 *
 * THE TRUST BAR IS UNCHANGED, DELIBERATELY. This service files a claim through
 * `IdentityClaimService.claim` and nothing else. It never writes `user_mappings`
 * directly. Everything P1 guarantees therefore still holds, for free:
 *   - the alias cap of 3 (`aliasCount`),
 *   - one-name-one-account (the UNIQUE index plus the pre-flight check),
 *   - an `identity_claims` audit row with `auto_matched_on` and `resolved_by`,
 *   - the refusal to touch a name someone else already holds.
 * The ONLY thing added here is the trigger — the decision is still P1's.
 *
 * `matchReasonFor` is consulted BEFORE `claim` so a non-matching name is never
 * even offered: a background trigger must not be able to file a PENDING claim,
 * which would fill a mod queue with requests no human made.
 *
 * KILL SWITCH: `IDENTITY_AUTO_LINK_EXACT`, global (env/settings) or per-room.
 * Absent means ON; only the literal string 'false' disables it.
 */

export const AUTO_LINK_SETTING = 'IDENTITY_AUTO_LINK_EXACT';

/** How many names one trigger will link in a single pass. The alias cap is 3. */
const MAX_LINKS_PER_PASS = 3;

/** SQLite's default host-parameter ceiling is 999; stay well under it. */
const PARAM_CHUNK = 300;

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

export class IdentityAutoLinkService {
    /**
     * Kill switch. Global first (a super-admin turning it off means off
     * everywhere), then the per-room override for a room that wants manual
     * claiming only.
     */
    static async isEnabled(roomId?: string | null): Promise<boolean> {
        if (process.env[AUTO_LINK_SETTING] === 'false') return false;
        if (roomId) {
            try {
                if ((await GameRoomSettingsService.get(roomId, AUTO_LINK_SETTING)) === 'false') return false;
            } catch {
                // A settings read failure must not decide policy; default stays on.
            }
        }
        return true;
    }

    /**
     * The names this account may be auto-linked on.
     *
     * Straight from `IdentityClaimService.knownNamesFor` — same sources, same
     * normalization — with ONE narrowing: a Google-only canonical has no Discord
     * username, so its stored `username` is really a Google display name. A
     * human filing that claim by hand still auto-approves (P1's rule is
     * untouched); the unattended path holds itself to the display name and the
     * verified email local-part instead.
     */
    private static async matchKeysFor(userId: string): Promise<Map<string, string>> {
        const known = await IdentityClaimService.knownNamesFor(userId);
        if (!isGoogleUserId(userId)) return known;
        const narrowed = new Map<string, string>();
        for (const [key, reason] of known) {
            if (reason !== MATCH_REASON.username) narrowed.set(key, reason);
        }
        return narrowed;
    }

    /**
     * Link one name if — and only if — P1 would auto-approve it.
     *
     * Returns true when a mapping now exists because of THIS call. Never throws:
     * every trigger is fire-and-forget on a path (login, sync poll) that must
     * not fail because an identity nicety failed.
     */
    static async autoLinkName(userId: string, roomId: string | null, rawName: string): Promise<boolean> {
        const name = (rawName ?? '').trim();
        if (!name) return false;
        try {
            if (!(await this.isEnabled(roomId))) return false;

            const keys = await this.matchKeysFor(userId);
            if (!keys.has(name.toLowerCase())) return false;

            // Don't race the mod queue: if someone ELSE is waiting on a human
            // decision for this name, an unattended link would pre-empt the very
            // review that exists to settle it.
            const db = await getDatabase();
            const contested = await db.get(
                `SELECT id FROM identity_claims
                  WHERE LOWER(iscored_username) = LOWER(?) AND status = 'pending'
                    AND claimant_user_id != ?`,
                name, userId,
            );
            if (contested) {
                logInfo(`Identity auto-link skipped: "${name}" has a pending claim from another account.`);
                return false;
            }

            const outcome = await IdentityClaimService.claim(userId, roomId, name);
            return outcome.result === 'auto_approved';
        } catch (error) {
            // ClaimError (ALREADY_CLAIMED / TOO_MANY_ALIASES / ...) is an
            // expected outcome here, not a fault — the whole point of routing
            // through `claim` is that its refusals apply.
            logWarn(`Identity auto-link declined for "${name}": ${(error as Error)?.message ?? error}`);
            return false;
        }
    }

    /**
     * LOGIN TRIGGER. Scan the iScored-origin names sitting unclaimed in the
     * rooms this user can be expected to care about, and link the exact matches.
     *
     * `roomId` is the room being entered when the caller knows it; the rest come
     * from `room_members`, so a player who logs in from the global surface still
     * gets their name in every room they belong to. Costs one scan of the score
     * tables per login, and only for names the user already answers to — an
     * account with no display name and no username matches nothing and returns
     * after a single `knownNamesFor`.
     */
    static async autoLinkForUser(userId: string, opts: { roomId?: string | null } = {}): Promise<string[]> {
        try {
            if (!(await this.isEnabled(opts.roomId ?? null))) return [];

            const keys = await this.matchKeysFor(userId);
            if (keys.size === 0) return [];

            const db = await getDatabase();
            const memberRooms = await db.all('SELECT room_id FROM room_members WHERE user_id = ?', userId);
            const rooms = new Set<string>(memberRooms.map((r: any) => r.room_id).filter(Boolean));
            if (opts.roomId) rooms.add(opts.roomId);
            if (rooms.size === 0) return [];

            const roomList = Array.from(rooms);
            const nameKeys = Array.from(keys.keys());
            const linked: string[] = [];

            for (const nameChunk of chunk(nameKeys, PARAM_CHUNK)) {
                if (linked.length >= MAX_LINKS_PER_PASS) break;
                const namePh = nameChunk.map(() => '?').join(', ');
                const roomPh = roomList.map(() => '?').join(', ');
                // Both score tables, because a room synced before `score_history`
                // carried sync rows still has the evidence only in `submissions`.
                // `submitted_by_user_id IS NULL AND discord_user_id LIKE 'iscored:%'`
                // is the poller's own signature for "nobody owns this row".
                const rows = await db.all(
                    `SELECT name, room_id, SUM(n) AS n FROM (
                         SELECT iscored_username AS name, game_room_id AS room_id, COUNT(*) AS n
                           FROM score_history
                          WHERE source = 'sync' AND game_room_id IN (${roomPh})
                            AND LOWER(TRIM(iscored_username)) IN (${namePh})
                          GROUP BY LOWER(iscored_username), game_room_id
                         UNION ALL
                         SELECT s.iscored_username AS name, s.submitted_from_room_id AS room_id, COUNT(*) AS n
                           FROM submissions s
                          WHERE s.submitted_by_user_id IS NULL AND s.discord_user_id LIKE 'iscored:%'
                            AND s.submitted_from_room_id IN (${roomPh})
                            AND LOWER(TRIM(s.iscored_username)) IN (${namePh})
                          GROUP BY LOWER(s.iscored_username), s.submitted_from_room_id
                     )
                     WHERE NOT EXISTS (
                         SELECT 1 FROM user_mappings um WHERE LOWER(um.iscored_username) = LOWER(name)
                     )
                     GROUP BY LOWER(name), room_id
                     ORDER BY n DESC`,
                    ...roomList, ...nameChunk, ...roomList, ...nameChunk,
                );

                const firstRoomForName = new Map<string, { name: string; roomId: string }>();
                for (const row of rows) {
                    const key = String(row.name ?? '').trim().toLowerCase();
                    if (!key || firstRoomForName.has(key)) continue;
                    firstRoomForName.set(key, { name: String(row.name).trim(), roomId: row.room_id });
                }

                for (const { name, roomId } of firstRoomForName.values()) {
                    if (linked.length >= MAX_LINKS_PER_PASS) break;
                    if (await this.autoLinkName(userId, roomId, name)) {
                        linked.push(name);
                        const room = await db.get('SELECT slug FROM game_rooms WHERE id = ?', roomId);
                        logInfo(`Identity auto-linked at login: ${userId} -> "${name}" in ${room?.slug ?? roomId} (exact match on ${keys.get(name.toLowerCase())})`);
                    }
                }
            }

            return linked;
        } catch (error) {
            logWarn('Identity auto-link at login failed (login continues):', error);
            return [];
        }
    }

    /**
     * SYNC TRIGGER helper. One batched `user_profiles` lookup for a whole poll
     * cycle's worth of unmapped iScored names.
     *
     * SCOPED TO `roomIds` — the rooms sharing the polled iScored account. The
     * login trigger can afford a global name match because a human presented
     * credentials for that exact account; sync has no such proof, only a string
     * on someone else's leaderboard. An iScored name "Jay" on one room's board
     * must not attach to an unrelated Arcaid user `jay` who has never set foot
     * in that room, so candidates are restricted to that room's MEMBERS.
     *
     * Returns lowercased name -> the single account that answers to it. A name
     * two different members answer to is DROPPED, not guessed at: an ambiguous
     * exact match is exactly the case the mod queue exists for.
     */
    static async candidateOwnersForNames(
        db: any,
        lowerNames: string[],
        roomIds: string[],
    ): Promise<Map<string, string>> {
        if (roomIds.length === 0) return new Map();
        const roomPh = roomIds.map(() => '?').join(', ');
        const owners = new Map<string, Set<string>>();
        for (const nameChunk of chunk(lowerNames, PARAM_CHUNK)) {
            const ph = nameChunk.map(() => '?').join(', ');
            // Membership is checked on the raw `discord_user_id` rather than an
            // expanded link graph: a linked pair's rows are re-keyed onto the
            // canonical at link time, and an unattended trigger is the wrong
            // place to reach across identities on a maybe.
            const rows = await db.all(
                `SELECT discord_user_id, username, display_name FROM user_profiles
                  WHERE (LOWER(TRIM(username)) IN (${ph}) OR LOWER(TRIM(display_name)) IN (${ph}))
                    AND discord_user_id IN (
                        SELECT user_id FROM room_members WHERE room_id IN (${roomPh})
                    )`,
                ...nameChunk, ...nameChunk, ...roomIds,
            );
            const wanted = new Set(nameChunk);
            for (const row of rows) {
                for (const raw of [row.username, row.display_name]) {
                    const key = String(raw ?? '').trim().toLowerCase();
                    if (!key || !wanted.has(key)) continue;
                    if (!owners.has(key)) owners.set(key, new Set());
                    owners.get(key)!.add(row.discord_user_id);
                }
            }
        }
        const out = new Map<string, string>();
        for (const [key, ids] of owners) {
            if (ids.size === 1) out.set(key, Array.from(ids)[0]!);
        }
        return out;
    }
}
