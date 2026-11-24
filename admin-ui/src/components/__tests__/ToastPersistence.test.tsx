import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { toast as sonner } from 'sonner';
import { ToastProvider, useToast } from '../Toast';

/**
 * v2.233.0 — an error toast stays until tapped (a long refusal vanished on a
 * phone before it could be read, owner 2026-11-08); success still clears
 * itself, and at most three stay on screen.
 * v2.260.0 (G23) — the Arcaid toast on Sonner: the clock is the pinball rail,
 * so a success leaves when the rail's animation ends; an error has no rail.
 */

function Fire({ message, type }: { message: string; type: 'success' | 'error' | 'info' }) {
    const { toast } = useToast();
    return <button onClick={() => toast(message, type)}>{`fire ${message}`}</button>;
}

// Sonner keeps its toast list in a module, across tests.
afterEach(() => act(() => { sonner.dismiss(); }));

describe('Toast', () => {
    it('keeps an error until dismissed and clears a success when its rail runs out', async () => {
        render(
            <ToastProvider>
                <Fire message="Saved" type="success" />
                <Fire message="Not in the catalogue" type="error" />
            </ToastProvider>,
        );
        fireEvent.click(screen.getByText('fire Saved'));
        fireEvent.click(screen.getByText('fire Not in the catalogue'));

        const success = (await screen.findByText('Saved')).closest('.arc-toast')!;
        expect(success.getAttribute('role')).toBe('status');
        expect(success.textContent).toContain('Done');
        const error = await screen.findByRole('alert');
        expect(error.textContent).toContain('Not in the catalogue');
        expect(error.querySelector('.arc-toast__run')).toBeNull();

        // jsdom has no AnimationEvent, so React listens for the prefixed name there
        // (browsers get the plain `animationend`).
        fireEvent(success.querySelector('.arc-toast__run')!, new Event('webkitAnimationEnd', { bubbles: true }));
        await waitFor(() => expect(screen.queryByText('Saved')).toBeNull());
        expect(screen.getByRole('alert').textContent).toContain('Not in the catalogue');

        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('shows at most three at once, dropping the oldest', async () => {
        render(
            <ToastProvider>
                <Fire message="E" type="error" />
            </ToastProvider>,
        );
        for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('fire E'));
        await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3));
    });

    it('labels info as a heads-up in the ice tone', async () => {
        render(
            <ToastProvider>
                <Fire message="Request sent" type="info" />
            </ToastProvider>,
        );
        fireEvent.click(screen.getByText('fire Request sent'));
        const t = (await screen.findByText('Request sent')).closest('.arc-toast')!;
        expect(t.classList.contains('arc-toast--ice')).toBe(true);
        expect(t.textContent).toContain('Heads up');
    });

    // Owner 2026-11-23: the room's Arcaid Witness toast names its own heading and stays longer
    // for several lines; the type still picks the colour, and an error still never clears itself.
    it('takes a heading and a clock of its own, and keeps an error with neither', async () => {
        function FireNamed() {
            const { toast } = useToast();
            return (
                <>
                    <button onClick={() => toast('Line one\nLine two', 'success', { label: 'Arcaid Witness', durationMs: 6000 })}>fire named</button>
                    <button onClick={() => toast('Refused', 'error', { durationMs: 1000 })}>fire timed error</button>
                </>
            );
        }
        render(<ToastProvider><FireNamed /></ToastProvider>);
        fireEvent.click(screen.getByText('fire named'));
        const msg = await screen.findByText(/Line one/);
        expect(msg.textContent).toBe('Line one\nLine two');
        const t = msg.closest('.arc-toast')!;
        expect(t.querySelector('.arc-toast__label')!.textContent).toBe('Arcaid Witness');
        expect(t.textContent).not.toContain('Done');
        expect(t.classList.contains('arc-toast--cyan')).toBe(true);
        expect((t.querySelector('.arc-toast__run') as HTMLElement).style.getPropertyValue('--arc-toast-ms')).toBe('6000ms');

        fireEvent.click(screen.getByText('fire timed error'));
        const error = await screen.findByRole('alert');
        expect(error.querySelector('.arc-toast__run')).toBeNull();
        expect(error.textContent).toContain("Didn't work");
    });

    // Owner 2026-11-23: pressing the room's Arcaid Witness toast opens the device settings.
    describe('a toast with an href', () => {
        function FireLink() {
            const { toast } = useToast();
            return (
                <>
                    <button onClick={() => toast('Your PC sends its scores here.', 'success', { href: '/account/settings#witness-devices', hrefHint: 'Open your device settings' })}>fire link</button>
                    <button onClick={() => toast('Refused', 'error', { href: '/account/settings' })}>fire error link</button>
                </>
            );
        }
        function Where() {
            const { pathname, hash } = useLocation();
            return <p data-testid="where">{pathname + hash}</p>;
        }
        const renderLink = () => render(
            <MemoryRouter initialEntries={['/room']}>
                <ToastProvider><FireLink /><Where /></ToastProvider>
            </MemoryRouter>,
        );

        it('is one link: a press goes there and closes the toast', async () => {
            renderLink();
            fireEvent.click(screen.getByText('fire link'));
            const link = await screen.findByRole('link', { name: /Your PC sends its scores here/ });
            expect(link.getAttribute('href')).toBe('/account/settings#witness-devices');
            expect(link.getAttribute('title')).toBe('Open your device settings');
            // The heading and the message are both inside it, and the corner x is not.
            expect(link.textContent).toContain('Done');
            expect(link.querySelector('button')).toBeNull();
            expect(link.closest('.arc-toast')!.querySelector('.arc-toast__x')).toBeTruthy();

            fireEvent.click(link);
            expect(screen.getByTestId('where').textContent).toBe('/account/settings#witness-devices');
            await waitFor(() => expect(screen.queryByText('Your PC sends its scores here.')).toBeNull());
        });

        it('a swipe is not a press, and the corner x only closes it', async () => {
            // jsdom has no pointer capture; Sonner asks for it on every pointer down.
            const proto = Element.prototype as unknown as { setPointerCapture?: unknown };
            const had = proto.setPointerCapture;
            proto.setPointerCapture = () => {};
            try {
                renderLink();
                fireEvent.click(screen.getByText('fire link'));
                const link = await screen.findByRole('link', { name: /Your PC sends its scores here/ });
                fireEvent.pointerDown(link, { clientX: 20, clientY: 20 });
                fireEvent.click(link, { clientX: 140, clientY: 22 });
                expect(screen.getByTestId('where').textContent).toBe('/room');

                fireEvent.click(link.closest('.arc-toast')!.querySelector('.arc-toast__x')!);
                await waitFor(() => expect(screen.queryByText('Your PC sends its scores here.')).toBeNull());
                expect(screen.getByTestId('where').textContent).toBe('/room');
            } finally {
                proto.setPointerCapture = had;
            }
        });

        it('an error is never a link: it keeps its Dismiss button', async () => {
            renderLink();
            fireEvent.click(screen.getByText('fire error link'));
            const error = await screen.findByRole('alert');
            expect(error.querySelector('a')).toBeNull();
            expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
        });
    });

    // v2.260.1 (owner 2026-11-22): on a phone the stack sits at the top, clear of dialog and sheet buttons.
    it.each([
        [true, 'top', 'center'],
        [false, 'bottom', 'right'],
    ])('phone=%s puts the toasts %s-%s', async (phone, y, x) => {
        vi.stubGlobal('matchMedia', (q: string) => ({
            matches: phone && q === '(max-width: 600px)', media: q,
            addEventListener: () => {}, removeEventListener: () => {},
        }));
        try {
            render(
                <ToastProvider>
                    <Fire message="Where am I" type="success" />
                </ToastProvider>,
            );
            fireEvent.click(screen.getByText('fire Where am I'));
            const list = (await screen.findByText('Where am I')).closest('[data-sonner-toaster]')!;
            expect(list.getAttribute('data-y-position')).toBe(y);
            expect(list.getAttribute('data-x-position')).toBe(x);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
