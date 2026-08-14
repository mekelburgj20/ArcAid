import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ScoreList from '../ScoreList';
import type { RankedEntry } from '../../ScoreboardComponents';

/**
 * v2.109.0 (score-gesture-photos) — gesture model v2.
 *
 * Replaces the v2.108.0 own-row-click-opens-popup exception (formerly tested
 * in ScoreList.ownRow.test.tsx, now superseded): EVERY row follows the same
 * two-step gesture, not just the viewer's own. ScoreList stands in for all
 * six card families here — they share the exact same `resolveRowClick` shape
 * from `lib/scoreGesture.ts`, so a divergence would be a copy that skipped
 * the helper, not a different rule.
 */

const MULTI: RankedEntry = {
  rank: 1, discord_user_id: 'disc-ada', iscored_username: 'alice', score: 1000,
};
const SINGLE: RankedEntry = {
  rank: 2, discord_user_id: 'disc-ben', iscored_username: 'bob', score: 900,
};

describe('ScoreList gesture v2', () => {
  it('unexpanded multi-score row: click EXPANDS, does not open the popup', () => {
    const onTogglePlayer = vi.fn();
    const onOpenQuickView = vi.fn();

    render(
      <ScoreList
        entries={[MULTI]}
        hasMultiple={() => true}
        expandedPlayer={null}
        onTogglePlayer={onTogglePlayer}
        onOpenQuickView={onOpenQuickView}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onTogglePlayer).toHaveBeenCalledWith('alice');
    expect(onOpenQuickView).not.toHaveBeenCalled();
  });

  it('expanded multi-score row: click on the row body OPENS the popup, not a re-toggle', () => {
    const onTogglePlayer = vi.fn();
    const onOpenQuickView = vi.fn();

    render(
      <ScoreList
        entries={[MULTI]}
        hasMultiple={() => true}
        expandedPlayer="alice"
        playerHistory={[]}
        onTogglePlayer={onTogglePlayer}
        onOpenQuickView={onOpenQuickView}
      />,
    );

    // The row body is the accessible "button" named for its content (the
    // collapse control below has its own explicit label and is a separate
    // element).
    fireEvent.click(screen.getByRole('button', { name: /alice/i }));
    expect(onOpenQuickView).toHaveBeenCalledTimes(1);
    expect(onTogglePlayer).not.toHaveBeenCalled();
  });

  it('single-score row: click opens the popup directly', () => {
    const onOpenQuickView = vi.fn();

    render(
      <ScoreList
        entries={[SINGLE]}
        hasMultiple={() => false}
        expandedPlayer={null}
        onTogglePlayer={vi.fn()}
        onOpenQuickView={onOpenQuickView}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onOpenQuickView).toHaveBeenCalledTimes(1);
  });

  it('collapse happens ONLY via the minus/chevron icon, never the row body', () => {
    const onTogglePlayer = vi.fn();
    const onOpenQuickView = vi.fn();

    render(
      <ScoreList
        entries={[MULTI]}
        hasMultiple={() => true}
        expandedPlayer="alice"
        playerHistory={[]}
        onTogglePlayer={onTogglePlayer}
        onOpenQuickView={onOpenQuickView}
      />,
    );

    fireEvent.click(screen.getByLabelText('Hide score history'));
    expect(onTogglePlayer).toHaveBeenCalledWith('alice');
    expect(onOpenQuickView).not.toHaveBeenCalled();
  });

  it('a nested expanded history row also opens the popup on click', () => {
    const onOpenQuickView = vi.fn();

    render(
      <ScoreList
        entries={[MULTI]}
        hasMultiple={() => true}
        expandedPlayer="alice"
        playerHistory={[
          { id: 1, score: 500, source: 'tournament', photo_url: null, created_at: '2026-08-01T00:00:00Z' },
        ]}
        onTogglePlayer={vi.fn()}
        onOpenQuickView={onOpenQuickView}
      />,
    );

    fireEvent.click(screen.getByText('500'));
    expect(onOpenQuickView).toHaveBeenCalledTimes(1);
  });

  it('single-score row is inert when the popup behaviour is not wired at all', () => {
    render(
      <ScoreList
        entries={[SINGLE]}
        hasMultiple={() => false}
        expandedPlayer={null}
        onTogglePlayer={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('unexpanded multi-score row still expands when the popup behaviour is not wired', () => {
    const onTogglePlayer = vi.fn();
    render(
      <ScoreList
        entries={[MULTI]}
        hasMultiple={() => true}
        expandedPlayer={null}
        onTogglePlayer={onTogglePlayer}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onTogglePlayer).toHaveBeenCalledWith('alice');
  });

  it('collapsing still works via the icon even when the popup behaviour is not wired', () => {
    const onTogglePlayer = vi.fn();
    render(
      <ScoreList
        entries={[MULTI]}
        hasMultiple={() => true}
        expandedPlayer="alice"
        playerHistory={[]}
        onTogglePlayer={onTogglePlayer}
      />,
    );

    fireEvent.click(screen.getByLabelText('Hide score history'));
    expect(onTogglePlayer).toHaveBeenCalledWith('alice');
  });
});
