import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import WhoLedChart from '../WhoLedChart';
import { makeRecap } from './recapFixture';

describe('WhoLedChart', () => {
  it('draws one segment per step and one dot per lead change, the winner in gold', () => {
    const r = makeRecap();
    const { container } = render(<WhoLedChart steps={r.lead_steps} changes={r.lead_changes} players={r.players} run={r.run} />);
    const segs = screen.getAllByTestId('lead-segment');
    expect(segs).toHaveLength(r.lead_steps.length);
    expect(screen.getAllByTestId('lead-dot')).toHaveLength(r.lead_changes.length);
    // Ann (winner) segments are gold; Bob's is not.
    expect(segs[1]!.getAttribute('stroke')).toBe('var(--color-neon-amber)');
    expect(segs[0]!.getAttribute('stroke')).toBe('var(--color-neon-cyan)');
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|oklch\(/);
  });

  it('labels each dot for a screen reader', () => {
    const r = makeRecap();
    render(<WhoLedChart steps={r.lead_steps} changes={r.lead_changes} players={r.players} run={r.run} />);
    expect(screen.getAllByRole('img').some(el => /Ann A takes first with 20\.0M/.test(el.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('still draws a single step and nothing for none', () => {
    const r = makeRecap();
    const one = render(<WhoLedChart steps={[r.lead_steps[0]!]} changes={[r.lead_changes[0]!]} players={r.players} run={r.run} />);
    expect(one.getAllByTestId('lead-segment')).toHaveLength(1);
    one.unmount();
    const none = render(<WhoLedChart steps={[]} changes={[]} players={r.players} run={r.run} />);
    expect(none.container.innerHTML).toBe('');
  });
});
