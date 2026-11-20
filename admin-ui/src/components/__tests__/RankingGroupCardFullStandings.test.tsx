import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RankingGroupCard, RankingsColumn, RankingsRow } from '../ScoreboardComponents';
import type { RankingGroupData, RankingsCardStyle } from '../ScoreboardComponents';

/**
 * B29 (v2.254.0) — every ranking card links to the full standings.
 *
 * The card shows the top 10; the full list lives at `/:slug/rankings/:groupId`
 * (`RankingsFullStandings`), which only the ticker style linked to, so a
 * card-style board had no way to see the 11th player onward (GamerDad89,
 * Mox 2026-11-20: "I feel like I am missing a 'show all' button").
 */

const GROUP: RankingGroupData['group'] = {
  id: 'group-42',
  name: 'Season 06 — Season',
  description: '',
  rank_method: 'best_game_linear',
  best_n: 12,
  min_games: 1,
};

const RANKINGS: RankingGroupData['rankings'] = Array.from({ length: 12 }, (_, i) => ({
  rank: i + 1,
  iscored_username: `Player${i + 1}`,
  total_points: 100 - i,
  games_played: 2,
}));

const STYLES: Array<[string, { rankingsStyle: RankingsCardStyle; scoreboardStyle: string }]> = [
  ['match + banner', { rankingsStyle: 'match', scoreboardStyle: 'banner' }],
  ['match + showcase', { rankingsStyle: 'match', scoreboardStyle: 'showcase' }],
  ['match + minimal', { rankingsStyle: 'match', scoreboardStyle: 'minimal' }],
  ['plaque', { rankingsStyle: 'plaque', scoreboardStyle: 'banner' }],
  ['compact', { rankingsStyle: 'compact', scoreboardStyle: 'banner' }],
  ['sidebar', { rankingsStyle: 'sidebar', scoreboardStyle: 'banner' }],
];

describe('RankingGroupCard full standings link (B29)', () => {
  it.each(STYLES)('%s links to /:slug/rankings/:groupId', (_label, props) => {
    render(
      <MemoryRouter>
        <RankingGroupCard group={GROUP} rankings={RANKINGS} slug="mox_s_game_room" {...props} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /full standings/i });
    expect(link.getAttribute('href')).toBe('/mox_s_game_room/rankings/group-42');
    // The card itself still shows only the top 10.
    expect(screen.queryByText('Player11')).toBeNull();
  });

  it('no slug (a preview with no room) renders no link', () => {
    render(<RankingGroupCard group={GROUP} rankings={RANKINGS} rankingsStyle="match" scoreboardStyle="banner" />);
    expect(screen.queryByRole('link', { name: /full standings/i })).toBeNull();
  });

  it('an empty group renders no link', () => {
    render(
      <MemoryRouter>
        <RankingGroupCard group={GROUP} rankings={[]} slug="mox_s_game_room" rankingsStyle="match" scoreboardStyle="banner" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /full standings/i })).toBeNull();
  });

  it('RankingsColumn and RankingsRow pass the slug through to each card', () => {
    const groups = [{ group: GROUP, rankings: RANKINGS }];
    const { unmount } = render(
      <MemoryRouter>
        <RankingsColumn rankingGroups={groups} scoreboardStyle="banner" slug="room" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /full standings/i }).getAttribute('href')).toBe('/room/rankings/group-42');
    unmount();
    render(
      <MemoryRouter>
        <RankingsRow rankingGroups={groups} scoreboardStyle="minimal" slug="room" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /full standings/i }).getAttribute('href')).toBe('/room/rankings/group-42');
  });
});
