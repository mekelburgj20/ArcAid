import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PinnedRail, { type PinnedGameChip } from '../PinnedRail';

// v2.52.0 (A4) — the "My Pins" rail.

function chip(over: Partial<PinnedGameChip> = {}): PinnedGameChip {
    return {
        global_game_id: 'g-1',
        name: 'Medieval Madness',
        display_name: null,
        manufacturer: 'Williams',
        year: 1997,
        image_url: null,
        local_image_path: null,
        wheel_image_path: null,
        score_count: 4,
        top_score: 900,
        top_player: {
            iscored_username: 'Champ',
            display_name: null,
            discord_user_id: 'disc-champ',
            avatar_hash: null,
            score: 900,
        },
        my_rank: 3,
        my_score: 400,
        rank_delta: null,
        pinned_at: '2026-07-28T12:00:00.000Z',
        ...over,
    };
}

function renderRail(pins: PinnedGameChip[], handlers: Partial<{ onSubmit: () => void; onAdd: () => void }> = {}) {
    return render(
        <MemoryRouter>
            <PinnedRail
                pins={pins}
                onSubmit={handlers.onSubmit ?? (() => {})}
                onAdd={handlers.onAdd ?? (() => {})}
            />
        </MemoryRouter>,
    );
}

describe('PinnedRail', () => {
    it('renders nothing at all when the viewer has zero pins', () => {
        const { container } = renderRail([]);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders one chip per pin plus the trailing add tile', () => {
        renderRail([chip(), chip({ global_game_id: 'g-2', name: 'Attack from Mars' })]);
        expect(screen.getByText('MY PINS')).toBeInTheDocument();
        expect(screen.getByText('— 2 games watched')).toBeInTheDocument();
        expect(screen.getByText('Medieval Madness')).toBeInTheDocument();
        expect(screen.getByText('Attack from Mars')).toBeInTheDocument();
        expect(screen.getByLabelText('Find a game to pin')).toBeInTheDocument();
    });

    it('shows the rank-delta badge only for a non-zero delta, and labels the direction', () => {
        // null → no badge (a freshly pinned game has no prior reading).
        const { unmount } = renderRail([chip({ rank_delta: null })]);
        expect(screen.queryByText(/since you pinned it/)).not.toBeInTheDocument();
        unmount();

        // 0 → held station, still no badge.
        const held = renderRail([chip({ rank_delta: 0 })]);
        expect(screen.queryByText(/since you pinned it/)).not.toBeInTheDocument();
        held.unmount();

        // negative → improved.
        const up = renderRail([chip({ rank_delta: -3 })]);
        expect(screen.getByText('Up 3 places since you pinned it')).toBeInTheDocument();
        up.unmount();

        // positive → dropped.
        renderRail([chip({ rank_delta: 2 })]);
        expect(screen.getByText('Down 2 places since you pinned it')).toBeInTheDocument();
    });

    it('falls back to "No scores yet" when nobody has scored the pinned game', () => {
        renderRail([chip({ top_player: null, top_score: null, score_count: 0 })]);
        expect(screen.getByText('No scores yet')).toBeInTheDocument();
    });

    it('wires the + button to onSubmit and the add tile to onAdd', () => {
        const onSubmit = vi.fn();
        const onAdd = vi.fn();
        renderRail([chip()], { onSubmit, onAdd });

        fireEvent.click(screen.getByLabelText('Submit a score for Medieval Madness'));
        expect(onSubmit).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByLabelText('Find a game to pin'));
        expect(onAdd).toHaveBeenCalledTimes(1);
    });
});
