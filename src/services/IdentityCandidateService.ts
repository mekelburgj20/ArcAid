import { getDatabase } from '../database/database.js';
import { BanService } from './BanService.js';
import { IdentityLinkService } from './IdentityLinkService.js';

/**
 * v2.82.0 (My Stats v1, Identity arc Phase 3, WS1 decision 1) — the shared
 * "every name this person might appear under, across every score table" set.
 * Composes two existing, independently-owned axes rather than re-deriving
 * either:
 *
 *   - `BanService.expandIdentityCandidates` (v2.49.0) is the declared single
 *     source of truth for LOGIN-IDENTITY link-graph expansion — the raw
 *     provider id presented at login, its canonical resolution, and every
 *     sibling id linked to either side. See that method's doc comment.
 *   - `user_mappings` (iScored username -> discord_user_id) is the OTHER,
 *     unrelated axis: a Discord user's game-handle ALIASES, i.e. names typed
 *     into iScored that got `/map-user`'d or merged onto this account. See
 *     `IdentityLinkService`'s doctrine comment for why these two mechanisms
 *     must never be conflated. My Stats needs both — a linked Google/Discord
 *     pair AND every iScored alias either side of that pair has claimed.
 *
 * `playerKeys` is deliberately shaped to match what `StatsService` /
 * `GlobalLeaderboardService` partition-key expressions actually compare
 * against: the raw provider ids as-is, plus each iScored alias folded to the
 * `'iscored:' || lower(username)` synthetic form those queries already use
 * for NULL-attribution (pre-link sync) rows.
 *
 * `canonicalKey` is what every alias in `playerKeys` collapses TO for ranking
 * purposes — see `StatsService.getPersonalBestsForIdentities`'s doctrine
 * comment for why a caller must canonicalize INSIDE the query rather than
 * filtering with a bare `player_key IN (playerKeys)`.
 */
export interface IdentityCandidates {
    /** The identity every alias in `playerKeys` collapses TO for rank/count purposes. */
    canonicalKey: string;
    /** Login-identity link-graph expansion (BanService's single source of truth). */
    ids: string[];
    /** iScored usernames mapped to any id in `ids` via `user_mappings`. */
    aliases: string[];
    /** `ids` ∪ `aliases` folded to the `'iscored:<lower-username>'` synthetic form — the full candidate set to match against `player_key`-shaped SQL expressions. */
    playerKeys: string[];
}

export class IdentityCandidateService {
    static async forUser(tokenId: string): Promise<IdentityCandidates> {
        const ids = await BanService.expandIdentityCandidates(tokenId);

        const db = await getDatabase();
        const placeholders = ids.map(() => '?').join(', ');
        const aliasRows = await db.all<{ iscored_username: string }[]>(
            `SELECT iscored_username FROM user_mappings WHERE discord_user_id IN (${placeholders})`,
            ...ids,
        );
        const aliases = aliasRows.map(r => r.iscored_username);

        const playerKeys = [...ids, ...aliases.map(a => `iscored:${a.toLowerCase()}`)];

        const canonicalKey = await IdentityLinkService.resolveCanonical(tokenId);

        return { canonicalKey, ids, aliases, playerKeys };
    }
}
