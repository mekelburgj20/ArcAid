import { getDatabase } from '../database/database.js';

/**
 * Read-time display resolution for leaderboard rows — v2.74.0 (S24.1).
 *
 * ## Why this exists
 *
 * `leaderboard_cache` and `global_leaderboard_cache` used to bake
 * `display_name` / `avatar_hash` straight into their cached JSON, which made a
 * profile edit a CACHE-CORRECTNESS problem: renaming yourself or changing your
 * avatar had to `invalidateAll()` (a whole-table DELETE of every room's
 * leaderboard), and the very next page load serially recalculated every game in
 * the room. Worse, the avatar path only nuked `LeaderboardService` — the Global
 * Scoreboard kept serving the OLD avatar forever, because nothing ever
 * invalidated `global_leaderboard_cache` on an avatar change.
 *
 * The fix is structural rather than "add one more invalidate call": the caches
 * now store IDENTITY-STABLE rows only (`submitted_by_user_id`, the raw per-row
 * discord id, `iscored_username`, score, provenance) and names/avatars are
 * joined on at READ time. A rename is then visible on the next read with no
 * invalidation at all, and it cannot go stale on one surface but not another,
 * because every surface resolves through this one helper.
 *
 * ## Why two batched queries rather than a SQL JOIN
 *
 * The read paths that consume the caches read JSON blobs, not rows, so there is
 * nothing to LEFT JOIN against without materialising a temp table. Two `IN (...)`
 * lookups over de-duplicated key sets reproduce the documented join EXACTLY
 * (see CLAUDE.md, "Display-name resolution in BE leaderboard queries") while
 * costing two round-trips for a WHOLE PAGE — where the pre-S24 code paid a join
 * per recalculated game.
 *
 * The resolution rule mirrored here, leg for leg:
 *   1. `user_mappings` resolves an `iscored:*` synthetic id to a real Discord
 *      user via `iscored_username` (case-insensitive). Only consulted when the
 *      row's raw id IS a synthetic — a real Discord id on the row is never
 *      re-resolved through someone's alias.
 *   2. `user_profiles` is keyed on `COALESCE(submitted_by_user_id,
 *      um.discord_user_id)`. Deliberately NOT on the raw per-row discord id: an
 *      unattributed row carrying a bare Discord id has never picked up a
 *      profile, and starting now would change what renders.
 *   3. The DISPLAYED id is `COALESCE(submitted_by_user_id, um.discord_user_id,
 *      raw)` — one leg wider than the profile key, exactly as before.
 */

/** The identity columns a cached/queried score row must carry. */
export interface ProfileIdentityKey {
    /** `score_history.submitted_by_user_id` / `global_scores.submitted_by_user_id`. */
    submitted_by_user_id?: string | null;
    /** The row's own discord id — may be an `iscored:*` synthetic or a sentinel. */
    discord_user_id?: string | null;
    iscored_username?: string | null;
}

/** What a resolved identity renders as. */
export interface ResolvedProfile {
    /** `COALESCE(submitted_by_user_id, user_mappings.discord_user_id, raw)`. */
    discord_user_id: string;
    display_name: string | null;
    avatar_hash: string | null;
    /**
     * v2.74.0 — full avatar URL (Google-linked users). `PlayerAvatar` prefers
     * it over `avatar_hash`; closes the ROADMAP "Google avatars never render on
     * leaderboards" line.
     */
    avatar_url: string | null;
}

/**
 * Resolve display identity for a batch of score rows. The returned array is
 * INDEX-ALIGNED with `rows`.
 *
 * Costs at most two queries regardless of batch size, and zero when the batch
 * needs neither lookup.
 */
export async function resolveProfiles(
    rows: ReadonlyArray<ProfileIdentityKey>,
): Promise<ResolvedProfile[]> {
    if (rows.length === 0) return [];

    const db = await getDatabase();

    // Leg 1 — user_mappings, only for rows whose raw id is an `iscored:*`
    // synthetic. Matches the LEFT JOIN's `discord_user_id LIKE 'iscored:%'`
    // guard; without it a COMMUNITY/ANON row could borrow a real user's profile
    // just because the typed name collides with someone's alias.
    const aliasNeedles = new Set<string>();
    for (const row of rows) {
        const raw = row.discord_user_id ?? '';
        const uname = row.iscored_username;
        if (raw.startsWith('iscored:') && uname) aliasNeedles.add(uname.toLowerCase());
    }
    const mappedIdByAlias = new Map<string, string>();
    if (aliasNeedles.size > 0) {
        const list = [...aliasNeedles];
        const ph = list.map(() => '?').join(',');
        const mappingRows = await db.all(
            `SELECT iscored_username, discord_user_id FROM user_mappings
             WHERE LOWER(iscored_username) IN (${ph})`,
            ...list,
        );
        for (const m of mappingRows) {
            mappedIdByAlias.set(String(m.iscored_username).toLowerCase(), m.discord_user_id);
        }
    }

    // Leg 2 — user_profiles, keyed on the profile key computed above.
    const profileKeys = new Set<string>();
    const perRow: Array<{ displayedId: string; profileKey: string | null }> = [];
    for (const row of rows) {
        const raw = row.discord_user_id ?? '';
        const uname = row.iscored_username;
        const mapped = (raw.startsWith('iscored:') && uname)
            ? mappedIdByAlias.get(uname.toLowerCase()) ?? null
            : null;
        const profileKey = row.submitted_by_user_id ?? mapped ?? null;
        if (profileKey) profileKeys.add(profileKey);
        perRow.push({
            displayedId: row.submitted_by_user_id ?? mapped ?? raw,
            profileKey,
        });
    }

    const profileById = new Map<string, { display_name: string | null; avatar_hash: string | null; avatar_url: string | null }>();
    if (profileKeys.size > 0) {
        const list = [...profileKeys];
        const ph = list.map(() => '?').join(',');
        const profileRows = await db.all(
            `SELECT discord_user_id, display_name, avatar_hash, avatar_url
             FROM user_profiles WHERE discord_user_id IN (${ph})`,
            ...list,
        );
        for (const p of profileRows) {
            profileById.set(p.discord_user_id, {
                display_name: p.display_name ?? null,
                avatar_hash: p.avatar_hash ?? null,
                avatar_url: p.avatar_url ?? null,
            });
        }
    }

    return perRow.map(({ displayedId, profileKey }) => {
        const profile = profileKey ? profileById.get(profileKey) : undefined;
        return {
            discord_user_id: displayedId,
            display_name: profile?.display_name || null,
            avatar_hash: profile?.avatar_hash || null,
            avatar_url: profile?.avatar_url || null,
        };
    });
}
