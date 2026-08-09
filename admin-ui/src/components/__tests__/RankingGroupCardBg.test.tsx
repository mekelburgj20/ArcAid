import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RankingGroupCard } from '../ScoreboardComponents';
import type { RankingGroupData } from '../ScoreboardComponents';

/**
 * Ranking-card backgrounds (owner-designed 2026-08-09).
 *
 * The bg image + darkening overlay renders on the two "full-size" treatments
 * — rankingsStyle 'match' (mirroring the parent banner/showcase/minimal
 * scoreboardStyle) and 'plaque' — and is deliberately withheld on 'compact'
 * and 'sidebar', which stay chrome-less/dense by design. Gating additionally
 * requires bg_has_bg !== 0 (a style can exist but lack a background image),
 * mirroring GameCard's effectiveBgId resolution exactly.
 */

const BASE_GROUP: RankingGroupData['group'] = {
  id: 'group-1',
  name: 'Overall',
  description: '',
  rank_method: 'max_10',
  best_n: 25,
  min_games: 1,
};

const RANKINGS: RankingGroupData['rankings'] = [
  { rank: 1, iscored_username: 'Alice', total_points: 100, games_played: 3 },
];

const BG_URL = '/api/styles/images/backgrounds/style-busy-1.png';

function hasBgLayer(container: HTMLElement, url: string): boolean {
  return !!container.querySelector(`[style*="${url}"]`);
}

describe('RankingGroupCard background gating', () => {
  it('renders no background layer when bg_style_id is unset (baseline)', () => {
    const { container } = render(
      <RankingGroupCard group={BASE_GROUP} rankings={RANKINGS} rankingsStyle="match" scoreboardStyle="banner" />
    );
    expect(hasBgLayer(container, '/api/styles/images/backgrounds/')).toBe(false);
  });

  describe('full-size treatments (bg renders)', () => {
    it.each([
      ['match + banner', { rankingsStyle: 'match' as const, scoreboardStyle: 'banner' }],
      ['match + showcase', { rankingsStyle: 'match' as const, scoreboardStyle: 'showcase' }],
      ['match + minimal', { rankingsStyle: 'match' as const, scoreboardStyle: 'minimal' }],
      ['plaque', { rankingsStyle: 'plaque' as const, scoreboardStyle: 'banner' }],
    ])('%s renders the background image and a darkening overlay', (_label, props) => {
      const group = { ...BASE_GROUP, bg_style_id: 'style-busy-1', bg_has_bg: 1 };
      const { container } = render(
        <RankingGroupCard group={group} rankings={RANKINGS} {...props} />
      );
      expect(hasBgLayer(container, BG_URL)).toBe(true);
      // Darkening overlay: an absolutely-positioned black layer sitting
      // alongside the image layer (bg-black/* utility, or showcase's inline
      // rgba(0,0,0,0.55) — jsdom/browser both normalize the serialized rgba
      // spacing, so match loosely on "0, 0, 0" rather than the literal
      // source string).
      const overlay = container.querySelector('.bg-black\\/50, .bg-black\\/55')
        ?? [...container.querySelectorAll<HTMLElement>('[style]')].find(el => /rgba\(\s*0,\s*0,\s*0/.test(el.style.background));
      expect(overlay).toBeTruthy();
    });
  });

  describe('small treatments (bg withheld — gate proof)', () => {
    it.each([
      ['compact', 'compact' as const],
      ['sidebar', 'sidebar' as const],
    ])('%s does NOT render the background image even though bg_style_id is set', (_label, rankingsStyle) => {
      const group = { ...BASE_GROUP, bg_style_id: 'style-busy-1', bg_has_bg: 1 };
      const { container } = render(
        <RankingGroupCard group={group} rankings={RANKINGS} rankingsStyle={rankingsStyle} scoreboardStyle="banner" />
      );
      expect(hasBgLayer(container, BG_URL)).toBe(false);
    });
  });

  it('withholds the background when the style has no background image (bg_has_bg === 0)', () => {
    const group = { ...BASE_GROUP, bg_style_id: 'style-header-only', bg_has_bg: 0 };
    const { container } = render(
      <RankingGroupCard group={group} rankings={RANKINGS} rankingsStyle="match" scoreboardStyle="banner" />
    );
    expect(hasBgLayer(container, '/api/styles/images/backgrounds/')).toBe(false);
  });

  it('withholds the background when bg_style_id is null even with a plaque style', () => {
    const group = { ...BASE_GROUP, bg_style_id: null, bg_has_bg: null };
    const { container } = render(
      <RankingGroupCard group={group} rankings={RANKINGS} rankingsStyle="plaque" scoreboardStyle="banner" />
    );
    expect(hasBgLayer(container, '/api/styles/images/backgrounds/')).toBe(false);
  });
});
