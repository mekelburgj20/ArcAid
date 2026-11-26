import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmissionSheet, { type SubmissionTarget } from '../SubmissionSheet';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { setPartImporterForTests } from '../../lib/lazyPart';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/**
 * G23d (v2.272.0) — the score entry sheet is the Arcaid dialog (`parts/Dialog`
 * with `sheet`). What the move must keep, and what it adds:
 *
 *   - Escape and a press outside close it (the old overlay closed on a
 *     backdrop click only), through `onClose`.
 *   - Its name is the game, so `getByRole('dialog', { name })` finds it.
 *   - Focus starts in the score field on a desktop; on a touch screen it does
 *     not, because focusing that field opens the on-screen keypad.
 *   - Only its top drags (phone): the form, the success card and the keypad
 *     carry `data-base-ui-swipe-ignore`, and the keypad is the footer.
 *   - With the dialog chunk held back, the stand-in draws the same form and a
 *     score still goes in, end to end.
 *
 * Harness as in `SubmissionSheet.test.tsx`: a signed-in viewer (else the sheet
 * renders `loginRequired`), `MemoryRouter` for the `<Link>`s, and
 * `submittable: ['real']` so engine and device auto-lock and a score alone
 * makes the form submittable.
 */

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signIn(discordId = '111111111111111111', username = 'Tester') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

const GAME = 'Indiana Jones: The Pinball Adventure';
const never = () => new Promise<never>(() => {});
const realChunk = () => import('../parts/DialogImpl');

function renderSheet(target: Partial<SubmissionTarget> = {}) {
    const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/submit/platforms')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    platforms: ['real'],
                    submittable: ['real'],
                    features: [],
                    tournamentRules: { engines: { required: [], excluded: [] }, devices: { required: [], excluded: [] } },
                }),
            });
        }
        if (url.includes('/submit-score/')) {
            return Promise.resolve({
                ok: true,
                status: 201,
                json: () => Promise.resolve({ displayName: 'Tester', rank: { rank: 2, totalPlayers: 5, previousBest: null, gapToNext: 100, gapToFirst: 100 } }),
            });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const onClose = vi.fn();
    const onSubmitted = vi.fn();
    const utils = render(
        <MemoryRouter>
            <ViewerAuthProvider>
                <SubmissionSheet
                    target={{ kind: 'tournament', roomId: 'room-1', gameName: GAME, ...target } as SubmissionTarget}
                    onClose={onClose}
                    onSubmitted={onSubmitted}
                    roomSlug="room-1"
                />
            </ViewerAuthProvider>
        </MemoryRouter>,
    );
    return { ...utils, fetchMock, onClose, onSubmitted };
}

/** A press outside the slab: on the viewport around it (the backdrop sits under it). */
function pressOutside() {
    const viewport = document.querySelector('.arc-dialog-vp') as HTMLElement;
    fireEvent.pointerDown(viewport);
    fireEvent.mouseDown(viewport);
    fireEvent.pointerUp(viewport);
    fireEvent.mouseUp(viewport);
    fireEvent.click(viewport);
}

const submitCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(c => String(c[0]).includes('/submit-score/')).length;

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    signIn();
});
afterEach(() => {
    setPartImporterForTests('dialog');
    vi.unstubAllGlobals();
    delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
});

describe('SubmissionSheet — the Arcaid dialog', () => {
    it('is a dialog named for the game, with the room label above the title', async () => {
        setPartImporterForTests('dialog', realChunk);
        renderSheet();
        await waitForRealDialog();
        const dialog = screen.getByRole('dialog', { name: GAME });
        expect(dialog).toHaveClass('arc-dialog--sheet');
        expect(dialog).toHaveTextContent('Submit a score');
    });

    it('Escape closes it, through onClose', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onClose } = renderSheet();
        await waitForRealDialog();
        await screen.findByText('Real Cabinet');
        fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a press on the backdrop closes it, through onClose; a press inside does not', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onClose } = renderSheet();
        await waitForRealDialog();
        const label = await screen.findByText('Real Cabinet');
        fireEvent.pointerDown(label);
        fireEvent.mouseDown(label);
        fireEvent.pointerUp(label);
        fireEvent.mouseUp(label);
        fireEvent.click(label);
        await act(async () => { await Promise.resolve(); });
        expect(onClose).not.toHaveBeenCalled();
        pressOutside();
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('the × closes it, through onClose', async () => {
        setPartImporterForTests('dialog', realChunk);
        const { onClose } = renderSheet();
        await waitForRealDialog();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('starts focus in the score field on a desktop', async () => {
        setPartImporterForTests('dialog', realChunk);
        renderSheet();
        await waitForRealDialog();
        await waitFor(() => expect(screen.getByPlaceholderText('0')).toHaveFocus());
        // A desktop never opens the keypad on focus.
        expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    });

    it('on a touch screen focus does not start in the score field, so the keypad stays down until it is tapped', async () => {
        (window as unknown as { ontouchstart?: unknown }).ontouchstart = null;
        setPartImporterForTests('dialog', realChunk);
        renderSheet();
        await waitForRealDialog();
        await screen.findByText('Real Cabinet');
        expect(screen.getByPlaceholderText('0')).not.toHaveFocus();
        expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    });

    it('only the top drags: the form and the keypad (the footer) ignore swipes; no footer while the keypad is down', async () => {
        (window as unknown as { ontouchstart?: unknown }).ontouchstart = null;
        // A phone: the sheet drags (above 600 px `DialogImpl` marks the whole slab swipe-ignored).
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query === '(max-width: 600px)', media: query, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
            dispatchEvent: () => false,
        }));
        setPartImporterForTests('dialog', realChunk);
        renderSheet();
        await waitForRealDialog();
        const input = await screen.findByPlaceholderText('0') as HTMLInputElement;
        expect(input.closest('[data-base-ui-swipe-ignore]')).not.toBeNull();
        expect(screen.getByRole('button', { name: 'Submit Score' }).closest('[data-base-ui-swipe-ignore]')).not.toBeNull();
        expect(document.querySelector('.arc-dialog__foot')).toBeNull();

        act(() => input.focus());
        const done = await screen.findByRole('button', { name: 'Done' });
        const keypad = done.closest('.sheet-keypad');
        expect(keypad).not.toBeNull();
        expect(keypad).toHaveAttribute('data-base-ui-swipe-ignore');
        expect(keypad!.closest('.arc-dialog__foot')).not.toBeNull();
        // The grab handle and the title are outside every ignored region: they drag.
        expect(document.querySelector('.arc-dialog__grab')!.closest('[data-base-ui-swipe-ignore]')).toBeNull();
        expect(document.querySelector('.arc-dialog__title')!.closest('[data-base-ui-swipe-ignore]')).toBeNull();
    });

    it('the success card ignores swipes too', async () => {
        setPartImporterForTests('dialog', realChunk);
        renderSheet();
        await waitForRealDialog();
        await screen.findByText('Real Cabinet');
        fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '4200' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit Score' }));
        const doneButton = await screen.findByRole('button', { name: 'Done' });
        expect(screen.getByText('You are #2 of 5')).toBeInTheDocument();
        expect(doneButton.closest('[data-base-ui-swipe-ignore]')).not.toBeNull();
    });
});

describe('SubmissionSheet — the stand-in (dialog chunk held back)', () => {
    it('draws the form and a score goes in end to end', async () => {
        setPartImporterForTests('dialog', never);
        const { fetchMock, onSubmitted } = renderSheet({ gameId: 'game-9' });

        const dialog = screen.getByRole('dialog', { name: GAME });
        expect(dialog).toHaveClass('arc-dialog--stand-in');
        await screen.findByText('Real Cabinet');

        fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '1234567' } });
        expect(screen.getByPlaceholderText('0')).toHaveValue('1,234,567');
        fireEvent.click(screen.getByRole('button', { name: 'Submit Score' }));

        await screen.findByText('You are #2 of 5');
        expect(submitCalls(fetchMock)).toBe(1);
        const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/submit-score/'))!;
        expect(String(call[0])).toBe(`/api/rooms/room-1/submit-score/${encodeURIComponent(GAME)}`);
        const body = (call[1] as { body: FormData }).body;
        expect(body.get('score')).toBe('1234567');
        expect(body.get('engine')).toBe('real');
        expect(body.get('device')).toBe('real_cabinet');
        expect(body.get('gameId')).toBe('game-9');
        // Still the stand-in throughout; Done hands back to the caller.
        expect(document.querySelector('.arc-dialog--stand-in')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onSubmitted).toHaveBeenCalledTimes(1);
    });

    it('Escape and a press outside close the stand-in, through onClose', async () => {
        setPartImporterForTests('dialog', never);
        const { onClose } = renderSheet();
        await screen.findByText('Real Cabinet');
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        const viewport = document.querySelector('.arc-dialog-vp') as HTMLElement;
        fireEvent.click(viewport);
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
