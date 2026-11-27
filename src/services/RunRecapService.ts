import { getDatabase } from '../database/database.js';
import { logWarn } from '../utils/logger.js';
import { gameRunWindowByIdSql, gameRunWindowSql } from '../utils/gameRunWindow.js';
import { openCardSql } from '../utils/openCard.js';
import { nextRotationIso } from '../utils/cronUtils.js';
import { sqliteLower } from '../utils/sqliteLower.js';
import { resolveTimezone, roomTimezone, roomTimezonesFor } from '../utils/roomTimezone.js';
import { normalizeWitnessFlagMode, type WitnessFlagMode } from '../utils/witnessFlagMode.js';
import { tournamentRunRecapUrl } from '../utils/publicLinks.js';
import { computeRunRecap, type ComputedRunRecap, type RecapPrefs, type RecapScoreRow, type RecapStanding } from '../utils/runRecapCompute.js';
import { buildRunRecapText, DISCORD_COPY_MAX } from '../utils/runRecapText.js';
import { LeaderboardService, type RankedEntry } from './LeaderboardService.js';
import { IDENTITY_KEY_SQL, roundRowsWhere } from './EventResultService.js';
import { EventService, type EventRoundRow } from './EventService.js';
import { PreferencesService } from './PreferencesService.js';
import { AttemptService } from './AttemptService.js';
import { GameArtService } from './GameArtService.js';
import type {
    LiveRunsResponse, RecapPlayerDetail, RecapPlayerRef, RecapPlayerRow, RecapRunState, RunRecap,
} from '../types/runRecap.js';

/**
 * Run recaps, "By the numbers" (B31.1; docs/run-recap-plan.md).
 *
 * Loads a run's score rows exactly as its board does, hands them to the pure
 * `computeRunRecap`, and attaches names at READ (never stored). Nothing is cached
 * per run. Later slices (player/table runs, season recap, room records) consume
 * `summarizeRuns` and never query score rows themselves.
 */

export interface RunContext {
    roomId: string; gameId: string; gameName: string; status: string; startDate: string | null; endDate: string | null;
    roundNo: number | null; scheduledStartAt: string | null; scheduledEndAt: string | null;
    tournament: { id: string; name: string; type: string; format: 'rotation' | 'event'; cadence: string | null;
                  witnessFlagMode: WitnessFlagMode; maxAttempts: number | null; roomSlug: string };
    isEventRound: boolean; timezone: string;
}

const RUN_STATUSES = ['ACTIVE', 'COMPLETED', 'ARCHIVED'] as const;
type RunStatus = typeof RUN_STATUSES[number];

/** Explicit columns only: never `t.*` (it carries invite_code). */
const RUN_SELECT = `
    g.id AS game_id, g.name AS game_name, g.status, g.start_date, g.end_date, g.round_no,
    g.scheduled_start_at, g.scheduled_end_at, g.tournament_id,
    t.name AS t_name, t.type AS t_type, t.format AS t_format, t.cadence AS t_cadence,
    t.witness_flag_mode AS t_flag_mode, t.max_attempts AS t_max_attempts, t.game_room_id AS room_id,
    gr.slug AS room_slug`;

interface RunRow {
    game_id: string; game_name: string; status: string; start_date: string | null; end_date: string | null;
    round_no: number | null; scheduled_start_at: string | null; scheduled_end_at: string | null; tournament_id: string;
    t_name: string; t_type: string; t_format: string; t_cadence: string | null; t_flag_mode: string | null;
    t_max_attempts: number | null; room_id: string; room_slug: string;
}

function cadenceZone(cadence: string | null): string | null {
    try {
        const tz = JSON.parse(cadence || '{}')?.timezone;
        return typeof tz === 'string' && tz ? tz : null;
    } catch { return null; }
}

function contextFromRow(r: RunRow, roomTz: string | null): RunContext {
    const format = r.t_format === 'event' ? 'event' : 'rotation';
    return {
        roomId: r.room_id, gameId: r.game_id, gameName: r.game_name, status: r.status,
        startDate: r.start_date, endDate: r.end_date, roundNo: r.round_no,
        scheduledStartAt: r.scheduled_start_at, scheduledEndAt: r.scheduled_end_at,
        tournament: {
            id: r.tournament_id, name: r.t_name, type: r.t_type, format, cadence: r.t_cadence,
            witnessFlagMode: normalizeWitnessFlagMode(r.t_flag_mode), maxAttempts: r.t_max_attempts ?? null, roomSlug: r.room_slug,
        },
        isEventRound: format === 'event' && r.round_no != null,
        timezone: resolveTimezone(cadenceZone(r.t_cadence), roomTz),
    };
}

const stateOf = (status: string): RecapRunState => (status === 'ACTIVE' ? 'active' : 'completed');

let warnedLeaderMismatch = false;

interface RawRow {
    run_id?: string; history_id: number; key: string; iscored_username: string; discord_user_id: string | null;
    submitted_by_user_id: string | null; score: number; source: string; created_at: string;
}

const toScoreRow = (r: RawRow): RecapScoreRow => ({
    history_id: r.history_id, key: r.key, iscored_username: r.iscored_username, discord_user_id: r.discord_user_id,
    submitted_by_user_id: r.submitted_by_user_id, score: r.score, source: r.source, created_at: r.created_at,
});

function refOf(key: string, e: RankedEntry): RecapPlayerRef {
    return {
        key, iscored_username: e.iscored_username, display_name: e.display_name ?? null,
        discord_user_id: e.discord_user_id || null, avatar_hash: e.avatar_hash ?? null, avatar_url: e.avatar_url ?? null,
    };
}

/** key -> canonical id, one IN query (user_identity_links). Keys with no link map to themselves. */
async function canonicalMap(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>(keys.map(k => [k, k]));
    const real = [...new Set(keys.filter(k => k && !k.toLowerCase().startsWith('iscored:')))];
    if (real.length === 0) return out;
    const db = await getDatabase();
    for (let i = 0; i < real.length; i += 400) {
        const chunk = real.slice(i, i + 400);
        const rows = await db.all<Array<{ provider_user_id: string; canonical_user_id: string }>>(
            `SELECT provider_user_id, canonical_user_id FROM user_identity_links
              WHERE provider_user_id IN (${chunk.map(() => '?').join(',')})`, ...chunk);
        for (const r of rows) out.set(r.provider_user_id, r.canonical_user_id);
    }
    return out;
}

function closeAtFor(ctx: RunContext, now: Date, roomTz: string | null): string | null {
    if (stateOf(ctx.status) === 'completed') return ctx.endDate;
    if (ctx.isEventRound) return ctx.scheduledEndAt;
    return nextRotationIso(ctx.tournament.cadence, now, roomTz);
}

function runInfo(ctx: RunContext, imageUrl: string | null, closeAt: string | null): RunRecap['run'] {
    return {
        game_id: ctx.gameId, game_name: ctx.gameName, tournament_id: ctx.tournament.id, tournament_name: ctx.tournament.name,
        tournament_type: ctx.tournament.type, format: ctx.tournament.format, round_no: ctx.roundNo, state: stateOf(ctx.status),
        start_date: ctx.startDate, end_date: ctx.endDate, close_at: closeAt, timezone: ctx.timezone,
        image_url: imageUrl, max_attempts: ctx.tournament.maxAttempts,
    };
}

/** Standings (board order) from the hydrated entries, keyed through the rows' history ids. */
function standingsFrom(entries: RankedEntry[], rows: RecapScoreRow[]): { standings: RecapStanding[]; refs: Map<string, RecapPlayerRef> } {
    const byHistory = new Map(rows.map(r => [r.history_id, r]));
    const standings: RecapStanding[] = [];
    const refs = new Map<string, RecapPlayerRef>();
    for (const e of entries) {
        const row = e.history_id != null ? byHistory.get(e.history_id) : undefined;
        const key = row?.key ?? e.submitted_by_user_id ?? `iscored:${sqliteLower(e.iscored_username)}`;
        if (refs.has(key)) continue;
        refs.set(key, refOf(key, e));
        standings.push({ key, rank: e.rank, history_id: e.history_id ?? null, score: e.score, created_at: row?.created_at ?? null });
    }
    return { standings, refs };
}

function attachNames(players: ComputedRunRecap['players'], refs: Map<string, RecapPlayerRef>): RecapPlayerRow[] {
    return players.map(p => {
        const ref = refs.get(p.key);
        return {
            ...p,
            iscored_username: ref?.iscored_username ?? '',
            display_name: ref?.display_name ?? null,
            discord_user_id: ref?.discord_user_id ?? null,
            avatar_hash: ref?.avatar_hash ?? null,
            avatar_url: ref?.avatar_url ?? null,
        };
    });
}

interface Assembled { recap: Omit<RunRecap, 'discord_text'>; computed: ComputedRunRecap; refs: Map<string, RecapPlayerRef> }

export class RunRecapService {
    /** null = not a run in this room (wrong room, pinned, QUEUED/SCHEDULED, missing). */
    static async loadRunContext(roomId: string, gameId: string): Promise<RunContext | null> {
        const db = await getDatabase();
        const row = await db.get<RunRow>(
            `SELECT ${RUN_SELECT}
               FROM games g
               JOIN tournaments t ON t.id = g.tournament_id
               JOIN game_rooms gr ON gr.id = t.game_room_id
              WHERE g.id = ? AND t.game_room_id = ? AND g.tournament_id IS NOT NULL
                AND g.status IN ('ACTIVE', 'COMPLETED', 'ARCHIVED')`,
            gameId, roomId,
        );
        if (!row) return null;
        return contextFromRow(row, await roomTimezone(roomId));
    }

    /** The plan's 0.1 rows; prevent-flagged event-round rows removed. */
    static async loadRunRows(ctx: RunContext): Promise<RecapScoreRow[]> {
        const db = await getDatabase();
        if (!ctx.isEventRound) {
            const rows = await db.all<RawRow[]>(
                `SELECT sh.id AS history_id,
                        COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username)) AS key,
                        sh.iscored_username, sh.discord_user_id, sh.submitted_by_user_id, sh.score, sh.source, sh.created_at
                   FROM score_history sh
                  WHERE sh.game_room_id = ? AND sh.submitted_during_tournament_id = ? AND LOWER(sh.game_name) = LOWER(?)
                    AND sh.orphaned_at IS NULL
                    AND ${gameRunWindowByIdSql('sh')}`,
                ctx.roomId, ctx.tournament.id, ctx.gameName, ctx.gameId,
            );
            return rows.map(toScoreRow);
        }
        const event = await EventService.getEvent(ctx.tournament.id);
        const round = await db.get<EventRoundRow>(
            `SELECT id, tournament_id, game_room_id, name, status, round_no, scheduled_start_at, scheduled_end_at,
                    start_date, end_date, iscored_id
               FROM games WHERE id = ?`, ctx.gameId);
        if (!event || !round) return [];
        const where = roundRowsWhere(event, round);
        const rows = await db.all<RawRow[]>(
            `SELECT sh.id AS history_id, ${IDENTITY_KEY_SQL} AS key,
                    sh.iscored_username, sh.discord_user_id, sh.submitted_by_user_id, sh.score, sh.source, sh.created_at
               FROM score_history sh
               LEFT JOIN user_mappings um ON um.iscored_username = sh.iscored_username COLLATE NOCASE
              WHERE ${where.sql}`,
            ...where.params,
        );
        let out = rows.map(toScoreRow);
        if (ctx.tournament.witnessFlagMode === 'prevent') {
            const overlay = (await LeaderboardService.getEventRoundOverlays([ctx.gameId])).get(ctx.gameId);
            if (overlay) {
                out = out.filter(r => overlay.witnessByHistoryId[String(r.history_id)]?.status !== 'flagged');
            }
        }
        return out;
    }

    private static async assemble(
        ctx: RunContext, rows: RecapScoreRow[], entries: RankedEntry[], now: Date,
    ): Promise<Assembled> {
        const { standings, refs } = standingsFrom(entries, rows);
        const keys = standings.map(s => s.key);
        const prefs = await PreferencesService.getRecapPrefsFor(keys);
        let attemptsUsed: Map<string, number> | null = null;
        if (ctx.tournament.maxAttempts != null) {
            const used = await AttemptService.usedByGame(ctx.tournament.id);
            const canon = await canonicalMap(keys);
            const forGame = used[ctx.gameId] ?? {};
            attemptsUsed = new Map();
            for (const k of keys) {
                const n = forGame[canon.get(k) ?? k] ?? forGame[k];
                if (n != null) attemptsUsed.set(k, n);
            }
        }
        const roomTz = await roomTimezone(ctx.roomId);
        const closeAt = closeAtFor(ctx, now, roomTz);
        const computed = computeRunRecap({
            rows, standings, prefs, timezone: ctx.timezone, state: stateOf(ctx.status),
            start_date: ctx.startDate, end_date: ctx.endDate, close_at: closeAt, attemptsUsed, now,
        });
        const players = attachNames(computed.players, refs);
        const recap: Omit<RunRecap, 'discord_text'> = {
            version: 1,
            run: runInfo(ctx, null, closeAt),
            totals: computed.totals, hero: computed.hero, players, lead_changes: computed.lead_changes,
            lead_steps: computed.lead_steps, awards: computed.awards, per_day: computed.per_day, facts: computed.facts,
            generated_at: now.toISOString(),
        };
        const lastStep = computed.lead_steps[computed.lead_steps.length - 1];
        if (lastStep && computed.hero.winner_key && lastStep.player_key !== computed.hero.winner_key && !warnedLeaderMismatch) {
            warnedLeaderMismatch = true;
            logWarn(`Run recap: the computed final leader differs from the board's rank 1 (game ${ctx.gameId}); the standings are trusted.`);
        }
        return { recap, computed, refs };
    }

    private static async build(roomId: string, gameId: string, now: Date): Promise<{ ctx: RunContext; built: Assembled } | null> {
        const ctx = await RunRecapService.loadRunContext(roomId, gameId);
        if (!ctx) return null;
        const rows = await RunRecapService.loadRunRows(ctx);
        const entries = (await LeaderboardService.getRunStandings([gameId])).get(gameId) ?? [];
        const built = await RunRecapService.assemble(ctx, rows, entries, now);
        const art = await GameArtService.artForNames([ctx.gameName]);
        built.recap.run.image_url = art.get(GameArtService.key(ctx.gameName)) ?? null;
        return { ctx, built };
    }

    static async getRunRecap(roomId: string, gameId: string, opts?: { now?: Date }): Promise<RunRecap | null> {
        const made = await RunRecapService.build(roomId, gameId, opts?.now ?? new Date());
        if (!made) return null;
        const { ctx, built } = made;
        const discord_text = buildRunRecapText(built.recap, {
            maxChars: DISCORD_COPY_MAX, link: tournamentRunRecapUrl(ctx.tournament.roomSlug, ctx.tournament.id, gameId),
        });
        return { ...built.recap, discord_text };
    }

    static async getPlayerRunDetail(roomId: string, gameId: string, playerKey: string): Promise<RecapPlayerDetail | null> {
        const made = await RunRecapService.build(roomId, gameId, new Date());
        if (!made) return null;
        const player = made.built.recap.players.find(p => p.key === playerKey);
        if (!player) return null;
        const d = made.built.computed.detail.get(playerKey) ?? { games: [], sessions: [], hours: null };
        return { player, games: d.games, sessions: d.sessions, hours: d.hours, timezone: made.ctx.timezone };
    }

    static async listLiveRuns(roomId: string, tournamentId: string): Promise<LiveRunsResponse | null> {
        const db = await getDatabase();
        const t = await db.get<{ id: string }>('SELECT id FROM tournaments WHERE id = ? AND game_room_id = ?', tournamentId, roomId);
        if (!t) return null;
        const rows = await db.all<Array<{ id: string; name: string; start_date: string | null }>>(
            `SELECT g.id, g.name, g.start_date
               FROM games g JOIN tournaments t ON t.id = g.tournament_id
              WHERE t.id = ? AND t.game_room_id = ? AND ${openCardSql('g', 't')}
              ORDER BY g.start_date ASC, g.name ASC`,
            tournamentId, roomId,
        );
        const art = await GameArtService.artForNames(rows.map(r => r.name));
        return {
            runs: rows.map(r => ({
                game_id: r.id, game_name: r.name, start_date: r.start_date,
                image_url: art.get(GameArtService.key(r.name)) ?? null,
            })),
        };
    }

    /**
     * Bulk: every run in the room matching the filter, each computed with
     * `computeRunRecap` (no discord_text), plus one ref per key seen. B31.3 and
     * B31.4 consume this; they never re-query score rows themselves.
     */
    static async summarizeRuns(roomId: string, filter: {
        tournamentId?: string; gameName?: string; keys?: string[]; statuses?: RunStatus[];
    }): Promise<{ runs: Array<{ run: RunRecap['run']; recap: ComputedRunRecap }>; refs: Map<string, RecapPlayerRef> }> {
        const db = await getDatabase();
        const statuses = filter.statuses?.length ? filter.statuses : [...RUN_STATUSES];
        const params: unknown[] = [roomId, ...statuses];
        let extra = '';
        if (filter.tournamentId) { extra += ' AND g.tournament_id = ?'; params.push(filter.tournamentId); }
        if (filter.gameName) { extra += ' AND LOWER(g.name) = LOWER(?)'; params.push(filter.gameName); }
        const runRows = await db.all<RunRow[]>(
            `SELECT ${RUN_SELECT}
               FROM games g
               JOIN tournaments t ON t.id = g.tournament_id
               JOIN game_rooms gr ON gr.id = t.game_room_id
              WHERE t.game_room_id = ? AND g.status IN (${statuses.map(() => '?').join(',')})${extra}`,
            ...params,
        );
        const empty = { runs: [], refs: new Map<string, RecapPlayerRef>() };
        if (runRows.length === 0) return empty;

        const roomTz = (await roomTimezonesFor([roomId])).get(roomId) ?? null;
        const ctxs = runRows.map(r => contextFromRow(r, roomTz));
        const rowsByRun = new Map<string, RecapScoreRow[]>();

        // Rotation runs: one query for every run's rows (the board's join, RankingService.computeRankings).
        let rotation = ctxs.filter(c => !c.isEventRound);
        let runIdSql = '';
        const runIdParams: string[] = [];
        if (filter.keys?.length && rotation.length > 0) {
            // Pre-select the runs where any wanted key has a row (the row key is built exactly as in the
            // rows query below); each matching run is then computed from ALL of its rows.
            const hit = await db.all<Array<{ run_id: string }>>(
                `SELECT DISTINCT g.id AS run_id
                   FROM games g
                   JOIN tournaments t ON t.id = g.tournament_id
                   JOIN score_history sh
                     ON sh.game_room_id = t.game_room_id
                    AND sh.submitted_during_tournament_id = g.tournament_id
                    AND LOWER(sh.game_name) = LOWER(g.name)
                    AND sh.orphaned_at IS NULL
                    AND ${gameRunWindowSql('sh', 'g')}
                  WHERE t.game_room_id = ?
                    AND g.status IN (${statuses.map(() => '?').join(',')})
                    AND NOT (t.format = 'event' AND g.round_no IS NOT NULL)${extra}
                    AND COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username)) IN (${filter.keys.map(() => '?').join(',')})`,
                ...params, ...filter.keys,
            );
            const ids = new Set(hit.map(h => h.run_id));
            rotation = rotation.filter(c => ids.has(c.gameId));
            if (rotation.length > 0) {
                runIdSql = ` AND g.id IN (${rotation.map(() => '?').join(',')})`;
                runIdParams.push(...rotation.map(c => c.gameId));
            }
        }
        if (rotation.length > 0) {
            const all = await db.all<RawRow[]>(
                `SELECT g.id AS run_id, sh.id AS history_id,
                        COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username)) AS key,
                        sh.iscored_username, sh.discord_user_id, sh.submitted_by_user_id, sh.score, sh.source, sh.created_at
                   FROM games g
                   JOIN tournaments t ON t.id = g.tournament_id
                   JOIN score_history sh
                     ON sh.game_room_id = t.game_room_id
                    AND sh.submitted_during_tournament_id = g.tournament_id
                    AND LOWER(sh.game_name) = LOWER(g.name)
                    AND sh.orphaned_at IS NULL
                    AND ${gameRunWindowSql('sh', 'g')}
                  WHERE t.game_room_id = ?
                    AND g.status IN (${statuses.map(() => '?').join(',')})
                    AND NOT (t.format = 'event' AND g.round_no IS NOT NULL)${extra}${runIdSql}`,
                ...params, ...runIdParams,
            );
            for (const r of all) {
                const list = rowsByRun.get(r.run_id!);
                const row = toScoreRow(r);
                if (list) list.push(row); else rowsByRun.set(r.run_id!, [row]);
            }
        }
        // Event rounds are few: each through its own loader.
        for (const c of ctxs.filter(x => x.isEventRound)) rowsByRun.set(c.gameId, await RunRecapService.loadRunRows(c));

        let selected = ctxs;
        if (filter.keys?.length) {
            const wanted = new Set(filter.keys);
            selected = ctxs.filter(c => (rowsByRun.get(c.gameId) ?? []).some(r => wanted.has(r.key)));
        }
        if (selected.length === 0) return empty;

        const standingsByRun = await LeaderboardService.getRunStandings(selected.map(c => c.gameId));
        const entryLists = selected.map(c => standingsFrom(standingsByRun.get(c.gameId) ?? [], rowsByRun.get(c.gameId) ?? []));
        const allKeys = [...new Set(entryLists.flatMap(e => e.standings.map(s => s.key)))];
        const prefs = await PreferencesService.getRecapPrefsFor(allKeys);
        const canon = await canonicalMap(allKeys);
        const usedByTournament = new Map<string, Record<string, Record<string, number>>>();
        for (const c of selected) {
            if (c.tournament.maxAttempts != null && !usedByTournament.has(c.tournament.id)) {
                usedByTournament.set(c.tournament.id, await AttemptService.usedByGame(c.tournament.id));
            }
        }
        const art = await GameArtService.artForNames(selected.map(c => c.gameName));

        const now = new Date();
        const refs = new Map<string, RecapPlayerRef>();
        const runs: Array<{ run: RunRecap['run']; recap: ComputedRunRecap }> = [];
        for (let i = 0; i < selected.length; i++) {
            const c = selected[i]!;
            const built = await RunRecapService.assembleBulk(
                c, rowsByRun.get(c.gameId) ?? [], standingsByRun.get(c.gameId) ?? [], now,
                { prefs, canon, used: usedByTournament.get(c.tournament.id) ?? null }, roomTz,
            );
            for (const [k, ref] of entryLists[i]!.refs) if (!refs.has(k)) refs.set(k, ref);
            const image = art.get(GameArtService.key(c.gameName)) ?? null;
            runs.push({ run: runInfo(c, image, built.closeAt), recap: built.computed });
        }
        return { runs, refs };
    }

    /** `assemble` for the bulk path: compute only, with the room zone already known. */
    private static async assembleBulk(
        ctx: RunContext, rows: RecapScoreRow[], entries: RankedEntry[], now: Date,
        shared: { prefs: Map<string, RecapPrefs>; canon: Map<string, string>; used: Record<string, Record<string, number>> | null },
        roomTz: string | null,
    ): Promise<{ computed: ComputedRunRecap; closeAt: string | null }> {
        const { standings } = standingsFrom(entries, rows);
        let attemptsUsed: Map<string, number> | null = null;
        if (ctx.tournament.maxAttempts != null) {
            const forGame = shared.used?.[ctx.gameId] ?? {};
            attemptsUsed = new Map();
            for (const s of standings) {
                const n = forGame[shared.canon.get(s.key) ?? s.key] ?? forGame[s.key];
                if (n != null) attemptsUsed.set(s.key, n);
            }
        }
        const closeAt = closeAtFor(ctx, now, roomTz);
        const computed = computeRunRecap({
            rows, standings, prefs: shared.prefs, timezone: ctx.timezone, state: stateOf(ctx.status),
            start_date: ctx.startDate, end_date: ctx.endDate, close_at: closeAt, attemptsUsed, now,
        });
        return { computed, closeAt };
    }
}
