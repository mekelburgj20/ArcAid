import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from '../Toast';

/**
 * v2.233.0 — an error toast stays until tapped (a long refusal vanished on a
 * phone before it could be read, owner 2026-11-08); success still clears
 * itself, and at most three stay on screen.
 */

function Fire({ message, type }: { message: string; type: 'success' | 'error' }) {
    const { toast } = useToast();
    return <button onClick={() => toast(message, type)}>{`fire ${message}`}</button>;
}

afterEach(() => vi.useRealTimers());

describe('Toast', () => {
    it('keeps an error until dismissed and clears a success after 4 s', () => {
        vi.useFakeTimers();
        render(
            <ToastProvider>
                <Fire message="Saved" type="success" />
                <Fire message="Not in the catalogue" type="error" />
            </ToastProvider>,
        );
        fireEvent.click(screen.getByText('fire Saved'));
        fireEvent.click(screen.getByText('fire Not in the catalogue'));
        act(() => { vi.advanceTimersByTime(10_000); });

        expect(screen.queryByText('Saved')).toBeNull();
        expect(screen.getByRole('alert').textContent).toContain('Not in the catalogue');

        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows at most three at once', () => {
        render(
            <ToastProvider>
                <Fire message="E" type="error" />
            </ToastProvider>,
        );
        for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('fire E'));
        expect(screen.getAllByRole('alert')).toHaveLength(3);
    });
});
