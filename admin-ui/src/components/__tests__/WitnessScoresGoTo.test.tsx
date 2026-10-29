import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WitnessScoresGoTo from '../WitnessScoresGoTo';
import { attemptStartsNeeded, homeLines, roomLines, type Routing } from '../../lib/witnessScoresGoTo';
import { ATTEMPT_STARTS_CHANGED_EVENT } from '../../lib/attemptStarts';

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

describe('attemptStartsNeeded (W56)', () => {
    it('names unstarted tables once, only when a device sends here', () => {
        const games = [{ gameName: 'Congo', started: false }, { gameName: 'Congo', started: false }, { gameName: 'Done', started: true }];
        expect(attemptStartsNeeded([row({})], games)).toEqual(['Congo']);
        expect(attemptStartsNeeded([row({ sendsHere: 'entered_only' })], games)).toEqual(['Congo']);
        expect(attemptStartsNeeded([row({ sendsHere: 'no', why: 'other_room' })], games)).toBeNull();
        expect(attemptStartsNeeded([], games)).toBeNull();
        expect(attemptStartsNeeded([row({})], [{ gameName: 'Done', started: true }])).toBeNull();
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

    // W56 — the "Start attempts needed on:" line.
    const stubRoom = (routing: Routing[], games: Array<{ gameName: string; started: boolean }>) => {
        const fetchMock = vi.fn((url: string) => Promise.resolve({
            ok: true,
            json: () => Promise.resolve(url.includes('/attempt-starts/me')
                ? { games: games.map((g, i) => ({ gameId: `g${i}`, tournamentId: 't', tournamentName: 'T', roundNo: null, startedTs: null, ...g })) }
                : routing),
        }));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    };

    it('W56: names the tables still needing Start attempts, each linking to its game page', async () => {
        const fetchMock = stubRoom([row({})], [
            { gameName: 'Cactus Canyon', started: false }, { gameName: 'Congo', started: false }, { gameName: 'Done', started: true },
        ]);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        const line = await screen.findByTestId('attempt-starts-needed');
        expect(line).toHaveTextContent('Start attempts needed on: Cactus Canyon, Congo');
        expect(screen.getByRole('link', { name: 'Cactus Canyon' }).getAttribute('href')).toBe('/wizard/games/Cactus%20Canyon');
        expect(screen.getByRole('link', { name: 'Congo' }).getAttribute('href')).toBe('/wizard/games/Congo');
        expect(screen.queryByRole('link', { name: 'Done' })).toBeNull();
        expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room-1/attempt-starts/me', { headers: { Authorization: 'Bearer tok' } });
    });

    it('W56: no line once every table is started', async () => {
        stubRoom([row({})], [{ gameName: 'Congo', started: true }]);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        expect(await screen.findByText('Your cabinet sends its scores here.')).toBeTruthy();
        expect(screen.queryByTestId('attempt-starts-needed')).toBeNull();
    });

    it('W56: no line with no paired device, or when no device sends here', async () => {
        stubRoom([], [{ gameName: 'Congo', started: false }]);
        const { container, unmount } = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
        unmount();

        stubRoom([row({ sendsHere: 'no', why: 'global_only' })], [{ gameName: 'Congo', started: false }]);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        expect(await screen.findByText(/set to the Global Scoreboard only/)).toBeTruthy();
        expect(screen.queryByTestId('attempt-starts-needed')).toBeNull();
    });

    it('W56: re-reads the list when a scoreboard card is pressed', async () => {
        let started = false;
        vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
            ok: true,
            json: () => Promise.resolve(url.includes('/attempt-starts/me')
                ? { games: [{ gameId: 'g', gameName: 'Congo', tournamentId: 't', tournamentName: 'T', roundNo: null, started, startedTs: null }] }
                : [row({})]),
        })));
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        expect(await screen.findByTestId('attempt-starts-needed')).toBeTruthy();
        started = true;
        window.dispatchEvent(new Event(ATTEMPT_STARTS_CHANGED_EVENT));
        await waitFor(() => expect(screen.queryByTestId('attempt-starts-needed')).toBeNull());
    });

    it('renders nothing with no paired device', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })));
        const { container } = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" /></MemoryRouter>);
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });
});
