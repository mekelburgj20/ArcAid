/**
 * Check-in lobby statuses (v2.159.0 / v2.160.0) — the server computes them
 * (`EventLobbyService`); this is the ONE place they are named for the UI.
 * Lives in lib/, not beside the component, because a component file may export
 * only components (react-refresh) and two surfaces render this copy.
 */
export type LobbyStatus = 'ready' | 'table_open' | 'no_checkin' | 'offline' | 'not_routed' | 'no_cabinet';

export const LOBBY_STATUS_META: Record<LobbyStatus, { label: string; dot: string; text: string; hint: string }> = {
    ready: {
        label: 'Ready',
        dot: 'bg-neon-green',
        text: 'text-neon-green',
        hint: 'Arcaid Witness checked in and no table is open on that machine.',
    },
    table_open: {
        label: 'Exit the table',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'A table was opened after the Witness checked in. Exit the table, then check in again (open the Arcaid Witness tile on a cabinet; the desktop companion checks in by itself once VPX is closed).',
    },
    // The label keeps the cabinet's verb because that is the only MANUAL
    // check-in there is; the hint covers the desktop companion, which checks
    // in on its own while VPX is closed (v2.163.0).
    no_checkin: {
        label: 'Open the Witness tile',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'A Witness device is paired but has not checked in since check-in opened. On a cabinet, open the Arcaid Witness tile; on a PC, make sure the Castcade companion is running and VPX is closed.',
    },
    offline: {
        label: 'Witness not responding',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'The Witness device has not been heard from for over five minutes. Is it on and connected? (v1.0.4 cabinets and the desktop companion send a heartbeat every two minutes.)',
    },
    // W26 (v2.174.0): a paired device exists but none of them sends its scores
    // to this event — the server grades with the same rule as score routing.
    not_routed: {
        label: 'Device not sending here',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'A Witness device is paired, but it sends scores somewhere else (another room, another tournament, or the Global Scoreboard only). In Account Settings, Arcaid Witness, set "Send scores to" to this event\'s room.',
    },
    // The status is still named `no_cabinet` server-side; the copy is
    // device-neutral because a Witness device may be a cabinet or a desktop
    // VPX rig running the Castcade companion (v2.163.0).
    no_cabinet: {
        label: 'No Witness device',
        dot: 'bg-faint',
        text: 'text-faint',
        hint: 'No paired Witness device — cabinet or desktop. Scores will post, unverified.',
    },
};
