import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ArcadeCard from '../ArcadeCard';
import { arcadeNeonKey } from '../arcadeNeon';
import type { GameLeaderboard, RankedEntry } from '../../ScoreboardComponents';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * ArcadeCard — style-system revamp Phase 1.
 *
 * The card is the Global Scoreboard's LOOK on the room card's BEHAVIOUR, and
 * the behaviour half is what a screenshot cannot check. So this file locks the
 * room-card contract the look is wrapped around: the always-on podium and its
 * claim affordance, the tail below it, viewer-row injection, the verified
 * badge, the inline score-history expand, the maintenance countdown, the
 * tournament label, and the admin style-image resolution chain (including the
 * `lb.imageUrl` fallback that the pre-v2.0.3 cards rendered blank for).
 *
 * The neon frame is asserted as a `data-neon` KEY, not as a colour: the colour
 * lives in `index.css` under `.arc-card[data-neon=…]`, which is exactly where a
 * theme is allowed to change it.
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

function renderCard(lb: GameLeaderboard, props: Record<string, unknown> = {}) {
  const onSubmitScore = (props.onSubmitScore as (lb: GameLeaderboard) => void) ?? vi.fn();
  const utils = render(
    <MemoryRouter>
      <ArcadeCard lb={lb} slug="test-room" maxScores={10} {...props} onSubmitScore={onSubmitScore} />
    </MemoryRouter>,
  );
  return { ...utils, onSubmitScore, card: screen.getByTestId('arcade-card') };
}

describe('ArcadeCard — the Global look', () => {
  it('sets the title on the art block, not above it', () => {
    const { card } = renderCard(makeLb());
    const art = within(card).getByTestId('arcade-art');
    // The title overlay is a SIBLING of the art image inside the art block —
    // the art region is the surface the title is set on, which is the whole
    // shape of the card. A title rendered outside it is the pre-Arcade layout.
    expect(within(art).getByText('Medieval Madness')).toBeInTheDocument();
  });

  it('renders the game title in full — never ellipsized', () => {
    const long = 'The Lord of the Rings Limited Edition Special Reissue';
    const { card } = renderCard(makeLb({ gameName: long }));
    const title = within(card).getByText(long);
    expect(title.className).not.toMatch(/truncate/);
    expect(getComputedStyle(title).textOverflow).not.toBe('ellipsis');
  });

  it('prefers the room admin style background, and falls back to the catalogue image', () => {
    const styled = renderCard(makeLb({ bgStyleId: 'style-9', imageUrl: 'https://cdn/mm.png' }));
    expect(within(styled.card).getByRole('presentation', { hidden: true }) ?? null).toBeTruthy();
    expect(styled.card.querySelector('img')!.getAttribute('src'))
      .toBe('/api/styles/images/backgrounds/style-9.png');
    styled.unmount();

    // v2.0.3's fallback: no style mapping at all still shows catalogue art
    // rather than the blank card the pre-fallback versions rendered.
    const plain = renderCard(makeLb({ imageUrl: 'https://cdn/mm.png' }));
    expect(plain.card.querySelector('img')!.getAttribute('src')).toBe('https://cdn/mm.png');
  });

  it('shows a placeholder when the game has no art at all', () => {
    const { card } = renderCard(makeLb());
    expect(within(card).getByText('No image')).toBeInTheDocument();
  });

  it('declares its neon by tournament kind, so index.css can colour the frame', () => {
    expect(arcadeNeonKey({ tournamentType: 'DG', isPinned: false })).toBe('dg');
    expect(arcadeNeonKey({ tournamentType: 'WG-VPXS', isPinned: false })).toBe('wg');
    expect(arcadeNeonKey({ tournamentType: 'WG-VR', isPinned: false })).toBe('wg-vr');
    expect(arcadeNeonKey({ tournamentType: 'MG', isPinned: false })).toBe('mg');
    // Pinned outranks type: a pinned row has no tournament at all.
    expect(arcadeNeonKey({ tournamentType: '', isPinned: true })).toBe('pinned');
    // `none` is DECLARED, not absent — "no tournament" and the stylesheet
    // default must be the same stated thing.
    expect(arcadeNeonKey({ tournamentType: '', isPinned: false })).toBe('none');

    const { card } = renderCard(makeLb({ tournamentType: 'MG' }));
    expect(card.getAttribute('data-neon')).toBe('mg');
    expect(card.className).toMatch(/\barc-card\b/);
  });

  it('names the board with the tournament chip, and Pinned for a pinned game', () => {
    const t = renderCard(makeLb({ tournamentType: 'WG-VR' }));
    expect(within(t.card).getByTestId('arcade-chip')).toHaveTextContent('WG-VR');
    t.unmount();

    const p = renderCard(makeLb({ isPinned: true, tournamentType: '', tournamentName: '' }));
    expect(within(p.card).getByTestId('arcade-chip')).toHaveTextContent('Pinned');
  });
});

describe('ArcadeCard — room-card behaviour', () => {
  it('renders the podium above a tail of ranks 4+', () => {
    const { card } = renderCard(makeLb({ rankings: [1, 2, 3, 4, 5].map(r => entry(r)) }));

    expect(within(card).getByTestId('arcade-place-1')).toHaveTextContent('player1');
    expect(within(card).getByTestId('arcade-place-3')).toHaveTextContent('player3');
    // Rank 4+ rows carry a `#n` rank cell rather than a medal.
    expect(within(card).getByText('#4')).toBeInTheDocument();
    expect(within(card).getByText('#5')).toBeInTheDocument();
  });

  it('honours maxScores for the tail', () => {
    const { card } = renderCard(
      makeLb({ rankings: [1, 2, 3, 4, 5, 6].map(r => entry(r)) }),
      { maxScores: 4 },
    );
    expect(within(card).getByText('#4')).toBeInTheDocument();
    expect(within(card).queryByText('#5')).toBeNull();
  });

  it('offers "Claim this spot" for every open place, wired to the submit flow', () => {
    const onSubmitScore = vi.fn();
    const lb = makeLb({ rankings: [entry(1)] });
    const { card } = renderCard(lb, { onSubmitScore });

    // 1st is taken, 2nd and 3rd are on offer — an empty podium is the same
    // object as a full one, it just says what's available.
    expect(within(card).getByTestId('arcade-place-1')).toBeInTheDocument();
    fireEvent.click(within(card).getByTestId('arcade-claim-place-2'));
    expect(onSubmitScore).toHaveBeenCalledWith(lb);
    expect(within(card).getByTestId('arcade-claim-place-3')).toBeInTheDocument();
  });

  it('injects the viewer row when they rank below the visible window', () => {
    const viewerEntry = entry(42, { iscored_username: 'me' });
    const { card } = renderCard(
      makeLb({ rankings: [1, 2, 3, 4, 5].map(r => entry(r)) }),
      { maxScores: 5, viewerUsername: 'me', viewerEntry },
    );

    // The last visible slot is given up so the viewer can always find
    // themselves — rank 5 goes, rank 42 arrives.
    expect(within(card).getByText('#42')).toBeInTheDocument();
    expect(within(card).queryByText('#5')).toBeNull();
  });

  it('does not inject the viewer row when they are already visible', () => {
    const rankings = [entry(1, { iscored_username: 'me' }), entry(2), entry(3)];
    const { card } = renderCard(makeLb({ rankings }), {
      maxScores: 5,
      viewerUsername: 'me',
      viewerEntry: entry(1, { iscored_username: 'me' }),
    });
    expect(within(card).getAllByText('me')).toHaveLength(1);
  });

  it('marks a verified score with the admin badge', () => {
    const { card } = renderCard(makeLb({ rankings: [entry(1, { verified: true }), entry(4)] }));
    expect(within(card).getAllByLabelText('Verified score')).toHaveLength(1);
  });

  it('shows the lock when the game is completed', () => {
    const { card } = renderCard(makeLb({ gameStatus: 'COMPLETED' }));
    expect(within(card).getByLabelText('Locked')).toBeInTheDocument();
  });

  it('counts PLAYERS in the footer, not scores, and links the full leaderboard', () => {
    const { card } = renderCard(makeLb({ rankings: [entry(1), entry(2)] }));
    expect(within(card).getByText('2 players')).toBeInTheDocument();
    expect(within(card).getByText(/Full Leaderboard/).getAttribute('href'))
      .toBe('/test-room/games/Medieval%20Madness');
  });
});

/**
 * The "Game Art Header" toggle (v2.115.0, owner ask). The card may lose its
 * ART; it may never lose its NAME — which is the half a screenshot won't catch
 * on a card whose art was the thing being looked at.
 */
describe('ArcadeCard — game art header toggle', () => {
  it('renders the art region as usual when the header is on', () => {
    const { card } = renderCard(makeLb({ imageUrl: 'https://cdn/mm.png' }), { gameHeaderEnabled: true });
    const art = within(card).getByTestId('arcade-art');
    expect(art.querySelector('img')!.getAttribute('src')).toBe('https://cdn/mm.png');
    expect(within(art).getByText('Medieval Madness')).toBeInTheDocument();
  });

  it('drops the art but keeps title, chip and countdown when the header is off', () => {
    const { card } = renderCard(
      makeLb({ imageUrl: 'https://cdn/mm.png', nextMaintenanceAt: new Date(Date.now() + 2 * 3600_000).toISOString() }),
      { gameHeaderEnabled: false },
    );
    const art = within(card).getByTestId('arcade-art');

    // No art image, no "No image" placeholder standing in for one, and no
    // fixed-height art panel left behind.
    expect(art.querySelector('img')).toBeNull();
    expect(within(card).queryByText('No image')).toBeNull();
    expect(art.className).not.toMatch(/h-\[176px\]/);

    // The card still says what it is.
    expect(within(art).getByText('Medieval Madness')).toBeInTheDocument();
    expect(within(art).getByTestId('arcade-chip')).toHaveTextContent('DG');
    expect(within(card).getByText(/\d+[hm]/)).toBeInTheDocument();
  });

  it('hides the identifier art too, not just the background', () => {
    const { card } = renderCard(
      makeLb({ logoStyleId: 'style-7', imageUrl: 'https://cdn/mm.png' }),
      { gameHeaderEnabled: false },
    );
    expect(card.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('ArcadeCard — maintenance countdown', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders a countdown when the game has a next-maintenance time', () => {
    const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString();
    const { card } = renderCard(makeLb({ nextMaintenanceAt: inTwoHours }));
    expect(within(card).getByText(/\d+[hm]/)).toBeInTheDocument();
  });

  it('renders no countdown when the timer is switched off', () => {
    const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString();
    const { card } = renderCard(makeLb({ nextMaintenanceAt: inTwoHours }), { showTimer: false });
    expect(within(card).queryByText(/\d+[hm]/)).toBeNull();
  });
});

describe('ArcadeCard — QR block', () => {
  it('renders no QR when disabled', () => {
    const { container } = renderCard(makeLb());
    expect(container.querySelector('canvas')).toBeNull();
  });

  // Owner call, 2026-08-15: the QR anchors to an EDGE, always horizontally
  // centred. The old corner variants were folded into these two.
  it('renders one QR for each enabled edge', () => {
    for (const qrPosition of ['top-center', 'bottom-center'] as const) {
      const view = renderCard(makeLb(), { qrMode: 'all', qrPosition, qrSize: 40 });
      expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
      view.unmount();
    }
  });

  it('centres the QR horizontally at both edges', () => {
    for (const qrPosition of ['top-center', 'bottom-center'] as const) {
      const view = renderCard(makeLb(), { qrMode: 'all', qrPosition, qrSize: 40 });
      const box = view.container.querySelector('canvas')!.parentElement as HTMLElement;
      expect(box.style.justifyContent).toBe('center');
      view.unmount();
    }
  });

  it('applies the signed offset to the anchored edge — negative overlaps', () => {
    const top = renderCard(makeLb(), { qrMode: 'all', qrPosition: 'top-center', qrSize: 40, qrOffsetPx: -10 });
    const topBox = top.container.querySelector('canvas')!.parentElement as HTMLElement;
    expect(topBox.style.marginBottom).toBe('-10px');
    top.unmount();

    const bottom = renderCard(makeLb(), { qrMode: 'all', qrPosition: 'bottom-center', qrSize: 40, qrOffsetPx: 12 });
    const bottomBox = bottom.container.querySelector('canvas')!.parentElement as HTMLElement;
    expect(bottomBox.style.marginTop).toBe('12px');
    bottom.unmount();
  });
});
