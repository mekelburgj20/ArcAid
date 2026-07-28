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

    /**
     * True (with reason/expiry) when `providerUserId` — or any identity
     * linked to it — has an active ban. Active = `lifted_at IS NULL AND
     * (expires_at IS NULL OR expires_at > now)`.
     */
    static async isIdentityBanned(providerUserId: string): Promise<BanCheckResult> {
        if (!providerUserId) return { banned: false };

        const now = Date.now();
        const hit = this.cache.get(providerUserId);
        if (hit && now - hit.ts < this.TTL_MS) return hit.value;

        const result = await this.computeIsIdentityBanned(providerUserId);
        this.cache.set(providerUserId, { value: result, ts: now });
        return result;
    }

    /** Drops the cached result for `providerUserId` only. Kept for callers that know
     *  they're only affecting one exact key; production ban/unban writers use
     *  `clearCache()` instead — see its doc comment for why. */
    static invalidate(providerUserId: string): void {
        this.cache.delete(providerUserId);
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

    private static async computeIsIdentityBanned(providerUserId: string): Promise<BanCheckResult> {
        const candidates = new Set<string>([providerUserId]);

        const canonical = await IdentityLinkService.resolveCanonical(providerUserId);
        candidates.add(canonical);

        // Any provider id linked TO this raw id (meaningful if providerUserId
        // is itself already a canonical/Discord identity with linked aliases).
        const linkedToRaw = await IdentityLinkService.getLinkForCanonical(providerUserId);
        for (const link of linkedToRaw) candidates.add(link.provider_user_id);

        // Any provider id linked TO the canonical resolution, when that
        // differs from the raw id (covers a login presenting the
        // already-linked non-canonical side).
        if (canonical !== providerUserId) {
            const linkedToCanonical = await IdentityLinkService.getLinkForCanonical(canonical);
            for (const link of linkedToCanonical) candidates.add(link.provider_user_id);
        }

        const ids = Array.from(candidates);
        const db = await getDatabase();
        const placeholders = ids.map(() => '?').join(', ');
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
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
             ORDER BY banned_at DESC LIMIT 1`,
            ...ids,
        );
        if (!row) return { banned: false };
        return { banned: true, reason: row.reason ?? undefined, expiresAt: row.expires_at ?? undefined };
    }
}
