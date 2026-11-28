import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import WitnessCabinetScreens from '../WitnessCabinetScreens';

/**
 * W132.3 (ADR 0046): the "Cabinet screens" section of a paired cabinet.
 * The server endpoints are built in parallel; this pins the contract this
 * panel codes against.
 */

type Init = RequestInit | undefined;
const ALL = ['attract', 'card', 'global', 'standings', 'activity', 'event'];

const READY = { key: 'card', label: 'AC/DC, Mox Game Room', secs: 10, backglassUrl: '/api/me/witness-devices/dev1/cabinet-frames/aaa.jpg', dmdUrl: '/api/me/witness-devices/dev1/cabinet-frames/bbb.jpg', ready: true };
const DRAWING = { key: 'global', label: 'Global: AC/DC', secs: 10, backglassUrl: null, dmdUrl: null, ready: false };

function stub(opts: { prefs?: unknown; frames?: unknown[]; putFails?: boolean; framesFails?: boolean } = {}) {
    const puts: unknown[] = [];
    const fn = vi.fn((url: string, init?: Init) => {
        const method = (init?.method || 'GET').toUpperCase();
        const json = (body: unknown, ok = true, status = 200) => Promise.resolve({
            ok, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body),
        });
        if (url.endsWith('/cabinet-screens') && method === 'PUT') {
            if (opts.putFails) return json({ error: 'Pick at least one screen' }, false, 400);
            const b = JSON.parse(String(init!.body));
            puts.push(b);
            return json(b);
        }
        if (url.endsWith('/cabinet-screens')) {
            return json(opts.prefs ?? { screens: ALL, seconds: 10, defaults: { screens: ALL, seconds: 10 } });
        }
        if (url.endsWith('/cabinet-frames')) {
            if (opts.framesFails) return json({ error: 'nope' }, false, 500);
            return json({ screens: opts.frames ?? [READY, DRAWING] });
        }
        if (url.endsWith('.jpg')) return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['x'], { type: 'image/jpeg' })) });
        return json({});
    });
    vi.stubGlobal('fetch', fn);
    return { fn, puts };
}

beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:picture');
    URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); });

const renderIt = () => render(<WitnessCabinetScreens deviceId="dev1" playerToken="tok" />);

describe('WitnessCabinetScreens', () => {
    it('loads the choices and shows a switch per screen, all on by default', async () => {
        const { fn } = stub();
        renderIt();
        const sw = await screen.findAllByRole('switch');
        await waitFor(() => expect(sw.every(s => s.getAttribute('aria-checked') === 'true' && !(s as HTMLButtonElement).disabled)).toBe(true));
        expect(sw).toHaveLength(6);
        for (const name of ['Attract', "My rooms' games", 'Global scoreboard', 'Standings', 'Activity', 'Live event']) {
            expect(screen.getByRole('switch', { name: new RegExp(name, 'i') })).toBeInTheDocument();
        }
        const call = fn.mock.calls.find(c => String(c[0]).endsWith('/cabinet-screens'))!;
        expect(call[0]).toBe('/api/me/witness-devices/dev1/cabinet-screens');
        expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    });

    it('turns a screen off, sets the seconds and saves them', async () => {
        const { puts } = stub();
        renderIt();
        const save = screen.getByRole('button', { name: 'Save' });
        await waitFor(() => expect(screen.getByRole('switch', { name: /activity/i })).not.toBeDisabled());
        expect(save).toBeDisabled();
        fireEvent.click(screen.getByRole('switch', { name: /activity/i }));
        fireEvent.change(screen.getByLabelText('Seconds on each screen'), { target: { value: '20' } });
        expect(screen.getByRole('switch', { name: /activity/i })).toHaveAttribute('aria-checked', 'false');
        expect(save).toBeEnabled();
        fireEvent.click(save);
        await screen.findByText(/Saved\./);
        expect(puts).toEqual([{ screens: ['attract', 'card', 'global', 'standings', 'event'], seconds: 20 }]);
        expect(save).toBeDisabled();
    });

    it('will not save with every screen off', async () => {
        stub({ prefs: { screens: ['card'], seconds: 10 } });
        renderIt();
        const card = await screen.findByRole('switch', { name: /my rooms/i });
        await waitFor(() => expect(card).toHaveAttribute('aria-checked', 'true'));
        fireEvent.click(card);
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        expect(screen.getByText(/Pick at least one screen/)).toBeInTheDocument();
    });

    it('shows the server error when saving fails', async () => {
        stub({ putFails: true });
        renderIt();
        await waitFor(() => expect(screen.getByRole('switch', { name: /attract/i })).not.toBeDisabled());
        fireEvent.click(screen.getByRole('switch', { name: /attract/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one screen');
    });

    it('shows a drawn picture and a skeleton that says it is being drawn', async () => {
        stub();
        renderIt();
        const ready = await screen.findByTestId('cabinet-preview-card');
        await waitFor(() => expect(within(ready).getAllByRole('img')).toHaveLength(2));
        expect(within(ready).getByAltText(/as the backglass shows it/)).toHaveAttribute('src', 'blob:picture');
        const drawing = screen.getByTestId('cabinet-preview-global');
        expect(within(drawing).getByText(/Being drawn/)).toBeInTheDocument();
        expect(within(drawing).queryByRole('img')).toBeNull();
    });

    it('fetches pictures with the player token', async () => {
        const { fn } = stub();
        renderIt();
        await waitFor(() => expect(fn.mock.calls.some(c => String(c[0]).endsWith('aaa.jpg'))).toBe(true));
        const c = fn.mock.calls.find(x => String(x[0]).endsWith('aaa.jpg'))!;
        expect((c[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    });

    it('says so when there is nothing to preview, or the preview fails', async () => {
        stub({ frames: [] });
        const { unmount } = renderIt();
        expect(await screen.findByText(/Nothing to show yet/)).toBeInTheDocument();
        unmount();
        stub({ framesFails: true });
        renderIt();
        expect(await screen.findByText('Could not load the preview.')).toBeInTheDocument();
    });
});
