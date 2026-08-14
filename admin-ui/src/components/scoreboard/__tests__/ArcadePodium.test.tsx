import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ArcadePodium from '../ArcadePodium';
import { ARCADE_RANK_TINTS } from '../arcadeNeon';
import type { RankedEntry } from '../../ScoreboardComponents';

/**
 * ArcadePodium — the SWAP SEAM.
 *
 * The owner is sending a replacement podium design, and this file is the
 * contract that replacement has to satisfy. Everything asserted here is
 * behaviour a redesign must keep, not decoration it must copy:
 *
 *   - three places ALWAYS, filled or open
 *   - an open place offers the claim affordance and fires the card's submit
 *   - the verified badge, the expand toggle and the history panel survive
 *   - colours come from CSS TOKENS, never literal hex, so the design lands
 *     theme-correct in all 17 themes and both polarities for free
 *
 * Colour is asserted as "is a var(--…)", deliberately not as a value. A test
 * that pinned the hex would fail the moment a theme did its job.
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

function renderPodium(entries: RankedEntry[], props: Record<string, unknown> = {}) {
  const onClaim = (props.onClaim as (r: number) => void) ?? vi.fn();
  const utils = render(
    <MemoryRouter>
      <ArcadePodium entries={entries} slug="test-room" {...props} onClaim={onClaim} />
    </MemoryRouter>,
  );
  return { ...utils, onClaim };
}

describe('ArcadePodium — three places, always', () => {
  it('renders all three as claim rows when nobody has scored', () => {
    renderPodium([]);
    expect(screen.getByTestId('arcade-claim-place-1')).toBeInTheDocument();
    expect(screen.getByTestId('arcade-claim-place-2')).toBeInTheDocument();
    expect(screen.getByTestId('arcade-claim-place-3')).toBeInTheDocument();
    expect(screen.queryByTestId('arcade-place-1')).toBeNull();
  });

  it('renders a mixed podium — taken places filled, the rest on offer', () => {
    renderPodium([entry(1)]);
    expect(screen.getByTestId('arcade-place-1')).toHaveTextContent('player1');
    expect(screen.getByTestId('arcade-claim-place-2')).toBeInTheDocument();
    expect(screen.getByTestId('arcade-claim-place-3')).toBeInTheDocument();
  });

  it('renders all three filled when the board is full', () => {
    renderPodium([entry(1), entry(2), entry(3)]);
    for (const rank of [1, 2, 3]) {
      expect(screen.getByTestId(`arcade-place-${rank}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('arcade-claim-place-1')).toBeNull();
  });

  it('names a claim row for the PLACE, so a place-label query cannot be satisfied by an empty row', () => {
    renderPodium([]);
    // The filled row's medal carries `aria-label="1st place"`. The empty row
    // says "Claim 1st place" — a superstring, deliberately, so a test asking
    // "does anyone hold first" gets a false rather than a false positive.
    expect(screen.queryByLabelText('1st place')).toBeNull();
    expect(screen.getByLabelText('Claim 1st place')).toBeInTheDocument();
  });

  it('fires the claim callback with the rank that was clicked', () => {
    const onClaim = vi.fn();
    renderPodium([entry(1)], { onClaim });
    fireEvent.click(screen.getByTestId('arcade-claim-place-3'));
    expect(onClaim).toHaveBeenCalledWith(3);
  });
});

describe('ArcadePodium — room-card behaviour', () => {
  it('shows the verified badge on a verified score only', () => {
    renderPodium([entry(1, { verified: true }), entry(2)]);
    expect(screen.getAllByLabelText('Verified score')).toHaveLength(1);
  });

  it('toggles score history from a row that has multiple scores', () => {
    const onTogglePlayer = vi.fn();
    renderPodium([entry(1)], { hasMultiple: () => true, onTogglePlayer });
    fireEvent.click(screen.getByTestId('arcade-place-1'));
    expect(onTogglePlayer).toHaveBeenCalledWith('player1');
  });

  it('does not toggle from a row with only one score', () => {
    const onTogglePlayer = vi.fn();
    renderPodium([entry(1)], { hasMultiple: () => false, onTogglePlayer });
    fireEvent.click(screen.getByTestId('arcade-place-1'));
    expect(onTogglePlayer).not.toHaveBeenCalled();
  });

  it('drops the history panel directly under the expanded row', () => {
    renderPodium([entry(1), entry(2)], {
      hasMultiple: () => true,
      expandedPlayer: 'player1',
      playerHistory: [{ id: 7, score: 999, source: 'tournament', photo_url: null, created_at: '2026-08-01T00:00:00Z' }],
    });
    const panel = screen.getByTestId('arcade-history');
    expect(panel).toHaveTextContent('999');
    expect(screen.getByTestId('arcade-place-1').parentElement).toContainElement(panel);
  });

  it('says so when an expanded player has no further scores', () => {
    renderPodium([entry(1)], { hasMultiple: () => true, expandedPlayer: 'player1', playerHistory: [] });
    expect(screen.getByText('No additional scores.')).toBeInTheDocument();
  });

  it('marks the viewer’s own row even when it holds a medal place', () => {
    renderPodium([entry(1, { iscored_username: 'me' })], { viewerUsername: 'ME' });
    // "this is me" outranks the medal tint on a board someone opened to find
    // themselves on — the row wears the `you` wash, not gold.
    const row = screen.getByTestId('arcade-place-1');
    expect(row.getAttribute('style')).toContain('--sb-row-you-bg');
  });
});

describe('ArcadePodium — colours are tokens', () => {
  it('drives every rank tint from a CSS variable, never a literal', () => {
    for (const rank of [1, 2, 3]) {
      const tint = ARCADE_RANK_TINTS[rank]!;
      expect(tint.bg).toMatch(/^var\(--sb-row-/);
      expect(tint.border).toMatch(/^var\(--sb-row-/);
      // Medal colour is a Tailwind token class, which resolves to a themed
      // custom property — not a hex either.
      expect(tint.medal).toMatch(/^text-(neon|medal)-/);
    }
  });

  it('renders rank tints and the claim arrow as var() references', () => {
    renderPodium([entry(1)]);
    expect(screen.getByTestId('arcade-place-1').getAttribute('style')).toContain('var(--sb-row-gold-bg)');
    const claim = screen.getByTestId('arcade-claim-place-2');
    expect(claim.getAttribute('style')).toContain('var(--sb-row-silver-border)');
    // The arrow reads the card's own neon, inherited — so a swapped podium
    // stays in the frame's colour without knowing which colour that is.
    expect(claim.innerHTML).toContain('var(--arc-neon)');
  });
});
