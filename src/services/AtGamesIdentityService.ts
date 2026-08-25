import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';
import { invalidateIdentityCaches } from './IdentityAliasEffectsService.js';

/**
 * P7 — attaching an AtGames account to an Arcaid one.
 *
 * ## Why this exists at all
 *
 * A score pulled from AtGames arrives with an AtGames account id and an AtGames
 * handle, and nothing else. Arcaid deliberately refuses to guess which local
 * player that is: name-matching a third party's handle is how one player ends
 * up owning another player's scores, permanently and silently. So an unlinked
 * AtGames score lands anonymous — visible on the board under its AtGames name,
 * owned by nobody — and stays that way until a human says who it is.
 *
 * This service is that "human says who it is" step, plus the sweep that goes
 * back and claims the scores already ingested under the account.
 *
 * ## Shape
 *
 * The link lives in `user_identity_links` as `atgames:<account id>` →
 * canonical Arcaid user, the same table Google logins use (ADR 0015). No new
 * table: an AtGames account is one more provider identity, it just happens to
 * be one nobody logs in with.
 *
 * ## The freeze gate
 *
 * Re-attribution deliberately SKIPS rows belonging to a finished tournament,
 * matching `MergeService.previewMerge` and `IdentityAliasEffectsService`. A
 * concluded event's standings are a historical record; linking an account
 * afterwards must not silently rewrite who won last week.
 */

export interface AtGamesAccountRow {
    /** The numeric AtGames account id (the part after `atgames:`). */
    atgamesAccountId: number;
    /** The AtGames handle, as AtGames spells it. */
    userName: string;
    /** How many scores from this account are in this tournament. */
    scoreCount: number;
    /** The Arcaid account it is attached to, or null when nobody has said. */
    linkedUserId: string | null;
    linkedDisplayName: string | null;
}

export class AtGamesLinkError extends Error {
    readonly code: 'LINK_CONFLICT' | 'BAD_ACCOUNT_ID';
    constructor(code: AtGamesLinkError['code'], message: string) {
        super(message);
        this.name = 'AtGamesLinkError';
        this.code = code;
    }
}

/** `atgames:<id>` from a numeric id, rejecting anything that is not one. */
function providerId(atgamesAccountId: number | string): string {
    const n = Number(atgamesAccountId);
    if (!Number.isInteger(n) || n <= 0) {
        throw new AtGamesLinkError('BAD_ACCOUNT_ID', `"${atgamesAccountId}" is not an AtGames account id`);
    }
    return `atgames:${n}`;
}

export class AtGamesIdentityService {
    /**
     * Every AtGames account that appears in this tournament's scores, with
     * whoever it is attached to.
     *
     * Reads the ingested rows rather than AtGames — the host is answering "who
     * is this?" about names already on their board, and this must work without
     * a live AtGames call.
     */
    static async listAccountsForTournament(tournamentId: string): Promise<AtGamesAccountRow[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<{
            discord_user_id: string;
            user_name: string;
            n: number;
            linked_user_id: string | null;
            display_name: string | null;
        }>>(
            `SELECT sh.discord_user_id,
                    MAX(sh.iscored_username) AS user_name,
                    COUNT(*) AS n,
                    uil.canonical_user_id AS linked_user_id,
                    up.display_name
             FROM score_history sh
             LEFT JOIN user_identity_links uil ON uil.provider_user_id = sh.discord_user_id
             LEFT JOIN user_profiles up ON up.discord_user_id = uil.canonical_user_id
             WHERE sh.submitted_during_tournament_id = ?
               AND sh.source = 'atgames'
               AND sh.discord_user_id LIKE 'atgames:%'
             GROUP BY sh.discord_user_id, uil.canonical_user_id, up.display_name
             ORDER BY n DESC`,
            tournamentId,
        );

        // Rows already attributed carry the REAL user id in discord_user_id, so
        // they never match the LIKE above. Fold them in from the other side so
        // the host sees one list, not "the ones that worked" and "the rest".
        const attributed = await db.all<Array<{
            provider_user_id: string; user_name: string; n: number;
            linked_user_id: string; display_name: string | null;
        }>>(
            `SELECT uil.provider_user_id,
                    MAX(sh.iscored_username) AS user_name,
                    COUNT(*) AS n,
                    uil.canonical_user_id AS linked_user_id,
                    up.display_name
             FROM score_history sh
             JOIN user_identity_links uil ON uil.canonical_user_id = sh.submitted_by_user_id
             LEFT JOIN user_profiles up ON up.discord_user_id = uil.canonical_user_id
             WHERE sh.submitted_during_tournament_id = ?
               AND sh.source = 'atgames'
               AND uil.provider_user_id LIKE 'atgames:%'
             GROUP BY uil.provider_user_id, uil.canonical_user_id, up.display_name`,
            tournamentId,
        );

        const byProvider = new Map<string, AtGamesAccountRow>();
        for (const r of rows) {
            byProvider.set(r.discord_user_id, {
                atgamesAccountId: Number(r.discord_user_id.slice('atgames:'.length)),
                userName: r.user_name,
                scoreCount: r.n,
                linkedUserId: r.linked_user_id,
                linkedDisplayName: r.display_name,
            });
        }
        for (const r of attributed) {
            const existing = byProvider.get(r.provider_user_id);
            if (existing) {
                existing.scoreCount += r.n;
                existing.linkedUserId = r.linked_user_id;
                existing.linkedDisplayName = r.display_name;
                continue;
            }
            byProvider.set(r.provider_user_id, {
                atgamesAccountId: Number(r.provider_user_id.slice('atgames:'.length)),
                userName: r.user_name,
                scoreCount: r.n,
                linkedUserId: r.linked_user_id,
                linkedDisplayName: r.display_name,
            });
        }
        return [...byProvider.values()].sort((a, b) => b.scoreCount - a.scoreCount);
    }

    /**
     * Attach an AtGames account to an Arcaid account and claim its past scores.
     *
     * Idempotent when it is already attached to the SAME account (re-running the
     * sweep is the repair path for a link made before more scores arrived).
     * A different account is a conflict, never a silent re-point — last-write-
     * wins on an identity link is how one player quietly inherits another's
     * history.
     */
    static async linkAccount(
        atgamesAccountId: number | string,
        canonicalUserId: string,
    ): Promise<{ rowsAttributed: number }> {
        const provider = providerId(atgamesAccountId);
        const db = await getDatabase();

        const existing = await db.get<{ canonical_user_id: string }>(
            'SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?',
            provider,
        );
        if (existing && existing.canonical_user_id !== canonicalUserId) {
            throw new AtGamesLinkError(
                'LINK_CONFLICT',
                `AtGames account ${atgamesAccountId} is already attached to a different player`,
            );
        }

        let rowsAttributed = 0;
        await db.exec('BEGIN');
        try {
            if (!existing) {
                await db.run(
                    `INSERT INTO user_identity_links (provider_user_id, canonical_user_id)
                     VALUES (?, ?) ON CONFLICT(provider_user_id) DO NOTHING`,
                    provider, canonicalUserId,
                );
            }
            // Claim the scores already ingested under the synthetic id. The
            // freeze gate keeps a concluded event's standings as they were.
            const res = await db.run(
                `UPDATE score_history
                    SET submitted_by_user_id = ?, discord_user_id = ?, submitted_by_anonymous_name = NULL
                  WHERE discord_user_id = ?
                    AND source = 'atgames'
                    AND submitted_by_user_id IS NULL
                    AND (
                        submitted_during_tournament_id IS NULL
                        OR submitted_during_tournament_id IN (
                            SELECT id FROM tournaments WHERE is_active = 1
                        )
                    )`,
                canonicalUserId, canonicalUserId, provider,
            );
            rowsAttributed = typeof res.changes === 'number' ? res.changes : 0;
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        if (rowsAttributed > 0) await invalidateIdentityCaches();
        logInfo(`AtGames: linked ${provider} to ${canonicalUserId}; ${rowsAttributed} score(s) re-attributed`);
        return { rowsAttributed };
    }

    /**
     * Detach an AtGames account and put its scores back to anonymous.
     *
     * Only rows this link is responsible for are touched — `source = 'atgames'`
     * scores currently sitting under that Arcaid account. A player's own web or
     * Discord submissions are never re-anonymised by an unlink.
     */
    static async unlinkAccount(atgamesAccountId: number | string): Promise<{ rowsReanonymized: number }> {
        const provider = providerId(atgamesAccountId);
        const db = await getDatabase();

        const existing = await db.get<{ canonical_user_id: string }>(
            'SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?',
            provider,
        );
        if (!existing) return { rowsReanonymized: 0 };

        let rowsReanonymized = 0;
        await db.exec('BEGIN');
        try {
            await db.run('DELETE FROM user_identity_links WHERE provider_user_id = ?', provider);
            const res = await db.run(
                `UPDATE score_history
                    SET submitted_by_user_id = NULL, discord_user_id = ?, submitted_by_anonymous_name = iscored_username
                  WHERE source = 'atgames'
                    AND submitted_by_user_id = ?
                    AND (
                        submitted_during_tournament_id IS NULL
                        OR submitted_during_tournament_id IN (
                            SELECT id FROM tournaments WHERE is_active = 1
                        )
                    )`,
                provider, existing.canonical_user_id,
            );
            rowsReanonymized = typeof res.changes === 'number' ? res.changes : 0;
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        if (rowsReanonymized > 0) await invalidateIdentityCaches();
        logInfo(`AtGames: unlinked ${provider}; ${rowsReanonymized} score(s) returned to anonymous`);
        return { rowsReanonymized };
    }
}
