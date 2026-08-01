import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalGameCard, { type GlobalGameCardGame, type TopScoreEntry } from '../GlobalGameCard';
import { glitchVars } from '../../lib/cardGlitch';

/**
 * v2.67.0 neon card — the four things the rebuild is, locked.
 *
 *   1. The title opens the card (header row), not the art block.
 *   2. Places 1-3 always render; ranks 4+ are still shown on top of them.
 *   3. The frame's category neon is declared by `data-neon`, and the chip
 *      reads the same `--gg-neon` the frame does.
 *   4. The glitch timings (`lib/cardGlitch.ts`) are a pure function of
 *      `card_id` — stable across renders, different between cards.
 *      `Math.random()` would pass a "they differ" test and fail the "stable"
 *      one, which is why both are here.
 */

function makeScore(n: number): TopScoreEntry {
  return {
    iscored_username: `player${n}`,
    display_name: null,
    score: 1_000_000 - n * 1000,
    avatar_hash: null,
    discord_user_id: `discord-${n}`,
    origin_room_slug: null,
    origin_room_logo_url: null,
    origin_room_short_tag: null,
  };
}

function makeGame(overrides: Partial<GlobalGameCardGame> = {}): GlobalGameCardGame {
  return {
    global_game_id: 'g1',
    card_id: 'g1::real',
    name: 'Medieval Madness',
    display_name: null,
    manufacturer: 'Williams',
    year: 1997,
    image_url: null,
    local_image_path: null,
    wheel_image_path: null,
    platforms: JSON.stringify(['vpx']),
    score_count: 0,
    top_scores: [],
    category: 'real',
    ...overrides,
  };
}

function renderCard(game: GlobalGameCardGame, onSubmit = vi.fn()) {
  const utils = render(
    <MemoryRouter>
      <GlobalGameCard game={game} onSubmit={onSubmit} />
    </MemoryRouter>,
  );
  return { ...utils, onSubmit, card: screen.getByTestId('global-game-card') };
}

describe('GlobalGameCard — layout (v2.67.0)', () => {
  it('puts the title in the card header, not inside the art link', () => {
    const { card } = renderCard(makeGame());
    const heading = within(card).getByRole('heading', { name: 'Medieval Madness' });
    // The art link is labelled; if the title were still inside it, this walk
    // would land on the art rather than on the header's own link.
    expect(heading.closest('a')).not.toBe(within(card).getByLabelText('Medieval Madness details'));
    expect(heading.closest('a')).toHaveAttribute('href', '/games/g1?category=real');
  });

  it('renders the pin control immediately before the title', () => {
    render(
      <MemoryRouter>
        <GlobalGameCard game={makeGame()} onSubmit={vi.fn()} onTogglePin={vi.fn()} />
      </MemoryRouter>,
    );
    const row = screen.getByRole('button', { name: /^Pin / }).parentElement as HTMLElement;
    expect(within(row).getByRole('heading', { name: 'Medieval Madness' })).toBeInTheDocument();
  });

  it('carries the 1.5x floor height as a token, not a magic number', () => {
    const { card } = renderCard(makeGame());
    expect(card.className).toContain('min-h-[var(--sb-card-min-h)]');
  });
});

describe('GlobalGameCard — the podium is a floor (v2.67.0)', () => {
  it('offers all three places when nobody holds any', () => {
    const { card } = renderCard(makeGame());
    expect(within(card).getAllByText('Claim this spot')).toHaveLength(3);
  });

  it('fires onSubmit from a claim place', () => {
    const { card, onSubmit } = renderCard(makeGame());
    fireEvent.click(within(card).getByRole('button', { name: 'Claim 2nd place' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps ranks 4+ — three rows is a minimum, never a cap', () => {
    const scores = Array.from({ length: 5 }, (_, i) => makeScore(i + 1));
    const { card } = renderCard(makeGame({ top_scores: scores, score_count: 5 }));
    expect(within(card).queryByText('Claim this spot')).not.toBeInTheDocument();
    expect(within(card).getByText('#4')).toBeInTheDocument();
    expect(within(card).getByText('#5')).toBeInTheDocument();
    expect(within(card).getByText('player5')).toBeInTheDocument();
  });
});

describe('GlobalGameCard — category neon (v2.67.0)', () => {
  it.each([
    ['real', 'real'],
    ['simulation', 'simulation'],
    ['arcade_style', 'arcade_style'],
    ['video', 'video'],
    ['unspecified', 'unspecified'],
  ])('declares data-neon="%s" for the %s board', (category, expected) => {
    const { card } = renderCard(makeGame({ category, card_id: `g1::${category}` }));
    expect(card).toHaveAttribute('data-neon', expected);
  });

  it('falls back to the `none` key when the card has no board at all', () => {
    const { card } = renderCard(makeGame({ category: null, card_id: 'g1::none' }));
    expect(card).toHaveAttribute('data-neon', 'none');
  });

  it('uses a prospective band for the frame as well as for the chip', () => {
    const { card } = renderCard(makeGame({ category: null, prospective_category: 'simulation' }));
    expect(card).toHaveAttribute('data-neon', 'simulation');
  });

  it('paints the chip from the same --gg-neon the frame uses', () => {
    const { card } = renderCard(makeGame());
    const style = within(card).getByTestId('category-chip').getAttribute('style') ?? '';
    expect(style).toContain('--gg-neon');
    // The pre-v2.67 tokens survive as the fallback, which is what keeps
    // GlobalHeroCard (no --gg-neon in scope) rendering as it always did.
    expect(style).toContain('--sb-cat-fg');
    // Tokens only — a literal colour here would be a light-mode bug.
    expect(style).not.toMatch(/rgba?\(/);
  });
});

describe('glitchVars (v2.67.0)', () => {
  it('is a pure function of the seed — the same card never re-rolls', () => {
    expect(glitchVars('g1::real')).toEqual(glitchVars('g1::real'));
  });

  it('gives different cards different delays', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => `game-${i}::real`);
    const delays = new Set(seeds.map(s => (glitchVars(s) as Record<string, string>)['--gg-gl-delay']));
    // Not 40/40 — collisions are allowed and harmless — but a wall of cards
    // must not share one delay, which is what a constant would give.
    expect(delays.size).toBeGreaterThan(30);
  });

  it('spreads cards across all three periods', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `game-${i}::real`);
    const periods = new Set(seeds.map(s => (glitchVars(s) as Record<string, string>)['--gg-gl-dur']));
    expect([...periods].sort()).toEqual(['17s', '21s', '26s']);
  });

  it('starts every delay in the past, so no card waits a full cycle to glitch', () => {
    for (const seed of ['a', 'bb::real', 'g9::unspecified']) {
      const v = glitchVars(seed) as Record<string, string>;
      const period = parseFloat(v['--gg-gl-dur']);
      for (const key of ['--gg-gl-delay', '--gg-gl-delay-2']) {
        const delay = parseFloat(v[key]);
        expect(delay).toBeLessThanOrEqual(0);
        expect(delay).toBeGreaterThan(-period);
      }
    }
  });

  it('gives the two fringe rings independent offsets', () => {
    const v = glitchVars('g1::real') as Record<string, string>;
    expect(v['--gg-gl-delay']).not.toEqual(v['--gg-gl-delay-2']);
  });
});
