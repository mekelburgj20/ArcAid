/**
 * The ONE auto-pick ranking (v2.219.0, ADR 0036, WORK.md A25).
 *
 * Both auto-pick sites — `TournamentEngine.autoPickAndActivate` (no winner /
 * winner picks off) and `TimeoutManager.fallbackToAutoSelection` (every picker
 * timed out) — filter the catalogue exactly as before (mode, platform rules,
 * cooldown) and then hand the survivors here instead of `Math.random()`.
 *
 * Pure: no DB access. `AutoPickSignalService.load` gathers the signals; the
 * rng is injectable so tests are deterministic.
 *
 * Tiers (owner-approved 2026-11-03, after the dart-board complaint):
 *   0. The site's eligible set minus names already ACTIVE in this tournament.
 *   1. Ranked choice over the room's queues. Each player's queue is walked in
 *      `queueOrderSql` order, skipping rows not in Tier 0 (a held head is on
 *      cooldown, so it is skipped and does not waste the vote). The player's
 *      1st/2nd/3rd remaining distinct names score 3/2/1. Totals add across
 *      players; the top wins outright (deterministic), ties broken by the
 *      Tier 2 weight, then by the earliest-queued contributing row.
 *   2. Weighted roam, only when nobody's queue scored: weight =
 *      Bayes-adjusted rating × (1 + ln(1 + distinct room players)), drawn
 *      over the names that are not benched.
 *   3. The benched names, same draw, only when Tiers 1 and 2 are empty.
 */

/** Points for a player's 1st, 2nd and 3rd eligible queued name. */
export const TIER1_POINTS = [3, 2, 1] as const;
/** How deep into a player's eligible queue a vote reaches. */
export const TIER1_DEPTH = 3;
/** Pseudo-votes at the site-wide mean in the Bayesian rating adjustment. */
export const BAYES_C = 5;
/** A room member's per-user average at or below this benches the table. */
export const LOW_RATING_MAX = 2;
/** The low-rating bench clears with at least this many raters … */
export const BENCH_CLEAR_MIN_RATINGS = 3;
/** … averaging at least this. */
export const BENCH_CLEAR_MIN_AVG = 3.0;
/** A last run below this fraction of the median turnout benches the table. */
export const THIN_FRACTION = 0.5;
/** The thin-turnout rule only applies once the tournament has this many rounds. */
export const THIN_MIN_ROUNDS = 10;
/** Site-wide mean used when nobody has rated anything. */
export const DEFAULT_SITE_MEAN = 4.0;

export interface AutoPickQueueRow {
    gameId: string;
    name: string;
    /** `games.rowid` — the "earliest queued" tie-break. */
    rowid: number;
}

export interface AutoPickPlayerQueue {
    userId: string;
    /** QUEUED rows already in `queueOrderSql()` order. */
    rows: AutoPickQueueRow[];
}

export interface AutoPickRating {
    /** Sum of per-user averages (one vote per user per name, ADR 0035). */
    sum: number;
    /** Number of distinct raters. */
    count: number;
    /** A member of this room gave it a per-user average ≤ LOW_RATING_MAX. */
    memberLow: boolean;
}

export interface AutoPickRound {
    name: string;
    startDate: string;
    /** Distinct players who posted a score in that run. */
    participants: number;
}

/** Every map is keyed by `LOWER(name)`. */
export interface AutoPickSignals {
    queues: AutoPickPlayerQueue[];
    ratings: Map<string, AutoPickRating>;
    siteMean: number;
    roomPlayers: Map<string, number>;
    /** COMPLETED/ARCHIVED runs of this tournament with a start_date. */
    rounds: AutoPickRound[];
    /** Names currently ACTIVE in this tournament. */
    activeNames: Set<string>;
}

export type BenchReason = 'low_rating' | 'thin_turnout';

export interface AutoPickContributor {
    userId: string;
    /** Every QUEUED row of the picked name in this player's queue. */
    gameIds: string[];
    /** The points this player's vote gave the pick. */
    points: number;
}

export interface AutoPickResult<T extends { name: string }> {
    pick: T;
    tier: 1 | 2 | 3;
    points?: number;
    contributors?: AutoPickContributor[];
    /** Tier 1 totals, top 5 (empty when no queue scored). */
    tally: Array<{ name: string; points: number }>;
    /** The pick's Tier 2 weight (computed for every tier). */
    weight: number;
    benchReason?: BenchReason;
    /** Size of the tier the pick was drawn from. */
    poolSize: number;
}

const key = (name: string) => name.toLowerCase();

/** Bayes-adjusted rating: BAYES_C pseudo-votes at the site mean. Unrated = mean. */
export function ratingAdjusted(rating: AutoPickRating | undefined, siteMean: number): number {
    const sum = rating?.sum ?? 0;
    const count = rating?.count ?? 0;
    return (BAYES_C * siteMean + sum) / (BAYES_C + count);
}

/** Tier 2 weight: rating × (1 + ln(1 + distinct room players)). */
export function tier2Weight(nameKey: string, signals: AutoPickSignals): number {
    const players = signals.roomPlayers.get(nameKey) ?? 0;
    return ratingAdjusted(signals.ratings.get(nameKey), signals.siteMean) * (1 + Math.log(1 + players));
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function timeOf(iso: string): number {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
}

/**
 * Why a name is benched, or undefined. (a) a room member rated it low and the
 * wider rating has not cleared it; (b) thin turnout on its most recent run,
 * only once the tournament has THIN_MIN_ROUNDS rounds.
 */
export function benchReasonFor(nameKey: string, signals: AutoPickSignals): BenchReason | undefined {
    const r = signals.ratings.get(nameKey);
    if (r?.memberLow) {
        const cleared = r.count >= BENCH_CLEAR_MIN_RATINGS && r.sum / r.count >= BENCH_CLEAR_MIN_AVG;
        if (!cleared) return 'low_rating';
    }
    if (signals.rounds.length >= THIN_MIN_ROUNDS) {
        const m = median(signals.rounds.map(x => x.participants));
        let latest: AutoPickRound | undefined;
        for (const round of signals.rounds) {
            if (key(round.name) !== nameKey) continue;
            if (!latest || timeOf(round.startDate) > timeOf(latest.startDate)) latest = round;
        }
        if (latest && latest.participants < THIN_FRACTION * m) return 'thin_turnout';
    }
    return undefined;
}

function weightedDraw<T>(items: Array<{ item: T; weight: number }>, rng: () => number): T {
    const total = items.reduce((s, x) => s + Math.max(0, x.weight), 0);
    if (!(total > 0)) return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!.item;
    let r = rng() * total;
    for (const x of items) {
        r -= Math.max(0, x.weight);
        if (r < 0) return x.item;
    }
    return items[items.length - 1]!.item;
}

/**
 * Rank `eligible` (the site's filtered catalogue, name-keyed) and choose one.
 * Returns null only when Tier 0 is empty (every eligible name is ACTIVE).
 */
export function rankAutoPick<T extends { name: string }>(
    eligible: T[],
    signals: AutoPickSignals,
    rng: () => number = Math.random,
): AutoPickResult<T> | null {
    // Tier 0 — stable order (by name) so a seeded rng is reproducible.
    const tier0 = new Map<string, T>();
    for (const g of eligible) {
        const k = key(g.name);
        if (signals.activeNames.has(k) || tier0.has(k)) continue;
        tier0.set(k, g);
    }
    if (tier0.size === 0) return null;
    const pool = [...tier0.keys()].sort();

    const weights = new Map<string, number>();
    for (const k of pool) weights.set(k, tier2Weight(k, signals));

    // Tier 1 — ranked choice.
    const totals = new Map<string, number>();
    const earliest = new Map<string, number>();
    const votes = new Map<string, AutoPickContributor[]>();
    for (const q of signals.queues) {
        const seen = new Set<string>();
        let position = 0;
        for (const row of q.rows) {
            const k = key(row.name);
            if (!tier0.has(k) || seen.has(k)) continue; // ineligible/held → skipped; a repeat counts once
            seen.add(k);
            if (position >= TIER1_DEPTH) break;
            const pts = TIER1_POINTS[position] ?? 0;
            position++;
            if (pts <= 0) continue;
            totals.set(k, (totals.get(k) ?? 0) + pts);
            const ids = q.rows.filter(r => key(r.name) === k);
            const minRow = Math.min(...ids.map(r => r.rowid));
            earliest.set(k, Math.min(earliest.get(k) ?? Infinity, minRow));
            const list = votes.get(k) ?? [];
            list.push({ userId: q.userId, gameIds: ids.map(r => r.gameId), points: pts });
            votes.set(k, list);
        }
    }

    const tally = [...totals.entries()]
        .map(([k, points]) => ({ k, points }))
        .sort((a, b) => b.points - a.points
            || (weights.get(b.k)! - weights.get(a.k)!)
            || (earliest.get(a.k)! - earliest.get(b.k)!));
    const tallyOut = tally.slice(0, 5).map(t => ({ name: tier0.get(t.k)!.name, points: t.points }));

    if (tally.length > 0) {
        const top = tally[0]!;
        const contributors = [...(votes.get(top.k) ?? [])]
            .sort((a, b) => b.points - a.points || a.userId.localeCompare(b.userId));
        return {
            pick: tier0.get(top.k)!,
            tier: 1,
            points: top.points,
            contributors,
            tally: tallyOut,
            weight: weights.get(top.k)!,
            poolSize: pool.length,
        };
    }

    // Tier 2 / Tier 3 — weighted roam over the unbenched names, then the benched.
    const unbenched: string[] = [];
    const benched: Array<{ k: string; reason: BenchReason }> = [];
    for (const k of pool) {
        const reason = benchReasonFor(k, signals);
        if (reason) benched.push({ k, reason });
        else unbenched.push(k);
    }
    if (unbenched.length > 0) {
        const k = weightedDraw(unbenched.map(item => ({ item, weight: weights.get(item)! })), rng);
        return { pick: tier0.get(k)!, tier: 2, tally: [], weight: weights.get(k)!, poolSize: unbenched.length };
    }
    const b = weightedDraw(benched.map(item => ({ item, weight: weights.get(item.k)! })), rng);
    return {
        pick: tier0.get(b.k)!, tier: 3, tally: [], weight: weights.get(b.k)!,
        benchReason: b.reason, poolSize: benched.length,
    };
}

/**
 * "A", "A and B", "A, B and C" — the queue-credit clause of a Tier 1
 * announcement. Labels are already resolved (never raw ids).
 */
export function formatQueueCredit(labels: string[]): string {
    if (labels.length <= 1) return labels[0] ?? 'a member';
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Fallback label for a contributor with no resolvable name. */
export const UNLABELLED_CONTRIBUTOR = 'a member';
