import { getDatabase } from '../database/database.js';
import { logWarn } from '../utils/logger.js';
import { trackBackground } from '../utils/backgroundTasks.js';
import { activityRequestContext } from '../utils/activityRequestContext.js';
import { adminSummary, auditActionOf, buildActivityDetail, type ActivityDetail } from '../utils/activityPresentation.js';

/**
 * G14 (v2.227.0, ADR 0037) - the room activity log.
 *
 * One append-only table (`activity_log`, migration 209) written at the
 * existing choke points: score landings / corrections / deletes / refusals,
 * Witness and Castcade ingest outcomes, device activity, admin writes, bot
 * failures, tournament lifecycle. Read by Room Admin -> Activity (one room)
 * and the super-admin Activity page (every room + room-less rows).
 *
 * Invariants (ADR 0037):
 *  - Room scope is decided AT WRITE TIME and stamped on the row; a later
 *    routing change never rewrites history (§2).
 *  - Rows hold identity-stable ids; player labels resolve at READ through
 *    `resolveUserLabels` (§3). `player_alias` is the raw alias a score was
 *    posted under, for rows with no linked account.
 *  - A log write NEVER fails the action it describes: `record` swallows,
 *    warns and counts; the count is shown on the super-admin view (§7).
 *  - Every new event source writes its row here (rule files).
 */

export type ActivityCategory = 'score' | 'device' | 'admin' | 'bot' | 'lifecycle' | 'server';
export const ACTIVITY_CATEGORIES: ActivityCategory[] = ['score', 'device', 'admin', 'bot', 'lifecycle', 'server'];
export type ActivitySeverity = 'info' | 'problem';

/** Retention (ADR 0037 §8). */
export const ACTIVITY_RETENTION_DAYS = 90;

export interface ActivityEntry {
    /**
     * The room the row belongs to. `undefined` = derive it from `tournamentId`
     * (then `gameId`); `null` = deliberately room-less (super-admin only).
     */
    roomId?: string | null;
    category: ActivityCategory;
    eventType: string;
    severity?: ActivitySeverity;
    /** The player the row is ABOUT (canonical id when known). */
    userId?: string | null;
    /** The alias the score was posted under, when there is no linked account. */
    playerAlias?: string | null;
    /** Who DID it, when that is not the player (an admin deleting a score). */
    actorUserId?: string | null;
    deviceId?: string | null;
    tournamentId?: string | null;
    gameId?: string | null;
    tournamentName?: string | null;
    gameName?: string | null;
    tableName?: string | null;
    source?: string | null;
    score?: number | null;
    /** Searchable text. Never a player name (labels resolve at read). */
    summary: string;
    details?: Record<string, unknown> | null;
    /** Unique key; a second write with the same key is ignored (backfill, sweeps). */
    dedupeKey?: string | null;
    /** SQLite UTC `YYYY-MM-DD HH:MM:SS`; omitted = now. */
    createdAt?: string | null;
}

export interface ActivityFilters {
    /** One room (room admin). `undefined` = every room (super-admin). */
    roomId?: string;
    /** Super-admin: only rows with no room. */
    roomless?: boolean;
    player?: string;
    /** `YYYY-MM-DD`, interpreted in `timezone`. Inclusive. */
    from?: string;
    to?: string;
    tournamentId?: string;
    game?: string;
    categories?: ActivityCategory[];
    eventType?: string;
    keyword?: string;
    problemsOnly?: boolean;
    /** Cursor: rows with id < before. */
    before?: number;
    limit?: number;
    /** The zone `from`/`to` are read in. */
    timezone?: string;
}

/** What a reader sees. Raw ids are only present for the super-admin. */
export interface ActivityRow {
    id: number;
    created_at: string;
    room_id?: string | null;
    room_name: string | null;
    tz: string;
    category: string;
    event_type: string;
    severity: ActivitySeverity;
    player: string | null;
    actor: string | null;
    device: string | null;
    tournament_id: string | null;
    tournament_name: string | null;
    game_name: string | null;
    table_name: string | null;
    source: string | null;
    score: number | null;
    summary: string;
    reasons: string[];
    /**
     * G15 (v2.228.0) - the curated details panel: a per-type allowlist built
     * here, never ids, IPs, tokens or hashes. Both readers get it.
     */
    detail: ActivityDetail;
    /** Super-admin only. */
    canonical_user_id?: string | null;
    actor_user_id?: string | null;
    device_id?: string | null;
    details?: Record<string, unknown> | null;
}

type DbRow = {
    id: number; created_at: string; game_room_id: string | null; category: string; event_type: string;
    severity: string; canonical_user_id: string | null; player_alias: string | null; actor_user_id: string | null;
    device_id: string | null; tournament_id: string | null; game_id: string | null;
    tournament_name: string | null; game_name: string | null; table_name: string | null;
    source: string | null; score: number | null; summary: string; details: string | null;
    dedupe_key: string | null; room_name: string | null; device_model: string | null;
};

/** Sentinel submitter ids that are never a person. */
const NON_PERSON_IDS = new Set(['SYSTEM', 'COMMUNITY', 'ANON', '']);

/** `details` keys a room admin never sees (ADR 0037 §10). */
const PRIVATE_DETAIL_KEYS = /ip|token|secret|password|hash/i;

function safeParse(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function likeEscape(s: string): string {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
function tzOffsetMs(ms: number, tz: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - ms;
}

/** Midnight of `YYYY-MM-DD` in `tz`, as SQLite UTC text; null on a bad date. */
export function zonedDayStartUtc(day: string, tz: string, addDays = 0): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
    if (!m) return null;
    const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays);
    if (!Number.isFinite(guess)) return null;
    let ms = guess - tzOffsetMs(guess, tz);
    ms = guess - tzOffsetMs(ms, tz);
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Filters from a request's query string (both readers share it). */
export function parseActivityQuery(q: Record<string, unknown>): ActivityFilters {
    const str = (k: string) => (typeof q[k] === 'string' && (q[k] as string).trim() ? (q[k] as string).trim().slice(0, 200) : undefined);
    const cats = (str('category') ?? '').split(',').map(s => s.trim()).filter((c): c is ActivityCategory =>
        (ACTIVITY_CATEGORIES as string[]).includes(c));
    const before = Number(str('before'));
    const limit = Number(str('limit'));
    return {
        player: str('player'),
        from: str('from'),
        to: str('to'),
        tournamentId: str('tournament'),
        game: str('game'),
        categories: cats.length ? cats : undefined,
        eventType: str('type'),
        keyword: str('q'),
        problemsOnly: str('problems') === '1' || str('problems') === 'true',
        before: Number.isFinite(before) && before > 0 ? before : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
    };
}

export class ActivityLogService {
    /** In-memory count of writes that failed since boot (ADR 0037 §7). */
    private static failures = 0;
    private static lastFailure: string | null = null;
    /** Per-room debounce for the live ping. */
    private static pingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    static writeFailureStats(): { count: number; last: string | null } {
        return { count: ActivityLogService.failures, last: ActivityLogService.lastFailure };
    }

    /**
     * G15 - inside an admin write, mark the action as already accounted for
     * WITHOUT writing a row, so the middleware's generic row is skipped too.
     * For a save that changed nothing (ADR 0037 §10 amendment).
     */
    static suppressAdminRow(): void {
        const store = activityRequestContext.getStore();
        if (store) store.wrote = true;
    }

    /** Test hook. */
    static _resetFailuresForTests(): void {
        ActivityLogService.failures = 0;
        ActivityLogService.lastFailure = null;
    }

    /**
     * Write one row. NEVER rejects: a failure is warned, counted and dropped.
     * Callers may `await` it (tests, ordered paths) or fire and forget; the
     * promise is registered with the background-task tracker either way.
     */
    static record(entry: ActivityEntry): Promise<void> {
        // Inside an admin write (activityAdminMiddleware): this row is the
        // record of the action, so the middleware's generic row is skipped,
        // and an admin row with no actor names the admin who made the request.
        const store = activityRequestContext.getStore();
        if (store) {
            store.wrote = true;
            if (entry.category === 'admin' && !entry.actorUserId) {
                const actor = store.actor();
                if (actor) {
                    entry = {
                        ...entry,
                        actorUserId: actor.userId,
                        details: actor.name ? { ...(entry.details ?? {}), actorName: actor.name } : entry.details,
                    };
                }
            }
        }
        return trackBackground(ActivityLogService.write(entry).catch((err) => {
            ActivityLogService.failures++;
            const msg = err instanceof Error ? err.message : String(err);
            ActivityLogService.lastFailure = `${new Date().toISOString()} ${entry.category}/${entry.eventType}: ${msg}`;
            logWarn(`Activity log write failed (${entry.category}/${entry.eventType}): ${msg}`);
        }));
    }

    private static async write(entry: ActivityEntry): Promise<void> {
        const db = await getDatabase();
        let roomId = entry.roomId;
        let tournamentName = entry.tournamentName ?? null;
        let gameName = entry.gameName ?? null;
        let tournamentId = entry.tournamentId ?? null;

        if (entry.gameId && (!gameName || roomId === undefined || !tournamentId)) {
            const g = await db.get<{ name: string; tournament_id: string | null; game_room_id: string | null }>(
                `SELECT g.name, g.tournament_id, COALESCE(g.game_room_id, t.game_room_id) AS game_room_id
                   FROM games g LEFT JOIN tournaments t ON t.id = g.tournament_id WHERE g.id = ?`,
                entry.gameId,
            );
            if (g) {
                gameName = gameName ?? g.name;
                tournamentId = tournamentId ?? g.tournament_id;
                if (roomId === undefined && !entry.tournamentId) roomId = g.game_room_id;
            }
        }
        if (tournamentId && (!tournamentName || roomId === undefined)) {
            const t = await db.get<{ name: string; game_room_id: string | null }>(
                'SELECT name, game_room_id FROM tournaments WHERE id = ?', tournamentId,
            );
            if (t) {
                tournamentName = tournamentName ?? t.name;
                if (roomId === undefined) roomId = t.game_room_id;
            }
        }
        const userId = entry.userId && !NON_PERSON_IDS.has(entry.userId) ? entry.userId : null;
        const actorId = entry.actorUserId && !NON_PERSON_IDS.has(entry.actorUserId) ? entry.actorUserId : null;
        const severity: ActivitySeverity = entry.severity === 'problem' ? 'problem' : 'info';
        const cols = [
            'game_room_id', 'category', 'event_type', 'severity', 'canonical_user_id', 'player_alias',
            'actor_user_id', 'device_id', 'tournament_id', 'game_id', 'tournament_name', 'game_name',
            'table_name', 'source', 'score', 'summary', 'details', 'dedupe_key',
        ];
        const vals: unknown[] = [
            roomId ?? null, entry.category, entry.eventType, severity, userId, entry.playerAlias ?? null,
            actorId, entry.deviceId ?? null, tournamentId, entry.gameId ?? null, tournamentName, gameName,
            entry.tableName ?? null, entry.source ?? null,
            typeof entry.score === 'number' && Number.isFinite(entry.score) ? Math.floor(entry.score) : null,
            (entry.summary || '').slice(0, 1000),
            entry.details ? JSON.stringify(entry.details) : null,
            entry.dedupeKey ?? null,
        ];
        if (entry.createdAt) { cols.push('created_at'); vals.push(entry.createdAt); }
        const res = await db.run(
            `INSERT OR IGNORE INTO activity_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            ...vals,
        );
        if ((res.changes ?? 0) > 0) ActivityLogService.ping(roomId ?? null);
    }

    /**
     * A content-free `activity:new` to the room channel (debounced), so an
     * open Activity page refetches through its authed API. Nothing about the
     * row rides the socket: the room channel is joinable by any viewer.
     */
    private static ping(roomId: string | null): void {
        if (!roomId || process.env.VITEST) return;
        if (ActivityLogService.pingTimers.has(roomId)) return;
        const t = setTimeout(async () => {
            ActivityLogService.pingTimers.delete(roomId);
            try {
                const { emitActivityNew } = await import('../api/websocket.js');
                emitActivityNew(roomId);
            } catch { /* best effort */ }
        }, 2000);
        if (typeof t === 'object' && t && 'unref' in t) (t as { unref: () => void }).unref();
        ActivityLogService.pingTimers.set(roomId, t);
    }

    /**
     * The rooms a device's activity belongs to RIGHT NOW (ADR 0037 §2): its
     * designated room (room or tournament pin), or with "All my rooms" every
     * room the player is a member of or entered a tournament in. Decided by
     * `deviceRoutesTo`, the one routing rule. Empty = Global-only / no room.
     */
    static async roomsForDevice(deviceId: string, canonicalUserId: string): Promise<string[]> {
        const { WitnessService } = await import('./WitnessService.js');
        const { deviceRoutesTo } = await import('../utils/witnessRouting.js');
        const target = await WitnessService.getDeviceTarget(deviceId);
        if (target.roomId) return [target.roomId];
        if (target.globalOnly) return [];
        const db = await getDatabase();
        const members = await db.all<Array<{ room_id: string }>>(
            'SELECT room_id FROM room_members WHERE user_id = ?', canonicalUserId,
        );
        const entered = await db.all<Array<{ room_id: string }>>(
            `SELECT DISTINCT t.game_room_id AS room_id FROM tournaments t
              WHERE t.game_room_id IS NOT NULL
                AND (EXISTS (SELECT 1 FROM tournament_participants tp WHERE tp.tournament_id = t.id AND tp.user_id = ?)
                  OR EXISTS (SELECT 1 FROM tournament_roster tr WHERE tr.tournament_id = t.id AND tr.user_id = ?))`,
            canonicalUserId, canonicalUserId,
        );
        const memberSet = new Set(members.map(m => m.room_id));
        const enteredSet = new Set(entered.map(e => e.room_id));
        const out: string[] = [];
        for (const roomId of new Set([...memberSet, ...enteredSet])) {
            if (deviceRoutesTo(target, {
                roomId, tournamentId: null, isRound: false,
                isParticipant: enteredSet.has(roomId), isMember: memberSet.has(roomId),
            })) out.push(roomId);
        }
        return out;
    }

    /**
     * A device event: one row per room the device routes to now, or one
     * room-less row when it routes to none. Never rejects.
     */
    static recordForDevice(
        deviceId: string, canonicalUserId: string, entry: Omit<ActivityEntry, 'roomId' | 'deviceId' | 'userId'>,
        severityFor?: (roomId: string | null) => Promise<ActivitySeverity>,
    ): Promise<void> {
        // Tracked as a whole: the routing lookup runs before `record` registers itself.
        return trackBackground(ActivityLogService.recordForDeviceNow(deviceId, canonicalUserId, entry, severityFor));
    }

    private static async recordForDeviceNow(
        deviceId: string, canonicalUserId: string, entry: Omit<ActivityEntry, 'roomId' | 'deviceId' | 'userId'>,
        severityFor?: (roomId: string | null) => Promise<ActivitySeverity>,
    ): Promise<void> {
        let rooms: string[] = [];
        let deviceType: string | null = null;
        try {
            rooms = await ActivityLogService.roomsForDevice(deviceId, canonicalUserId);
            const db = await getDatabase();
            deviceType = (await db.get<{ device_type: string | null }>(
                'SELECT device_type FROM witness_devices WHERE atgames_unique_id = ?', deviceId,
            ))?.device_type ?? null;
        } catch (err) {
            logWarn(`Activity log: device routing lookup failed for ${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const details = { ...(entry.details ?? {}), deviceType: deviceType === 'desktop' ? 'desktop' : 'atgames' };
        const targets: Array<string | null> = rooms.length > 0 ? rooms : [null];
        await Promise.all(targets.map(async roomId => ActivityLogService.record({
            ...entry,
            ...(severityFor ? { severity: await severityFor(roomId).catch((): ActivitySeverity => 'info') } : {}),
            details,
            roomId,
            deviceId,
            userId: canonicalUserId,
            dedupeKey: entry.dedupeKey ? `${entry.dedupeKey}:${roomId ?? '-'}` : null,
        })));
    }

    /**
     * The per-minute device sweep (runs beside `EventScheduler.tick`).
     *
     * 1. **Offline**: a device whose last heartbeat is older than
     *    `HEARTBEAT_STALE_SEC` (the lobby's rule) and whose offline has not
     *    been logged since that heartbeat -> one row per routed room, `info`
     *    unless `deviceMatteredInRoom` says it mattered there. Only devices
     *    heard from in the last 24 h, so a long-dead device is not announced.
     * 2. **Launched, no score arrived** (the rule, ADR 0037 Consequences): a
     *    table SESSION observation that ran at least `NO_SCORE_MIN_SEC`, whose
     *    exit is at least `NO_SCORE_GRACE_SEC` old, and for which no witness
     *    score from that device (any outcome, `witness_evidence`) was played
     *    between its launch and exit + grace -> one `problem` row, dated at the
     *    exit. Each session is evaluated once (`activity_checked_at`); sessions
     *    whose exit is older than 24 h are never evaluated (no first-run flood).
     *    It cannot say WHY (a client-side refusal looks the same); it says
     *    where to look.
     */
    static readonly NO_SCORE_GRACE_SEC = 600;
    static readonly NO_SCORE_MIN_SEC = 60;
    static async sweepDevices(nowSec: number = Math.floor(Date.now() / 1000)): Promise<{ offline: number; noScore: number }> {
        const db = await getDatabase();
        const { HEARTBEAT_STALE_SEC } = await import('./EventLobbyService.js');
        let offline = 0;
        let noScore = 0;
        const nowSql = new Date(nowSec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

        const stale = await db.all<Array<{ atgames_unique_id: string; canonical_user_id: string; heartbeat_at: string }>>(
            `SELECT atgames_unique_id, canonical_user_id, heartbeat_at FROM witness_devices
              WHERE revoked_at IS NULL AND heartbeat_at IS NOT NULL
                AND ? - CAST(strftime('%s', heartbeat_at) AS INTEGER) > ?
                AND ? - CAST(strftime('%s', heartbeat_at) AS INTEGER) < 86400
                AND (offline_logged_at IS NULL OR offline_logged_at < heartbeat_at)`,
            nowSec, HEARTBEAT_STALE_SEC, nowSec,
        );
        for (const d of stale) {
            const claim = await db.run(
                `UPDATE witness_devices SET offline_logged_at = ?
                  WHERE atgames_unique_id = ? AND heartbeat_at = ? AND (offline_logged_at IS NULL OR offline_logged_at < heartbeat_at)`,
                nowSql, d.atgames_unique_id, d.heartbeat_at,
            );
            if (claim.changes !== 1) continue;
            offline++;
            // Owner ruling 2026-11-07: offline is `info` unless it mattered in THAT
            // room (decided per routed room), so a nightly power-off is never a problem.
            const { WitnessService } = await import('./WitnessService.js');
            const target = await WitnessService.getDeviceTarget(d.atgames_unique_id);
            await ActivityLogService.recordForDevice(d.atgames_unique_id, d.canonical_user_id, {
                category: 'device', eventType: 'device_offline',
                summary: 'Device stopped responding (no heartbeat for over 5 minutes)',
                details: { lastHeartbeat: d.heartbeat_at },
                createdAt: d.heartbeat_at,
            }, async (roomId) => (roomId && await ActivityLogService.deviceMatteredInRoom(
                roomId, d.canonical_user_id, target.tournamentId,
            )) ? 'problem' : 'info');
        }

        const sessions = await db.all<Array<{
            id: number; atgames_unique_id: string; canonical_user_id: string; table_name: string;
            launch_ts: number; exit_ts: number; duration_sec: number | null;
        }>>(
            `SELECT id, atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec
               FROM witness_observations
              WHERE kind = 'session' AND exit_ts IS NOT NULL AND activity_checked_at IS NULL
                AND exit_ts <= ? AND exit_ts >= ?`,
            nowSec - ActivityLogService.NO_SCORE_GRACE_SEC, nowSec - 86400,
        );
        for (const o of sessions) {
            const claim = await db.run(
                `UPDATE witness_observations SET activity_checked_at = ? WHERE id = ? AND activity_checked_at IS NULL`,
                nowSql, o.id,
            );
            if (claim.changes !== 1) continue;
            const duration = o.duration_sec ?? (o.exit_ts - o.launch_ts);
            if (duration < ActivityLogService.NO_SCORE_MIN_SEC) continue;
            const scored = await db.get(
                `SELECT 1 FROM witness_evidence
                  WHERE device_id = ? AND CAST(strftime('%s', played_at) AS INTEGER) BETWEEN ? AND ?
                  LIMIT 1`,
                o.atgames_unique_id, o.launch_ts, o.exit_ts + ActivityLogService.NO_SCORE_GRACE_SEC,
            );
            if (scored) continue;
            noScore++;
            await ActivityLogService.recordForDevice(o.atgames_unique_id, o.canonical_user_id, {
                category: 'device', eventType: 'device_no_score', severity: 'problem', tableName: o.table_name,
                summary: `Played ${o.table_name} for ${Math.max(1, Math.round(duration / 60))} min, but no score arrived`,
                details: {
                    launchTs: o.launch_ts, exitTs: o.exit_ts, durationSec: duration,
                    reasons: ['The device reported the table session but sent no score for it. '
                        + 'If the player finished a game, the client (Castcade / the cabinet) did not send it - check its log.'],
                },
                dedupeKey: `noscore:${o.id}`,
                createdAt: new Date(o.exit_ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
            });
        }
        return { offline, noScore };
    }

    /**
     * A Discord post the bot could not make, with Discord's error, on the
     * room(s) that route posts to that channel (room-less when none does).
     */
    static recordBotPostFailure(channelId: string, err: unknown, what: string = 'post'): Promise<void> {
        return trackBackground((async () => {
            const e = err as { message?: string; code?: number | string; status?: number };
            const message = (e?.message || String(err)).slice(0, 300);
            const code = e?.code ?? e?.status ?? null;
            let rooms: string[] = [];
            try { rooms = await ActivityLogService.roomsForChannel(channelId); } catch { rooms = []; }
            await Promise.all((rooms.length > 0 ? rooms : [null]).map(roomId => ActivityLogService.record({
                roomId, category: 'bot', eventType: 'bot_post_failed', severity: 'problem',
                summary: `The bot could not ${what} to a Discord channel: ${message}${code != null ? ` (code ${code})` : ''}`,
                details: { channelId, code, reasons: [message] },
            })));
        })());
    }

    /** Rooms whose settings or tournaments name this channel. */
    static async roomsForChannel(channelId: string): Promise<string[]> {
        if (!channelId) return [];
        const db = await getDatabase();
        const rows = await db.all<Array<{ room_id: string | null }>>(
            `SELECT game_room_id AS room_id FROM tournaments
              WHERE discord_channel_id = ? OR (discord_announce_routes IS NOT NULL AND instr(discord_announce_routes, ?) > 0)
             UNION
             SELECT game_room_id AS room_id FROM game_room_settings WHERE value = ? AND key LIKE '%CHANNEL%'`,
            channelId, `"${channelId}"`, channelId,
        );
        return [...new Set(rows.map(r => r.room_id).filter((v): v is string => !!v))];
    }

    /**
     * A slash command the room policy (or a gate) refused: one `problem` row
     * on each room linked to the guild. Successful commands are not logged.
     */
    static recordCommandRefusal(guildId: string, userId: string, commandName: string, refusal: string): Promise<void> {
        return trackBackground((async () => {
            let rooms: string[] = [];
            try {
                const db = await getDatabase();
                rooms = (await db.all<Array<{ id: string }>>(
                    `SELECT game_room_id AS id FROM game_room_settings WHERE key = 'DISCORD_GUILD_ID' AND value = ?`, guildId,
                )).map(r => r.id);
            } catch { rooms = []; }
            await Promise.all((rooms.length > 0 ? rooms : [null]).map(roomId => ActivityLogService.record({
                roomId, category: 'bot', eventType: 'command_refused', severity: 'problem', userId,
                summary: `/${commandName} refused: ${refusal}`,
                details: { command: commandName, reasons: [refusal] },
            })));
        })());
    }

    /**
     * Did a device going quiet matter in this room right now (owner ruling
     * 2026-11-07)? True when the player is checked in to an unfinished event
     * of the room, or the room has an open event round or an open game in a
     * Limited-attempts tournament. The device already routes to the room; a
     * device pinned to one tournament only counts that tournament.
     */
    static async deviceMatteredInRoom(roomId: string, canonicalUserId: string, pinnedTournamentId: string | null): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT 1 FROM tournaments t
              WHERE t.game_room_id = ? AND (? IS NULL OR t.id = ?)
                AND (
                    (t.format = 'event' AND t.event_finished_at IS NULL
                       AND EXISTS (SELECT 1 FROM tournament_participants tp WHERE tp.tournament_id = t.id AND tp.user_id = ?))
                 OR (t.format = 'event' AND EXISTS (SELECT 1 FROM games g WHERE g.tournament_id = t.id AND g.status = 'ACTIVE'))
                 OR (t.max_attempts IS NOT NULL AND t.is_active = 1
                       AND EXISTS (SELECT 1 FROM games g WHERE g.tournament_id = t.id AND g.status = 'ACTIVE'))
                )
              LIMIT 1`,
            roomId, pinnedTournamentId, pinnedTournamentId, canonicalUserId,
        );
        return !!row;
    }

    /** Daily retention prune (ADR 0037 §8). */
    static async prune(retentionDays: number = ACTIVITY_RETENTION_DAYS): Promise<number> {
        const db = await getDatabase();
        const res = await db.run(
            "DELETE FROM activity_log WHERE created_at < datetime('now', ?)",
            `-${retentionDays} days`,
        );
        return res.changes ?? 0;
    }

    /**
     * Every id the player filter text names: display names, Discord usernames,
     * every iScored alias, per-room names, and the provider ids linked to any
     * of them (both directions). Case-insensitive substring match.
     */
    static async idsForPlayer(text: string): Promise<string[]> {
        const q = (text || '').trim();
        if (!q) return [];
        const db = await getDatabase();
        const like = `%${likeEscape(q.toLowerCase())}%`;
        const ids = new Set<string>();
        const add = (rows: Array<{ id: string | null }>) => rows.forEach(r => { if (r.id) ids.add(r.id); });
        add(await db.all(
            `SELECT discord_user_id AS id FROM user_profiles
              WHERE LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(username, '')) LIKE ? ESCAPE '\\'`,
            like, like,
        ));
        add(await db.all(
            `SELECT discord_user_id AS id FROM user_mappings WHERE LOWER(iscored_username) LIKE ? ESCAPE '\\'`, like,
        ));
        add(await db.all(
            `SELECT user_id AS id FROM room_members WHERE LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\'`, like,
        ));
        if (ids.size > 0) {
            const list = [...ids];
            const ph = list.map(() => '?').join(',');
            add(await db.all(
                `SELECT provider_user_id AS id FROM user_identity_links WHERE canonical_user_id IN (${ph})
                 UNION SELECT canonical_user_id AS id FROM user_identity_links WHERE provider_user_id IN (${ph})`,
                ...list, ...list,
            ));
        }
        return [...ids].slice(0, 500);
    }

    /** WHERE clause + params for a filter set. */
    private static async where(f: ActivityFilters): Promise<{ sql: string; params: unknown[] }> {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (f.roomId !== undefined) { clauses.push('a.game_room_id = ?'); params.push(f.roomId); }
        else if (f.roomless) clauses.push('a.game_room_id IS NULL');
        if (f.player && f.player.trim()) {
            const ids = await ActivityLogService.idsForPlayer(f.player);
            const like = `%${likeEscape(f.player.trim().toLowerCase())}%`;
            const parts = [`LOWER(COALESCE(a.player_alias, '')) LIKE ? ESCAPE '\\'`];
            params.push(like);
            if (ids.length > 0) {
                const ph = ids.map(() => '?').join(',');
                parts.push(`a.canonical_user_id IN (${ph})`, `a.actor_user_id IN (${ph})`);
                params.push(...ids, ...ids);
            }
            clauses.push(`(${parts.join(' OR ')})`);
        }
        if (f.from || f.to) {
            const range = (tz: string): { sql: string; params: unknown[] } | null => {
                const parts: string[] = [];
                const ps: unknown[] = [];
                const from = f.from ? zonedDayStartUtc(f.from, tz) : null;
                const to = f.to ? zonedDayStartUtc(f.to, tz, 1) : null;
                if (from) { parts.push('a.created_at >= ?'); ps.push(from); }
                if (to) { parts.push('a.created_at < ?'); ps.push(to); }
                return parts.length ? { sql: parts.join(' AND '), params: ps } : null;
            };
            const defaultTz = f.timezone || 'UTC';
            if (f.roomId !== undefined || f.roomless) {
                const r = range(defaultTz);
                if (r) { clauses.push(r.sql); params.push(...r.params); }
            } else {
                // Super-admin across rooms (owner ruling 2026-11-07): each row's
                // dates are read in ITS room's zone; rooms with no valid zone and
                // room-less rows use `defaultTz` (the server zone, the end of the
                // resolveTimezone chain).
                const db = await getDatabase();
                const { roomTimezonesFor } = await import('../utils/roomTimezone.js');
                const roomIds = (await db.all<Array<{ id: string }>>('SELECT id FROM game_rooms')).map(r => r.id);
                const byTz = new Map<string, string[]>();
                for (const [roomId, tz] of await roomTimezonesFor(roomIds)) {
                    if (tz === defaultTz) continue;
                    byTz.set(tz, [...(byTz.get(tz) ?? []), roomId]);
                }
                const ors: string[] = [];
                const orParams: unknown[] = [];
                const grouped: string[] = [];
                for (const [tz, ids] of byTz) {
                    const r = range(tz);
                    if (!r) continue;
                    ors.push(`(a.game_room_id IN (${ids.map(() => '?').join(',')}) AND ${r.sql})`);
                    orParams.push(...ids, ...r.params);
                    grouped.push(...ids);
                }
                const r = range(defaultTz);
                if (r) {
                    const notGrouped = grouped.length
                        ? `(a.game_room_id IS NULL OR a.game_room_id NOT IN (${grouped.map(() => '?').join(',')}))`
                        : '1=1';
                    ors.push(`(${notGrouped} AND ${r.sql})`);
                    orParams.push(...grouped, ...r.params);
                }
                if (ors.length) { clauses.push(`(${ors.join(' OR ')})`); params.push(...orParams); }
            }
        }
        if (f.tournamentId) { clauses.push('a.tournament_id = ?'); params.push(f.tournamentId); }
        if (f.game && f.game.trim()) {
            const like = `%${likeEscape(f.game.trim().toLowerCase())}%`;
            clauses.push(`(LOWER(COALESCE(a.game_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.table_name, '')) LIKE ? ESCAPE '\\')`);
            params.push(like, like);
        }
        const cats = (f.categories ?? []).filter(c => ACTIVITY_CATEGORIES.includes(c));
        if (cats.length > 0) {
            clauses.push(`a.category IN (${cats.map(() => '?').join(',')})`);
            params.push(...cats);
        }
        if (f.eventType) { clauses.push('a.event_type = ?'); params.push(f.eventType); }
        if (f.keyword && f.keyword.trim()) {
            const like = `%${likeEscape(f.keyword.trim().toLowerCase())}%`;
            clauses.push(`(LOWER(a.summary) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.game_name, '')) LIKE ? ESCAPE '\\'
                 OR LOWER(COALESCE(a.table_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.tournament_name, '')) LIKE ? ESCAPE '\\'
                 OR LOWER(COALESCE(a.player_alias, '')) LIKE ? ESCAPE '\\' OR LOWER(a.event_type) LIKE ? ESCAPE '\\')`);
            params.push(like, like, like, like, like, like);
        }
        if (f.problemsOnly) clauses.push(`a.severity = 'problem'`);
        if (f.before && Number.isFinite(f.before)) { clauses.push('a.id < ?'); params.push(f.before); }
        return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
    }

    /**
     * Read a filtered page, newest first. `superAdmin` decides what a row
     * carries: room admins never get raw ids, device ids or private detail
     * keys (ADR 0037 §10); labels are resolved here.
     */
    static async query(f: ActivityFilters, opts: { superAdmin: boolean }): Promise<{ rows: ActivityRow[]; nextBefore: number | null }> {
        const db = await getDatabase();
        const limit = Math.min(Math.max(Math.floor(f.limit ?? 50), 1), 5000);
        const { sql, params } = await ActivityLogService.where(f);
        const raw = await db.all<DbRow[]>(
            `SELECT a.*, r.name AS room_name, wd.device_model_name AS device_model FROM activity_log a
               LEFT JOIN game_rooms r ON r.id = a.game_room_id
               LEFT JOIN witness_devices wd ON wd.atgames_unique_id = a.device_id
             ${sql} ORDER BY a.id DESC LIMIT ?`,
            ...params, limit + 1,
        );
        const more = raw.length > limit;
        const page = more ? raw.slice(0, limit) : raw;

        const { resolveUserLabels } = await import('./PlayerProfileResolver.js');
        const labels = await resolveUserLabels(page.flatMap(r => [r.canonical_user_id, r.actor_user_id].filter((v): v is string => !!v)));
        const { roomTimezonesFor, resolveTimezone } = await import('../utils/roomTimezone.js');
        const tzs = await roomTimezonesFor(page.map(r => r.game_room_id).filter((v): v is string => !!v));
        const auditKeys = await ActivityLogService.auditSettingKeys(page);

        const rows = page.map((r): ActivityRow => {
            const details = safeParse(r.details);
            const reasons = Array.isArray(details?.reasons)
                ? (details!.reasons as unknown[]).filter((x): x is string => typeof x === 'string')
                : [];
            const deviceType = details?.deviceType;
            const device = r.device_id || deviceType
                ? (deviceType === 'desktop' ? 'Castcade (PC)' : 'Witness cabinet')
                : null;
            const player = r.canonical_user_id
                ? (labels[r.canonical_user_id] ?? r.player_alias ?? 'Unknown player')
                : (r.player_alias ?? null);
            const actor = r.actor_user_id
                ? (labels[r.actor_user_id] ?? (typeof details?.actorName === 'string' ? details.actorName : 'an admin'))
                : (typeof details?.actorName === 'string' ? details.actorName : null);
            const keys = auditKeys.get(r.id) ?? null;
            const presentable = { ...r, device_model: r.device_model ?? null };
            const row: ActivityRow = {
                id: r.id,
                created_at: r.created_at,
                room_name: r.room_name,
                tz: resolveTimezone(null, r.game_room_id ? tzs.get(r.game_room_id) : null),
                category: r.category,
                event_type: r.event_type,
                severity: r.severity === 'problem' ? 'problem' : 'info',
                player, actor, device,
                tournament_id: r.tournament_id,
                tournament_name: r.tournament_name,
                game_name: r.game_name,
                table_name: r.table_name,
                source: r.source,
                score: r.score,
                summary: adminSummary(presentable, details, actor, keys) ?? r.summary,
                reasons,
                detail: buildActivityDetail(presentable, details, keys),
            };
            if (opts.superAdmin) {
                row.room_id = r.game_room_id;
                row.canonical_user_id = r.canonical_user_id;
                row.actor_user_id = r.actor_user_id;
                row.device_id = r.device_id;
                row.details = details;
            } else if (details) {
                // Room admins: no ids, no private keys - only the reasons list above.
                for (const k of Object.keys(details)) if (PRIVATE_DETAIL_KEYS.test(k)) delete details[k];
            }
            return row;
        });
        return { rows, nextBefore: more ? page[page.length - 1]!.id : null };
    }

    /**
     * Rows backfilled from `audit_log` (dedupe `al:<id>`) for a settings save
     * carry no keys of their own; the audit row has them. Only the KEYS are
     * read (never values, IPs or the actor).
     */
    private static async auditSettingKeys(page: DbRow[]): Promise<Map<number, string[]>> {
        const want = new Map<number, number>();
        for (const r of page) {
            const action = r.category === 'admin' ? auditActionOf(r.summary) : null;
            const m = /^al:(\d+)$/.exec(r.dedupe_key ?? '');
            if (m && (action === 'room.settings_update' || action === 'settings.update')) want.set(Number(m[1]), r.id);
        }
        const out = new Map<number, string[]>();
        if (want.size === 0) return out;
        try {
            const db = await getDatabase();
            const ids = [...want.keys()];
            const audits = await db.all<Array<{ id: number; details: string | null }>>(
                `SELECT id, details FROM audit_log WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids,
            );
            for (const a of audits) {
                const keys = safeParse(a.details)?.keys;
                if (Array.isArray(keys)) out.set(want.get(a.id)!, keys.filter((k): k is string => typeof k === 'string'));
            }
        } catch { /* the audit row may be pruned; the row still reads */ }
        return out;
    }

    /** The filtered rows as CSV (up to 5000, newest first). */
    static async exportCsv(f: ActivityFilters, opts: { superAdmin: boolean }): Promise<string> {
        const { rows } = await ActivityLogService.query({ ...f, before: undefined, limit: 5000 }, opts);
        const header = ['time', 'timezone', ...(opts.superAdmin ? ['room'] : []), 'category', 'type', 'severity',
            'player', 'actor', 'device', 'tournament', 'game', 'table', 'source', 'score', 'summary', 'reasons'];
        const esc = (v: unknown) => {
            const s = v == null ? '' : String(v);
            // Leading = + - @ would be read as a formula by spreadsheet apps.
            const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
            return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };
        const lines = [header.join(',')];
        for (const r of rows) {
            lines.push([
                localTime(r.created_at, r.tz), r.tz, ...(opts.superAdmin ? [r.room_name ?? '(no room)'] : []),
                r.category, r.event_type, r.severity, r.player, r.actor, r.device,
                r.tournament_name, r.game_name, r.table_name, r.source, r.score, r.summary, r.reasons.join('; '),
            ].map(esc).join(','));
        }
        return lines.join('\r\n') + '\r\n';
    }
}

/** `YYYY-MM-DD HH:MM:SS` in `tz` for a SQLite UTC stamp. */
function localTime(utc: string, tz: string): string {
    const ms = Date.parse(utc.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ms)) return utc;
    try {
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).format(new Date(ms));
    } catch {
        return utc;
    }
}

/** Pretty integer for summaries. */
export function fmtScore(n: number | null | undefined): string {
    return typeof n === 'number' && Number.isFinite(n) ? Math.floor(n).toLocaleString('en-US') : '?';
}
