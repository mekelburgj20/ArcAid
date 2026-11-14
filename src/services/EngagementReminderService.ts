import { getDatabase } from '../database/database.js';
import { getNextRunTime } from '../utils/cronUtils.js';
import { roomTimezonesFor, resolveTimezone } from '../utils/roomTimezone.js';
import { resolveSubmissionPlayerId } from '../utils/submissionAttribution.js';
import { normalizeEntryMode } from '../utils/tournamentEntry.js';
import { utcMs } from '../utils/activityPresentation.js';
import { logError } from '../utils/logger.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { BanService } from './BanService.js';
import { NotificationService, playReminderHoursOf, type NotificationType } from './NotificationService.js';

/**
 * EngagementReminderService - the opt-in "come play" DMs (five types, all
 * default OFF): playReminder, halfwayReminder, endingSoon, podiumLost and the
 * room-level inactiveReminder. Driven by `Scheduler.startEngagementReminderSweep`
 * (every 15 minutes) through `sweep(now)`; the clock is a parameter so tests
 * can drive it.
 *
 * Dedupe and spacing share one table, `engagement_reminders`: a row is INSERTed
 * before the DM is sent (the UNIQUE constraint is the dedupe, as in
 * `rotation_nudges`), and a player's newest row gates the 20 h spacing between
 * reminders. A candidate that is merely waiting for the spacing is never
 * inserted, so it fires on a later sweep.
 */

const HOUR = 3_600_000;
const SPACING_MS = 20 * HOUR;
const RETENTION_MS = 120 * 24 * HOUR;
const PODIUM_SIZE = 3;

/**
 * W102 - appended to a reminder DM when the player has a paired cabinet that
 * sends to the reminder's room but no device sending there is watching now.
 */
export const CABINET_WITNESS_LINE = 'Playing on your cabinet? Open the Arcaid Witness tile first so your score posts by itself.';

/**
 * Send priority, highest first.
 *
 * A table's close is taken as the tournament's NEXT rotation. On a tournament
 * with several active tables that is the earliest any of them can close, so a
 * reminder can only be early there, never late.
 */
const KIND_PRIORITY: readonly NotificationType[] = [
    'endingSoon',
    'podiumLost',
    'halfwayReminder',
    'playReminder',
    'inactiveReminder',
];

interface RankEntry { id: string; score: number; ts: number | null }

interface GameCtx {
    tournamentId: string;
    tournamentName: string;
    roomId: string;
    roomName: string;
    slug: string | null;
    gameId: string;
    table: string;
    S: number;
    E: number;
    W: number;
    ranking: RankEntry[];
}

interface Item {
    kind: NotificationType;
    roomId: string;
    roomName: string;
    slug: string | null;
    tournamentId: string | null;
    tournamentName: string;
    gameId: string | null;
    table: string;
    S: number;
    E: number;
    dedupeKey: string;
    /** endingSoon: the player's standing, when they have a score. */
    rank?: number;
    players?: number;
    score?: number;
    /** podiumLost: current rank. inactiveReminder: whole days since the baseline, or null = never scored. */
    days?: number | null;
    /** inactiveReminder: names of the open tables. */
    tables?: string[];
}

interface RoomFacts {
    roomName: string;
    slug: string | null;
    joinedMs: number | null;
    tables: Map<string, string>; // gameId -> name
    minE: number;
}

interface UserState {
    memberId: string;
    canonical: string;
    prefs: Record<string, unknown>;
    items: Item[];
    rooms: Map<string, RoomFacts>;
}

/** SQLite UTC text ("YYYY-MM-DD HH:MM:SS") for an instant. */
function sqlUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function humanLeft(ms: number): string {
    const h = Math.max(1, Math.round(ms / HOUR));
    if (h >= 48) return `${Math.round(h / 24)} days`;
    return `${h} hour${h === 1 ? '' : 's'}`;
}

function rel(E: number): string {
    return `<t:${Math.floor(E / 1000)}:R>`;
}

function fmtScore(n: number): string {
    return n.toLocaleString('en-US');
}

export class EngagementReminderService {
    /** Never throws; a failure in one tournament never stops the others. */
    static async sweep(now: Date = new Date()): Promise<void> {
        try {
            const db = await getDatabase();
            const nowMs = now.getTime();

            // Housekeeping first, so a dead game's sightings never fire.
            await db.run(`DELETE FROM podium_sightings WHERE game_id NOT IN (SELECT id FROM games WHERE status = 'ACTIVE')`)
                .catch((e) => logError('EngagementReminderService prune sightings error:', e));
            await db.run('DELETE FROM engagement_reminders WHERE created_at < ?', sqlUtc(nowMs - RETENTION_MS))
                .catch((e) => logError('EngagementReminderService prune reminders error:', e));

            const tournaments = await db.all(
                `SELECT t.id, t.name, t.cadence, t.game_room_id, t.entry_mode,
                        r.name AS room_name, r.slug AS room_slug
                   FROM tournaments t
                   JOIN game_rooms r ON r.id = t.game_room_id
                  WHERE t.is_active = 1
                    AND COALESCE(t.format, 'rotation') <> 'event'
                    AND t.game_room_id IS NOT NULL
                    AND t.cadence IS NOT NULL
                    AND t.season_paused_at IS NULL
                    AND t.season_finished_at IS NULL`,
            );
            const roomTzById = await roomTimezonesFor((tournaments as any[]).map(t => t.game_room_id));

            const users = new Map<string, UserState>();
            const bans = new Map<string, boolean>();
            for (const t of tournaments as any[]) {
                try {
                    await this.collectTournament(db, t, roomTzById.get(t.game_room_id) ?? null, now, users, bans);
                } catch (error) {
                    logError(`EngagementReminderService tournament ${t.id} error:`, error);
                }
            }

            for (const user of users.values()) {
                try {
                    await this.processUser(db, user, now);
                } catch (error) {
                    logError(`EngagementReminderService user ${user.memberId} error:`, error);
                }
            }
        } catch (error) {
            logError('EngagementReminderService.sweep error:', error);
        }
    }

    // -- per tournament -----------------------------------------------------

    private static async collectTournament(
        db: any,
        t: any,
        roomTz: string | null,
        now: Date,
        users: Map<string, UserState>,
        bans: Map<string, boolean>,
    ): Promise<void> {
        const nowMs = now.getTime();
        let cadence: { cron?: string; timezone?: string };
        try { cadence = JSON.parse(t.cadence || '{}'); } catch { return; }
        if (!cadence.cron) return;
        const E = getNextRunTime(cadence.cron, resolveTimezone(cadence.timezone, roomTz), now)?.getTime();
        if (!E) return;

        const games = await db.all(
            `SELECT id, name, display_name, start_date FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`,
            t.id,
        );
        const ctxs: GameCtx[] = [];
        for (const g of games) {
            const S = utcMs(g.start_date);
            if (S === null) continue;
            ctxs.push({
                tournamentId: t.id,
                tournamentName: t.name,
                roomId: t.game_room_id,
                roomName: t.room_name,
                slug: t.room_slug || null,
                gameId: g.id,
                table: g.display_name || g.name,
                S, E, W: E - S,
                ranking: await this.buildRanking(db, g.id),
            });
        }
        if (ctxs.length === 0) return;

        // Podium sightings run for every qualifying game, whoever opted in.
        for (const c of ctxs) {
            for (const r of c.ranking.slice(0, PODIUM_SIZE)) {
                await db.run(
                    `INSERT INTO podium_sightings (game_id, user_id, last_on_podium_at) VALUES (?, ?, ?)
                     ON CONFLICT(game_id, user_id) DO UPDATE SET last_on_podium_at = excluded.last_on_podium_at`,
                    c.gameId, r.id, now.toISOString(),
                );
            }
        }

        const members = await db.all(
            `SELECT rm.user_id, rm.joined_at, up.notification_prefs
               FROM room_members rm
               JOIN user_preferences up ON up.discord_user_id = rm.user_id
              WHERE rm.room_id = ? AND up.notification_prefs IS NOT NULL`,
            t.game_room_id,
        );
        if (members.length === 0) return;

        let roster: Set<string> | null = null;
        if (normalizeEntryMode(t.entry_mode) === 'invited') {
            roster = new Set<string>();
            const rows = await db.all('SELECT user_id FROM tournament_roster WHERE tournament_id = ?', t.id);
            for (const r of rows) roster.add(await IdentityLinkService.resolveCanonical(r.user_id));
        }

        for (const m of members) {
            let prefs: Record<string, unknown>;
            try { prefs = JSON.parse(m.notification_prefs); } catch { continue; }
            if (!prefs || typeof prefs !== 'object') continue;
            if (!KIND_PRIORITY.some(k => prefs[k] === true)) continue;

            const canonical = await IdentityLinkService.resolveCanonical(m.user_id);
            if (roster && !roster.has(canonical)) continue;

            const banKey = `${m.user_id}::${t.game_room_id}`;
            let banned = bans.get(banKey);
            if (banned === undefined) {
                banned = !!(await BanService.isIdentityBanned(m.user_id, t.game_room_id)).banned;
                bans.set(banKey, banned);
            }
            if (banned) continue;

            let user = users.get(m.user_id);
            if (!user) {
                user = { memberId: m.user_id, canonical, prefs, items: [], rooms: new Map() };
                users.set(m.user_id, user);
            }
            let room = user.rooms.get(t.game_room_id);
            if (!room) {
                room = { roomName: t.room_name, slug: t.room_slug || null, joinedMs: utcMs(m.joined_at), tables: new Map(), minE: E };
                user.rooms.set(t.game_room_id, room);
            }
            room.minE = Math.min(room.minE, E);

            for (const c of ctxs) {
                room.tables.set(c.gameId, c.table);
                await this.candidatesFor(db, user, c, nowMs);
            }
        }
    }

    /** Ranking of a game: one entry per resolved identity, best score first. */
    private static async buildRanking(db: any, gameId: string): Promise<RankEntry[]> {
        const rows = await db.all(
            `SELECT iscored_username, discord_user_id, submitted_by_user_id, score, timestamp
               FROM submissions WHERE game_id = ? AND orphaned_at IS NULL ORDER BY score DESC`,
            gameId,
        );
        const out: RankEntry[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
            const pid = await resolveSubmissionPlayerId(db, row);
            if (!pid) continue;
            const id = await IdentityLinkService.resolveCanonical(pid);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, score: row.score, ts: utcMs(row.timestamp) });
        }
        return out;
    }

    private static async candidatesFor(db: any, user: UserState, c: GameCtx, nowMs: number): Promise<void> {
        const { prefs } = user;
        const idx = c.ranking.findIndex(r => r.id === user.canonical);
        const mine = idx >= 0 ? c.ranking[idx]! : null;
        const left = c.E - nowMs;
        const base = {
            roomId: c.roomId, roomName: c.roomName, slug: c.slug,
            tournamentId: c.tournamentId, tournamentName: c.tournamentName,
            gameId: c.gameId, table: c.table, S: c.S, E: c.E,
        };
        const gameKey = `game:${c.gameId}`;

        if (prefs.playReminder === true && !mine
            && nowMs >= c.S + playReminderHoursOf(prefs) * HOUR && left >= 2 * HOUR) {
            user.items.push({ ...base, kind: 'playReminder', dedupeKey: gameKey });
        }
        if (prefs.halfwayReminder === true && !mine
            && c.W >= 20 * HOUR && nowMs >= c.S + c.W / 2 && left >= HOUR) {
            user.items.push({ ...base, kind: 'halfwayReminder', dedupeKey: gameKey });
        }
        if (prefs.endingSoon === true && c.W >= 96 * HOUR && nowMs >= c.E - 72 * HOUR && left >= 6 * HOUR) {
            user.items.push({
                ...base, kind: 'endingSoon', dedupeKey: gameKey,
                ...(mine ? { rank: idx + 1, players: c.ranking.length, score: mine.score } : {}),
            });
        }
        if (prefs.podiumLost === true && mine && idx + 1 > PODIUM_SIZE && left >= 2 * HOUR) {
            const sighting = await db.get(
                'SELECT last_on_podium_at FROM podium_sightings WHERE game_id = ? AND user_id = ?',
                c.gameId, user.canonical,
            );
            const lastMs = sighting ? Date.parse(sighting.last_on_podium_at) : NaN;
            if (Number.isFinite(lastMs)
                && lastMs >= nowMs - 72 * HOUR && lastMs <= nowMs - 24 * HOUR
                && !(mine.ts !== null && mine.ts > lastMs)) {
                user.items.push({
                    ...base, kind: 'podiumLost', rank: idx + 1,
                    dedupeKey: `game:${c.gameId}:${sighting.last_on_podium_at}`,
                });
            }
        }
    }

    // -- per user -----------------------------------------------------------

    /** Room-level "a few quiet days" candidates, built only for opted-in users. */
    private static async inactiveItems(db: any, user: UserState, nowMs: number): Promise<Item[]> {
        if (user.prefs.inactiveReminder !== true) return [];
        const out: Item[] = [];
        for (const [roomId, room] of user.rooms) {
            const lastScoreMs = await this.lastScoreMs(db, user, roomId);
            const baseline = Math.max(room.joinedMs ?? 0, lastScoreMs ?? 0);
            if (!baseline || nowMs - baseline < 72 * HOUR) continue;
            out.push({
                kind: 'inactiveReminder', roomId, roomName: room.roomName, slug: room.slug,
                tournamentId: null, tournamentName: '', gameId: null, table: '',
                S: 0, E: room.minE,
                dedupeKey: `room:${roomId}:${new Date(baseline).toISOString()}`,
                days: lastScoreMs === null ? null : Math.floor((nowMs - lastScoreMs) / (24 * HOUR)),
                tables: [...room.tables.values()],
            });
        }
        return out;
    }

    /**
     * Latest score by this player in the room, from `score_history`
     * (columns: game_room_id, orphaned_at, submitted_by_user_id,
     * discord_user_id, iscored_username, created_at), attributed by the
     * member/canonical ids plus any iScored alias in `user_mappings`.
     */
    private static async lastScoreMs(db: any, user: UserState, roomId: string): Promise<number | null> {
        const ids = [...new Set([user.memberId, user.canonical])];
        const idMarks = ids.map(() => '?').join(',');
        const aliasRows = await db.all(
            `SELECT iscored_username FROM user_mappings WHERE discord_user_id IN (${idMarks})`,
            ...ids,
        );
        const aliases = aliasRows.map((r: any) => String(r.iscored_username).toLowerCase());
        const aliasClause = aliases.length ? ` OR LOWER(iscored_username) IN (${aliases.map(() => '?').join(',')})` : '';
        const row = await db.get(
            `SELECT MAX(datetime(created_at)) AS last FROM score_history
              WHERE game_room_id = ? AND orphaned_at IS NULL
                AND (submitted_by_user_id IN (${idMarks}) OR discord_user_id IN (${idMarks})${aliasClause})`,
            roomId, ...ids, ...ids, ...aliases,
        );
        return row?.last ? utcMs(row.last) : null;
    }

    private static async processUser(db: any, user: UserState, now: Date): Promise<void> {
        const nowMs = now.getTime();
        const items = [...user.items, ...(await this.inactiveItems(db, user, nowMs))];
        if (items.length === 0) return;

        // Spacing: any recent reminder row holds everything back.
        const recent = await db.get(
            'SELECT 1 AS hit FROM engagement_reminders WHERE user_id = ? AND created_at > ? LIMIT 1',
            user.memberId, sqlUtc(nowMs - SPACING_MS),
        );
        if (recent) return;

        const sentRows = await db.all('SELECT kind, dedupe_key FROM engagement_reminders WHERE user_id = ?', user.memberId);
        const sent = new Set<string>(sentRows.map((r: any) => `${r.kind}\u0000${r.dedupe_key}`));
        const fresh = items.filter(i => !sent.has(`${i.kind}\u0000${i.dedupeKey}`));

        for (const kind of KIND_PRIORITY) {
            const ofKind = fresh.filter(i => i.kind === kind);
            if (ofKind.length === 0) continue;
            // The room whose table closes soonest.
            const earliest = new Map<string, number>();
            for (const i of ofKind) earliest.set(i.roomId, Math.min(earliest.get(i.roomId) ?? Infinity, i.E));
            const roomId = [...earliest.entries()].sort((a, b) => a[1] - b[1])[0]![0];
            const group = ofKind.filter(i => i.roomId === roomId).sort((a, b) => a.E - b.E);

            const createdAt = sqlUtc(nowMs);
            const won: Item[] = [];
            for (const i of group) {
                try {
                    await db.run(
                        `INSERT INTO engagement_reminders (user_id, kind, dedupe_key, game_room_id, tournament_id, game_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        user.memberId, i.kind, i.dedupeKey, i.roomId, i.tournamentId, i.gameId, createdAt,
                    );
                    won.push(i);
                } catch {
                    // UNIQUE(user_id, kind, dedupe_key): already sent.
                }
            }
            if (won.length === 0) return;

            // An earlier-stage nudge for the same game must never follow a later one.
            const superseded: NotificationType[] =
                kind === 'halfwayReminder' ? ['playReminder']
                : kind === 'endingSoon' ? ['playReminder', 'halfwayReminder'] : [];
            for (const i of won) {
                if (!i.gameId) continue;
                for (const k of superseded) {
                    await db.run(
                        `INSERT OR IGNORE INTO engagement_reminders (user_id, kind, dedupe_key, game_room_id, tournament_id, game_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        user.memberId, k, `game:${i.gameId}`, i.roomId, i.tournamentId, i.gameId, createdAt,
                    );
                }
            }

            const cabinetLine = await this.cabinetLine(user.canonical, roomId);
            const { message, pushBody, link } = this.compose(kind, won, nowMs, cabinetLine);
            await NotificationService.notify({
                userId: user.memberId,
                type: kind,
                message,
                pushBody,
                roomId,
                tournamentId: won.length === 1 ? won[0]!.tournamentId : null,
                pushUrl: link || undefined,
            }).catch(() => {});
            return; // one DM per user per sweep
        }
    }

    /**
     * W102 - the cabinet line, or null. Added when the player has a paired
     * cabinet that heartbeats (`watching` not `unknown`) and routes to this
     * room (`routingForRoom`, verdict other than `no`), and none of the
     * player's devices routing there is watching now. Best-effort: a failure
     * adds nothing and never stops the DM.
     */
    private static async cabinetLine(canonicalUserId: string, roomId: string): Promise<string | null> {
        try {
            const { WitnessService } = await import('./WitnessService.js');
            const routed = (await WitnessService.routingForRoom(canonicalUserId, roomId)).filter(d => d.sendsHere !== 'no');
            const cabinet = routed.some(d => d.deviceType === 'atgames' && d.watching !== 'unknown');
            if (!cabinet || routed.some(d => d.watching === 'yes')) return null;
            return CABINET_WITNESS_LINE;
        } catch (error) {
            logError('EngagementReminderService cabinet line error (the reminder is sent without it):', error);
            return null;
        }
    }

    // -- copy ---------------------------------------------------------------

    private static compose(kind: NotificationType, items: Item[], nowMs: number, extraLine: string | null = null): { message: string; pushBody: string; link: string } {
        const first = items[0]!;
        const link = first.slug ? NotificationService.buildLink(first.slug) : '';
        const tail = link ? `\n${link}` : '';
        const single = items.length === 1;
        const lines = (fn: (i: Item) => string) => items.map(i => `• ${fn(i)}`).join('\n');
        const left = (i: Item) => humanLeft(i.E - nowMs);
        let message: string;
        let pushBody: string;

        switch (kind) {
            case 'playReminder': {
                if (single) {
                    const n = humanLeft(nowMs - first.S);
                    message = `\u{1F3AF} **${first.table}** has been live in **${first.tournamentName}** for ${n} and you haven't posted a score yet. It closes ${rel(first.E)}.`;
                    pushBody = `${first.table} has been live for ${n} and you haven't posted a score yet. It closes in ${left(first)}.`;
                } else {
                    message = `\u{1F3AF} You haven't posted a score yet on these tables in **${first.roomName}**:\n`
                        + lines(i => `**${i.table}** (${i.tournamentName}), closes ${rel(i.E)}`);
                    pushBody = `You haven't posted a score yet on ${items.length} tables in ${first.roomName}.`;
                }
                break;
            }
            case 'halfwayReminder': {
                if (single) {
                    message = `\u{23F3} Halfway point: **${first.table}** in **${first.tournamentName}** closes ${rel(first.E)} and you haven't posted a score yet.`;
                    pushBody = `${first.table} closes in ${left(first)} and you haven't posted a score yet.`;
                } else {
                    message = `\u{23F3} Halfway point. You haven't posted a score yet on these tables in **${first.roomName}**:\n`
                        + lines(i => `**${i.table}** (${i.tournamentName}), closes ${rel(i.E)}`);
                    pushBody = `Halfway point: ${items.length} tables in ${first.roomName} still need your score.`;
                }
                break;
            }
            case 'endingSoon': {
                const status = (i: Item) => i.rank !== undefined
                    ? `You're #${i.rank} of ${i.players} with ${fmtScore(i.score ?? 0)}.`
                    : `You haven't posted a score yet.`;
                const statusPlain = (i: Item) => i.rank !== undefined
                    ? `you're #${i.rank} of ${i.players}`
                    : `no score from you yet`;
                if (single) {
                    message = `\u{23F0} 3 days left on **${first.table}** in **${first.tournamentName}** (closes ${rel(first.E)}). ${status(first)}`;
                    pushBody = `${first.table} closes in ${left(first)}; ${statusPlain(first)}.`;
                } else {
                    message = `\u{23F0} 3 days left on these tables in **${first.roomName}**:\n`
                        + lines(i => `**${i.table}** (${i.tournamentName}), closes ${rel(i.E)}. ${status(i)}`);
                    pushBody = `${items.length} tables in ${first.roomName} close in ${left(first)} or less.`;
                }
                break;
            }
            case 'podiumLost': {
                if (single) {
                    message = `\u{1F949} You've been knocked out of the top three on **${first.table}** in **${first.tournamentName}**. You're now #${first.rank}. It closes ${rel(first.E)}, so there's still time to take it back.`;
                    pushBody = `You're now #${first.rank} on ${first.table}. It closes in ${left(first)}.`;
                } else {
                    message = `\u{1F949} You've been knocked out of the top three on these tables in **${first.roomName}**:\n`
                        + lines(i => `**${i.table}** (${i.tournamentName}), now #${i.rank}, closes ${rel(i.E)}`);
                    pushBody = `You've been knocked out of the top three on ${items.length} tables in ${first.roomName}.`;
                }
                break;
            }
            default: { // inactiveReminder
                const open = (first.tables ?? []).map(n => `**${n}**`).join(', ');
                const head = first.days === null || first.days === undefined
                    ? `\u{1F44B} You haven't posted a score in **${first.roomName}** yet.`
                    : `\u{1F44B} It's been ${first.days} days since your last score in **${first.roomName}**.`;
                message = `${head}\nOpen now: ${open}.`;
                pushBody = first.days === null || first.days === undefined
                    ? `You haven't posted a score in ${first.roomName} yet.`
                    : `It's been ${first.days} days since your last score in ${first.roomName}.`;
                break;
            }
        }
        return { message: message + (extraLine ? `\n${extraLine}` : '') + tail, pushBody, link };
    }
}
