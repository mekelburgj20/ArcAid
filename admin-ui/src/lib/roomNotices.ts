/**
 * W83 - dismissal store for the notices at the top of a room page
 * (`EventBanner` cards, the "Your scores go to" device lines and the
 * "Start attempts needed on" line).
 *
 * One localStorage key per room, `arcaid_room_notices_dismissed:<roomId>`,
 * holding JSON `{ [noticeKey]: dismissedAtMs }`. A dismissal lasts
 * `ROOM_NOTICE_DISMISS_DAYS` (7) days; older entries are ignored on read and
 * pruned on the next write. Every storage access is wrapped in try/catch: a
 * private window or blocked storage means "nothing dismissed", never a crash.
 *
 * THE KEY RULE: a notice is keyed on its CONTENT, not just on what it is
 * about, so a dismissed notice comes back by itself when its answer changes.
 *
 *   - event card:   `event:<tournamentId>:<live|upcoming>:<checkin|round>`
 *                   (re-appears when the event goes live or check-in opens)
 *   - device line:  `device:<deviceId>:<sendsHere>:<why ?? ''>:<targetTournamentName ?? ''>`
 *                   (re-appears when the device's routing answer changes)
 *   - starts line:  `starts:<game names, sorted, joined by |>`
 *                   (re-appears when the list of tables needing a press changes)
 *
 * Callers build keys with the helpers below so the rule lives in one place.
 * `dismissNotice` fires `ROOM_NOTICE_DISMISSED_EVENT` on `window` so sibling
 * components can re-read.
 */

export const ROOM_NOTICE_DISMISSED_EVENT = 'arcaid:room-notice-dismissed';
export const ROOM_NOTICE_DISMISS_DAYS = 7;
const TTL_MS = ROOM_NOTICE_DISMISS_DAYS * 24 * 60 * 60 * 1000;
const PREFIX = 'arcaid_room_notices_dismissed:';

type Store = Record<string, number>;

function read(roomId: string): Store {
    try {
        const raw = localStorage.getItem(PREFIX + roomId);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Store = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

function fresh(at: number, now: number): boolean {
    return now - at < TTL_MS;
}

export function isNoticeDismissed(roomId: string | null | undefined, key: string): boolean {
    if (!roomId) return false;
    const at = read(roomId)[key];
    return typeof at === 'number' && fresh(at, Date.now());
}

export function dismissNotice(roomId: string | null | undefined, key: string): void {
    if (!roomId) return;
    const now = Date.now();
    const next: Store = {};
    for (const [k, at] of Object.entries(read(roomId))) {
        if (fresh(at, now)) next[k] = at;
    }
    next[key] = now;
    try {
        localStorage.setItem(PREFIX + roomId, JSON.stringify(next));
    } catch {
        // Storage unavailable: the notice is still hidden for this render.
    }
    try {
        window.dispatchEvent(new CustomEvent(ROOM_NOTICE_DISMISSED_EVENT, { detail: { roomId, key } }));
    } catch {
        // No window (SSR / odd test env) - nothing to notify.
    }
}

export function eventNoticeKey(tournamentId: string, live: boolean, checkin: boolean): string {
    return `event:${tournamentId}:${live ? 'live' : 'upcoming'}:${checkin ? 'checkin' : 'round'}`;
}

export function deviceNoticeKey(r: {
    deviceId: string; sendsHere: string; why: string | null; targetTournamentName: string | null;
}): string {
    return `device:${r.deviceId}:${r.sendsHere}:${r.why ?? ''}:${r.targetTournamentName ?? ''}`;
}

export function startsNoticeKey(gameNames: string[]): string {
    return `starts:${[...gameNames].sort().join('|')}`;
}
