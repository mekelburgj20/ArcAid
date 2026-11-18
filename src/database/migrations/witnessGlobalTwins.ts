import type { Database } from 'sqlite';

/**
 * W106 — remove the second Global Scoreboard row a refused Witness play left.
 *
 * Until this release a Witness play that one tournament REFUSED (attempts
 * used up, not sanctioned) and another tournament TOOK got two
 * `global_scores` rows from one report: the refusal's fall-through row
 * (`origin_type = 'global'`, written by `VpxScoreIngestService.recordGlobal`)
 * and, milliseconds later, the landing's fan-out row
 * (`origin_type = 'game_room'`). The ingest now holds the fall-through until
 * every board has had its turn; this removes the rows it already wrote.
 *
 * Only an exact twin is removed. The fall-through row is recognised by what
 * `recordGlobal` writes and nothing else does: source `vpx`, Global origin,
 * no room, no game, no tournament stamp (a Throwdown landing is Global-origin
 * too, but carries its tournament). Its keeper is a live room fan-out row for
 * the same player, catalogue game and score written within a minute of it,
 * with the same sharing flag. A row the player deleted, a row somebody
 * reported, and a pair whose sharing flags differ are all left alone.
 *
 * The keeper is the row a room delete or correction finds
 * (`ScoreHistoryService.findFannedOutGlobalScoreId`), so it is the one to
 * keep. Trail rows that pointed at a removed row are unpointed: a refusal's
 * `global_score_id` means "kept on Global instead", which a play that landed
 * on a board never was. Each removed row is logged whole enough to put back.
 * Idempotent.
 */
export async function removeWitnessGlobalTwins(db: Database): Promise<number> {
    const twins = await db.all<Array<{
        id: string; global_game_id: string; player_id: string; score: number; submitted_at: string;
    }>>(`
        SELECT t.id, t.global_game_id, t.player_id, t.score, t.submitted_at
          FROM global_scores t
         WHERE t.source = 'vpx'
           AND t.origin_type = 'global'
           AND t.origin_game_room_id IS NULL
           AND t.origin_game_id IS NULL
           AND t.submitted_during_tournament_id IS NULL
           AND t.deleted_at IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM score_reports r WHERE r.score_id = t.id AND r.score_source = 'global'
           )
           AND EXISTS (
               SELECT 1 FROM global_scores k
                WHERE k.source = 'vpx'
                  AND k.origin_type = 'game_room'
                  AND k.global_game_id = t.global_game_id
                  AND k.player_id = t.player_id
                  AND k.score = t.score
                  AND k.deleted_at IS NULL
                  AND k.exclude_from_global = t.exclude_from_global
                  AND ABS(julianday(k.submitted_at) - julianday(t.submitted_at)) * 86400.0 <= 60
           )
         ORDER BY t.submitted_at`);

    for (const twin of twins) {
        await db.run(`UPDATE witness_evidence SET global_score_id = NULL WHERE global_score_id = ?`, twin.id);
        await db.run(`DELETE FROM global_scores WHERE id = ?`, twin.id);
        console.log(`[migration 217] removed duplicate Global row ${JSON.stringify(twin)}`);
    }
    // The cached boards may hold a removed row's id (boot clears only the room cache).
    if (twins.length > 0) await db.run(`DELETE FROM global_leaderboard_cache`);
    return twins.length;
}
