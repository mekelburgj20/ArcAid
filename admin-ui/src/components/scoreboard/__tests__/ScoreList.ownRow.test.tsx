import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ScoreList from '../ScoreList';
import type { RankedEntry } from '../../ScoreboardComponents';

/**
 * v2.108.0 (F3) — own-row click opens the game quick popup.
 *
 * The load-bearing half of this contract is the NEGATIVE one: every row that
 * is not the viewer's own must behave exactly as it did in v2.107 (inline
 * expand when it has multiple scores, inert otherwise). ScoreList stands in
 * for all six card families here — they share the same `ownRowOpener` +
 * `openOwn ?? (canExpand ? toggle : undefined)` shape, so a divergence would
 * be a copy that skipped the helper, not a different rule.
 */

const OWN: RankedEntry = {
  rank: 1, discord_user_id: 'disc-ada', iscored_username: 'alice', score: 1000,
  submitted_by_user_id: 'disc-ada', history_id: 11, source: 'tournament',
};
const OTHER: RankedEntry = {
  rank: 2, discord_user_id: 'disc-ben', iscored_username: 'bob', score: 900,
  submitted_by_user_id: 'disc-ben', history_id: 12, source: 'tournament',
};

describe('ScoreList own-row click', () => {
  it('opens the popup instead of expanding, on the viewer\'s own row', () => {
    const open = vi.fn();
    const onTogglePlayer = vi.fn();

    render(
      <ScoreList
        entries={[OWN]}
        hasMultiple={() => true}
        expandedPlayer={null}
        onTogglePlayer={onTogglePlayer}
        ownRow={{ viewerDiscordId: 'disc-ada', open }}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(onTogglePlayer).not.toHaveBeenCalled();
  });

  it('leaves another player\'s multi-score row on the inline expand', () => {
    const open = vi.fn();
    const onTogglePlayer = vi.fn();

    render(
      <ScoreList
        entries={[OTHER]}
        hasMultiple={() => true}
        expandedPlayer={null}
        onTogglePlayer={onTogglePlayer}
        ownRow={{ viewerDiscordId: 'disc-ada', open }}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onTogglePlayer).toHaveBeenCalledWith('bob');
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves another player\'s single-score row inert', () => {
    render(
      <ScoreList
        entries={[OTHER]}
        hasMultiple={() => false}
        expandedPlayer={null}
        onTogglePlayer={vi.fn()}
        ownRow={{ viewerDiscordId: 'disc-ada', open: vi.fn() }}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('makes a SINGLE-score own row clickable — the point of the feature', () => {
    const open = vi.fn();
    render(
      <ScoreList
        entries={[OWN]}
        hasMultiple={() => false}
        expandedPlayer={null}
        onTogglePlayer={vi.fn()}
        ownRow={{ viewerDiscordId: 'disc-ada', open }}
      />,
    );

    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('changes nothing at all when the behaviour is not wired', () => {
    const onTogglePlayer = vi.fn();
    render(
      <ScoreList
        entries={[OWN]}
        hasMultiple={() => true}
        expandedPlayer={null}
        onTogglePlayer={onTogglePlayer}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onTogglePlayer).toHaveBeenCalledWith('alice');
  });
});
