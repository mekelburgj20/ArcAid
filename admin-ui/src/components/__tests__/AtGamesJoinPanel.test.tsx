import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * A33 — "Join on AtGames" on the event page. The player signs in with their
 * AtGames account for this one join; the password is cleared afterwards.
 */

// `post` is a plain function over a swappable implementation, not a vi.fn():
// the spy's own result tracking reported the refused-join rejection as a test
// failure even though the panel catches it.
const { postMock, impl } = vi.hoisted(() => {
    const impl: { fn: (...a: unknown[]) => Promise<unknown> } = { fn: async () => ({}) };
    const calls: unknown[][] = [];
    const postMock = Object.assign((...a: unknown[]) => { calls.push(a); return impl.fn(...a); }, { calls });
    return { postMock, impl };
});
vi.mock('../../lib/playerApi', () => ({ playerApi: { get: async () => ({}), post: postMock } }));

const { default: AtGamesJoinPanel } = await import('../AtGamesJoinPanel');

beforeEach(() => { postMock.calls.length = 0; impl.fn = async () => ({}); });

describe('AtGamesJoinPanel', () => {
    it('asks a signed-out viewer to log in, without the code', () => {
        const onLogin = vi.fn();
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken={null} code={null} signedIn={false} onLogin={onLogin} />);
        fireEvent.click(screen.getByRole('button', { name: 'Log in to join' }));
        expect(onLogin).toHaveBeenCalled();
        expect(screen.queryByText(/join on the cabinet with code/)).toBeNull();
    });

    it('joins with the typed AtGames sign-in and confirms', async () => {
        impl.fn = async () => ({ tournamentName: 'AtGames Night', linkConflict: false });
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken="tok" code="ETX2MKJ" signedIn onLogin={vi.fn()} />);
        expect(screen.getByText('ETX2MKJ')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Join on AtGames' }));
        fireEvent.change(screen.getByLabelText('AtGames email'), { target: { value: 'p@x.com' } });
        fireEvent.change(screen.getByLabelText('AtGames password'), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Join tournament' }));

        await waitFor(() => expect(screen.getByText(/You joined AtGames Night/)).toBeTruthy());
        expect(postMock.calls).toEqual([['/rooms/r/events/e/atgames-join', { email: 'p@x.com', password: 'secret' }, { token: 'tok' }]]);
    });

    it('shows the refusal and clears the password', async () => {
        impl.fn = async () => { throw new Error('AtGames did not accept that email and password'); };
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken="tok" code="ETX2MKJ" signedIn onLogin={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Join on AtGames' }));
        fireEvent.change(screen.getByLabelText('AtGames email'), { target: { value: 'p@x.com' } });
        fireEvent.change(screen.getByLabelText('AtGames password'), { target: { value: 'wrong' } });
        fireEvent.click(screen.getByRole('button', { name: 'Join tournament' }));

        await waitFor(() => expect(screen.getByText('AtGames did not accept that email and password')).toBeTruthy());
        expect((screen.getByLabelText('AtGames password') as HTMLInputElement).value).toBe('');
    });
});
