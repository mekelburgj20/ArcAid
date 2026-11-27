import { isProviderUserId } from '../utils/identityProvider.js';
import { getDatabase } from '../database/database.js';
import { sqliteLower } from '../utils/sqliteLower.js';
import { PreferencesService } from './PreferencesService.js';
import { RunRecapService } from './RunRecapService.js';
import type {
    PlayerRunLine, PlayerRunsResponse, RecapPlayerRef, TableRunsSummary,
} from '../types/runRecap.js';

/**
 * Roll-ups of run recaps for one player (PlayerDetail) and one table
 * (GameDetail), B31.3. Both reduce `RunRecapService.summarizeRuns`: they never
 * query score rows. Privacy is already applied by the compute (a hidden
 * player's play fields are null and their Witness games are left out of every
 * aggregate), so a table median or "most games in one run" cannot leak them.
 */

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function timeMs(s: string | null): number {
    if (!s) return -Infinity;
    const ms = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    return Number.isNaN(ms) ? -Infinity : ms;
}

/** Newest first; a missing time sorts last. */
function timeDesc(a: string | null, b: string | null): number {
    const ta = timeMs(a);
    const tb = timeMs(b);
    return ta === tb ? 0 : tb > ta ? 1 : -1;
}

export class RunRollupService {
    /**
     * identifier = a provider id (isProviderUserId) or an iScored/room name,
     * resolved like `/stats/enhanced/player/:identifier`: an id is the key; a
     * name is its alias's Discord id (user_mappings, NOCASE) when it has one
     * plus the synthetic `iscored:<name>` key.
     */
    static async playerRuns(roomId: string, identifier: string): Promise<PlayerRunsResponse> {
        let keys: string[];
        if (isProviderUserId(identifier)) {
            keys = [identifier];
        } else {
            const db = await getDatabase();
            const mapping = await db.get<{ discord_user_id: string | null }>(
                'SELECT discord_user_id FROM user_mappings WHERE iscored_username = ? COLLATE NOCASE', identifier,
            );
            keys = [];
            if (mapping?.discord_user_id) keys.push(mapping.discord_user_id);
            keys.push(`iscored:${sqliteLower(identifier)}`);
        }

        const { runs, refs } = await RunRecapService.summarizeRuns(roomId, { keys });
        const prefs = await PreferencesService.getRecapPrefsFor(keys);
        const hidden = keys.some(k => prefs.get(k)?.playStats === false);
        const wanted = new Set(keys);

        const lines: Array<PlayerRunLine & { _start: string | null }> = [];
        let ref: RecapPlayerRef | null = null;
        let refRank = Infinity;
        for (const { run, recap } of runs) {
            // Two keys of one player in one run (an alias): the better finish.
            let mine: (typeof recap.players)[number] | null = null;
            for (const p of recap.players) {
                if (wanted.has(p.key) && (!mine || p.rank < mine.rank)) mine = p;
            }
            if (!mine) continue;
            const found = refs.get(mine.key);
            if (found && (!ref || mine.rank < refRank)) { ref = found; refRank = mine.rank; }
            lines.push({
                game_id: run.game_id,
                game_name: run.game_name,
                tournament_id: run.tournament_id,
                tournament_name: run.tournament_name,
                state: run.state,
                end_date: run.end_date,
                image_url: run.image_url,
                games: hidden ? null : mine.games,
                average: hidden ? null : mine.average,
                best: mine.best,
                best_game_no: hidden ? null : mine.best_game_no,
                finish: mine.rank,
                field: recap.totals.players,
                _start: run.start_date,
            });
        }
        // Active runs first (newest start), then the closed ones newest end first.
        lines.sort((a, b) => {
            if ((a.state === 'active') !== (b.state === 'active')) return a.state === 'active' ? -1 : 1;
            return a.state === 'active' ? timeDesc(a._start, b._start) : timeDesc(a.end_date, b.end_date);
        });
        return {
            player: lines.length ? ref : null,
            play_stats: hidden ? 'hidden' : 'shown',
            runs: lines.map(({ _start, ...line }) => line),
        };
    }

    static async tableRuns(roomId: string, gameName: string): Promise<TableRunsSummary> {
        const { runs, refs } = await RunRecapService.summarizeRuns(roomId, {
            gameName, statuses: ['COMPLETED', 'ARCHIVED'],
        });
        const winning: number[] = [];
        const gameScores: number[] = [];
        let most: TableRunsSummary['most_games_in_run'] = null;
        for (const { run, recap } of runs) {
            if (recap.hero.best != null) winning.push(recap.hero.best);
            // `detail` is already empty for a hidden player.
            for (const d of recap.detail.values()) {
                for (const g of d.games) if (g.source === 'witness') gameScores.push(g.score);
            }
            const mg = recap.facts.most_games;
            const ref = mg ? refs.get(mg.player_key) : undefined;
            if (mg && ref && (!most || mg.games > most.games)) {
                most = { player: ref, games: mg.games, game_id: run.game_id, tournament_id: run.tournament_id };
            }
        }
        const recent = [...runs]
            .sort((a, b) => timeDesc(a.run.end_date, b.run.end_date))
            .slice(0, 10)
            .map(({ run, recap }) => ({
                game_id: run.game_id,
                tournament_id: run.tournament_id,
                tournament_name: run.tournament_name,
                end_date: run.end_date,
                winner: recap.hero.winner_key ? refs.get(recap.hero.winner_key) ?? null : null,
                winning_score: recap.hero.best,
                players: recap.totals.players,
                witness_games: recap.totals.witness_games,
            }));
        return {
            game_name: runs[0]?.run.game_name ?? gameName,
            runs: runs.length,
            typical_winning_score: median(winning),
            median_game: median(gameScores),
            most_games_in_run: most,
            recent,
        };
    }
}
