import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RatingBadge from '../RatingBadge';

/**
 * A14.2 - the badge is a plain span without `to` and a link to the game page's
 * ratings with it; the testid stays on the outer element either way.
 */
describe('RatingBadge', () => {
  it('renders a span, not a link, without `to`', () => {
    render(<RatingBadge avg={4.25} count={3} />);
    const badge = screen.getByTestId('rating-badge');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveAttribute('title', 'Average rating 4.3 from 3 players');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a link to `to` with the title suffix', () => {
    render(
      <MemoryRouter>
        <RatingBadge avg={4} count={1} to="/rtx/games/Cyclone#ratings" />
      </MemoryRouter>,
    );
    const badge = screen.getByTestId('rating-badge');
    expect(badge.tagName).toBe('A');
    expect(badge).toHaveAttribute('href', '/rtx/games/Cyclone#ratings');
    expect(badge).toHaveAttribute('title', 'Average rating 4.0 from 1 player - see the ratings');
    expect(badge).toHaveTextContent('4.0');
    expect(badge).toHaveTextContent('(1)');
  });

  it('renders nothing when nobody has rated, link or not', () => {
    const { container } = render(
      <MemoryRouter>
        <RatingBadge avg={0} count={0} to="/games/g1#ratings" />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
