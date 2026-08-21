import { getDatabase } from '../database/database.js';
import { IdentityLinkService } from './IdentityLinkService.js';

/**
 * S22 Phase 2 (v2.44.0) — ban enforcement at token issuance.
 *
 * `user_bans` (ScoreReportService.ts, S22 Phase 1) already models bans keyed
 * on `discord_user_id` (a provider user id — Discord snowflake, `google:*`,
 * or in principle any future provider). This service is the READ side used
 * at the enforcement points (OAuth callbacks, refresh, room creation) — it
 * does not duplicate the write side (ScoreReportService.ban/lift/listBans
 * stay the single source of truth for ban CRUD).
 *
 * Design decision #4 (contract): a ban may name EITHER side of an identity
 * link (`user_identity_links`, v2.36.0 Google<->Discord linking). A login
 * must be rejected whether the ban was placed on the raw id presented at
 * login, its canonical resolution, or a sibling id linked to that canonical
 * — otherwise a banned user trivially evades the ban by logging in via the
 * OTHER linked provider. `resolveCanonical` handles the "banned id was the
 * non-canonical side" direction; `getLinkForCanonical` (checked against both
 * the raw id AND its canonical, since the raw id might already BE a
 * different canonical than itself resolves to) handles "banned id is a
 * sibling alias" direction.
 *
 * v2.49.0 (room-tier bans, docs/contracts/room-bans-contract.md) — `isIdentityBanned`
 * takes an optional `gameRoomId`. Omitted/null preserves every pre-existing
 * call site's behavior exactly: global bans only (`game_room_id IS NULL`).
 * Passed: `(game_room_id IS NULL OR game_room_id = ?)` — a global ban still
 * bites inside every room, and a room ban only bites in ITS room (decision
 * 5 — a room ban must never block global surfaces or other rooms).
 */
export interface BanCheckResult {
    banned: boolean;
    reason?: string;
    expiresAt?: string;
}

export class BanService {
    // v2.47.0 (S22 follow-ups Workstream 1) — 10s in-memory TTL cache, same
    // idiom as `PickAwardGate.cache` / `NotificationService.flagCache`. Every
    // per-submit route now calls `isIdentityBanned` on the hot path (via
    // `requireNotBanned`), so a raw per-request DB round-trip (plus two
    // `IdentityLinkService` lookups) would meaningfully add load. Keyed on
    // the raw `providerUserId` as presented — cache invalidation on ban/unban
    // (`invalidate`) covers the "fresh ban must apply immediately" contract
    // requirement without needing correctness across the canonical/linked-id
    // expansion (a stale hit for a JUST-banned linked alias self-heals within
    // the 10s TTL, same tolerance PickAwardGate accepts for its 5s window).
    private static cache = new Map<string, { value: BanCheckResult; ts: number }>();
    private static readonly TTL_MS = 10_000;

    /** Composite cache key — room-scoped and global checks for the same id
     *  cache independently (a room ban must not be masked by a cached
     *  global-only "not banned" result, or vice versa). */
    private static cacheKey(providerUserId: string, gameRoomId: string | null): string {
        return `${providerUserId}::${gameRoomId ?? ''}`;
    }

    /**
     * True (with reason/expiry) when `providerUserId` — or any identity
     * linked to it — has an active ban. Active = `lifted_at IS NULL AND
     * (expires_at IS NULL OR expires_at > now)`.
     *
     * `gameRoomId` omitted/null → global bans only (matches every pre-v2.49
     * call site). Passed → also matches a ban scoped to that room.
     */
    static async isIdentityBanned(providerUserId: string, gameRoomId?: string | null): Promise<BanCheckResult> {
        if (!providerUserId) return { banned: false };

        const roomId = gameRoomId ?? null;
        const key = this.cacheKey(providerUserId, roomId);
        const now = Date.now();
        const hit = this.cache.get(key);
        if (hit && now - hit.ts < this.TTL_MS) return hit.value;

        const result = await this.computeIsIdentityBanned(providerUserId, roomId);
        this.cache.set(key, { value: result, ts: now });
        return result;
    }

    /** Drops the cached GLOBAL-scope result for `providerUserId` only. Kept for
     *  callers that know they're only affecting one exact key; production
     *  ban/unban writers use `clearCache()` instead — see its doc comment for
     *  why (a room-scoped cache entry for the same id would otherwise survive). */
    static invalidate(providerUserId: string): void {
        this.cache.delete(this.cacheKey(providerUserId, null));
    }

    /**
     * v2.47.0 (S22 follow-ups L2) — clears the WHOLE cache. `invalidate(id)`
     * only drops the entry keyed on the exact id passed in, but a ban can be
     * looked up under any of several linked-identity keys (the raw id, its
     * canonical resolution, sibling aliases — see `computeIsIdentityBanned`),
     * each cached under its OWN key. Invalidating only the banned/lifted id
     * left every other linked alias's cached "not banned" result stale for up
     * to the full 10s TTL. Bans are rare — a full clear is cheap and closes
     * that gap. Call from every ban-create/unban write path.
     */
    static clearCache(): void {
        this.cache.clear();
    }

    /** Test-only alias for `clearCache()` — kept for descriptive test call sites. */
    static clearCacheForTests(): void {
        this.clearCache();
    }

    /**
     * v2.49.0 fix-round (docs/contracts/room-bans-fixes.md #3) — the full link-graph
     * expansion for `providerUserId`, extracted out of `computeIsIdentityBanned`
     * so it's the ONE source of truth for "every identity this could be."
     * `computeIsIdentityBanned` uses it internally; callers that need to
     * check something OTHER than an active ban against the full identity
     * graph (e.g. the room-admin ban route's super-admin/room-admin target
     * guards, which previously only checked `IN (raw, canonical)` and missed
     * a super-admin or room-admin grant held on a linked sibling id) should
     * call this directly rather than re-deriving their own narrower
     * candidate set.
     */
    static async expandIdentityCandidates(providerUserId: string): Promise<string[]> {
        // v2.9x.0 (linked-identity role-sync fix) — delegates to
        // `IdentityLinkService.expandCandidates`, now the single source of
        // truth for this expansion (this method's public signature and
        // behavior are unchanged; only the implementation moved).
        return Array.from(await IdentityLinkService.expandCandidates(providerUserId));
    }

    private static async computeIsIdentityBanned(providerUserId: string, gameRoomId: string | null): Promise<BanCheckResult> {
        const ids = await this.expandIdentityCandidates(providerUserId);
        const db = await getDatabase();
        const placeholders = ids.map(() => '?').join(', ');
        // v2.49.0 — room-tier bans (decision 5): a room ban only bites in ITS
        // room, but a global ban (game_room_id IS NULL) always bites, room or
        // not. `gameRoomId === null` (the pre-v2.49 shape) stays global-only.
        const roomClause = gameRoomId
            ? 'AND (game_room_id IS NULL OR game_room_id = ?)'
            : 'AND game_room_id IS NULL';
        const params = gameRoomId ? [...ids, gameRoomId] : ids;
        const row = await db.get<{ reason: string | null; expires_at: string | null }>(
            // n-fix (S22 Phase 2 adversarial-review-anticipation) — comparing
            // the raw ISO 8601 string (`...T...Z`, what ScoreReportService.ban
            // stores via `.toISOString()`) directly against `datetime('now')`
            // (sqlite's `YYYY-MM-DD HH:MM:SS`, space-separated) is a string
            // comparison where 'T' (0x54) sorts AFTER ' ' (0x20) — so a
            // same-calendar-day expiry that's actually already PAST would
            // still compare as "greater than now" and read as still-active.
            // Wrapping both sides in `datetime(...)` normalizes to the same
            // representation before comparing. (This latent bug also affects
            // ScoreReportService.listBans' activeOnly filter, which uses the
            // same raw-string comparison — out of scope to fix here per the
            // Phase 2 contract; flagged for a follow-up.)
            `SELECT reason, expires_at FROM user_bans
             WHERE discord_user_id IN (${placeholders})
               AND lifted_at IS NULL
               ${roomClause}
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
             ORDER BY banned_at DESC LIMIT 1`,
            ...params,
        );
        if (!row) return { banned: false };
        return { banned: true, reason: row.reason ?? undefined, expiresAt: row.expires_at ?? undefined };
    }
}
