import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../../lib/playerApi', () => ({
    playerApi: { get: (...a: unknown[]) => get(...a), patch: (...a: unknown[]) => patch(...a) },
}));
vi.mock('../../contexts/ViewerAuthContext', () => ({
    useViewerAuth: () => ({ playerToken: 'tok' }),
}));

import GlobalPrivateScores from '../GlobalPrivateScores';

const ROWS = [
    { id: 's1', game_name: 'Medieval Madness', score: 1234567, submitted_at: '2026-11-01 10:00:00', origin_room_name: 'Wizard Room' },
    { id: 's2', game_name: 'Attack from Mars', score: 900, submitted_at: '2026-11-02 10:00:00', origin_room_name: null },
];

beforeEach(() => {
    get.mockReset();
    patch.mockReset();
});

describe('GlobalPrivateScores', () => {
    it('renders nothing when the list is empty', async () => {
        get.mockResolvedValue({ scores: [] });
        const { container } = render(<GlobalPrivateScores />);
        await waitFor(() => expect(get).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the load fails', async () => {
        get.mockRejectedValue(new Error('boom'));
        const { container } = render(<GlobalPrivateScores />);
        await waitFor(() => expect(get).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('renders one row per score', async () => {
        get.mockResolvedValue({ scores: ROWS });
        render(<GlobalPrivateScores />);
        expect(await screen.findByTestId('private-score-s1')).toHaveTextContent('Medieval Madness');
        expect(screen.getByTestId('private-score-s1')).toHaveTextContent('1,234,567');
        expect(screen.getByTestId('private-score-s1')).toHaveTextContent('Wizard Room');
        expect(screen.getByTestId('private-score-s2')).toHaveTextContent('Attack from Mars');
        expect(screen.getByTestId('post-global-s2')).toBeInTheDocument();
    });

    it('Post then Undo round-trips the row', async () => {
        get.mockResolvedValue({ scores: ROWS });
        patch.mockResolvedValue({ success: true });
        render(<GlobalPrivateScores />);
        fireEvent.click(await screen.findByTestId('post-global-s1'));

        expect(await screen.findByText('On the Global Scoreboard')).toBeInTheDocument();
        expect(patch).toHaveBeenLastCalledWith('/me/global-scores/s1', { share_to_global: true }, { token: 'tok' });

        fireEvent.click(screen.getByTestId('undo-global-s1'));
        expect(await screen.findByTestId('post-global-s1')).toBeInTheDocument();
        expect(patch).toHaveBeenLastCalledWith('/me/global-scores/s1', { share_to_global: false }, { token: 'tok' });
        expect(screen.queryByText('On the Global Scoreboard')).not.toBeInTheDocument();
    });

    it('a rejected PATCH shows the server message and keeps the Post button', async () => {
        get.mockResolvedValue({ scores: ROWS });
        patch.mockRejectedValue(new Error('This room keeps its scores off the Global Scoreboard.'));
        render(<GlobalPrivateScores />);
        fireEvent.click(await screen.findByTestId('post-global-s1'));

        expect(await screen.findByText('This room keeps its scores off the Global Scoreboard.')).toBeInTheDocument();
        expect(screen.getByTestId('post-global-s1')).toBeEnabled();
        expect(screen.queryByTestId('undo-global-s1')).not.toBeInTheDocument();
    });
});
