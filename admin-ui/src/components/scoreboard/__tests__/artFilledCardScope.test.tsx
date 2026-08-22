import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BannerCard from '../BannerCard';
import MinimalCard from '../MinimalCard';
import ArcadeCard from '../ArcadeCard';
import ShowcaseCard from '../ShowcaseCard';
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../../../lib/scoreboardThemes';
import type { GameLeaderboard, RankedEntry } from '../../ScoreboardComponents';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.131.1 — an art-filled card is a DARK-TOKEN ISLAND.
 *
 * With `cardBgFill` on, the artwork covers the whole card and every card draws
 * its text over a FIXED black scrim (`bg-black/50`…`/60`). The text, however,
 * was set in PAGE-THEME tokens, so under a light theme `--color-primary`
 * resolved to oklch(21% …) — near-black ink on a near-black scrim, invisible
 * (owner, 2026-08-22, but the bug predates the v2.130.0 Appearance toggle).
 *
 * The fix is structural, which is what this file locks: the card ROOT carries
 * `sb-theme-scope sb-on-art` — the first restates the dark token defaults for
 * the subtree, the second adds the legibility shadow to `.sb-art-text` — and it
 * carries them ONLY when the art actually fills the card. The header-image
 * variant (`cardBgFill` off) sets its text on the card SURFACE and must keep
 * following the page theme, so the classes must be absent there.
 *
 * The colours themselves live in `index.css` and are deliberately not asserted;
 * what cannot regress silently is which element opts into the island.
 */

function entry(rank: number, over: Partial<RankedEntry> = {}): RankedEntry {
  return {
    rank,
    discord_user_id: `d-${rank}`,
    iscored_username: `player${rank}`,
    display_name: null,
    score: 1_000_000 - rank * 1000,
    avatar_hash: null,
    ...over,
  };
}

function makeLb(over: Partial<GameLeaderboard> = {}): GameLeaderboard {
  return {
    gameId: 'game-1',
    gameName: 'Medieval Madness',
    displayName: null,
    tournamentName: 'Daily Grind',
    tournamentType: 'DG',
    // The art the fill layer paints. Every card resolves it through the same
    // style-id → catalogue-image → `imageUrl` chain, so one field covers all.
    imageUrl: 'https://cdn.example/mm.png',
    gameStatus: 'ACTIVE',
    catalogueStyleId: null,
    logoStyleId: null,
    bgStyleId: null,
    styleHeaderDisabled: false,
    notes: null,
    rankings: [entry(1), entry(2), entry(3), entry(4)],
    ...over,
  };
}

/** Each card's ROOT — the bordered card itself, not the outer slot wrapper
 *  (which also holds the QR code, deliberately outside the island). */
const CARDS = [
  {
    name: 'BannerCard',
    Card: BannerCard,
    root: (c: HTMLElement) => c.querySelector('.border-2')!,
    title: (c: HTMLElement) => c.querySelector('h3, a[data-tour="game-card-title"]')!,
    // title + tournament caption + 4 rows × (rank, name, score).
    artTextCount: 14,
  },
  {
    name: 'MinimalCard',
    Card: MinimalCard,
    root: (c: HTMLElement) => c.querySelector('.rounded-lg')!,
    title: (c: HTMLElement) => c.querySelector('h3, a[data-tour="game-card-title"]')!,
    artTextCount: 14,
  },
  {
    name: 'ArcadeCard',
    Card: ArcadeCard,
    root: (c: HTMLElement) => c.querySelector('.arc-card')!,
    title: (c: HTMLElement) => c.querySelector('h3 > span, a[data-tour="game-card-title"] > span')!,
    // title + 3 podium places × (name, score) + 1 tail row × (rank, name,
    // score). The podium's rank is a medal glyph, not text.
    artTextCount: 10,
  },
] as const;

function renderCard(Card: (typeof CARDS)[number]['Card'], cardBgFill: boolean) {
  const { container } = render(
    <MemoryRouter>
      <Card lb={makeLb()} slug="test-room" maxScores={10} cardBgFill={cardBgFill} />
    </MemoryRouter>,
  );
  return container;
}

describe.each(CARDS)('$name — art-filled cards escape the page theme', ({ Card, root, title, artTextCount }) => {
  it('carries sb-theme-scope + sb-on-art on the card root when the art fills the card', () => {
    const el = root(renderCard(Card, true));
    expect(el.classList.contains('sb-theme-scope')).toBe(true);
    expect(el.classList.contains('sb-on-art')).toBe(true);
  });

  it('carries neither when the art is only a header image', () => {
    const el = root(renderCard(Card, false));
    expect(el.classList.contains('sb-theme-scope')).toBe(false);
    expect(el.classList.contains('sb-on-art')).toBe(false);
  });

  it('marks the title as art text, so it gets the legibility shadow inside the island', () => {
    const filled = renderCard(Card, true);
    expect(title(filled).classList.contains('sb-art-text')).toBe(true);
    // The class is inert outside `.sb-on-art` (the rule is a descendant
    // selector), so it may stay on unconditionally — assert it does, since a
    // conditional would be a second thing to keep in sync.
    expect(title(renderCard(Card, false)).classList.contains('sb-art-text')).toBe(true);
  });

  it('marks every score row — rank, player name and score — as art text', () => {
    // Exact, not a floor: a row element silently dropping out of the set is
    // precisely the regression (the text goes back to inheriting the theme).
    expect(renderCard(Card, true).querySelectorAll('.sb-art-text')).toHaveLength(artTextCount);
  });
});

describe('ShowcaseCard — same root contract, fixed palette', () => {
  const showcaseTheme = SHOWCASE_THEMES[DEFAULT_SHOWCASE_THEME]!;
  const showcaseRoot = (c: HTMLElement) => c.querySelector('.scoreboard-card-slot')!;

  it('carries sb-theme-scope + sb-on-art when art-filled', () => {
    const { container } = render(
      <MemoryRouter>
        <ShowcaseCard lb={makeLb()} slug="test-room" maxScores={10} theme={showcaseTheme} cardBgFill />
      </MemoryRouter>,
    );
    const el = showcaseRoot(container);
    expect(el.classList.contains('sb-theme-scope')).toBe(true);
    expect(el.classList.contains('sb-on-art')).toBe(true);
  });

  it('carries neither without the fill', () => {
    const { container } = render(
      <MemoryRouter>
        <ShowcaseCard lb={makeLb()} slug="test-room" maxScores={10} theme={showcaseTheme} cardBgFill={false} />
      </MemoryRouter>,
    );
    const el = showcaseRoot(container);
    expect(el.classList.contains('sb-theme-scope')).toBe(false);
    expect(el.classList.contains('sb-on-art')).toBe(false);
  });
});
