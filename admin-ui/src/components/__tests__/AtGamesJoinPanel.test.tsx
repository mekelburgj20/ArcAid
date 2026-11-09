import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * A33 — "Join on AtGames" on the event page. The player signs in with their
 * AtGames account for this one join; the password is cleared afterwards.
 */

// `post` is a plain function over a swappable implementation, not a vi.fn():
// the spy's own result tracking reported the refused-join rejection as a test
// failure even though the panel catches it.
const { postMock, impl, deleteMock, delImpl } = vi.hoisted(() => {
    const impl: { fn: (...a: unknown[]) => Promise<unknown> } = { fn: async () => ({}) };
    const calls: unknown[][] = [];
    const postMock = Object.assign((...a: unknown[]) => { calls.push(a); return impl.fn(...a); }, { calls });
    const delImpl: { fn: (...a: unknown[]) => Promise<unknown> } = { fn: async () => ({ joinedVia: null }) };
    const delCalls: unknown[][] = [];
    const deleteMock = Object.assign((...a: unknown[]) => { delCalls.push(a); return delImpl.fn(...a); }, { calls: delCalls });
    return { postMock, impl, deleteMock, delImpl };
});
vi.mock('../../lib/playerApi', () => ({ playerApi: { get: async () => ({}), post: postMock, delete: deleteMock } }));

const { default: AtGamesJoinPanel } = await import('../AtGamesJoinPanel');

beforeEach(() => {
    postMock.calls.length = 0; impl.fn = async () => ({});
    deleteMock.calls.length = 0; delImpl.fn = async () => ({ joinedVia: null });
});

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

    // ---- A40 (v2.237.0) ----

    it('a viewer the server knows is in it sees Joined, not the invitation or a Join button', () => {
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken="tok" code="ETX2MKJ" signedIn joinedVia="verified" onLogin={vi.fn()} />);
        expect(screen.getByText('Joined on AtGames')).toBeTruthy();
        expect(screen.queryByText('Playing on an AtGames cabinet?')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Join on AtGames' })).toBeNull();
        expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    });

    it('a player already in the tournament is told so and the panel turns to Joined', async () => {
        impl.fn = async () => ({ tournamentName: 'AtGames Night', linkConflict: false, alreadyMember: true });
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken="tok" code="ETX2MKJ" signedIn onLogin={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Join on AtGames' }));
        fireEvent.change(screen.getByLabelText('AtGames email'), { target: { value: 'p@x.com' } });
        fireEvent.change(screen.getByLabelText('AtGames password'), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Join tournament' }));

        await waitFor(() => expect(screen.getByText(/You're already in AtGames Night on AtGames/)).toBeTruthy());
        expect(screen.getByText('Joined on AtGames')).toBeTruthy();
        expect(screen.queryByText('Playing on an AtGames cabinet?')).toBeNull();
    });

    it('"I\'ve joined" marks the viewer joined with no sign-in, and Undo brings the Join button back', async () => {
        impl.fn = async () => ({ joinedVia: 'self' });
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken="tok" code="ETX2MKJ" signedIn onLogin={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: "I've joined" }));

        await waitFor(() => expect(screen.getByText('Joined on AtGames')).toBeTruthy());
        expect(postMock.calls).toEqual([['/rooms/r/events/e/atgames-joined', {}, { token: 'tok' }]]);
        expect(screen.queryByLabelText('AtGames password')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Join on AtGames' })).toBeTruthy());
        expect(deleteMock.calls).toEqual([['/rooms/r/events/e/atgames-joined', { token: 'tok' }]]);
    });

    it('Undo leaves Joined in place when the server still knows another way', async () => {
        delImpl.fn = async () => ({ joinedVia: 'scores' });
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken="tok" code="ETX2MKJ" signedIn joinedVia="self" onLogin={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
        await waitFor(() => expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull());
        expect(screen.getByText('Joined on AtGames')).toBeTruthy();
    });

    it('a signed-out viewer is not offered "I\'ve joined"', () => {
        render(<AtGamesJoinPanel roomId="r" eventId="e" playerToken={null} code={null} signedIn={false} onLogin={vi.fn()} />);
        expect(screen.queryByRole('button', { name: "I've joined" })).toBeNull();
    });
});
