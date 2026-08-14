import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StyleThemePicker from '../StyleThemePicker';

/**
 * Style-system revamp P0 (honesty fix, item 2). Locks:
 *   - an unset SCOREBOARD_STYLE renders no tile as active and shows the
 *     legacy-system amber notice (was: falling back to 'banner' for display
 *     purposes made the Banner tile look falsely selected)
 *   - once SCOREBOARD_STYLE is set, the matching tile is active and the
 *     notice is gone
 *   - the P0 item 11 context-aware hides: rankings position control
 *     disappears (replaced by a note) when SCOREBOARD_RANKINGS_STYLE is
 *     'ticker'
 */

function renderPicker(settings: Record<string, string>, onChange = vi.fn()) {
  render(<StyleThemePicker settings={settings} onChange={onChange} />);
  return onChange;
}

describe('StyleThemePicker', () => {
  it('shows no active tile and the legacy-system notice when SCOREBOARD_STYLE is unset', () => {
    renderPicker({});

    expect(screen.getByText(/legacy card system/i)).toBeInTheDocument();

    const arcadeTile = screen.getByText('Arcade').closest('button')!;
    const bannerTile = screen.getByText('Banner').closest('button')!;
    const showcaseTile = screen.getByText('Showcase').closest('button')!;
    const minimalTile = screen.getByText('Minimal').closest('button')!;
    // The active-tile styling is the 'bg-neon-cyan/10' fill (present only on
    // the selected tile) — the base class list also carries a hover-only
    // 'hover:border-neon-cyan/30' on every tile, so match the fill, not the
    // border color alone.
    expect(arcadeTile.className).not.toMatch(/bg-neon-cyan\/10/);
    expect(bannerTile.className).not.toMatch(/bg-neon-cyan\/10/);
    expect(showcaseTile.className).not.toMatch(/bg-neon-cyan\/10/);
    expect(minimalTile.className).not.toMatch(/bg-neon-cyan\/10/);
  });

  it('marks the matching tile active and hides the notice once a style is set', () => {
    renderPicker({ SCOREBOARD_STYLE: 'banner' });

    expect(screen.queryByText(/legacy card system/i)).not.toBeInTheDocument();
    const bannerTile = screen.getByText('Banner').closest('button')!;
    expect(bannerTile.className).toMatch(/bg-neon-cyan\/10/);
  });

  it('picking a tile from the unset state fires onChange with the picked style', () => {
    const onChange = renderPicker({});
    fireEvent.click(screen.getByText('Showcase').closest('button')!);
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_STYLE', 'showcase');
  });

  // ── Style-system revamp Phase 1: the Arcade family ──

  it('offers Arcade FIRST — it is the flagship and the seeded default', () => {
    renderPicker({});
    // The Advanced toggle button also carries a .font-display span — exclude
    // it; this test pins style-tile order only.
    const labels = Array.from(document.querySelectorAll('button .font-display'))
      .map(el => el.textContent)
      .filter(t => t !== 'Advanced');
    expect(labels).toEqual(['Arcade', 'Banner', 'Showcase', 'Minimal']);
  });

  it('marks the Arcade tile active for an arcade room', () => {
    renderPicker({ SCOREBOARD_STYLE: 'arcade' });

    expect(screen.queryByText(/legacy card system/i)).not.toBeInTheDocument();
    expect(screen.getByText('Arcade').closest('button')!.className).toMatch(/bg-neon-cyan\/10/);
    expect(screen.getByText('Banner').closest('button')!.className).not.toMatch(/bg-neon-cyan\/10/);
  });

  it('picking Arcade fires onChange with the arcade style and no showcase theme', () => {
    const onChange = renderPicker({});
    fireEvent.click(screen.getByText('Arcade').closest('button')!);
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_STYLE', 'arcade');
    // Arcade has no theme variants of its own — the showcase-theme default
    // must not tag along and quietly restyle a later switch to Showcase.
    expect(onChange).not.toHaveBeenCalledWith('SCOREBOARD_THEME', expect.anything());
  });

  it('hides the rankings-position control and shows a note when rankings style is ticker', () => {
    renderPicker({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_RANKINGS_STYLE: 'ticker' });
    fireEvent.click(screen.getByText('Advanced'));

    expect(screen.queryByText('Rankings position')).not.toBeInTheDocument();
    expect(screen.getByText(/Ticker pins to the top/)).toBeInTheDocument();
  });

  it('shows the rankings-position control when rankings style is not ticker', () => {
    renderPicker({ SCOREBOARD_STYLE: 'banner' });
    fireEvent.click(screen.getByText('Advanced'));

    expect(screen.getByText('Rankings position')).toBeInTheDocument();
    expect(screen.queryByText(/Ticker pins to the top/)).not.toBeInTheDocument();
  });
});
