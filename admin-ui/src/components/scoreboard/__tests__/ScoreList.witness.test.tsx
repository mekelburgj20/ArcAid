import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ScoreList from '../ScoreList';
import type { RankedEntry } from '../../ScoreboardComponents';

/**
 * v2.190.0 (W22) — a scoreboard card row marks a witness-FLAGGED score (an
 * event round under 'flag' mode, where the score still ranks). Cards are tight,
 * so a verified or unwitnessed score shows nothing extra.
 */
const verdict = (status: 'verified' | 'flagged' | 'unwitnessed') => ({
  status, method: status === 'unwitnessed' ? null : 'session' as const,
  launchTs: null, exitTs: null, durationSec: null, table: null,
});

const entries: RankedEntry[] = [
  { rank: 1, discord_user_id: 'd1', iscored_username: 'tomato', score: 54692760, witness: verdict('flagged') },
  { rank: 2, discord_user_id: 'd2', iscored_username: 'bee', score: 700, witness: verdict('verified') },
  { rank: 3, discord_user_id: 'd3', iscored_username: 'cat', score: 600, witness: verdict('unwitnessed') },
  { rank: 4, discord_user_id: 'd4', iscored_username: 'dog', score: 500 },
];

describe('ScoreList witness mark', () => {
  it('marks only the flagged row', () => {
    render(
      <ScoreList
        entries={entries}
        hasMultiple={() => false}
        expandedPlayer={null}
        onTogglePlayer={() => {}}
      />,
    );
    const marks = screen.getAllByTestId('witness-flag-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute('title', 'Witness: this table was launched before the round opened');
  });
});
