import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ScoreHistoryChart from '../ScoreHistoryChart';

/**
 * v2.157.0 — the score-over-time chart behind a click on a Global board score.
 */

const pt = (id: string, score: number, date: string) => ({ id, score, submitted_at: date });

describe('ScoreHistoryChart', () => {
  it('draws one dot per score and highlights exactly the best one', () => {
    render(<ScoreHistoryChart scores={[
      pt('a', 500, '2026-09-01T00:00:00.000Z'),
      pt('b', 1_250_000, '2026-09-05T00:00:00.000Z'),
      pt('c', 800, '2026-09-03T00:00:00.000Z'),
    ]} />);
    const chart = screen.getByTestId('score-history-chart');
    expect(within(chart).getAllByTestId('chart-point')).toHaveLength(2);
    const best = within(chart).getAllByTestId('chart-point-best');
    expect(best).toHaveLength(1);
    expect(best[0]!).toHaveAttribute('aria-label', expect.stringContaining('1,250,000'));
    expect(best[0]!).toHaveAttribute('aria-label', expect.stringContaining('(best)'));
    expect(screen.getByTestId('best-line')).toBeInTheDocument();
    expect(screen.queryByTestId('single-point-caption')).not.toBeInTheDocument();
  });

  it('abbreviates y-axis ticks instead of printing every digit', () => {
    const { container } = render(<ScoreHistoryChart scores={[
      pt('a', 1_000_000, '2026-09-01T00:00:00.000Z'),
      pt('b', 3_000_000, '2026-09-05T00:00:00.000Z'),
    ]} />);
    const labels = Array.from(container.querySelectorAll('text')).map(t => t.textContent);
    expect(labels.some(l => /^\d+(\.\d)?M$/.test(l ?? ''))).toBe(true);
    expect(labels).not.toContain('3,000,000');
  });

  it('shows the dot and a caption for a single score rather than an empty chart', () => {
    render(<ScoreHistoryChart scores={[pt('a', 4200, '2026-09-01T00:00:00.000Z')]} />);
    expect(screen.getAllByTestId('chart-point-best')).toHaveLength(1);
    expect(screen.getByTestId('single-point-caption')).toHaveTextContent('Only one score so far.');
  });

  it('keeps every point when several share a timestamp', () => {
    render(<ScoreHistoryChart scores={[
      pt('a', 100, '2026-09-01T00:00:00.000Z'),
      pt('b', 200, '2026-09-01T00:00:00.000Z'),
      pt('c', 300, '2026-09-01T00:00:00.000Z'),
    ]} />);
    expect(screen.getAllByTestId('chart-point')).toHaveLength(2);
    expect(screen.getAllByTestId('chart-point-best')).toHaveLength(1);
  });

  it('shows a tooltip with the formatted score and date on focus', () => {
    render(<ScoreHistoryChart scores={[
      pt('a', 500, '2026-09-01T00:00:00.000Z'),
      pt('b', 12_345, '2026-09-05T00:00:00.000Z'),
    ]} />);
    fireEvent.focus(screen.getByTestId('chart-point-best'));
    expect(screen.getByRole('status')).toHaveTextContent('12,345');
  });
});
