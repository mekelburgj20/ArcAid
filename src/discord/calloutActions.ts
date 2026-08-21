import { getDatabase } from '../database/database.js';
import { GuildReadScope } from '../utils/discordRoomFilter.js';
import { roomPicksUrl, roomUrl } from '../utils/publicLinks.js';
import { CalloutAction, CalloutRoomContext } from '../utils/callouts.js';
import { listActiveGamesForScope } from './activeGames.js';

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
 * Renders one action into reply text, or null when it can't be answered (no
 * room resolved — the gate makes that near-impossible, but a room deleted
 * mid-flight shouldn't throw).
 */
export async function renderCalloutAction(
    action: CalloutAction,
    scope: GuildReadScope,
    rooms: CalloutRoom[],
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
