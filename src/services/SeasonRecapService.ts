import { getDatabase } from '../database/database.js';
import { getRecapPrefsVersion } from './PreferencesService.js';
import { RunRecapService } from './RunRecapService.js';
import { resolveProfiles } from './PlayerProfileResolver.js';
import type { ComputedRunRecap } from '../utils/runRecapCompute.js';
import type {
    RecapPlayerRef, RecapRunLink, RoomRecord, RoomRecordId, RoomRecordsResponse, RunRecap,
    SeasonAward, SeasonRecap,
} from '../types/runRecap.js';

/**
 * Season recap (a tournament's "By the numbers") and room records (B31.4;
 * docs/run-recap-plan.md). Both REDUCE `RunRecapService.summarizeRuns`: they
 * never query score rows to compute a figure. Hidden players (recap_play_stats
 * = 0) already carry null games and are left out of every run aggregate by the
 * compute, so no volume award can name them and no total counts their games.
 */

type SummarizedRun = { run: RunRecap['run']; recap: ComputedRunRecap };

/** A tie shares up to 3; 4 or more are omitted (same rule as a run's awards). */
const TIE_MAX = 3;

export const SEASON_MIN = {
    runsWon: 2, everyTableRuns: 3, games: 10, leadChanges: 3, comebackRatio: 0.25,
} as const;
const STREAK_MIN_GAMES = 5;

const pct = (ratio: number, digits = 1): string => `${(ratio * 100).toFixed(digits)}`;

const linkOf = (run: RunRecap['run']): RecapRunLink => ({
    game_id: run.game_id, game_name: run.game_name, tournament_id: run.tournament_id,
    tournament_name: run.tournament_name, end_date: run.end_date,
});

/** Keys holding the extreme value, or null when empty / more than TIE_MAX share it. */
function extremeKeys(entries: Array<{ key: string; v: number }>, dir: 'max' | 'min', minimum: number): { keys: string[]; v: number } | null {
    const eligible = entries.filter(e => (dir === 'max' ? e.v >= minimum : true));
    if (eligible.length === 0) return null;
    const best = eligible.reduce((a, e) => (dir === 'max' ? Math.max(a, e.v) : Math.min(a, e.v)), eligible[0]!.v);
    const keys = eligible.filter(e => e.v === best).map(e => e.key);
    if (keys.length > TIE_MAX) return null;
    return { keys, v: best };
}

/** The run holding the extreme value; a tie goes to the EARLIEST finished run (it set the mark first). */
function extremeRun<T>(items: Array<{ run: RunRecap['run']; v: number; extra: T }>, dir: 'max' | 'min'):
    { run: RunRecap['run']; v: number; extra: T } | null {
    if (items.length === 0) return null;
    let best = items[0]!;
    for (const it of items.slice(1)) {
        const better = dir === 'max' ? it.v > best.v : it.v < best.v;
        const tie = it.v === best.v && (it.run.end_date ?? '') < (best.run.end_date ?? '');
        if (better || tie) best = it;
    }
    return best;
}

const completed = (runs: SummarizedRun[]) => runs.filter(r => r.run.state === 'completed');
const winnerOf = (r: SummarizedRun): string | null => r.recap.hero.winner_key ?? r.recap.players.find(p => p.rank === 1)?.key ?? null;

/** Per run: (1st - 2nd) / 1st from the compute, with the two keys. */
function marginItems(runs: SummarizedRun[]) {
    return runs
        .filter(r => r.recap.facts.closest_finish_ratio != null && r.recap.players.length >= 2)
        .map(r => ({ run: r.run, v: r.recap.facts.closest_finish_ratio as number, extra: r.recap.players.slice(0, 2).map(p => p.key) }));
}

/** One ref per key, resolved at READ (never cached). A key with no findable row is dropped. */
export async function resolveRefs(roomId: string, keys: string[]): Promise<Map<string, RecapPlayerRef>> {
    const out = new Map<string, RecapPlayerRef>();
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) return out;
    const db = await getDatabase();
    type Row = { submitted_by_user_id: string | null; discord_user_id: string | null; iscored_username: string };
    const found = new Map<string, Row>();
    const real = wanted.filter(k => !k.toLowerCase().startsWith('iscored:'));
    const synth = wanted.filter(k => k.toLowerCase().startsWith('iscored:'));
    for (let i = 0; i < real.length; i += 400) {
        const chunk = real.slice(i, i + 400);
        const rows = await db.all<Row[]>(
            `SELECT submitted_by_user_id, MAX(discord_user_id) AS discord_user_id, MAX(iscored_username) AS iscored_username
               FROM score_history WHERE game_room_id = ? AND submitted_by_user_id IN (${chunk.map(() => '?').join(',')})
              GROUP BY submitted_by_user_id`, roomId, ...chunk);
        for (const r of rows) found.set(r.submitted_by_user_id!, r);
    }
    const synthNames = synth.map(k => k.slice('iscored:'.length));
    for (let i = 0; i < synthNames.length; i += 400) {
        const chunk = synthNames.slice(i, i + 400);
        const rows = await db.all<Row[]>(
            `SELECT submitted_by_user_id, discord_user_id, iscored_username, LOWER(iscored_username) AS lname
               FROM score_history WHERE game_room_id = ? AND submitted_by_user_id IS NULL
                AND LOWER(iscored_username) IN (${chunk.map(() => '?').join(',')})
              GROUP BY LOWER(iscored_username)`, roomId, ...chunk.map(n => n.toLowerCase()));
        for (const r of rows as Array<Row & { lname: string }>) found.set(`iscored:${r.lname}`, r);
    }
    // Event-round keys can be a mapped Discord id with no row of their own: fall back to an alias.
    const missing = wanted.filter(k => !found.has(k) && !k.toLowerCase().startsWith('iscored:'));
    for (let i = 0; i < missing.length; i += 400) {
        const chunk = missing.slice(i, i + 400);
        const rows = await db.all<Array<{ discord_user_id: string; iscored_username: string }>>(
            `SELECT discord_user_id, MIN(iscored_username) AS iscored_username FROM user_mappings
              WHERE discord_user_id IN (${chunk.map(() => '?').join(',')}) GROUP BY discord_user_id`, ...chunk);
        for (const r of rows) found.set(r.discord_user_id, { submitted_by_user_id: r.discord_user_id, discord_user_id: r.discord_user_id, iscored_username: r.iscored_username });
    }
    const keyList = wanted.filter(k => found.has(k));
    const profiles = await resolveProfiles(keyList.map(k => found.get(k)!));
    keyList.forEach((k, i) => {
        const row = found.get(k)!;
        const p = profiles[i]!;
        out.set(k, {
            key: k, iscored_username: row.iscored_username, display_name: p.display_name ?? null,
            discord_user_id: p.discord_user_id && !p.discord_user_id.toLowerCase().startsWith('iscored:') ? p.discord_user_id : null,
            avatar_hash: p.avatar_hash ?? null, avatar_url: p.avatar_url ?? null,
        });
    });
    return out;
}

// ---- room records cache (ids only; names resolve after the cache read) ----

type RecordsValue = { records: RoomRecord[]; generated_at: string };
const recordsCache = new Map<string, { watermark: string; value: RecordsValue }>();

async function recordsWatermark(roomId: string): Promise<string> {
    const db = await getDatabase();
    const s = await db.get<{ n: number; maxid: number; sum: number }>(
        'SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS maxid, COALESCE(SUM(score), 0) AS sum FROM score_history WHERE game_room_id = ?', roomId);
    const g = await db.get<{ n: number; last: string | null }>(
        `SELECT COUNT(*) AS n, MAX(g.end_date) AS last FROM games g JOIN tournaments t ON t.id = g.tournament_id
          WHERE t.game_room_id = ? AND g.status IN ('COMPLETED','ARCHIVED')`, roomId);
    return `${s?.n}|${s?.maxid}|${s?.sum}|${g?.n}|${g?.last ?? ''}|${getRecapPrefsVersion()}`;
}

export function clearRoomRecordsCache(): void { recordsCache.clear(); }

function buildRecords(runs: SummarizedRun[]): RoomRecord[] {
    const out: RoomRecord[] = [];
    const add = (id: RoomRecordId, label: string, hit: { run: RecapRunLink; v: number; keys: string[]; detail: string } | null) => {
        if (hit) out.push({ id, label, player_keys: hit.keys, value: hit.v, detail: hit.detail, run: hit.run });
    };

    const streak = extremeRun(runs
        .filter(r => r.recap.facts.longest_streak && r.recap.facts.longest_streak.games >= STREAK_MIN_GAMES)
        .map(r => ({ run: r.run, v: r.recap.facts.longest_streak!.games, extra: r.recap.facts.longest_streak! })), 'max');
    add('longest_streak', 'Longest streak', streak && {
        run: linkOf(streak.run), v: streak.v, keys: [streak.extra.player_key],
        detail: `${streak.extra.games} games in ${streak.extra.minutes} minutes`,
    });

    const most = extremeRun(runs
        .filter(r => r.recap.facts.most_games && r.recap.facts.most_games.games >= SEASON_MIN.games)
        .map(r => ({ run: r.run, v: r.recap.facts.most_games!.games, extra: r.recap.facts.most_games! })), 'max');
    add('most_games_in_run', 'Most games in one run', most && {
        run: linkOf(most.run), v: most.v, keys: [most.extra.player_key], detail: `${most.v} games in one run`,
    });

    const leads = extremeRun(runs
        .filter(r => r.recap.facts.lead_changes >= SEASON_MIN.leadChanges)
        .map(r => ({ run: r.run, v: r.recap.facts.lead_changes, extra: null })), 'max');
    add('most_lead_changes', 'Most lead changes', leads && {
        run: linkOf(leads.run), v: leads.v, keys: [], detail: `${leads.v} lead changes`,
    });

    const comeback = extremeRun(runs
        .filter(r => (r.recap.facts.comeback_ratio ?? 0) >= SEASON_MIN.comebackRatio && winnerOf(r))
        .map(r => ({ run: r.run, v: r.recap.facts.comeback_ratio as number, extra: winnerOf(r)! })), 'max');
    add('biggest_comeback', 'Biggest comeback', comeback && {
        run: linkOf(comeback.run), v: comeback.v, keys: [comeback.extra], detail: `was ${pct(comeback.v, 0)}% behind the lead`,
    });

    const closest = extremeRun(marginItems(runs), 'min');
    add('closest_finish', 'Closest finish', closest && {
        run: linkOf(closest.run), v: closest.v, keys: closest.extra, detail: `${pct(closest.v)}% between first and second`,
    });
    return out;
}

function namedKeys(records: Array<{ player_keys: string[] }>): string[] {
    return [...new Set(records.flatMap(r => r.player_keys))];
}

export class SeasonRecapService {
    /** null = the tournament is not in this room. */
    static async seasonRecap(roomId: string, tournamentId: string): Promise<SeasonRecap | null> {
        const db = await getDatabase();
        const t = await db.get<{ id: string; name: string; type: string; format: string; is_active: number }>(
            'SELECT id, name, type, format, is_active FROM tournaments WHERE id = ? AND game_room_id = ?', tournamentId, roomId);
        if (!t) return null;
        const { runs: all, refs } = await RunRecapService.summarizeRuns(roomId, { tournamentId });
        const done = completed(all);
        const live = all.length - done.length;

        // Standings: one line per player across the completed runs.
        const stand = new Map<string, { runs_played: number; runs_won: number; podiums: number; games: number; hidden: boolean }>();
        for (const r of done) {
            for (const p of r.recap.players) {
                const s = stand.get(p.key) ?? { runs_played: 0, runs_won: 0, podiums: 0, games: 0, hidden: false };
                s.runs_played += 1;
                if (p.rank === 1) s.runs_won += 1;
                if (p.rank <= 3) s.podiums += 1;
                if (p.play_stats === 'hidden') s.hidden = true;
                else if (p.games != null) s.games += p.games;
                stand.set(p.key, s);
            }
        }
        const label = (k: string) => (refs.get(k)?.display_name ?? refs.get(k)?.iscored_username ?? k).toLowerCase();
        const standings = [...stand.entries()]
            .map(([player_key, s]) => ({ player_key, runs_played: s.runs_played, runs_won: s.runs_won, podiums: s.podiums, games: s.hidden ? null : s.games }))
            .sort((a, b) => b.runs_won - a.runs_won || b.podiums - a.podiums || b.runs_played - a.runs_played || label(a.player_key).localeCompare(label(b.player_key)));

        const awards: SeasonAward[] = [];
        const nRuns = done.length;

        const won = extremeKeys(standings.map(s => ({ key: s.player_key, v: s.runs_won })), 'max', SEASON_MIN.runsWon);
        if (won) awards.push({ id: 'most_runs_won', label: 'Most runs won', player_keys: won.keys, value: won.v, detail: `${won.v} of ${nRuns} runs`, run: null });

        if (nRuns >= SEASON_MIN.everyTableRuns) {
            const every = standings.filter(s => s.runs_played === nRuns).map(s => s.player_key);
            if (every.length > 0) {
                awards.push({
                    id: 'played_every_table', label: 'Played every table', player_keys: every.length <= TIE_MAX ? every : [],
                    value: every.length, detail: every.length <= TIE_MAX ? `scored in all ${nRuns} runs` : `${every.length} players`, run: null,
                });
            }
        }

        const gamesEntries = standings.filter(s => s.games != null).map(s => ({ key: s.player_key, v: s.games as number }));
        const mostGames = extremeKeys(gamesEntries, 'max', SEASON_MIN.games);
        if (mostGames) {
            const runsPlayed = stand.get(mostGames.keys[0]!)?.runs_played ?? 0;
            awards.push({ id: 'most_games', label: 'Most games', player_keys: mostGames.keys, value: mostGames.v, detail: `${mostGames.v} games across ${runsPlayed} ${runsPlayed === 1 ? 'run' : 'runs'}`, run: null });
        }

        const closest = extremeRun(marginItems(done), 'min');
        if (closest) {
            awards.push({ id: 'closest_finish', label: 'Closest finish', player_keys: closest.extra, value: closest.v, detail: `${pct(closest.v)}% between first and second`, run: linkOf(closest.run) });
        }

        const leads = extremeRun(done.filter(r => r.recap.facts.lead_changes >= SEASON_MIN.leadChanges)
            .map(r => ({ run: r.run, v: r.recap.facts.lead_changes, extra: null })), 'max');
        if (leads) awards.push({ id: 'most_lead_changes', label: 'Most lead changes', player_keys: [], value: leads.v, detail: `${leads.v} lead changes`, run: linkOf(leads.run) });

        const comeback = extremeRun(done.filter(r => (r.recap.facts.comeback_ratio ?? 0) >= SEASON_MIN.comebackRatio && winnerOf(r))
            .map(r => ({ run: r.run, v: r.recap.facts.comeback_ratio as number, extra: winnerOf(r)! })), 'max');
        if (comeback) awards.push({ id: 'biggest_comeback', label: 'Biggest comeback', player_keys: [comeback.extra], value: comeback.v, detail: `was ${pct(comeback.v, 0)}% behind the lead`, run: linkOf(comeback.run) });

        // Same ratio as "closest", read from the other end; skipped when it is the very same run.
        const margin = extremeRun(marginItems(done), 'max');
        if (margin && margin.run.game_id !== closest?.run.game_id) {
            awards.push({ id: 'biggest_margin', label: 'Biggest winning margin', player_keys: [margin.extra[0]!], value: margin.v, detail: `${pct(margin.v)}% ahead of second place`, run: linkOf(margin.run) });
        }

        const named = new Set<string>([...standings.map(s => s.player_key), ...namedKeys(awards)]);
        const players = [...named].map(k => refs.get(k)).filter((r): r is RecapPlayerRef => !!r);
        return {
            tournament: { id: t.id, name: t.name, type: t.type, format: t.format === 'event' ? 'event' : 'rotation', is_active: !!t.is_active },
            runs: nRuns, live_runs: live, players, standings, awards,
        };
    }

    static async roomRecords(roomId: string): Promise<RoomRecordsResponse> {
        const watermark = await recordsWatermark(roomId);
        let entry = recordsCache.get(roomId);
        if (!entry || entry.watermark !== watermark) {
            const { runs } = await RunRecapService.summarizeRuns(roomId, { statuses: ['COMPLETED', 'ARCHIVED'] });
            entry = { watermark, value: { records: buildRecords(runs), generated_at: new Date().toISOString() } };
            recordsCache.set(roomId, entry);
        }
        const { records, generated_at } = entry.value;
        const refs = await resolveRefs(roomId, namedKeys(records));
        return {
            players: [...refs.values()],
            records: records.map(r => ({ ...r, player_keys: r.player_keys.filter(k => refs.has(k)) })),
            generated_at,
        };
    }
}
