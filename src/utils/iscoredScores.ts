import { logInfo, logWarn } from './logger.js';
import type { IScoredApiGameScores } from '../engine/IScoredApiClient.js';

/**
 * Normalize the iScored `getAllScores` flat response into grouped-by-game form.
 *
 * API returns: `{ scores: [{ name, game, gameName, score, date, rank }] }`
 * We need:     `[{ GameID, gameName, scores: [{ name, score, date, rank }] }]`
 *
 * Extracted verbatim from `ScoreSyncPoller.normalizeScoreResponse` (v2.117.0)
 * so the snapshot service and the poller share ONE normalisation rule. The
 * poller still calls this and nothing else — behaviour is byte-for-byte what it
 * was, including the two log lines (hence the `opts` seams below).
 *
 * NOTE: `src/commands/syncstate.ts` carries an older near-duplicate. It is
 * deliberately left alone — it is a different (per-game) shape.
 */
export function normalizeIScoredScoreResponse(
    data: any,
    opts?: {
        /** Prefix for the "unexpected shape" WARN. Defaults to the caller-agnostic label. */
        context?: string;
        /** When true, INFO-log the total flat entry count (poller does this on its first cycle). */
        logTotals?: boolean;
    },
): IScoredApiGameScores[] {
    const context = opts?.context ?? 'iScored scores';

    // getAllScores returns { scores: [...] } with flat score entries
    let flatScores: any[] = [];

    if (data && data.scores && Array.isArray(data.scores)) {
        flatScores = data.scores;
    } else if (Array.isArray(data)) {
        flatScores = data;
    } else {
        logWarn(`${context}: unexpected API response shape — keys: ${data ? Object.keys(data).join(', ') : 'null'}`);
        return [];
    }

    if (opts?.logTotals) {
        logInfo(`${context}: API returned ${flatScores.length} total score entries`);
    }

    // Group flat scores by game ID
    const grouped = new Map<string, IScoredApiGameScores>();
    for (const entry of flatScores) {
        const gameId = String(entry.game || entry.GameID || '');
        if (!gameId) continue;

        if (!grouped.has(gameId)) {
            grouped.set(gameId, {
                GameID: gameId,
                gameName: entry.gameName || '',
                scores: [],
            });
        }
        grouped.get(gameId)!.scores.push({
            name: entry.name || '',
            score: String(entry.score || '0'),
            date: entry.date || '',
            rank: entry.rank || '',
        });
    }

    return Array.from(grouped.values());
}
