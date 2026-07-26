import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ArcaidLogoAnimated from '../ArcaidLogoAnimated';

// Logo refresh (v2.45.0) — "Delta House Chrome". The wordmark is rendered as
// four stacked, aria-hidden decorative text layers (pink/cyan glitch-ghosts +
// the chrome layer) so a screen reader isn't read "ArcAid" four times; the
// single accessible name comes from the wrapping role="img" aria-label.
describe('ArcaidLogoAnimated', () => {
  it('renders one accessible "ArcAid" image label, no crash, honors maxWidth', () => {
    render(<ArcaidLogoAnimated maxWidth={640} />);

    const img = screen.getByRole('img', { name: 'ArcAid' });
    expect(img).toBeInTheDocument();

    // The four duplicate text layers exist in the DOM (for the visual glitch
    // effect) but are aria-hidden — only one accessible node should match.
    expect(screen.getAllByRole('img', { name: 'ArcAid' })).toHaveLength(1);
  });

  it('defaults maxWidth to a hero-sized value when not provided', () => {
    const { container } = render(<ArcaidLogoAnimated />);
    const wrap = container.querySelector('.arcaid-logo-wrap') as HTMLElement;
    expect(wrap).toBeInTheDocument();
    expect(wrap.style.maxWidth).toBe('720px');
  });
});
