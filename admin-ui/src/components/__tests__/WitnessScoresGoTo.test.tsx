import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WitnessScoresGoTo from '../WitnessScoresGoTo';
import { homeLines, roomLines, type Routing } from '../../lib/witnessScoresGoTo';

/**
 * W27.3 (ADR 0033 §5) — "Your scores go to". Pins the words a player reads on a
 * room page for every routing answer the server gives, the home page's lines,
 * and that a miss carries a way to fix it (Change → the device picker).
 */

vi.mock('../../contexts/ViewerAuthContext', () => ({
    useViewerAuth: () => ({ playerToken: 'tok' }),
}));

const row = (over: Partial<Routing>): Routing => ({
    deviceId: 'dev', deviceType: 'atgames', sendsHere: 'yes', why: null,
    targetRoomName: null, targetTournamentName: null, ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('roomLines', () => {
    it('says yes quietly, and says why not with a way to fix it', () => {
        expect(roomLines([row({})])[0]).toMatchObject({ ok: true, text: 'Your cabinet sends its scores here.', change: false });
        expect(roomLines([row({ sendsHere: 'one_tournament', targetTournamentName: 'Spooky Season' })])[0])
            .toMatchObject({ ok: true, text: 'Your cabinet sends its scores here, to "Spooky Season" only.', change: true });
        expect(roomLines([row({ sendsHere: 'no', why: 'global_only' })])[0]).toMatchObject({
            ok: false, change: true,
            text: 'Your cabinet is set to the Global Scoreboard only, so plays here won\'t count in this room.',
        });
        expect(roomLines([row({ sendsHere: 'no', why: 'other_room', targetRoomName: 'RTX Pinball' })])[0].text)
            .toBe('Your cabinet sends to RTX Pinball only, so plays here won\'t count in this room.');
        expect(roomLines([row({ sendsHere: 'no', why: 'other_tournament', targetRoomName: 'RTX Pinball', targetTournamentName: 'Halloween Week' })])[0].text)
            .toBe('Your cabinet sends to "Halloween Week" in RTX Pinball only, so plays here won\'t count in this room.');
        expect(roomLines([row({ sendsHere: 'no', why: 'not_member' })])[0])
            .toMatchObject({ ok: false, change: false, text: 'Your cabinet\'s plays will count here once you join this room.' });
    });

    it('names a PC apart from a cabinet, and numbers two of a kind', () => {
        const lines = roomLines([row({ deviceId: 'a' }), row({ deviceId: 'b' }), row({ deviceId: 'c', deviceType: 'desktop' })]);
        expect(lines.map(l => l.text.split(' sends')[0])).toEqual(['Your cabinet 1', 'Your cabinet 2', 'Your PC']);
    });
});

describe('homeLines', () => {
    it('names where each device sends', () => {
        const base = { atgamesUniqueId: 'd', targetRoomId: null, targetRoomName: null, targetTournamentId: null, targetTournamentName: null };
        expect(homeLines([base])[0]).toMatchObject({ ok: true, text: 'Your cabinet sends its scores to every room you belong to.' });
        expect(homeLines([{ ...base, globalOnly: true }])[0])
            .toMatchObject({ ok: false, change: true, text: 'Your cabinet sends its scores to the Global Scoreboard only, not to your rooms.' });
        expect(homeLines([{ ...base, deviceType: 'desktop', targetRoomId: 'r', targetRoomName: 'The Wizard Room' }])[0].text)
            .toBe('Your PC sends its scores to The Wizard Room only.');
    });
});

describe('WitnessScoresGoTo', () => {
    it('asks the routing endpoint for this room and links Change to the device picker', async () => {
        const fetchMock = vi.fn(() => Promise.resolve({
            ok: true, json: () => Promise.resolve([row({ sendsHere: 'no', why: 'global_only' })]),
        }));
        vi.stubGlobal('fetch', fetchMock);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" /></MemoryRouter>);
        expect(await screen.findByText(/set to the Global Scoreboard only/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Change' }).getAttribute('href')).toBe('/account/settings#witness-devices');
        expect(fetchMock).toHaveBeenCalledWith('/api/me/witness/routing?roomId=room-1', { headers: { Authorization: 'Bearer tok' } });
    });

    it('renders nothing with no paired device', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })));
        const { container } = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" /></MemoryRouter>);
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });
});
