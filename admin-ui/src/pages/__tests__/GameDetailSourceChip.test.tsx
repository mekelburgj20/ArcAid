import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceChip } from '../GameDetail';

/**
 * The per-score SOURCE chip on a player's history rows.
 *
 * v2.155.0 made a cabinet-reported score render as the WITNESSED "AW" badge
 * instead of the raw word `vpx`, but only on two of the three history-row
 * renderers in GameDetail. The third — `ScoreHistoryRow`, the
 * This-tournament / All-time split — kept printing the raw word, and that was
 * the exact surface the round-8 tester was told to look at for the shield
 * (2026-09-06, "the only thing I didn't see was the AW in green").
 *
 * The chip is exported so this test can pin its contract directly; every
 * history-row renderer in GameDetail must go through it.
 */
describe('GameDetail SourceChip', () => {
    it('renders the AW shield for a cabinet-reported score, never the raw word', () => {
        render(<SourceChip source="vpx" />);
        expect(screen.getByText('AW')).toBeInTheDocument();
        expect(screen.queryByText('vpx')).not.toBeInTheDocument();
    });

    it('renders the AW shield for an AtGames-reported score too', () => {
        render(<SourceChip source="atgames" />);
        expect(screen.getByText('AW')).toBeInTheDocument();
    });

    it('keeps the plain source word for a typed score', () => {
        render(<SourceChip source="tournament" />);
        expect(screen.getByText('tournament')).toBeInTheDocument();
        expect(screen.queryByText('AW')).not.toBeInTheDocument();
    });
});
