import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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
});
