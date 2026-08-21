import { getDatabase } from '../database/database.js';
import { GuildReadScope, buildGuildScopedRoomSqlFilter } from '../utils/discordRoomFilter.js';
import { accountSettingsUrl, roomPicksUrl, roomUrl } from '../utils/publicLinks.js';
import { CalloutAction, CalloutRoomContext } from '../utils/callouts.js';
import { getNextRunTime } from '../utils/cronUtils.js';
import { parseTournamentRules } from '../utils/platformRules.js';
import { ActiveGameRow, listActiveGamesForScope } from './activeGames.js';

/**
 * Live-data callout responders (v2.123.0).
 *
 * A static response list can't answer "what's the table today?", so an entry
 * may name an `action` instead. The gate has already resolved WHICH rooms
 * opted in; these renderers answer for exactly those rooms and nothing else.
 *
 * Copy lives here, once. If wording needs to change it changes in one place,
 * not in every room's uploaded JSON.
 */

/** Room facts, resolved once per reply. Order follows the gate's room order. */
export interface CalloutRoom {
    id: string;
    name: string;
    slug: string;
}

/** Loads name+slug for the rooms that permitted this reply, in that order. */
export async function loadCalloutRooms(roomIds: string[]): Promise<CalloutRoom[]> {
    if (roomIds.length === 0) return [];
    const db = await getDatabase();
    const placeholders = roomIds.map(() => '?').join(', ');
    const rows = (await db.all(
        `SELECT id, name, slug FROM game_rooms WHERE id IN (${placeholders})`,
        ...roomIds,
    )) as CalloutRoom[];
    // Preserve the caller's order — the FIRST room is the one placeholders and
    // single-room copy resolve against, so it must be deterministic.
    const byId = new Map(rows.map(r => [r.id, r]));
    return roomIds.map(id => byId.get(id)).filter((r): r is CalloutRoom => !!r);
}

/** `{placeholder}` context for the first room in scope. Null when there is none. */
export function roomContextFor(rooms: CalloutRoom[]): CalloutRoomContext | null {
    const room = rooms[0];
    if (!room) return null;
    return {
        roomName: room.name,
        roomUrl: roomUrl(room.slug),
        picksUrl: roomPicksUrl(room.slug),
        scoresUrl: roomUrl(room.slug),
    };
}

/** Shown when no game is ACTIVE anywhere in scope. */
export const NO_ACTIVE_GAMES_MESSAGE = 'No active games right now.';

/**
 * Per-message facts an action may need beyond the room scope (v2.125.0).
 *
 * `authorId` is the asking Discord user — only `my_rank` and `time_left` read
 * it, and both must behave when it is absent (a webhook/system message has no
 * usable author). `now` is injected by tests so the countdown copy is
 * assertable against a fixed clock; production passes nothing.
 */
export interface CalloutActionContext {
    authorId?: string | null;
    now?: Date;
}

/**
 * Renders one action into reply text, or null when it can't be answered (no
 * room resolved — the gate makes that near-impossible, but a room deleted
 * mid-flight shouldn't throw).
 */
export async function renderCalloutAction(
    action: CalloutAction,
    scope: GuildReadScope,
    rooms: CalloutRoom[],
    ctx: CalloutActionContext = {},
): Promise<string | null> {
    const first = rooms[0];
    if (!first) return null;

    switch (action) {
        case 'active_games':
            return renderActiveGames(scope, rooms);
        case 'picks_link':
            return `Pick or queue your next table here: ${roomPicksUrl(first.slug)}`;
        case 'scores_link':
            return `Submit scores and see the standings: ${roomUrl(first.slug)}`;
        case 'how_to_submit':
            return [
                `**Submitting a score**`,
                `1. Open ${roomUrl(first.slug)} and find the game.`,
                `2. Tap **Submit Score**, sign in, and enter your score.`,
                `Prefer Discord? Run \`/submit-score\` right here instead.`,
            ].join('\n');
        case 'time_left':
            return renderTimeLeft(scope, rooms, ctx);
        case 'leaders':
            return renderLeaders(scope, rooms);
        case 'my_rank':
            return renderMyRank(scope, rooms, ctx);
        case 'pick_status':
            return renderPickStatus(scope, rooms);
        case 'tournament_rules':
            return renderTournamentRules(scope, rooms);
        case 'how_to_claim':
            return renderHowToClaim(first);
        default:
            return null;
    }
}

/**
 * "What's on right now", from the same rows `/list-active` shows.
 *
 * One line per TOURNAMENT — a multi-slot tournament lists each of its active
 * games on that line rather than repeating the tournament. Lines carry a room
 * prefix only when the guild is linked to more than one room, so the common
 * single-room case stays terse. The scoreboard link is the FIRST room's, the
 * same rule the `{placeholder}` substitution uses.
 */
async function renderActiveGames(scope: GuildReadScope, rooms: CalloutRoom[]): Promise<string> {
    const games = await listActiveGamesForScope(scope);
    const first = rooms[0]!;
    if (games.length === 0) return NO_ACTIVE_GAMES_MESSAGE;

    const showRoom = rooms.length > 1;
    const roomNames = new Map(rooms.map(r => [r.id, r.name]));

    // Group by (room, tournament) preserving first-seen order.
    const groups = new Map<string, { room: string | null; tournament: string; type: string | null; games: string[] }>();
    for (const row of games) {
        const tournament = row.tournament_name || 'Manual';
        const key = `${row.game_room_id ?? ''}::${tournament}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                room: showRoom ? (roomNames.get(row.game_room_id ?? '') ?? null) : null,
                tournament,
                type: row.tournament_type || null,
                games: [],
            };
            groups.set(key, group);
        }
        group.games.push(row.game_name);
    }

    const lines = ['**Currently active:**'];
    for (const group of groups.values()) {
        const prefix = group.room ? `${group.room} — ` : '';
        const type = group.type ? ` (${group.type})` : '';
        lines.push(`${prefix}**${group.tournament}**${type}: ${group.games.join(', ')}`);
    }
    lines.push(roomUrl(first.slug));
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// v2.125.0 — six more live answers.
//
// All six read through the SAME `listActiveGamesForScope` rows `active_games`
// and `/list-active` use, so a guild can never be told about a game it is not
// scoped to see. The only exception is `pick_status`, which is about queued
// placeholders rather than active games and therefore re-applies the scope
// filter itself.
// ---------------------------------------------------------------------------

/** Groups active rows by tournament, preserving the query's order. */
function groupByTournament(games: ActiveGameRow[]): Map<string, ActiveGameRow[]> {
    const groups = new Map<string, ActiveGameRow[]>();
    for (const row of games) {
        const key = row.tournament_id ?? `name:${row.tournament_name ?? 'Manual'}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(row); else groups.set(key, [row]);
    }
    return groups;
}

/** Room prefix for a line, only when the guild is linked to more than one room. */
function roomPrefix(rooms: CalloutRoom[], gameRoomId: string | null): string {
    if (rooms.length < 2) return '';
    const name = rooms.find(r => r.id === gameRoomId)?.name;
    return name ? `${name} — ` : '';
}

/**
 * "6h 12m" — the coarse form people actually want from a countdown. Rounds
 * DOWN, so "1h 0m" never appears while 119 minutes remain; under a minute
 * degrades to "any moment now" rather than "0m", which reads as broken.
 */
export function formatDuration(ms: number): string {
    if (ms <= 0) return 'any moment now';
    const totalMinutes = Math.floor(ms / 60000);
    if (totalMinutes < 1) return 'any moment now';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

/** The tournament's own timezone, falling back the way the Scheduler does. */
function cadenceOf(row: ActiveGameRow): { cron: string | null; timezone: string } {
    let parsed: { cron?: string; timezone?: string } = {};
    try { parsed = JSON.parse(row.cadence || '{}'); } catch { parsed = {}; }
    return {
        cron: parsed.cron || null,
        timezone: parsed.timezone || process.env.BOT_TIMEZONE || 'America/Chicago',
    };
}

/**
 * `time_left` — how long the current round has left, per tournament.
 *
 * The end of a round IS the next maintenance fire, so the answer is the
 * tournament's own maintenance cron evaluated in the tournament's own timezone
 * (NOT the deployment's) via the same `getNextRunTime` helper the dashboard
 * uses. A tournament with no cron does not rotate on a clock and says so rather
 * than inventing a deadline.
 */
async function renderTimeLeft(
    scope: GuildReadScope,
    rooms: CalloutRoom[],
    ctx: CalloutActionContext,
): Promise<string> {
    const games = await listActiveGamesForScope(scope);
    if (games.length === 0) return NO_ACTIVE_GAMES_MESSAGE;
    const now = ctx.now ?? new Date();
    const first = rooms[0]!;

    const lines: string[] = ['**Time left on the current round:**'];
    for (const [, rows] of groupByTournament(games)) {
        const row = rows[0]!;
        const label = `${roomPrefix(rooms, row.game_room_id)}**${row.tournament_name || 'Manual'}**`;
        const names = rows.map(r => r.game_name).join(', ');
        const { cron, timezone } = cadenceOf(row);
        const next = cron ? getNextRunTime(cron, timezone) : null;
        if (!next) {
            lines.push(`${label} (${names}): no scheduled rotation — it runs until an admin changes it.`);
            continue;
        }
        const remaining = formatDuration(next.getTime() - now.getTime());
        // The absolute time is a Discord <t:…:f> stamp so every reader sees it
        // in their OWN timezone — a raw "22:00 America/Chicago" is wrong for
        // most of the room.
        const stamp = `<t:${Math.floor(next.getTime() / 1000)}:f>`;
        lines.push(`${label} (${names}): ends in **${remaining}** — next rotation ${stamp}.`);
    }
    lines.push(roomUrl(first.slug));
    return lines.join('\n');
}

/**
 * `leaders` — who is #1 on each active game right now.
 *
 * Reads `LeaderboardService.getForGame`, the same cached ranking the scoreboard
 * renders, so the bot and the web page cannot disagree. Display follows the
 * project-wide rule: `display_name ?? iscored_username`.
 */
async function renderLeaders(scope: GuildReadScope, rooms: CalloutRoom[]): Promise<string> {
    const games = await listActiveGamesForScope(scope);
    if (games.length === 0) return NO_ACTIVE_GAMES_MESSAGE;
    const first = rooms[0]!;
    const { LeaderboardService } = await import('../services/LeaderboardService.js');

    const lines: string[] = ['**Current leaders:**'];
    for (const row of games) {
        const rankings = await LeaderboardService.getForGame(row.game_id);
        const top = rankings[0];
        const prefix = roomPrefix(rooms, row.game_room_id);
        if (!top) {
            lines.push(`${prefix}**${row.game_name}**: no scores yet — first one takes it.`);
            continue;
        }
        const who = top.display_name || top.iscored_username;
        lines.push(`${prefix}**${row.game_name}**: ${who} — ${top.score.toLocaleString('en-US')}`);
    }
    lines.push(roomUrl(first.slug));
    return lines.join('\n');
}

/**
 * `my_rank` — where the ASKER sits on each active game.
 *
 * Identity resolves the way `/list-scores user:` does: a ranking row belongs to
 * the asker when `submitted_by_user_id` is their Discord id, OR when its
 * `iscored_username` is one of the aliases `user_mappings` holds for them.
 * Someone with neither has never linked a name, so the reply is the claim
 * nudge — the same one the rotation copy uses — rather than "you are not on
 * it", which would be true but useless.
 */
async function renderMyRank(
    scope: GuildReadScope,
    rooms: CalloutRoom[],
    ctx: CalloutActionContext,
): Promise<string> {
    const first = rooms[0]!;
    const authorId = ctx.authorId;
    if (!authorId) return renderHowToClaim(first);

    const db = await getDatabase();
    const aliasRows = (await db.all(
        'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
        authorId,
    )) as Array<{ iscored_username: string }>;
    const aliases = new Set(aliasRows.map(r => (r.iscored_username || '').toLowerCase()));

    const games = await listActiveGamesForScope(scope);
    if (games.length === 0) return NO_ACTIVE_GAMES_MESSAGE;
    const { LeaderboardService } = await import('../services/LeaderboardService.js');

    const lines: string[] = [];
    let found = false;
    for (const row of games) {
        const rankings = await LeaderboardService.getForGame(row.game_id);
        const mine = rankings.find(r =>
            r.discord_user_id === authorId
            || aliases.has((r.iscored_username || '').toLowerCase()));
        const prefix = roomPrefix(rooms, row.game_room_id);
        if (!mine) {
            lines.push(`${prefix}**${row.game_name}**: no score from you yet.`);
            continue;
        }
        found = true;
        const leader = rankings[0];
        const gap = leader && leader !== mine
            ? ` (${(leader.score - mine.score).toLocaleString('en-US')} behind #1)`
            : ' — top of the board.';
        lines.push(
            `${prefix}**${row.game_name}**: #${mine.rank} with `
            + `${mine.score.toLocaleString('en-US')}${gap}`,
        );
    }

    // No score anywhere AND no linked alias is the classic unlinked symptom:
    // the person has been playing under a name Arcaid cannot tie to them.
    if (!found && aliases.size === 0) return renderHowToClaim(first);

    lines.unshift('**Your standing:**');
    lines.push(roomUrl(first.slug));
    return lines.join('\n');
}

/**
 * `pick_status` — who owes a pick, and how long they have.
 *
 * Reuses the Picks page query (`GET /:roomId/pick-status`) shape: an
 * unfulfilled pick is a QUEUED `[Pending Pick]` placeholder on an active
 * tournament with winner-picks not switched off. The window is per-tournament
 * (`winner_pick_window_min` / `runnerup_pick_window_min`, the columns
 * `TimeoutManager` enforces) measured from `picker_designated_at`, so the
 * countdown here and the timeout that actually fires agree.
 */
async function renderPickStatus(scope: GuildReadScope, rooms: CalloutRoom[]): Promise<string> {
    const db = await getDatabase();
    const { sql: scopeFilter, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);
    const rows = (await db.all(`
        SELECT g.picker_discord_id, g.picker_type, g.picker_designated_at,
               t.name AS tournament_name, t.game_room_id AS game_room_id,
               t.winner_pick_window_min, t.runnerup_pick_window_min
        FROM games g
        JOIN tournaments t ON g.tournament_id = t.id
        WHERE g.status = 'QUEUED' AND g.name = '[Pending Pick]'
          AND t.is_active = 1
          AND (t.winner_picks IS NULL OR t.winner_picks != 0)
          ${scopeFilter}
        ORDER BY g.picker_designated_at ASC, g.rowid ASC
    `, ...params)) as Array<{
        picker_discord_id: string | null;
        picker_type: string | null;
        picker_designated_at: string | null;
        tournament_name: string | null;
        game_room_id: string | null;
        winner_pick_window_min: number | null;
        runnerup_pick_window_min: number | null;
    }>;

    const first = rooms[0]!;
    if (rows.length === 0) {
        return `Nobody owes a pick right now. Queue one up anyway: ${roomPicksUrl(first.slug)}`;
    }

    const now = Date.now();
    const lines: string[] = ['**Waiting on a pick:**'];
    for (const row of rows) {
        const who = row.picker_discord_id ? `<@${row.picker_discord_id}>` : 'an unclaimed winner';
        const prefix = roomPrefix(rooms, row.game_room_id);
        const label = `${prefix}**${row.tournament_name || 'Manual'}**`;
        const windowMin = row.picker_type === 'RUNNER_UP'
            ? (row.runnerup_pick_window_min ?? 30)
            : (row.winner_pick_window_min ?? 60);
        if (!row.picker_designated_at) {
            lines.push(`${label}: ${who} — no deadline set.`);
            continue;
        }
        const deadline = new Date(row.picker_designated_at).getTime() + windowMin * 60000;
        const left = deadline - now;
        lines.push(left <= 0
            ? `${label}: ${who} — their window has expired; it auto-picks on the next check.`
            : `${label}: ${who} — **${formatDuration(left)}** left to pick.`);
    }
    lines.push(roomPicksUrl(first.slug));
    return lines.join('\n');
}

/** Renders one axis of a tournament's platform rules, or null when unset. */
function axisLine(label: string, axis: { required: string[]; excluded: string[] }): string | null {
    const parts: string[] = [];
    if (axis.required.length > 0) parts.push(`must be on ${axis.required.join(', ')}`);
    if (axis.excluded.length > 0) parts.push(`not allowed on ${axis.excluded.join(', ')}`);
    return parts.length > 0 ? `${label}: ${parts.join('; ')}` : null;
}

/**
 * `tournament_rules` — what can be picked and what can be submitted.
 *
 * `platform_rules` is read through `parseTournamentRules` like every other
 * runtime site (never a hand-rolled JSON.parse — the column still holds the
 * pre-ADR-0016 flat shape in most rooms and the parser is the lift). The two
 * axes are reported separately because they mean different things: `required`
 * decides which GAMES qualify, `excluded` decides which platforms may SUBMIT.
 */
async function renderTournamentRules(scope: GuildReadScope, rooms: CalloutRoom[]): Promise<string> {
    const games = await listActiveGamesForScope(scope);
    if (games.length === 0) return NO_ACTIVE_GAMES_MESSAGE;
    const first = rooms[0]!;

    const lines: string[] = ['**Tournament rules:**'];
    for (const [, rows] of groupByTournament(games)) {
        const row = rows[0]!;
        const label = `${roomPrefix(rooms, row.game_room_id)}**${row.tournament_name || 'Manual'}**`;
        const rules = parseTournamentRules({
            id: row.tournament_id, platform_rules: row.platform_rules,
        });
        const detail: string[] = [];
        const engines = axisLine('engines', rules.engines);
        const devices = axisLine('devices', rules.devices);
        if (engines) detail.push(engines);
        if (devices) detail.push(devices);
        if (rules.restrictedText) detail.push(rules.restrictedText);
        const days = row.eligibility_days;
        if (days && days > 0) detail.push(`a game cannot repeat within ${days} days`);
        lines.push(detail.length > 0
            ? `${label} — ${detail.join(' · ')}`
            : `${label} — no platform restrictions; anything in the catalogue is fair game.`);
    }
    lines.push(roomPicksUrl(first.slug));
    return lines.join('\n');
}

/**
 * `how_to_claim` — the fix for "I am playing but Arcaid does not know it is me".
 *
 * Static by design: it is the answer whether or not the asker is linked, and it
 * is also the fallback `my_rank` degrades to. Points at Account Settings, not a
 * room page, because `user_mappings` is global and the claim form lives there.
 */
function renderHowToClaim(room: CalloutRoom): string {
    return [
        `**Claiming your name**`,
        `Scores you post under an iScored name only count as *yours* once that name is linked to your Discord account.`,
        `1. Sign in at ${roomUrl(room.slug)} with Discord.`,
        `2. Open ${accountSettingsUrl()} and claim the iScored name you play under.`,
        `3. Ask an admin to run \`/map-user\` if the name is already taken by someone else.`,
        `Once it is linked, picks, rank alerts and your standing all find you.`,
    ].join('\n');
}
