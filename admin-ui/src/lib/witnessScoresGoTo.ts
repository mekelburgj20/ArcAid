/**
 * W27.3 (ADR 0033 §5) — the words of the "Your scores go to" lines
 * (`components/WitnessScoresGoTo.tsx`): one per paired Witness device, for a room
 * page (does it send HERE, from `GET /api/me/witness/routing`) or the home page
 * (where it sends, from `GET /api/me/witness/devices`).
 */
import { deviceNoticeKey } from './roomNotices';

export type Routing = {
    deviceId: string;
    deviceType: 'atgames' | 'desktop';
    sendsHere: 'yes' | 'one_tournament' | 'entered_only' | 'no';
    why: 'global_only' | 'other_room' | 'other_tournament' | 'not_member' | null;
    targetRoomName: string | null;
    targetTournamentName: string | null;
    /** W103: is the Witness watching now; absent on an older server. */
    watching?: 'yes' | 'no' | 'unknown';
};

/** W103 - the words appended to a line whose device is not watching now. */
export const NOT_WATCHING = 'not watching now';
export const NOT_WATCHING_CABINET = 'open the tile on the cabinet';

export function withWatching(line: Line, row: { watching?: 'yes' | 'no' | 'unknown'; deviceType?: 'atgames' | 'desktop' }): Line {
    if (row.watching !== 'no') return line;
    const tail = row.deviceType === 'desktop' ? NOT_WATCHING : `${NOT_WATCHING}, ${NOT_WATCHING_CABINET}`;
    return { ...line, text: `${line.text.replace(/\.$/, '')} · ${tail}.` };
}

export type Device = {
    atgamesUniqueId: string;
    deviceType?: 'atgames' | 'desktop';
    targetRoomId: string | null;
    targetRoomName: string | null;
    targetTournamentId: string | null;
    targetTournamentName: string | null;
    globalOnly?: boolean;
    watching?: 'yes' | 'no' | 'unknown';
};

export const CHANGE_HREF = '/account/settings#witness-devices';

function deviceName(type: 'atgames' | 'desktop' | undefined, many: boolean, index: number): string {
    const base = type === 'desktop' ? 'Your PC' : 'Your cabinet';
    return many ? `${base} ${index + 1}` : base;
}

export type Line = { key: string; ok: boolean; text: string; change: boolean };

export function roomLines(rows: Routing[]): Line[] {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.deviceType, (counts.get(r.deviceType) ?? 0) + 1);
    const seen = new Map<string, number>();
    return rows.map(r => withWatching(roomLine(r, seen, counts), r));
}

/**
 * What a line says after the device's name when the device sends here; null
 * when it does not. `many` words it for several devices in one sentence (the
 * room toast).
 */
function sendsHereWords(r: Routing, many = false): string | null {
    const sends = many ? 'send their scores here' : 'sends its scores here';
    const tournament = r.targetTournamentName ? `"${r.targetTournamentName}"` : 'one tournament';
    switch (r.sendsHere) {
        case 'yes': return `${sends}.`;
        case 'one_tournament': return `${sends}, to ${tournament} only.`;
        case 'entered_only': return `${sends}, to the tournaments you're entered in.`;
        default: return null;
    }
}

function roomLine(r: Routing, seen: Map<string, number>, counts: Map<string, number>): Line {
    {
        const i = seen.get(r.deviceType) ?? 0;
        seen.set(r.deviceType, i + 1);
        const who = deviceName(r.deviceType, (counts.get(r.deviceType) ?? 0) > 1, i);
        const tournament = r.targetTournamentName ? `"${r.targetTournamentName}"` : 'one tournament';
        switch (r.sendsHere) {
            case 'yes':
                return { key: r.deviceId, ok: true, text: `${who} ${sendsHereWords(r)}`, change: false };
            case 'one_tournament':
                return { key: r.deviceId, ok: true, text: `${who} ${sendsHereWords(r)}`, change: true };
            case 'entered_only':
                return { key: r.deviceId, ok: true, text: `${who} ${sendsHereWords(r)}`, change: false };
            default:
                switch (r.why) {
                    case 'global_only':
                        return { key: r.deviceId, ok: false, text: `${who} is set to the Global Scoreboard only, so plays here won't count in this room.`, change: true };
                    case 'other_room':
                        return { key: r.deviceId, ok: false, text: `${who} sends to ${r.targetRoomName ?? 'another room'} only, so plays here won't count in this room.`, change: true };
                    case 'other_tournament':
                        return { key: r.deviceId, ok: false, text: `${who} sends to ${tournament}${r.targetRoomName ? ` in ${r.targetRoomName}` : ''} only, so plays here won't count in this room.`, change: true };
                    default:
                        return { key: r.deviceId, ok: false, text: `${who}'s plays will count here once you join this room.`, change: false };
                }
        }
    }
}

/**
 * The room toast (owner 2026-11-23): on a ROOM page the devices that
 * send here are confirmed by one toast on entering the room, not by lines that
 * stay at the top of every page. Devices with the same answer share a
 * sentence ("Your cabinet 1 and your cabinet 2 send their scores here."), in
 * the order they first appear. Empty when no device sends here. A device that
 * does NOT send here is never in the toast: that line stays on the page, with
 * its Change link, until the player dismisses it.
 */
export const ROOM_TOAST_LABEL = 'Arcaid Witness';
/** The toast is a link to the device settings (`CHANGE_HREF`); this says so on hover and to a screen reader. */
export const ROOM_TOAST_HINT = 'Open your device settings';

export function roomToastLines(rows: Routing[]): string[] {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.deviceType, (counts.get(r.deviceType) ?? 0) + 1);
    const seen = new Map<string, number>();
    const groups = new Map<string, { first: Routing; names: string[] }>();
    for (const r of rows) {
        // Numbered exactly as `roomLines` numbers them, whether or not the device sends here.
        const i = seen.get(r.deviceType) ?? 0;
        seen.set(r.deviceType, i + 1);
        if (sendsHereWords(r) === null) continue;
        const who = deviceName(r.deviceType, (counts.get(r.deviceType) ?? 0) > 1, i);
        // Same words after the name = same sentence (the not-watching tail differs by device type).
        const same = [r.sendsHere, r.targetTournamentName ?? '', r.watching === 'no' ? `off:${r.deviceType}` : ''].join('|');
        const group = groups.get(same);
        if (group) group.names.push(who);
        else groups.set(same, { first: r, names: [who] });
    }
    return [...groups.values()].map(({ first, names }) => {
        const text = `${joinNames(names)} ${sendsHereWords(first, names.length > 1)}`;
        return withWatching({ key: first.deviceId, ok: true, change: false, text }, first).text;
    });
}

/** "Your cabinet 1, your cabinet 2 and your PC". */
function joinNames(names: string[]): string {
    const rest = names.slice(1).map(n => n.replace(/^Your /, 'your '));
    if (rest.length === 0) return names[0];
    return `${[names[0], ...rest.slice(0, -1)].join(', ')} and ${rest[rest.length - 1]}`;
}

/**
 * How long the room toast stays: 9 s for one sentence, 2 s more for each further one, 15 s at most.
 * It was 4 s + 2 s; the owner found that too quick to read (2026-11-23): the clock starts while the
 * room page is still drawing, and a sentence with the not-watching tail is a long one.
 */
export function roomToastMs(lineCount: number): number {
    return Math.min(9000 + 2000 * Math.max(0, lineCount - 1), 15000);
}

/**
 * What the room toast is ABOUT: which devices send here, and how. Built from
 * the same per-device key the dismissible lines use (`deviceNoticeKey`), so
 * "the answer changed" means one thing on the page. The not-watching tail is
 * deliberately NOT in it: a cabinet stops and starts watching every time it is
 * played, and that would bring the toast back each time.
 */
export function roomToastKey(rows: Routing[]): string {
    return rows.filter(r => sendsHereWords(r) !== null).map(deviceNoticeKey).sort().join('|');
}

/**
 * The room toast is said ONCE per room in this browser, and again only when
 * its answer changes (`roomToastKey`). The owner got it on every refresh of the
 * installed app on a phone (2026-11-24), which is what remembering it only in
 * memory did. So the last answer said for each room is kept in localStorage
 * (`arcaid_room_toast_said:<roomId>`), with no expiry: a confirmation the
 * player has read is not news until it changes. Memory is still consulted
 * first and is all there is when storage is blocked (a private window): then
 * it is once per page load, as before.
 */
const SAID_PREFIX = 'arcaid_room_toast_said:';
const roomToastSaid = new Map<string, string>();

function lastSaid(roomId: string): string | null {
    const inMemory = roomToastSaid.get(roomId);
    if (inMemory !== undefined) return inMemory;
    try {
        return localStorage.getItem(SAID_PREFIX + roomId);
    } catch {
        return null;
    }
}

export function firstRoomToast(roomId: string, key: string): boolean {
    if (lastSaid(roomId) === key) return false;
    roomToastSaid.set(roomId, key);
    try {
        localStorage.setItem(SAID_PREFIX + roomId, key);
    } catch {
        // Storage unavailable: remembered for this page load only.
    }
    return true;
}

/**
 * No device sends here any more: forget what was said, so the day one is
 * pointed back at the room the toast confirms it (the same answer as before,
 * but news to the player who has just fixed it).
 */
export function forgetRoomToast(roomId: string): void {
    roomToastSaid.delete(roomId);
    try {
        localStorage.removeItem(SAID_PREFIX + roomId);
    } catch {
        // Nothing stored, nothing to forget.
    }
}

/** Tests only: what a reload forgets (memory), not what the browser keeps. */
export function forgetRoomToasts(): void {
    roomToastSaid.clear();
}

export function homeLines(devices: Device[]): Line[] {
    const counts = new Map<string, number>();
    for (const d of devices) counts.set(d.deviceType ?? 'atgames', (counts.get(d.deviceType ?? 'atgames') ?? 0) + 1);
    const seen = new Map<string, number>();
    return devices.map(d => withWatching(homeLine(d, seen, counts), d));
}

function homeLine(d: Device, seen: Map<string, number>, counts: Map<string, number>): Line {
    {
        const type = d.deviceType ?? 'atgames';
        const i = seen.get(type) ?? 0;
        seen.set(type, i + 1);
        const who = deviceName(type, (counts.get(type) ?? 0) > 1, i);
        if (d.targetTournamentId) {
            return { key: d.atgamesUniqueId, ok: true, change: true,
                text: `${who} sends its scores to "${d.targetTournamentName ?? 'one tournament'}"${d.targetRoomName ? ` in ${d.targetRoomName}` : ''} only.` };
        }
        if (d.targetRoomId) {
            return { key: d.atgamesUniqueId, ok: true, change: true, text: `${who} sends its scores to ${d.targetRoomName ?? 'one room'} only.` };
        }
        if (d.globalOnly) {
            return { key: d.atgamesUniqueId, ok: false, change: true, text: `${who} sends its scores to the Global Scoreboard only, not to your rooms.` };
        }
        return { key: d.atgamesUniqueId, ok: true, change: false, text: `${who} sends its scores to every room you belong to.` };
    }
}

/**
 * W56 (ADR 0033 §4) — the lead-in of the room line that names the
 * Limited-attempts tables still waiting for the player's Start attempts press
 * ("Start attempts needed on: Cactus Canyon, Congo"; each name links to that
 * game's page).
 */
export const START_ATTEMPTS_NEEDED = 'Start attempts needed on:';

/**
 * W56 — which tables that line names, from the room's
 * `GET /api/rooms/:roomId/attempt-starts/me` list: the ones whose tournament
 * requires the press (W82: the list also carries limited tables that do not)
 * and that are not yet started, each name once, in list order. `null` (no line) when none of the player's
 * devices sends to this room — a play from them would not count here, so
 * pressing would change nothing — or when every table is started.
 */
export function attemptStartsNeeded(
    rows: Routing[],
    games: Array<{ gameName: string; started: boolean; requireStart: boolean }>,
): string[] | null {
    if (!rows.some(r => r.sendsHere !== 'no')) return null;
    const names = [...new Set(games.filter(g => g.requireStart && !g.started).map(g => g.gameName))];
    return names.length > 0 ? names : null;
}
