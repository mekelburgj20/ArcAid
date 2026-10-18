import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/websocket', () => ({
    getSocket: () => ({ emit: () => {}, on: () => {}, off: () => {} }),
}));

import { RankingsTicker, type RankingGroupData } from '../ScoreboardComponents';
import ScoreboardTicker from '../ScoreboardTicker';

/**
 * News-ticker contract (owner report 2026-10-18): each marquee renders ONE
 * copy of its items and enters from off the right edge. The old doubled track
 * put a second copy mid-screen when the content was narrower than the strip.
 * The motion itself is CSS (padding-left:100% + translateX(-100%)); this pins
 * the single copy and the class the CSS hangs on.
 */
describe('ticker motion', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('RankingsTicker renders each standing once', () => {
        const groups: RankingGroupData[] = [{
            group: { id: 'g1', name: 'Season One', description: '', rank_method: 'total_points', best_n: 0, min_games: 0 },
            rankings: [
                { rank: 1, iscored_username: 'Wyo', total_points: 100, games_played: 1 },
                { rank: 2, iscored_username: 'bofgi', total_points: 50, games_played: 1 },
            ],
        }];
        const { container } = render(<MemoryRouter><RankingsTicker rankingGroups={groups} slug="demo" /></MemoryRouter>);
        expect(screen.getAllByText('Season One')).toHaveLength(1);
        expect(screen.getAllByText(/1\. Wyo 100/)).toHaveLength(1);
        expect(container.querySelector('.rankings-ticker-track')).not.toBeNull();
    });

    it('ScoreboardTicker renders each feed event once', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [
                { id: 1, type: 'score_posted', title: 'Wyo posted on Medieval Madness', created_at: new Date().toISOString() },
                { id: 2, type: 'new_high_score', title: 'bofgi set a high score', created_at: new Date().toISOString() },
            ],
        })));
        const { container } = render(<ScoreboardTicker roomId="room-1" />);
        await waitFor(() => expect(screen.getAllByText('Wyo posted on Medieval Madness')).toHaveLength(1));
        expect(screen.getAllByText('bofgi set a high score')).toHaveLength(1);
        expect(container.querySelector('.scoreboard-ticker-track')).not.toBeNull();
    });
});
