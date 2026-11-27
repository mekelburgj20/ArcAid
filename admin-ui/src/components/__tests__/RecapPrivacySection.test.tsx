import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/playerApi', () => ({
    playerApi: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock('../../contexts/ViewerAuthContext', () => ({
    useViewerAuth: () => ({ playerToken: 'tok' }),
}));

import RecapPrivacySection from '../RecapPrivacySection';

beforeEach(() => {
    get.mockReset();
    post.mockReset();
});

describe('RecapPrivacySection', () => {
    it('defaults: play stats on, time of day off', async () => {
        get.mockResolvedValue({});
        render(<RecapPrivacySection />);
        expect(await screen.findByTestId('recap-play-stats')).toBeChecked();
        expect(screen.getByTestId('recap-time-of-day')).not.toBeChecked();
    });

    it('shows the stored values', async () => {
        get.mockResolvedValue({ recap_play_stats: false, recap_time_of_day: true });
        render(<RecapPrivacySection />);
        expect(await screen.findByTestId('recap-play-stats')).not.toBeChecked();
        expect(screen.getByTestId('recap-time-of-day')).toBeChecked();
    });

    it('a toggle posts only its own key', async () => {
        get.mockResolvedValue({});
        post.mockResolvedValue({ success: true });
        render(<RecapPrivacySection />);
        fireEvent.click(await screen.findByTestId('recap-time-of-day'));
        await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
        expect(post).toHaveBeenCalledWith('/me/preferences', { recap_time_of_day: true }, { token: 'tok' });
        expect(screen.getByTestId('recap-time-of-day')).toBeChecked();
        fireEvent.click(screen.getByTestId('recap-play-stats'));
        await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
        expect(post).toHaveBeenLastCalledWith('/me/preferences', { recap_play_stats: false }, { token: 'tok' });
    });

    it('rolls back and says so when the save fails', async () => {
        get.mockResolvedValue({});
        post.mockRejectedValue(new Error('nope'));
        render(<RecapPrivacySection />);
        fireEvent.click(await screen.findByTestId('recap-play-stats'));
        expect(await screen.findByText('nope')).toBeInTheDocument();
        expect(screen.getByTestId('recap-play-stats')).toBeChecked();
    });

    it('falls back to the defaults when the load fails', async () => {
        get.mockRejectedValue(new Error('boom'));
        render(<RecapPrivacySection />);
        expect(await screen.findByTestId('recap-play-stats')).toBeChecked();
    });
});
