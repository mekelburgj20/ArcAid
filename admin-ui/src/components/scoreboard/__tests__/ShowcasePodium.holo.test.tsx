import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ShowcasePodium from '../ShowcasePodium';
import { SHOWCASE_THEMES } from '../../../lib/scoreboardThemes';
import type { RankedEntry } from '../../ScoreboardComponents';

/**
 * Holo Steps podium (owner design handoff 2026-08-13,
 * tmp/design_handoff_podium_restyle). Locks the structural spec:
 * three risers always render (floor, not ceiling), empty slots go unlit,
 * the scanline shimmer is GOLD-ONLY (owner rejected it on silver/bronze),
 * and the variant dispatch — holo-steps is the default for showcase rooms,
 * with pyramid/chip still reachable when a theme pins them.
 */

const entry = (rank: number, name: string, score: number, extra: Partial<RankedEntry> = {}): RankedEntry => ({
  rank,
  iscored_username: name,
  score,
  timestamp: '2026-08-13T00:00:00Z',
  ...extra,
} as RankedEntry);

const holoTheme = { ...SHOWCASE_THEMES['glass-deck']!, podiumVariant: 'holo-steps' as const };

function renderPodium(entries: RankedEntry[], props: Partial<Parameters<typeof ShowcasePodium>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ShowcasePodium entries={entries} theme={holoTheme} slug="rtx" {...props} />
    </MemoryRouter>,
  );
}

describe('ShowcasePodium — holo-steps variant', () => {
  it('renders all three risers even when the podium is partly empty', () => {
    renderPodium([entry(1, 'mekelburgj', 46255563)]);
    expect(screen.getByTestId('holo-riser-1')).toBeInTheDocument();
    expect(screen.getByTestId('holo-riser-2')).toBeInTheDocument();
    expect(screen.getByTestId('holo-riser-3')).toBeInTheDocument();
  });

  it('marks occupied risers animated and leaves empty risers unlit', () => {
    renderPodium([entry(1, 'mekelburgj', 46255563), entry(2, 'RetroTechX', 17277285)]);
    expect(screen.getByTestId('holo-riser-1').className).toContain('hs-riser');
    expect(screen.getByTestId('holo-riser-2').className).toContain('hs-riser');
    expect(screen.getByTestId('holo-riser-3').className).not.toContain('hs-riser');
  });

  it('renders NO scanline overlay on any riser (removed 2026-08-13 — aliased into CRT bands at fractional display scaling)', () => {
    const { container } = renderPodium([
      entry(1, 'mekelburgj', 46255563),
      entry(2, 'RetroTechX', 17277285),
      entry(3, 'PinWizard', 9841002),
    ]);
    expect(container.querySelectorAll('.hs-scan')).toHaveLength(0);
  });

  it('shows names, scores and the verified badge above the risers', () => {
    renderPodium([entry(1, 'mekelburgj', 46255563, { verified: true })]);
    expect(screen.getByText('mekelburgj')).toBeInTheDocument();
    expect(screen.getByLabelText('Verified score')).toBeInTheDocument();
  });

  it('toggles the expanded history from the name/score stack', () => {
    const onToggle = vi.fn();
    renderPodium([entry(1, 'mekelburgj', 46255563)], {
      hasMultiple: () => true,
      onTogglePlayer: onToggle,
    });
    // The click handler is on the name/score stack (the nearest DIV — the name
    // itself sits in a span/link whose own onClick stops propagation).
    fireEvent.click(screen.getByText('mekelburgj').closest('div')!);
    expect(onToggle).toHaveBeenCalledWith('mekelburgj');
  });

  it('renders the expanded history panel under the steps when a podium player is expanded', () => {
    renderPodium([entry(1, 'mekelburgj', 46255563)], {
      hasMultiple: () => true,
      expandedPlayer: 'mekelburgj',
      playerHistory: [],
      historyLoading: false,
    });
    expect(screen.getByText('No additional scores.')).toBeInTheDocument();
  });

  it('still dispatches pyramid and chip when a theme pins them', () => {
    const { container: pyramid } = render(
      <MemoryRouter>
        <ShowcasePodium entries={[]} theme={{ ...holoTheme, podiumVariant: 'pyramid' }} />
      </MemoryRouter>,
    );
    expect(pyramid.querySelector('[data-testid="holo-riser-1"]')).toBeNull();

    const { container: chip } = render(
      <MemoryRouter>
        <ShowcasePodium entries={[]} theme={{ ...holoTheme, podiumVariant: 'chip' }} />
      </MemoryRouter>,
    );
    expect(chip.querySelector('[data-testid="holo-riser-1"]')).toBeNull();
  });
});
