import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmissionSheet, { type SubmissionTarget } from '../SubmissionSheet';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

/**
 * v2.128.0 — the two Android score-entry bugs, at the component seam.
 *
 *   Bug 1 "Done submits before I can check anything": Done fires on pointerUP
 *          (locked in `OnScreenKeyboard.test.tsx`) AND the submit handler
 *          latches out clicks for ~350ms after the keyboard closes, so a late
 *          synthetic click from the same touch can never submit.
 *   Bug 2 "typing mid-score jumps to the end": the keypad splices at the
 *          native caret (pure helpers locked in `lib/__tests__/caretEdit.test.ts`).
 *
 * Harness notes (mirrors `SubmissionSheet.test.tsx`):
 *   - A signed-in viewer is required or the sheet renders `loginRequired`.
 *   - `submittable: ['real']` makes engine + device auto-lock, so the form is
 *     submittable as soon as a score is present — no combobox wrangling.
 *   - `window.ontouchstart` is defined so `isTouchDevice` is true: that is
 *     what switches the score field to `type=text inputMode=none` (where the
 *     native caret exists and jsdom can report a selection) and opens the
 *     in-app keyboard on focus. It is deleted again in afterEach.
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

function platformsPayload() {
    return {
        // 'real' → exactly one engine and (via ENGINE_DEVICE_COMPAT) exactly
        // one device, so both pickers auto-lock to read-only chips.
        platforms: ['real'],
        submittable: ['real'],
        features: [],
        tournamentRules: { engines: { required: [], excluded: [] }, devices: { required: [], excluded: [] } },
    };
}

function renderSheet() {
    const target: SubmissionTarget = {
        kind: 'tournament',
        roomId: 'room-1',
        gameName: 'Attack from Mars',
    };
    const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/submit/platforms')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(platformsPayload()) });
        }
        if (url.includes('/submit-score/')) {
            return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const rendered = render(
        <MemoryRouter>
            <ViewerAuthProvider>
                <SubmissionSheet target={target} onClose={() => {}} roomSlug="room-1" />
            </ViewerAuthProvider>
        </MemoryRouter>,
    );
    return { ...rendered, fetchMock };
}

/** Opens the in-app numeric keyboard by focusing the score field. */
async function openKeypad() {
    const input = (await screen.findByPlaceholderText('0')) as HTMLInputElement;
    // Real .focus() (not fireEvent.focus): React maps onFocus to the bubbling
    // `focusin`, which only a genuine focus call emits in jsdom.
    act(() => input.focus());
    await screen.findByRole('button', { name: 'Done' });
    return input;
}

function pressKey(name: string) {
    fireEvent.pointerDown(screen.getByRole('button', { name }));
}

function pressDone() {
    const done = screen.getByRole('button', { name: 'Done' });
    fireEvent.pointerDown(done);
    fireEvent.pointerUp(done);
}

describe('SubmissionSheet — keypad caret handling (bug 2)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        (window as unknown as { ontouchstart?: unknown }).ontouchstart = null;
    });
    afterEach(() => {
        delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
    });

    it('is a text field with no OS keypad on touch (the precondition for a native caret)', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();
        expect(input.type).toBe('text');
        expect(input.getAttribute('inputmode')).toBe('none');
    });

    it('splices a digit at the caret instead of appending, and leaves the caret after it', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();

        for (const d of ['5', '0', '0', '9', '9', '9']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('500,999'));

        // Player taps between "500" and "999", then types 5.
        act(() => input.setSelectionRange(3, 3));
        pressKey('5');

        await waitFor(() => expect(input.value).toBe('5,005,999'));
        expect(input.selectionStart).toBe(5);
        expect(input.selectionEnd).toBe(5);
    });

    it('backspace deletes the character before the caret, not the last one', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();

        for (const d of ['5', '0', '0', '9', '9', '9']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('500,999'));

        act(() => input.setSelectionRange(3, 3));
        pressKey('Backspace');

        await waitFor(() => expect(input.value).toBe('50,999'));
        expect(input.selectionStart).toBe(2);
    });

    it('a digit replaces a selected range', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();

        for (const d of ['5', '0', '0', '9', '9', '9']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('500,999'));

        act(() => input.setSelectionRange(1, 3));
        pressKey('7');

        await waitFor(() => expect(input.value).toBe('57,999'));
        expect(input.selectionStart).toBe(2);
    });

    it('still appends when the caret sits at the end (the ordinary case)', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();

        for (const d of ['1', '2', '3']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('123'));
        expect(input.selectionStart).toBe(3);

        pressKey('4');
        await waitFor(() => expect(input.value).toBe('1,234'));
        expect(input.selectionStart).toBe(5);
    });
});

/**
 * Grouped score entry (owner incident 2026-08-30 — an eleven-digit score with
 * one extra zero reached a locked board). These lock the seam the pure helpers
 * in `lib/__tests__/scoreInput.test.ts` cannot: that the grouping survives the
 * keypad's caret splice, and that the magnitude echo renders.
 */
describe('SubmissionSheet — grouped score entry', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        (window as unknown as { ontouchstart?: unknown }).ontouchstart = null;
    });
    afterEach(() => {
        delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
    });

    it('groups digits as they are typed', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();
        for (const d of ['6', '6', '6', '6', '1', '5', '8', '9', '8', '0']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('6,666,158,980'));
    });

    it('echoes the magnitude in words — the check that actually catches a stray digit', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();
        for (const d of ['6', '6', '6', '6', '1', '5', '8', '9', '8', '0']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('6,666,158,980'));
        await screen.findByText('6.66 billion');

        // The typo that prompted this work: one more zero, an order of
        // magnitude the echo makes unmissable.
        pressKey('0');
        await waitFor(() => expect(input.value).toBe('66,661,589,800'));
        await screen.findByText('66.66 billion');
    });

    it('backspacing onto a separator removes the digit in front of it, not the comma', async () => {
        signIn();
        renderSheet();
        const input = await openKeypad();
        for (const d of ['1', '2', '3', '4']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('1,234'));

        // Caret immediately after the comma. Deleting the separator alone
        // would be undone by the re-group and the key would look dead.
        act(() => input.setSelectionRange(2, 2));
        pressKey('Backspace');

        await waitFor(() => expect(input.value).toBe('234'));
    });

    it('submits the ungrouped number, never the formatted string', async () => {
        signIn();
        const { fetchMock } = renderSheet();
        await screen.findByText('Real Cabinet');
        const input = await openKeypad();
        for (const d of ['1', '2', '3', '4', '5', '6', '7']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('1,234,567'));

        // Past the keyboard-close submit latch (see bug 1 below).
        const base = Date.now();
        let clock = base;
        vi.spyOn(Date, 'now').mockImplementation(() => clock);
        pressDone();
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument());
        clock = base + 400;

        fireEvent.click(screen.getByRole('button', { name: 'Submit Score' }));
        await waitFor(() => {
            const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/submit-score/'));
            expect(call).toBeTruthy();
            const body = (call![1] as { body: FormData }).body;
            expect(body.get('score')).toBe('1234567');
        });
    });
});

describe('SubmissionSheet — keyboard-close submit latch (bug 1)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        (window as unknown as { ontouchstart?: unknown }).ontouchstart = null;
    });
    afterEach(() => {
        delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
    });

    async function primeSubmittableSheet() {
        signIn();
        const { fetchMock } = renderSheet();
        // Both provenance chips auto-lock, so the form only needs a score.
        await screen.findByText('Real Cabinet');
        const input = await openKeypad();
        for (const d of ['1', '2', '3']) pressKey(d);
        await waitFor(() => expect(input.value).toBe('123'));
        return { fetchMock };
    }

    function submitCalls(fetchMock: ReturnType<typeof vi.fn>) {
        return fetchMock.mock.calls.filter(c => String(c[0]).includes('/submit-score/')).length;
    }

    it('ignores a Submit click that lands inside the latch window after Done', async () => {
        const { fetchMock } = await primeSubmittableSheet();

        const clock = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => clock);

        pressDone();
        // Keyboard is gone — the Submit button is now where the finger is.
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument());

        const submit = screen.getByRole('button', { name: 'Submit Score' });
        expect(submit).not.toBeDisabled();
        fireEvent.click(submit);

        await waitFor(() => expect(submitCalls(fetchMock)).toBe(0));
    });

    it('submits normally once the latch window has passed', async () => {
        const { fetchMock } = await primeSubmittableSheet();

        const base = Date.now();
        let clock = base;
        vi.spyOn(Date, 'now').mockImplementation(() => clock);

        pressDone();
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument());

        clock = base + 400; // past KEYBOARD_CLOSE_LATCH_MS (350)
        fireEvent.click(screen.getByRole('button', { name: 'Submit Score' }));

        await waitFor(() => expect(submitCalls(fetchMock)).toBe(1));
    });

    it('Enter in the score field never submits while the keypad is open — it closes it', async () => {
        const { fetchMock } = await primeSubmittableSheet();
        const input = screen.getByPlaceholderText('0') as HTMLInputElement;

        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument());
        expect(submitCalls(fetchMock)).toBe(0);
    });
});
