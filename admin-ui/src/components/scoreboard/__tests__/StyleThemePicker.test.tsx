import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StyleThemePicker from '../StyleThemePicker';
import { LOOK_DEFINITIONS } from '../../../lib/scoreboardLooks';
import { DEFAULT_SHOWCASE_THEME } from '../../../lib/scoreboardThemes';

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

  // ── Style-system revamp P1: Looks apply a COMPLETE bundle ──

  it('applies the whole bundle, not just the style key', () => {
    const onChange = renderPicker({});
    fireEvent.click(screen.getByText('Arcade').closest('button')!);

    const arcade = LOOK_DEFINITIONS.find(l => l.id === 'arcade')!;
    for (const [key, value] of Object.entries(arcade.settings)) {
      expect(onChange).toHaveBeenCalledWith(key, value);
    }
    // The specific bug: picking a style used to leave MIN_SCORES on its
    // default of 20, so every card reserved twenty rows of height.
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_MIN_SCORES', '10');
  });

  it('applies the showcase theme as part of the Showcase bundle', () => {
    const onChange = renderPicker({});
    fireEvent.click(screen.getByText('Showcase').closest('button')!);
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_STYLE', 'showcase');
    expect(onChange).toHaveBeenCalledWith('SCOREBOARD_THEME', DEFAULT_SHOWCASE_THEME);
  });

  it('never writes room identity or policy keys when a Look is picked', () => {
    const onChange = renderPicker({ SCOREBOARD_STYLE: 'arcade' });
    fireEvent.click(screen.getByText('Minimal').closest('button')!);

    const written = onChange.mock.calls.map(([key]) => key);
    for (const forbidden of [
      'SCOREBOARD_TITLE', 'LOGO_URL', 'SCOREBOARD_BG_URL',
      'SCOREBOARD_GAME_TITLE_STYLE', 'SCOREBOARD_QR_MODE', 'SCOREBOARD_MOBILE_SCALE',
    ]) {
      expect(written).not.toContain(forbidden);
    }
  });

  it('does NOT call a stock pre-Looks room "Customised"', () => {
    // Every room shipped before Looks stores a style and nothing else.
    renderPicker({ SCOREBOARD_STYLE: 'arcade' });
    expect(screen.queryByText(/customised/i)).not.toBeInTheDocument();
  });

  it('flags a room that stored a bundle key with a different value', () => {
    renderPicker({ SCOREBOARD_STYLE: 'arcade', SCOREBOARD_CARD_SPACING: '48' });
    expect(screen.getByText(/customised/i)).toBeInTheDocument();
    // Still highlights the family it is built on — one changed number does
    // not move the room off Arcade.
    expect(screen.getByText('Arcade').closest('button')!.className).toMatch(/bg-neon-cyan\/10/);
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
