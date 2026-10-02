import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EventLobbyRoster, { type LobbyEntry } from '../EventLobbyRoster';

/**
 * The check-in lobby roster (v2.159.0). The status is the server's; this pins
 * that each one is NAMED the way the owner's rule reads — green is "Ready",
 * both ambers say what to DO, grey is neutral — and that the viewer's own row
 * is marked.
 */
function entry(over: Partial<LobbyEntry>): LobbyEntry {
    return {
        userId: '1', displayName: 'Wyo', avatarHash: null, avatarUrl: null,
        checkedInAt: '2026-10-01T19:00:00.000Z', source: 'checkin',
        status: 'ready', witnessCheckinAt: '2026-10-01T19:05:00.000Z', openTable: null, lastSeenAt: null,
        ...over,
    };
}

describe('EventLobbyRoster', () => {
    it('names every status and marks the viewer', () => {
        render(<EventLobbyRoster
            viewerId="2"
            entries={[
                entry({ userId: '1', displayName: 'Wyo', status: 'ready' }),
                entry({ userId: '2', displayName: 'bofgi', status: 'table_open', openTable: 'Attack from Mars (Williams 1995)' }),
                entry({ userId: '3', displayName: 'Krobs', status: 'no_checkin', witnessCheckinAt: null }),
                entry({ userId: '4444', displayName: null, status: 'no_cabinet' }),
            ]}
        />);

        expect(screen.getByText('Ready')).toBeTruthy();
        expect(screen.getByText('Exit the table')).toBeTruthy();
        expect(screen.getByText('Open the Witness tile')).toBeTruthy();
        expect(screen.getByText('No cabinet')).toBeTruthy();
        // The open table is shown so the host can see what is in the way.
        expect(screen.getByText('Attack from Mars (Williams 1995)')).toBeTruthy();
        // The viewer's own row is marked; an unresolved id still renders as itself.
        expect(screen.getByText('(you)')).toBeTruthy();
        expect(screen.getByText('4444')).toBeTruthy();
    });

    it('renders nothing for an empty lobby', () => {
        const { container } = render(<EventLobbyRoster entries={[]} />);
        expect(container.innerHTML).toBe('');
    });
});
