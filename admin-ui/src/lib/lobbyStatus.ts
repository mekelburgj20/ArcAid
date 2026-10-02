/**
 * Check-in lobby statuses (v2.159.0 / v2.160.0) — the server computes them
 * (`EventLobbyService`); this is the ONE place they are named for the UI.
 * Lives in lib/, not beside the component, because a component file may export
 * only components (react-refresh) and two surfaces render this copy.
 */
export type LobbyStatus = 'ready' | 'table_open' | 'no_checkin' | 'offline' | 'no_cabinet';

export const LOBBY_STATUS_META: Record<LobbyStatus, { label: string; dot: string; text: string; hint: string }> = {
    ready: {
        label: 'Ready',
        dot: 'bg-neon-green',
        text: 'text-neon-green',
        hint: 'Arcaid Witness checked in and no table is open on the cabinet.',
    },
    table_open: {
        label: 'Exit the table',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'A table was opened after the Witness checked in. Exit to the cabinet menu, then open the Arcaid Witness tile again.',
    },
    no_checkin: {
        label: 'Open the Witness tile',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'A cabinet is paired but has not checked in since check-in opened. Open the Arcaid Witness tile on the cabinet.',
    },
    offline: {
        label: 'Cabinet not responding',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'The cabinet has not been heard from for over five minutes. Is it on and connected? (v1.0.4 cabinets send a heartbeat every two minutes.)',
    },
    no_cabinet: {
        label: 'No cabinet',
        dot: 'bg-faint',
        text: 'text-faint',
        hint: 'No paired cabinet. Scores will post, unverified.',
    },
};
