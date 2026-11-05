import type { Database } from 'sqlite';

/**
 * v2.220.0 (W93) — witness scores reach `submissions`.
 *
 * `submissions` is the best-score-per-player-per-game summary, and the
 * rotation close picks its winner from it ALONE (`TournamentEngine`
 * `processSlotMaintenance`: "Top scorer (local DB)"). Every manual path
 * wrote it; the witness ingest (`VpxScoreIngestService.writeBoardRow`) never
 * did, so a cabinet or Castcade score that topped a rotation board was
 * invisible to the close and the best TYPED score was crowned instead
 * (Krobs 31,269,280 vs Blegger 29,653,970, Weekly Grind - VPXS, 2026-11-04).
 *
 * The ingest writes the row from v2.220.0 on; this backfill gives every
 * EXISTING witness row that out-scores (or lacks) its summary row one, so
 * the boards that already carry witness scores resolve correctly at their
 * next close. Keyed exactly as the manual paths key it:
 * `<game id>-<board name lower>`. Rows a moderator orphaned are left out;
 * an existing higher summary row is kept. Idempotent.
 */
export async function backfillWitnessSubmissions(db: Database): Promise<number> {
    const result = await db.run(`
        INSERT INTO submissions (
            id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            submitted_by_anonymous_name, merged_from_anonymous_identity_id,
            platform, engine, device
        )
        SELECT
            h.game_id || '-' || LOWER(h.iscored_username),
            h.game_id,
            COALESCE(h.discord_user_id, 'SYSTEM'),
            h.iscored_username,
            h.score,
            NULL,
            h.created_at,
            h.game_room_id,
            h.submitted_during_tournament_id,
            h.submitted_by_user_id,
            NULL,
            NULL,
            h.platform,
            COALESCE(h.engine, 'unknown'),
            COALESCE(h.device, 'unknown')
        FROM score_history h
        JOIN games g ON g.id = h.game_id
        WHERE h.source = 'vpx'
          AND h.game_id IS NOT NULL
          AND h.orphaned_at IS NULL
          AND h.id = (
              SELECT h2.id FROM score_history h2
              WHERE h2.source = 'vpx'
                AND h2.game_id = h.game_id
                AND LOWER(h2.iscored_username) = LOWER(h.iscored_username)
                AND h2.orphaned_at IS NULL
              ORDER BY h2.score DESC, h2.created_at ASC, h2.id ASC
              LIMIT 1
          )
        ON CONFLICT(id) DO UPDATE SET
            score = excluded.score,
            timestamp = excluded.timestamp,
            discord_user_id = excluded.discord_user_id,
            submitted_by_user_id = COALESCE(excluded.submitted_by_user_id, submissions.submitted_by_user_id),
            submitted_during_tournament_id = COALESCE(excluded.submitted_during_tournament_id, submissions.submitted_during_tournament_id),
            platform = COALESCE(excluded.platform, submissions.platform),
            engine = COALESCE(NULLIF(excluded.engine, 'unknown'), submissions.engine, 'unknown'),
            device = COALESCE(NULLIF(excluded.device, 'unknown'), submissions.device, 'unknown')
        WHERE excluded.score > submissions.score
    `);
    return result.changes ?? 0;
}
