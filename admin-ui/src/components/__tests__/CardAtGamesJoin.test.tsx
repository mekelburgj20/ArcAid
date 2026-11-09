import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CardAtGamesJoin from '../scoreboard/CardAtGamesJoin';
import { CardAtGamesJoinContext, type CardAtGamesJoinValue } from '../scoreboard/cardAtGamesJoinContext';
import type { GameLeaderboard } from '../ScoreboardComponents';

/**
 * A36 (v2.234.0) — "Join on AtGames" sits in the card's action strip, where
 * "Start attempts" does (owner 2026-11-08). Only on an ACTIVE card the page's
 * joinable list names, only under the page's provider.
 */

const lb = (over: Partial<GameLeaderboard> = {}) => ({
    gameId: 'g1', gameName: 'Arkanoid (Pinball)', tournamentName: 'Card Night', tournamentType: 'CN',
    imageUrl: null, gameStatus: 'ACTIVE', catalogueStyleId: null, logoStyleId: null, bgStyleId: null,
    styleHeaderDisabled: false, rankings: [], ...over,
}) as GameLeaderboard;

const item = { gameId: 'g1', tournamentId: 't1', tournamentName: 'Card Night', code: 'CARD123' };

function renderWith(value: CardAtGamesJoinValue | null, board = lb()) {
    return render(
        <CardAtGamesJoinContext.Provider value={value}>
            <CardAtGamesJoin lb={board} />
        </CardAtGamesJoinContext.Provider>,
    );
}

describe('CardAtGamesJoin', () => {
    it('offers Join on a listed live card and opens the dialog for it', () => {
        const open = vi.fn();
        renderWith({ byGameId: { g1: item }, joined: new Set(), open });
        fireEvent.click(screen.getByRole('button', { name: 'Join Card Night on AtGames' }));
        expect(open).toHaveBeenCalledWith(item);
    });

    it('says Joined once this browser joined that tournament', () => {
        renderWith({ byGameId: { g1: item }, joined: new Set(['t1']), open: vi.fn() });
        expect(screen.getByText('Joined on AtGames')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders nothing without a provider, on an unlisted card, or on a closed card', () => {
        const { container: a } = renderWith(null);
        expect(a.textContent).toBe('');
        const { container: b } = renderWith({ byGameId: {}, joined: new Set(), open: vi.fn() });
        expect(b.textContent).toBe('');
        const { container: c } = renderWith({ byGameId: { g1: item }, joined: new Set(), open: vi.fn() }, lb({ gameStatus: 'COMPLETED' }));
        expect(c.textContent).toBe('');
    });
});
