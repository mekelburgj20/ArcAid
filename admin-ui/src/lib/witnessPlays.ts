/**
 * Words for Witness plays, shared by "Where your plays went" (W27.2) and
 * "Plays on this device" (W131.3). Kept out of the components so they export
 * components only (fast refresh).
 */

export type PlayDestination = {
    status: 'counted' | 'already_counted' | 'global' | 'already_global' | 'not_counted' | 'deleted' | 'not_recorded';
    tournamentName: string | null;
    roundNo: number | null;
    roomName: string | null;
    roomSlug: string | null;
    gameName: string | null;
    globalGameId: string | null;
    reason: string | null;
};

export type RecentPlay = {
    key: string;
    playedAt: string;
    tableName: string;
    score: number;
    deviceId: string;
    /** v2.191.0 (W53) - true = quit before game over; null/absent = unknown. A badge only. */
    quit?: boolean | null;
    quitBall?: number | null;
    /** W72 - the signer when the launcher's own record of the play verified ("lu-scoreserver"); null/absent otherwise. */
    signedBy?: string | null;
    /** W72 - the launcher's signed record covered a different game of this sitting (no badge; it still counted). */
    signedOtherGame?: boolean;
    destinations: PlayDestination[];
};

/** W131.3 - one play on a shared device, with who it went to and what decided it. */
export type DevicePlay = RecentPlay & {
    userId: string;
    label: string | null;
    isYou: boolean;
    attribution: 'only' | 'device' | 'attempt' | 'session' | 'fallback' | null;
    sessionId: number | null;
    receivedAt: string;
};

/** W131.3 - a run of plays credited to one person by one session. */
export type DeviceSitting = {
    userId: string;
    label: string | null;
    isYou: boolean;
    session: {
        id: number;
        startedAt: string;
        endedAt: string | null;
        via: 'web' | 'cabinet';
        startedByLabel: string | null;
        startedByYou: boolean;
    } | null;
    plays: DevicePlay[];
};

/** `2026-10-26 23:17:13` (SQLite UTC) → the viewer's local date and time. */
export function whenText(playedAt: string): string {
    const ms = Date.parse(playedAt.includes('T') ? playedAt : `${playedAt.replace(' ', 'T')}Z`);
    if (!Number.isFinite(ms)) return playedAt;
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The "why" lines under a play: one per destination that carries a reason. */
export function reasonLines(play: RecentPlay): string[] {
    const out: string[] = [];
    for (const d of play.destinations) {
        if (!d.reason) continue;
        if (d.status === 'global' || d.status === 'already_global') out.push(`Didn't count in a tournament: ${d.reason}`);
        else out.push(d.reason.charAt(0).toUpperCase() + d.reason.slice(1));
    }
    return [...new Set(out)];
}

/** W131.3 - why a sitting's plays went to this person, in a player's words. */
export function sittingCause(s: DeviceSitting, what: string): string {
    if (s.session) {
        const who = s.session.startedByYou ? 'you' : (s.session.startedByLabel || 'someone');
        const where = s.session.via === 'cabinet' ? `on the ${what}` : 'on arcaid.app';
        return `Playing as chosen by ${who} ${where}, ${whenText(s.session.startedAt)}`;
    }
    const kinds = new Set(s.plays.map(p => p.attribution));
    if (kinds.has('device')) return `The ${what} said who was playing`;
    if (kinds.has('attempt')) return 'Followed the attempt it was started as';
    if (kinds.has('only')) return `Only one person was on the ${what}`;
    if (kinds.has('session') || kinds.has('fallback')) return 'Nobody had chosen, so the default player';
    return 'Reported before players could share a device';
}
