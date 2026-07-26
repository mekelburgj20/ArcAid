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
    /**
     * True (with reason/expiry) when `providerUserId` — or any identity
     * linked to it — has an active ban. Active = `lifted_at IS NULL AND
     * (expires_at IS NULL OR expires_at > now)`.
     */
    static async isIdentityBanned(providerUserId: string): Promise<BanCheckResult> {
        if (!providerUserId) return { banned: false };

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
