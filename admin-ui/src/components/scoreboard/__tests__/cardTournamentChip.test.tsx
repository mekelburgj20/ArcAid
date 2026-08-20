import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ShowcaseCard from '../ShowcaseCard';
import BannerCard from '../BannerCard';
import MinimalCard from '../MinimalCard';
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../../../lib/scoreboardThemes';
import type { GameLeaderboard } from '../../ScoreboardComponents';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * Owner bug (2026-08-20): four card styles disagreed on the tournament chip
 * — two hardcoded an invented English label per tag ("Weekly Grind - VPXS"
 * rendered as "Weekly Grind", same as "Weekly Grind - VPX"), two showed the
 * raw tournament NAME. `tournamentChipLabel` (see tournamentChip.test.ts) is
 * now the one rule; this file locks that Showcase/Banner/Minimal actually
 * call it and show the TAG, not the name. ArcadeCard's equivalent assertion
 * lives in ArcadeCard.test.tsx.
 */
function makeLb(over: Partial<GameLeaderboard> = {}): GameLeaderboard {
  return {
    gameId: 'game-1',
    gameName: 'Medieval Madness',
    displayName: null,
    tournamentName: 'Weekly Grind - VPXS',
    tournamentType: 'WG-VPXS',
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

describe('score card tournament chip — tag, not name', () => {
  it('ShowcaseCard shows the tag', () => {
    render(
      <MemoryRouter>
        <ShowcaseCard
          lb={makeLb()}
          slug="test-room"
          maxScores={10}
          theme={SHOWCASE_THEMES[DEFAULT_SHOWCASE_THEME]!}
          onSubmitScore={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('WG-VPXS')).toBeInTheDocument();
    expect(screen.queryByText('Weekly Grind - VPXS')).toBeNull();
    expect(screen.queryByText('Weekly Grind')).toBeNull();
  });

  it('BannerCard shows the tag', () => {
    render(
      <MemoryRouter>
        <BannerCard lb={makeLb()} slug="test-room" maxScores={10} onSubmitScore={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('WG-VPXS')).toBeInTheDocument();
    expect(screen.queryByText('Weekly Grind - VPXS')).toBeNull();
    expect(screen.queryByText('Weekly Grind')).toBeNull();
  });

  it('MinimalCard shows the tag', () => {
    render(
      <MemoryRouter>
        <MinimalCard lb={makeLb()} slug="test-room" maxScores={10} onSubmitScore={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('WG-VPXS')).toBeInTheDocument();
    expect(screen.queryByText('Weekly Grind - VPXS')).toBeNull();
    expect(screen.queryByText('Weekly Grind')).toBeNull();
  });
});
