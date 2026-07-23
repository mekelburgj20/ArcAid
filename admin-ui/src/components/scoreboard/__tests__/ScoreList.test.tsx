import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ScoreList from '../ScoreList';
import type { RankedEntry } from '../../ScoreboardComponents';

// s20 — the expandable-row keyboard operability regression test. Rendered
// without a `slug` prop so the name cell falls back to a plain <span> (the
// PlayerNameLink path needs a Router + PlayerQuickViewProvider) — the row's
// own keyboard handling doesn't depend on either.
const entries: RankedEntry[] = [
  { rank: 1, discord_user_id: 'd1', iscored_username: 'alice', score: 1000 },
];

describe('ScoreList keyboard expand', () => {
  it('Enter toggles the row when it has multiple scores', () => {
    const onTogglePlayer = vi.fn();

    render(
      <ScoreList
        entries={entries}
        hasMultiple={() => true}
        expandedPlayer={null}
        onTogglePlayer={onTogglePlayer}
      />,
    );

    const row = screen.getByRole('button');
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(onTogglePlayer).toHaveBeenCalledWith('alice');
  });

  it('is not keyboard-focusable when the row cannot expand', () => {
    render(
      <ScoreList
        entries={entries}
        hasMultiple={() => false}
        expandedPlayer={null}
        onTogglePlayer={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
