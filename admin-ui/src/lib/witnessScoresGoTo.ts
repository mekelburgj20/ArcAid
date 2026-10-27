/**
 * W27.3 (ADR 0033 §5) — the words of the "Your scores go to" lines
 * (`components/WitnessScoresGoTo.tsx`): one per paired Witness device, for a room
 * page (does it send HERE, from `GET /api/me/witness/routing`) or the home page
 * (where it sends, from `GET /api/me/witness/devices`).
 */
export type Routing = {
    deviceId: string;
    deviceType: 'atgames' | 'desktop';
    sendsHere: 'yes' | 'one_tournament' | 'entered_only' | 'no';
    why: 'global_only' | 'other_room' | 'other_tournament' | 'not_member' | null;
    targetRoomName: string | null;
    targetTournamentName: string | null;
};

export type Device = {
    atgamesUniqueId: string;
    deviceType?: 'atgames' | 'desktop';
    targetRoomId: string | null;
    targetRoomName: string | null;
    targetTournamentId: string | null;
    targetTournamentName: string | null;
    globalOnly?: boolean;
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
    return rows.map(r => {
        const i = seen.get(r.deviceType) ?? 0;
        seen.set(r.deviceType, i + 1);
        const who = deviceName(r.deviceType, (counts.get(r.deviceType) ?? 0) > 1, i);
        const tournament = r.targetTournamentName ? `"${r.targetTournamentName}"` : 'one tournament';
        switch (r.sendsHere) {
            case 'yes':
                return { key: r.deviceId, ok: true, text: `${who} sends its scores here.`, change: false };
            case 'one_tournament':
                return { key: r.deviceId, ok: true, text: `${who} sends its scores here, to ${tournament} only.`, change: true };
            case 'entered_only':
                return { key: r.deviceId, ok: true, text: `${who} sends its scores here, to the tournaments you're entered in.`, change: false };
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
    });
}

export function homeLines(devices: Device[]): Line[] {
    const counts = new Map<string, number>();
    for (const d of devices) counts.set(d.deviceType ?? 'atgames', (counts.get(d.deviceType ?? 'atgames') ?? 0) + 1);
    const seen = new Map<string, number>();
    return devices.map(d => {
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
    });
}
