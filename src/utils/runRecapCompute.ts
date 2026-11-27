import { isMachinePlay } from './machinePlay.js';
import { abbrevScore, wordsScore } from './runRecapText.js';
import type {
    RecapAward, RecapAwardId, RecapBucket, RecapFacts, RecapLeadChange, RecapLeadStep, RecapPlayerGame,
    RecapPlayerRow, RecapSession, RecapSource, RecapPlayStats, RunRecap,
} from '../types/runRecap.js';

/**
 * Run recap compute (B31.1): pure, no DB. The service loads the rows, the
 * board's standings and the privacy prefs; everything the recap says is derived
 * here (docs/run-recap-plan.md sections 0 and B31.1).
 *
 * "A game" is a `vpx` row (`machinePlay.ts`); typed / synced rows count only for
 * best score, finish place and the who-led timeline.
 */

export const SESSION_GAP_MIN = 20;
export const NIGHT_OWL_HOURS = [0, 5] as const;   // [from, to) local
export const EARLY_BIRD_HOURS = [5, 9] as const;
export const PER_DAY_MAX_DAYS = 14;               // longer spans bucket by week (Monday start)

export interface RecapScoreRow {
    history_id: number; key: string; iscored_username: string; discord_user_id: string | null;
    submitted_by_user_id: string | null; score: number; source: string; created_at: string;
}
export interface RecapStanding { key: string; rank: number; history_id: number | null; score: number; created_at: string | null }
export interface RecapPrefs { playStats: boolean; timeOfDay: boolean }

export interface ComputeInput {
    rows: RecapScoreRow[];                    // already filtered (plan 0.1), any order
    standings: RecapStanding[];               // board order
    prefs: Map<string, RecapPrefs>;           // missing key = defaults {true,false}
    timezone: string;
    state: 'active' | 'completed';
    start_date: string | null; end_date: string | null; close_at: string | null;
    attemptsUsed: Map<string, number> | null; // key -> used (limited only)
    now: Date;
}
/** A RecapPlayerRow without the name/avatar fields: ids only (names are attached by the service). */
export type ComputedPlayerRow = Omit<RecapPlayerRow, 'iscored_username' | 'display_name' | 'discord_user_id' | 'avatar_hash' | 'avatar_url'>;
/** RunRecap minus run/refs/discord_text: ids only. */
export interface ComputedRunRecap {
    players: ComputedPlayerRow[];             // standings order
    totals: RunRecap['totals']; hero: RunRecap['hero']; lead_changes: RecapLeadChange[]; lead_steps: RecapLeadStep[];
    awards: RecapAward[]; per_day: RecapBucket[] | null; facts: RecapFacts;
    /** For the detail route: per key, the ordered games + sessions + hours (privacy already applied). */
    detail: Map<string, { games: RecapPlayerGame[]; sessions: RecapSession[]; hours: number[] | null }>;
}

const DEFAULT_PREFS: RecapPrefs = { playStats: true, timeOfDay: false };
const MIN = 60_000;
const DAY_MS = 86_400_000;
const AWARD_MAX = 9; // every award id; the opt-in time-of-day awards come last and must never be squeezed out
const TIE_MAX = 3;

// ---- time helpers ----

/** DB times come as `YYYY-MM-DD HH:MM:SS` (UTC) or ISO; a bare shape gets a `Z`. */
export function dbTimeMs(s: string): number {
    if (!s) return 0;
    let v = s.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) v = v.replace(' ', 'T') + 'Z';
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v += 'Z';
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? 0 : ms;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', minute: '2-digit',
        });
        formatters.set(tz, f);
    }
    return f;
}
interface LocalParts { day: string; hour: number; minute: number }
function localParts(ms: number, tz: string): LocalParts {
    const p: Record<string, string> = {};
    for (const part of partsFormatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
    return { day: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour!, 10) % 24, minute: parseInt(p.minute!, 10) };
}
export function localDayKey(ms: number, tz: string): string { return localParts(ms, tz).day; }
export function localHour(ms: number, tz: string): number { return localParts(ms, tz).hour; }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function keyToUtc(dayKey: string): Date {
    const [y, m, d] = dayKey.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!));
}
function utcToKey(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** 'Fri 11/20', computed from the key alone (zone-free). */
export function dayLabel(dayKey: string): string {
    const d = keyToUtc(dayKey);
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
function weekLabel(mondayKey: string): string {
    const d = keyToUtc(mondayKey);
    return `Week of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function mondayOf(dayKey: string): string {
    const d = keyToUtc(dayKey);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return utcToKey(d);
}
function daysBetween(fromKey: string, toKey: string): string[] {
    const out: string[] = [];
    const end = keyToUtc(toKey).getTime();
    for (let t = keyToUtc(fromKey).getTime(); t <= end; t += DAY_MS) out.push(utcToKey(new Date(t)));
    return out;
}

// ---- number helpers ----

/** Odd n: the middle; even n: the mean of the middle two, rounded. Empty: 0. */
export function medianOf(values: number[]): number {
    if (values.length === 0) return 0;
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function quantile(sorted: number[], q: number): number {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Splits sorted times into sessions: a gap strictly over SESSION_GAP_MIN starts a new one. */
export function sessionsOf(timesMs: number[]): Array<{ first: number; last: number; count: number; startIndex: number }> {
    const out: Array<{ first: number; last: number; count: number; startIndex: number }> = [];
    timesMs.forEach((t, i) => {
        const cur = out[out.length - 1];
        if (cur && t - cur.last <= SESSION_GAP_MIN * MIN) { cur.last = t; cur.count++; }
        else out.push({ first: t, last: t, count: 1, startIndex: i });
    });
    return out;
}

function sortRows(rows: RecapScoreRow[]): RecapScoreRow[] {
    return rows
        .map(r => ({ r, ms: dbTimeMs(r.created_at) }))
        .sort((a, b) => a.ms - b.ms || a.r.history_id - b.r.history_id)
        .map(x => x.r);
}

// ---- who led ----

function timeline(sorted: RecapScoreRow[]): {
    changes: Omit<RecapLeadChange, 'wins_it'>[]; steps: RecapLeadStep[]; leadHistoryIds: Set<number>;
} {
    const best = new Map<string, number>();
    const led = new Set<string>();
    const changes: Omit<RecapLeadChange, 'wins_it'>[] = [];
    const steps: RecapLeadStep[] = [];
    const leadHistoryIds = new Set<number>();
    let leader: string | null = null;
    for (const row of sorted) {
        const prev = best.get(row.key);
        if (prev !== undefined && row.score <= prev) continue;
        best.set(row.key, row.score);
        const at = new Date(dbTimeMs(row.created_at)).toISOString();
        if (leader === null) {
            leader = row.key; led.add(row.key);
            changes.push({ at, player_key: row.key, score: row.score, kind: 'first' });
            steps.push({ at, player_key: row.key, score: row.score });
            leadHistoryIds.add(row.history_id);
        } else if (row.key === leader) {
            steps.push({ at, player_key: row.key, score: row.score });
        } else if (row.score > (best.get(leader) ?? -Infinity)) {
            const kind = led.has(row.key) ? 'takes_back' : 'takes_first';
            leader = row.key; led.add(row.key);
            changes.push({ at, player_key: row.key, score: row.score, kind });
            steps.push({ at, player_key: row.key, score: row.score });
            leadHistoryIds.add(row.history_id);
        }
    }
    return { changes, steps, leadHistoryIds };
}

/** Every change of the leading score; a new leader needs a STRICTLY greater best. */
export function leadTimeline(rows: RecapScoreRow[]): { changes: Omit<RecapLeadChange, 'wins_it'>[]; steps: RecapLeadStep[] } {
    const { changes, steps } = timeline(sortRows(rows));
    return { changes, steps };
}

// ---- per-player analysis ----

interface Game { row: RecapScoreRow; ms: number; n: number; session: number; day: string; hour: number; minute: number; isPb: boolean }
interface Analysis {
    key: string;
    playStats: RecapPlayStats;
    timeOfDay: boolean;
    all: RecapScoreRow[];          // every row of the key, time order
    games: Game[];                 // Witness games, time order
    sessions: Array<{ first: number; last: number; count: number; startIndex: number; best: number; day: string }>;
    pbs: number;
    days: Map<string, number>;     // local day -> witness games
}

function analyse(key: string, allRows: RecapScoreRow[], prefs: RecapPrefs, tz: string): Analysis {
    const witness = allRows.filter(r => isMachinePlay(r.source));
    const playStats: RecapPlayStats = witness.length === 0 ? 'none' : prefs.playStats ? 'shown' : 'hidden';
    const a: Analysis = {
        key, playStats, timeOfDay: playStats === 'shown' && prefs.timeOfDay,
        all: allRows, games: [], sessions: [], pbs: 0, days: new Map(),
    };
    if (playStats !== 'shown') return a;
    const times = witness.map(r => dbTimeMs(r.created_at));
    const sess = sessionsOf(times);
    let runBest = -Infinity;
    witness.forEach((row, i) => {
        const ms = times[i]!;
        const p = localParts(ms, tz);
        const isPb = row.score > runBest;
        if (isPb) { runBest = row.score; a.pbs++; }
        let s = 0;
        for (let k = 0; k < sess.length; k++) if (sess[k]!.startIndex <= i) s = k;
        a.games.push({ row, ms, n: i + 1, session: s + 1, day: p.day, hour: p.hour, minute: p.minute, isPb });
        a.days.set(p.day, (a.days.get(p.day) ?? 0) + 1);
    });
    a.sessions = sess.map(s => {
        let best = -Infinity;
        for (let i = s.startIndex; i < s.startIndex + s.count; i++) best = Math.max(best, witness[i]!.score);
        return { ...s, best, day: localDayKey(s.first, tz) };
    });
    return a;
}

const minutesOf = (s: { first: number; last: number }) => Math.round((s.last - s.first) / MIN);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---- awards ----

interface Cand { key: string; value: number; extra?: unknown }

function pickTop(cands: Cand[], dir: 'max' | 'min'): Cand[] {
    if (cands.length === 0) return [];
    const target = dir === 'max' ? Math.max(...cands.map(c => c.value)) : Math.min(...cands.map(c => c.value));
    const top = cands.filter(c => c.value === target);
    return top.length > TIE_MAX ? [] : top;
}

function buildAwards(
    shown: Analysis[], leadHistoryIds: Set<number>, spanDays: string[], tz: string,
): RecapAward[] {
    const out: RecapAward[] = [];
    if (shown.length < 2) return out;
    const add = (id: RecapAwardId, label: string, top: Cand[], value: number, detail: string) => {
        if (top.length === 0) return;
        out.push({ id, label, player_keys: top.map(t => t.key), value, detail });
    };

    // Most games
    {
        const top = pickTop(shown.filter(a => a.games.length >= 3).map(a => ({ key: a.key, value: a.games.length })), 'max');
        if (top.length) {
            const a = shown.find(x => x.key === top[0]!.key)!;
            const n = top[0]!.value;
            let detail: string;
            if (top.length > 1) detail = `${n} games each`;
            else {
                const total = a.games.reduce((s, g) => s + g.row.score, 0);
                const dayPart = spanDays.length <= 1 ? ''
                    : a.days.size >= spanDays.length ? `, all ${spanDays.length} days`
                        : `, on ${a.days.size} of ${spanDays.length} days`;
                detail = `${n} games${dayPart}, ${wordsScore(total)} points in total`;
            }
            add('most_games', 'Most games', top, n, detail);
        }
    }

    // Longest streak (most games in one session) and longest session (most minutes)
    const streakSessions = new Set<string>();
    {
        const cands: Cand[] = [];
        for (const a of shown) {
            let best: { idx: number; s: Analysis['sessions'][number] } | null = null;
            a.sessions.forEach((s, idx) => { if (!best || s.count > best.s.count) best = { idx, s }; });
            if (best && (best as { s: { count: number } }).s.count >= 5) {
                const b = best as { idx: number; s: Analysis['sessions'][number] };
                cands.push({ key: a.key, value: b.s.count, extra: { idx: b.idx, minutes: minutesOf(b.s) } });
            }
        }
        const top = pickTop(cands, 'max');
        if (top.length) {
            for (const t of top) streakSessions.add(`${t.key}#${(t.extra as { idx: number }).idx}`);
            const n = top[0]!.value;
            const detail = top.length > 1 ? `${n} games each` : `${n} games in ${plural((top[0]!.extra as { minutes: number }).minutes, 'minute', 'minutes')}`;
            add('longest_streak', 'Longest streak', top, n, detail);
        }
    }
    {
        const cands: Cand[] = [];
        for (const a of shown) {
            let best: { idx: number; s: Analysis['sessions'][number] } | null = null;
            a.sessions.forEach((s, idx) => {
                if (s.count < 3 || minutesOf(s) < 30) return;
                if (!best || minutesOf(s) > minutesOf(best.s)) best = { idx, s };
            });
            if (best) {
                const b = best as { idx: number; s: Analysis['sessions'][number] };
                cands.push({ key: a.key, value: minutesOf(b.s), extra: { idx: b.idx, games: b.s.count } });
            }
        }
        const top = pickTop(cands, 'max');
        if (top.length && !top.some(t => streakSessions.has(`${t.key}#${(t.extra as { idx: number }).idx}`))) {
            const m = top[0]!.value;
            const detail = top.length > 1 ? `${m} minutes each`
                : `${(top[0]!.extra as { games: number }).games} games over ${m} minutes`;
            add('longest_session', 'Longest session', top, m, detail);
        }
    }

    // Busiest day
    {
        const cands: Cand[] = [];
        for (const a of shown) {
            let bestDay = ''; let bestN = 0;
            for (const [day, n] of a.days) if (n > bestN || (n === bestN && day < bestDay)) { bestN = n; bestDay = day; }
            if (bestN >= 5) cands.push({ key: a.key, value: bestN, extra: bestDay });
        }
        const top = pickTop(cands, 'max');
        if (top.length) {
            const n = top[0]!.value;
            const sameDay = top.every(t => t.extra === top[0]!.extra);
            add('busiest_day', 'Busiest day', top, n, `${n} games${sameDay ? ` on ${dayLabel(top[0]!.extra as string)}` : ''}`);
        }
    }

    // Most personal bests
    {
        const top = pickTop(shown.filter(a => a.pbs >= 3).map(a => ({ key: a.key, value: a.pbs })), 'max');
        if (top.length) add('most_personal_bests', 'Most personal bests', top, top[0]!.value,
            top.length > 1 ? `${top[0]!.value} each` : String(top[0]!.value));
    }

    // Best first game
    if (shown.length >= 3) {
        const top = pickTop(shown.map(a => ({ key: a.key, value: a.games[0]!.row.score, extra: a.games[0]!.row.history_id })), 'max');
        if (top.length) {
            const lead = top.some(t => leadHistoryIds.has(t.extra as number));
            add('best_first_game', 'Best first game', top, top[0]!.value,
                `${abbrevScore(top[0]!.value)} on game #1${lead ? ', good for the lead' : ''}`);
        }
    }

    // Most consistent
    {
        const cands: Cand[] = [];
        for (const a of shown) {
            if (a.games.length < 10) continue;
            const scores = a.games.map(g => g.row.score);
            const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
            if (mean <= 0) continue;
            const sd = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length);
            const sorted = [...scores].sort((x, y) => x - y);
            cands.push({ key: a.key, value: sd / mean, extra: [quantile(sorted, 0.25), quantile(sorted, 0.75)] });
        }
        const top = pickTop(cands, 'min');
        if (top.length) {
            const [q1, q3] = top[0]!.extra as [number, number];
            add('most_consistent', 'Most consistent', top, Math.round(top[0]!.value * 1000) / 10,
                top.length > 1 ? 'a dead heat' : `half their games between ${abbrevScore(q1)} and ${abbrevScore(q3)}`);
        }
    }

    // Time of day (opted-in players only)
    const clock = (id: RecapAwardId, label: string, [from, to]: readonly [number, number], phrase: string) => {
        const cands = shown.filter(a => a.timeOfDay).map(a => ({
            key: a.key, value: a.games.filter(g => g.hour >= from && g.hour < to).length,
        })).filter(c => c.value >= 5);
        const top = pickTop(cands, 'max');
        if (top.length) add(id, label, top, top[0]!.value, `${top[0]!.value} games ${phrase}`);
    };
    clock('night_owl', 'Night owl', NIGHT_OWL_HOURS, 'between midnight and 5 am');
    clock('early_bird', 'Early bird', EARLY_BIRD_HOURS, 'between 5 and 9 am');
    void tz;
    return out.slice(0, AWARD_MAX);
}

// ---- main ----

export function computeRunRecap(input: ComputeInput): ComputedRunRecap {
    const { timezone: tz, state } = input;
    const standingKeys = new Set(input.standings.map(s => s.key));
    const sorted = sortRows(standingKeys.size ? input.rows.filter(r => standingKeys.has(r.key)) : input.rows);
    const byKey = new Map<string, RecapScoreRow[]>();
    for (const r of sorted) {
        const list = byKey.get(r.key);
        if (list) list.push(r); else byKey.set(r.key, [r]);
    }

    const analyses = new Map<string, Analysis>();
    for (const s of input.standings) {
        analyses.set(s.key, analyse(s.key, byKey.get(s.key) ?? [], input.prefs.get(s.key) ?? DEFAULT_PREFS, tz));
    }
    const shown = input.standings.map(s => analyses.get(s.key)!).filter(a => a.playStats === 'shown');

    // players
    const players: ComputedPlayerRow[] = input.standings.map(s => {
        const a = analyses.get(s.key)!;
        const bestRow = s.history_id != null ? a.all.find(r => r.history_id === s.history_id) : undefined;
        const bestSource: RecapSource = bestRow && isMachinePlay(bestRow.source) ? 'witness' : 'other';
        const bestAtMs = s.created_at ? dbTimeMs(s.created_at) : bestRow ? dbTimeMs(bestRow.created_at) : input.now.getTime();
        const base: ComputedPlayerRow = {
            key: s.key, rank: s.rank, best: s.score, best_at: new Date(bestAtMs).toISOString(), best_source: bestSource,
            play_stats: a.playStats, games: null, average: null, median: null, sessions: null, personal_bests: null,
            days_played: null, best_game_no: null, attempts_used: null,
        };
        if (a.playStats !== 'shown') return base;
        const scores = a.games.map(g => g.row.score);
        base.games = a.games.length;
        base.average = Math.round(scores.reduce((x, y) => x + y, 0) / scores.length);
        base.median = medianOf(scores);
        base.sessions = a.sessions.length;
        base.personal_bests = a.pbs;
        base.days_played = a.days.size;
        base.attempts_used = input.attemptsUsed?.get(s.key) ?? null;
        if (bestSource === 'witness' && bestRow) {
            const g = a.games.find(x => x.row.history_id === bestRow.history_id);
            base.best_game_no = g ? g.n : null;
        }
        return base;
    });

    // lead timeline
    const tl = timeline(sorted);
    const lastIdx = tl.changes.length - 1;
    const leadChanges: RecapLeadChange[] = tl.changes.map((c, i) => ({ ...c, wins_it: state === 'completed' && i === lastIdx }));

    // totals
    const totals: RunRecap['totals'] = {
        players: input.standings.length,
        witness_games: shown.reduce((s, a) => s + a.games.length, 0),
        witness_players: shown.length,
        hidden_players: [...analyses.values()].filter(a => a.playStats === 'hidden').length,
        other_only_players: [...analyses.values()].filter(a => a.playStats === 'none').length,
    };

    // span + per-day
    let spanDays: string[] = [];
    let perDay: RecapBucket[] | null = null;
    const shownGames = shown.flatMap(a => a.games);
    if (shownGames.length > 0) {
        const firstMs = Math.min(...shownGames.map(g => g.ms));
        const lastRowMs = sorted.length ? dbTimeMs(sorted[sorted.length - 1]!.created_at) : firstMs;
        const endMs = Math.min(input.end_date ? dbTimeMs(input.end_date) : input.now.getTime(), lastRowMs);
        const firstDay = localDayKey(firstMs, tz);
        let lastDay = localDayKey(Math.max(endMs, firstMs), tz);
        if (lastDay < firstDay) lastDay = firstDay;
        spanDays = daysBetween(firstDay, lastDay);
        if (spanDays.length > 1) {
            const counts = new Map<string, number>();
            for (const g of shownGames) counts.set(g.day, (counts.get(g.day) ?? 0) + 1);
            if (spanDays.length > PER_DAY_MAX_DAYS) {
                const weeks = new Map<string, number>();
                for (const d of spanDays) { const w = mondayOf(d); if (!weeks.has(w)) weeks.set(w, 0); }
                for (const [d, n] of counts) { const w = mondayOf(d); weeks.set(w, (weeks.get(w) ?? 0) + n); }
                perDay = [...weeks].map(([key, games]) => ({ kind: 'week' as const, key, label: weekLabel(key), games }));
            } else {
                perDay = spanDays.map(d => ({ kind: 'day' as const, key: d, label: dayLabel(d), games: counts.get(d) ?? 0 }));
            }
        }
    }

    // facts
    let longestStreak: RecapFacts['longest_streak'] = null;
    let mostGames: RecapFacts['most_games'] = null;
    for (const a of shown) {
        if (!mostGames || a.games.length > mostGames.games) mostGames = { player_key: a.key, games: a.games.length };
        for (const s of a.sessions) {
            if (!longestStreak || s.count > longestStreak.games) {
                longestStreak = { player_key: a.key, games: s.count, minutes: minutesOf(s) };
            }
        }
    }
    const first = input.standings[0];
    const second = input.standings[1];
    const closest = first && second && first.score > 0 ? (first.score - second.score) / first.score : null;
    let comeback: number | null = null;
    if (first && input.standings.length >= 2) {
        const running = new Map<string, number>();
        let leaderBest = 0;
        let started = false;
        let max = 0;
        for (const r of sorted) {
            if (r.score > (running.get(r.key) ?? -Infinity)) running.set(r.key, r.score);
            leaderBest = Math.max(leaderBest, r.score);
            if (r.key === first.key) started = true;
            if (!started) continue;
            const mine = running.get(first.key) ?? 0;
            if (mine < leaderBest && leaderBest > 0) max = Math.max(max, (leaderBest - mine) / leaderBest);
        }
        comeback = max > 0 ? max : null;
    }
    const facts: RecapFacts = {
        closest_finish_ratio: closest,
        comeback_ratio: comeback,
        lead_changes: leadChanges.filter(c => c.kind !== 'first').length,
        longest_streak: longestStreak,
        most_games: mostGames,
    };

    // hero
    const winner = input.standings[0];
    const winnerRow = players[0];
    const winnerA = winner ? analyses.get(winner.key)! : null;
    const closeAtMs = input.close_at ? dbTimeMs(input.close_at) : null;
    let winnerDays: RecapBucket[] | null = null;
    let gameOfDay: number | null = null;
    if (winnerA && winnerA.playStats === 'shown') {
        winnerDays = [...winnerA.days].sort(([x], [y]) => (x < y ? -1 : 1))
            .map(([key, games]) => ({ kind: 'day' as const, key, label: dayLabel(key), games }));
        if (winnerRow!.best_source === 'witness' && winnerRow!.best_game_no != null) {
            const g = winnerA.games[winnerRow!.best_game_no - 1];
            if (g) gameOfDay = winnerA.games.filter(x => x.day === g.day && x.n <= g.n).length;
        }
    }
    const hero: RunRecap['hero'] = winner && winnerRow ? {
        winner_key: winner.key,
        best: winnerRow.best,
        best_at: winnerRow.best_at,
        best_source: winnerRow.best_source,
        winning_game_no: winnerRow.play_stats === 'shown' ? winnerRow.best_game_no : null,
        winner_games: winnerRow.games,
        ms_before_close: state === 'completed' && closeAtMs != null
            ? Math.max(0, closeAtMs - dbTimeMs(winnerRow.best_at)) : null,
        winner_days: winnerDays,
        game_of_day: gameOfDay,
    } : {
        winner_key: null, best: null, best_at: null, best_source: null, winning_game_no: null,
        winner_games: null, ms_before_close: null, winner_days: null, game_of_day: null,
    };

    // awards
    const awards = buildAwards(shown, tl.leadHistoryIds, spanDays, tz);

    // detail
    const detail: ComputedRunRecap['detail'] = new Map();
    for (const s of input.standings) {
        const a = analyses.get(s.key)!;
        if (a.playStats !== 'shown') { detail.set(s.key, { games: [], sessions: [], hours: null }); continue; }
        const gameByHistory = new Map(a.games.map(g => [g.row.history_id, g]));
        const games: RecapPlayerGame[] = a.all.map(row => {
            const g = gameByHistory.get(row.history_id);
            const ms = dbTimeMs(row.created_at);
            const p = g ?? { ...localParts(ms, tz), isPb: false, n: 0, session: 0 };
            const day = g ? g.day : (p as LocalParts).day;
            const hh = g ? g.hour : (p as LocalParts).hour;
            const mm = g ? g.minute : (p as LocalParts).minute;
            return {
                n: g ? g.n : null,
                source: g ? 'witness' : 'other',
                day,
                time: a.timeOfDay ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : null,
                score: row.score,
                session: g ? g.session : null,
                is_pb: g ? g.isPb : false,
                is_best: s.history_id != null ? row.history_id === s.history_id : row.score === s.score,
            };
        });
        const sessions: RecapSession[] = a.sessions.map((x, i) => ({
            n: i + 1, games: x.count, minutes: minutesOf(x), best: x.best, day: x.day,
        }));
        let hours: number[] | null = null;
        if (a.timeOfDay) {
            hours = new Array(24).fill(0);
            for (const g of a.games) hours[g.hour]!++;
        }
        detail.set(s.key, { games, sessions, hours });
    }

    return { players, totals, hero, lead_changes: leadChanges, lead_steps: tl.steps, awards, per_day: perDay, facts, detail };
}
