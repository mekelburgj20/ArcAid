import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CardRouter from '../CardRouter';
import { tournamentChipLink } from '../tournamentChip';
import type { GameLeaderboard } from '../../ScoreboardComponents';
import { formatEndedLabel } from '../cardTimer';
import type { ScoreboardStyle } from '../../../lib/scoreboardThemes';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.238.0 (B24) — every card style:
 *   - the tournament chip links to the tournament's results (a finished card
 *     to its own run), named for the tournament since the chip shows a tag;
 *   - a finished card shows "Ended Tue, Nov 3" where a live one shows its
 *     countdown;
 *   - without a link target (the kiosk) the chip stays plain text.
 */
const STYLES: ScoreboardStyle[] = ['showcase', 'banner', 'minimal', 'arcade'];
const ENDED = '2026-11-03T22:00:00.000Z';

function makeLb(over: Partial<GameLeaderboard> = {}): GameLeaderboard {
  return {
    gameId: 'g-godzilla',
    gameName: 'Godzilla',
    displayName: null,
    tournamentName: 'Daily Grind',
    tournamentType: 'DG',
    tournamentId: 't-dg',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: null,
    logoStyleId: null,
    bgStyleId: null,
    styleHeaderDisabled: false,
    notes: null,
    rankings: [],
    ...over,
  };
}

function renderCard(style: ScoreboardStyle, lb: GameLeaderboard, withLink = true) {
  return render(
    <MemoryRouter>
      <CardRouter
        lb={lb}
        slug="rtx"
        style={style}
        maxScores={10}
        onSubmitScore={vi.fn()}
        chipLinkTo={withLink ? tournamentChipLink('rtx')(lb) : undefined}
      />
    </MemoryRouter>,
  );
}

describe.each(STYLES)('%s card — results link and end date', (style) => {
  it('a live card\'s chip opens the tournament page', () => {
    renderCard(style, makeLb());
    const link = screen.getByRole('link', { name: 'Daily Grind results' });
    expect(link).toHaveAttribute('href', '/rtx/tournaments/t-dg');
    expect(link).toHaveTextContent('DG');
  });

  it('a finished card\'s chip opens its own run, and it shows when it ended', () => {
    renderCard(style, makeLb({ gameStatus: 'COMPLETED', endedAt: ENDED }));
    expect(screen.getByRole('link', { name: 'Daily Grind: Godzilla final standings' }))
      .toHaveAttribute('href', '/rtx/tournaments/t-dg?run=g-godzilla');
    expect(screen.getByText(formatEndedLabel(ENDED)!)).toBeInTheDocument();
  });

  it('without a link target (kiosk) the chip is plain text', () => {
    renderCard(style, makeLb(), false);
    expect(screen.getByText('DG')).toBeInTheDocument();
    expect(screen.queryByTestId('tournament-chip-link')).toBeNull();
  });

  it('a pinned board\'s chip never links', () => {
    renderCard(style, makeLb({ isPinned: true, tournamentId: null }));
    expect(screen.queryByTestId('tournament-chip-link')).toBeNull();
  });
});

describe('formatEndedLabel', () => {
  it('reads "Ended <weekday>, <month> <day>" and is null without a date', () => {
    const d = new Date(ENDED);
    expect(formatEndedLabel(ENDED))
      .toBe(`Ended ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`);
    expect(formatEndedLabel(null)).toBeNull();
    expect(formatEndedLabel('not a date')).toBeNull();
  });
});
