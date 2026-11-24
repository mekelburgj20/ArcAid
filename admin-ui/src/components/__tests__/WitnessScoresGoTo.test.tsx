import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WitnessScoresGoTo from '../WitnessScoresGoTo';
import {
    attemptStartsNeeded, firstRoomToast, forgetRoomToast, forgetRoomToasts, homeLines, roomLines, roomToastKey, roomToastLines,
    roomToastMs, type Routing,
} from '../../lib/witnessScoresGoTo';
import { ATTEMPT_STARTS_CHANGED_EVENT } from '../../lib/attemptStarts';

/**
 * W27.3 (ADR 0033 §5) — "Your scores go to". Pins the words a player reads on a
 * room page for every routing answer the server gives, the home page's lines,
 * and that a miss carries a way to fix it (Change → the device picker).
 *
 * Owner 2026-11-23: on a room page a device that sends here is said by ONE
 * toast on entering the room, never by a line that stays on the page; only a
 * device that does not send here (and the Start attempts line) stays.
 */

vi.mock('../../contexts/ViewerAuthContext', () => ({
    useViewerAuth: () => ({ playerToken: 'tok' }),
}));

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('../Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

const row = (over: Partial<Routing>): Routing => ({
    deviceId: 'dev', deviceType: 'atgames', sendsHere: 'yes', why: null,
    targetRoomName: null, targetTournamentName: null, ...over,
});

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); toastSpy.mockClear(); forgetRoomToasts(); });

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

describe('roomToastLines', () => {
    it('says one device as its room line reads', () => {
        expect(roomToastLines([row({})])).toEqual(['Your cabinet sends its scores here.']);
        expect(roomToastLines([row({ sendsHere: 'one_tournament', targetTournamentName: 'Spooky Season' })]))
            .toEqual(['Your cabinet sends its scores here, to "Spooky Season" only.']);
        expect(roomToastLines([row({ deviceType: 'desktop', watching: 'no' })])).toEqual(['Your PC sends its scores here · not watching now.']);
    });

    it('puts devices with the same answer in one sentence, in the order they first appear', () => {
        // The owner's own room, 2026-11-23: two cabinets not watching, one PC.
        expect(roomToastLines([
            row({ deviceId: 'a', watching: 'no' }), row({ deviceId: 'b', deviceType: 'desktop' }), row({ deviceId: 'c', watching: 'no' }),
        ])).toEqual([
            'Your cabinet 1 and your cabinet 2 send their scores here · not watching now, open the tile on the cabinet.',
            'Your PC sends its scores here.',
        ]);
        expect(roomToastLines([row({ deviceId: 'a' }), row({ deviceId: 'b' }), row({ deviceId: 'c', deviceType: 'desktop' })]))
            .toEqual(['Your cabinet 1, your cabinet 2 and your PC send their scores here.']);
    });

    it('leaves out a device that does not send here, and keeps the numbering of the room lines', () => {
        expect(roomToastLines([row({ deviceId: 'a', sendsHere: 'no', why: 'global_only' }), row({ deviceId: 'b' })]))
            .toEqual(['Your cabinet 2 sends its scores here.']);
        expect(roomToastLines([row({ sendsHere: 'no', why: 'not_member' })])).toEqual([]);
        expect(roomToastLines([])).toEqual([]);
    });

    it('stays longer for more sentences, and is said once per room until the answer changes', () => {
        expect([1, 2, 3, 9].map(roomToastMs)).toEqual([9000, 11000, 13000, 15000]);
        expect(firstRoomToast('room-1', 'a')).toBe(true);
        expect(firstRoomToast('room-1', 'a')).toBe(false);
        expect(firstRoomToast('room-2', 'a')).toBe(true);
        expect(firstRoomToast('room-1', 'b')).toBe(true);
    });

    // Owner 2026-11-24: every refresh of the installed app on a phone said it again.
    it('is remembered across a reload, until the answer changes or no device sends here', () => {
        expect(firstRoomToast('room-1', 'a')).toBe(true);
        forgetRoomToasts(); // a reload: memory is gone, the browser's storage is not
        expect(firstRoomToast('room-1', 'a')).toBe(false);
        forgetRoomToasts();
        expect(firstRoomToast('room-2', 'a')).toBe(true);
        expect(firstRoomToast('room-1', 'b')).toBe(true);
        forgetRoomToasts();
        expect(firstRoomToast('room-1', 'a')).toBe(true); // back to the first answer: a change again

        forgetRoomToast('room-1');
        forgetRoomToasts();
        expect(firstRoomToast('room-1', 'a')).toBe(true);
    });

    it('with storage blocked it is still once per page load', () => {
        const refuse = () => { throw new Error('blocked'); };
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
        const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(refuse);
        try {
            expect(firstRoomToast('room-1', 'a')).toBe(true);
            expect(firstRoomToast('room-1', 'a')).toBe(false);
            expect(() => forgetRoomToast('room-1')).not.toThrow();
            expect(firstRoomToast('room-1', 'a')).toBe(true);
        } finally {
            get.mockRestore(); set.mockRestore(); remove.mockRestore();
        }
    });

    it('is keyed on which devices send here and how, never on whether they are watching now', () => {
        const a = row({ deviceId: 'a' });
        const b = row({ deviceId: 'b', deviceType: 'desktop' });
        expect(roomToastKey([a, b])).toBe(roomToastKey([b, a]));
        expect(roomToastKey([{ ...a, watching: 'no' }, b])).toBe(roomToastKey([{ ...a, watching: 'yes' }, b]));
        expect(roomToastKey([a])).not.toBe(roomToastKey([a, b]));
        expect(roomToastKey([a])).not.toBe(roomToastKey([row({ deviceId: 'a', sendsHere: 'one_tournament', targetTournamentName: 'Spooky Season' })]));
        // A device that does not send here is not what the toast is about.
        expect(roomToastKey([a, { ...b, sendsHere: 'no', why: 'global_only' }])).toBe(roomToastKey([a]));
        expect(roomToastKey([{ ...a, sendsHere: 'no', why: 'not_member' }])).toBe('');
    });
});

describe('attemptStartsNeeded (W56)', () => {
    it('names unstarted tables once, only when a device sends here', () => {
        const games = [
            { gameName: 'Congo', started: false, requireStart: true }, { gameName: 'Congo', started: false, requireStart: true },
            { gameName: 'Done', started: true, requireStart: true },
        ];
        expect(attemptStartsNeeded([row({})], games)).toEqual(['Congo']);
        expect(attemptStartsNeeded([row({ sendsHere: 'entered_only' })], games)).toEqual(['Congo']);
        expect(attemptStartsNeeded([row({ sendsHere: 'no', why: 'other_room' })], games)).toBeNull();
        expect(attemptStartsNeeded([], games)).toBeNull();
        expect(attemptStartsNeeded([row({})], [{ gameName: 'Done', started: true, requireStart: true }])).toBeNull();
    });

    it('W82: leaves out a limited table that does not require the press', () => {
        expect(attemptStartsNeeded([row({})], [{ gameName: 'No Press', started: false, requireStart: false }])).toBeNull();
        expect(attemptStartsNeeded([row({})], [
            { gameName: 'No Press', started: false, requireStart: false }, { gameName: 'Congo', started: false, requireStart: true },
        ])).toEqual(['Congo']);
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
                ? { games: games.map((g, i) => ({ gameId: `g${i}`, tournamentId: 't', tournamentName: 'T', roundNo: null, startedTs: null, limit: 3, used: 0, left: 3, requireStart: true, ...g })) }
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
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 0));
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
                ? { games: [{ gameId: 'g', gameName: 'Congo', tournamentId: 't', tournamentName: 'T', roundNo: null, started, startedTs: null, limit: 3, used: 0, left: 3, requireStart: true }] }
                : [row({})]),
        })));
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        expect(await screen.findByTestId('attempt-starts-needed')).toBeTruthy();
        started = true;
        window.dispatchEvent(new Event(ATTEMPT_STARTS_CHANGED_EVENT));
        await waitFor(() => expect(screen.queryByTestId('attempt-starts-needed')).toBeNull());
    });

    it('says the devices that send here in ONE toast, and draws no line for them', async () => {
        stubRoom([row({ deviceId: 'a', watching: 'no' }), row({ deviceId: 'b', deviceType: 'desktop' }), row({ deviceId: 'c', watching: 'no' })], []);
        const { container } = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
        expect(toastSpy).toHaveBeenCalledWith(
            'Your cabinet 1 and your cabinet 2 send their scores here · not watching now, open the tile on the cabinet.\nYour PC sends its scores here.',
            'success',
            // Pressing it opens the device settings (owner 2026-11-23).
            { label: 'Arcaid Witness', durationMs: 11000, href: '/account/settings#witness-devices', hrefHint: 'Open your device settings' },
        );
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });

    it('says it once per room: not again on the next page of the room, again when the answer changes', async () => {
        stubRoom([row({})], []);
        const first = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
        first.unmount();

        const fetchMock = stubRoom([row({})], []);
        const second = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await new Promise(r => setTimeout(r, 0));
        expect(toastSpy).toHaveBeenCalledTimes(1);
        second.unmount();

        stubRoom([row({ sendsHere: 'one_tournament', targetTournamentName: 'Spooky Season' })], []);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
        expect(toastSpy.mock.calls[1][0]).toBe('Your cabinet sends its scores here, to "Spooky Season" only.');
    });

    // Owner 2026-11-24: "every time I refresh the page (on mobile using the app), I get the toast again".
    it('does not say it again after a reload, or because the cabinet stopped watching', async () => {
        stubRoom([row({})], []);
        const first = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
        first.unmount();
        forgetRoomToasts(); // the reload

        const again = stubRoom([row({ watching: 'no' })], []);
        const second = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await waitFor(() => expect(again).toHaveBeenCalledTimes(2));
        await new Promise(r => setTimeout(r, 0));
        expect(toastSpy).toHaveBeenCalledTimes(1);
        second.unmount();
        forgetRoomToasts();

        // Pointed away from the room (the amber line says so), then back: said again.
        stubRoom([row({ sendsHere: 'no', why: 'global_only' })], []);
        const away = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        expect(await screen.findByText(/is set to the Global Scoreboard only/)).toBeTruthy();
        expect(toastSpy).toHaveBeenCalledTimes(1);
        away.unmount();
        forgetRoomToasts();

        stubRoom([row({})], []);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
    });

    it('a device that does not send here stays a line on the page and is never in the toast', async () => {
        stubRoom([row({ deviceId: 'a' }), row({ deviceId: 'b', deviceType: 'desktop', sendsHere: 'no', why: 'global_only' })], []);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        expect(await screen.findByText(/Your PC is set to the Global Scoreboard only/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Change' })).toBeTruthy();
        expect(screen.queryByText(/Your cabinet sends its scores here/)).toBeNull();
        expect(toastSpy).toHaveBeenCalledTimes(1);
        expect(toastSpy.mock.calls[0][0]).toBe('Your cabinet sends its scores here.');
    });

    it('the home page never toasts', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ atgamesUniqueId: 'd', targetRoomId: null, targetRoomName: null, targetTournamentId: null, targetTournamentName: null }]),
        })));
        render(<MemoryRouter><WitnessScoresGoTo /></MemoryRouter>);
        expect(await screen.findByText(/sends its scores to every room you belong to/)).toBeTruthy();
        expect(toastSpy).not.toHaveBeenCalled();
    });

    it('renders nothing with no paired device', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })));
        const { container } = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" /></MemoryRouter>);
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });
});

describe('WitnessScoresGoTo dismissal (W83)', () => {
    const STORE = 'arcaid_room_notices_dismissed:room-1';
    const stub = (routing: Routing[], games: Array<{ gameName: string; started: boolean }> = []) => {
        vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
            ok: true,
            json: () => Promise.resolve(url.includes('/attempt-starts/me')
                ? { games: games.map((g, i) => ({ gameId: `g${i}`, tournamentId: 't', tournamentName: 'T', roundNo: null, startedTs: null, limit: 3, used: 0, left: 3, requireStart: true, ...g })) }
                : routing),
        })));
    };
    const stored = () => Object.keys(JSON.parse(localStorage.getItem(STORE) ?? '{}'));

    it('the X on a device line hides just that line, keyed on its routing answer', async () => {
        stub([
            row({ deviceId: 'a', sendsHere: 'no', why: 'other_room', targetRoomName: 'RTX Pinball' }),
            row({ deviceId: 'b', deviceType: 'desktop', sendsHere: 'no', why: 'global_only' }),
        ]);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        const line = (await screen.findByText(/Your cabinet sends to RTX Pinball only/)).closest('[data-testid="dismissible-notice"]') as HTMLElement;
        expect(line.getAttribute('data-notice-key')).toBe('device:a:no:other_room:');
        fireEvent.click(within(line).getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText(/Your cabinet sends to RTX Pinball only/)).toBeNull();
        expect(screen.getByText(/Your PC is set to the Global Scoreboard only/)).toBeTruthy();
        expect(stored()).toEqual(['device:a:no:other_room:']);
    });

    it('a changed routing answer shows the line again', async () => {
        localStorage.setItem(STORE, JSON.stringify({ 'device:a:no:other_room:': Date.now() }));
        stub([row({ deviceId: 'a', sendsHere: 'no', why: 'global_only' })]);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        const text = await screen.findByText(/set to the Global Scoreboard only/);
        expect(text.closest('[data-testid="dismissible-notice"]')?.getAttribute('data-notice-key'))
            .toBe('device:a:no:global_only:');
    });

    it('the "Start attempts needed on" line is dismissible, keyed on its sorted table list', async () => {
        stub([row({ deviceId: 'a' })], [{ gameName: 'Congo', started: false }, { gameName: 'Cactus Canyon', started: false }]);
        render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        const needed = await screen.findByTestId('attempt-starts-needed');
        const wrapper = needed.closest('[data-testid="dismissible-notice"]') as HTMLElement;
        expect(wrapper.getAttribute('data-notice-key')).toBe('starts:Cactus Canyon|Congo');
        fireEvent.click(within(wrapper).getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByTestId('attempt-starts-needed')).toBeNull();
        expect(stored()).toEqual(['starts:Cactus Canyon|Congo']);
    });

    it('renders nothing once every line is dismissed', async () => {
        stub([row({ deviceId: 'a' }), row({ deviceId: 'b', deviceType: 'desktop', sendsHere: 'no', why: 'global_only' })], [{ gameName: 'Congo', started: false }]);
        const { container } = render(<MemoryRouter><WitnessScoresGoTo roomId="room-1" roomSlug="wizard" /></MemoryRouter>);
        await screen.findByTestId('attempt-starts-needed');
        await screen.findByText(/Your PC is set to the Global Scoreboard only/);
        for (const btn of screen.getAllByRole('button', { name: 'Dismiss' })) fireEvent.click(btn);
        expect(container.innerHTML).toBe('');
        expect(stored().sort()).toEqual(['device:b:no:global_only:', 'starts:Congo']);
    });

    it('home mode (no room) has no X', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ atgamesUniqueId: 'd', targetRoomId: null, targetRoomName: null, targetTournamentId: null, targetTournamentName: null }]),
        })));
        render(<MemoryRouter><WitnessScoresGoTo /></MemoryRouter>);
        expect(await screen.findByText(/sends its scores to every room you belong to/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
        expect(screen.queryByTestId('dismissible-notice')).toBeNull();
    });
});
