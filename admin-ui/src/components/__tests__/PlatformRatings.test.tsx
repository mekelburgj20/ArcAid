import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PlatformRatings from '../PlatformRatings';
import type { RatingInfo } from '../RatedByList';

/**
 * C3 - the platform axis of a rating: one row per offered engine plus every
 * platform that already has ratings.
 */

const base: RatingInfo = { avg_rating: 0, rating_count: 0, user_rating: null };

describe('PlatformRatings (C3)', () => {
  it('renders rows from engines + by_platform, expanded for a guest once any exist', () => {
    const info: RatingInfo = {
      ...base,
      avg_rating: 4,
      rating_count: 2,
      by_platform: [{ platform: 'fx', avg_rating: 4.2, rating_count: 3, user_rating: null }],
    };
    render(<PlatformRatings info={info} engines={['vpx', 'real']} loggedIn={false} />);
    expect(screen.getByTestId('platform-ratings')).toBeInTheDocument();
    expect(screen.getByText('By platform')).toBeInTheDocument();
    // The offered engines first, then any other rated platform.
    const rows = screen.getAllByRole('listitem');
    expect(rows.map(r => r.getAttribute('data-testid'))).toEqual([
      'platform-rating-vpx', 'platform-rating-real', 'platform-rating-fx',
    ]);
    const fx = screen.getByTestId('platform-rating-fx');
    expect(within(fx).getByText('FX')).toBeInTheDocument();
    expect(within(fx).getByText('4.2 (3)')).toBeInTheDocument();
    // A guest's stars are read-only.
    expect(screen.queryByRole('button', { name: /^Rate \d star/ })).not.toBeInTheDocument();
  });

  it('clicking a star calls onRate(platform, n) and shows the viewer rating', () => {
    const onRate = vi.fn();
    const info: RatingInfo = {
      ...base,
      user_ratings: { '': 3, vpx: 4 },
      by_platform: [{ platform: 'vpx', avg_rating: 4, rating_count: 1, user_rating: 4 }],
    };
    render(<PlatformRatings info={info} engines={['vpx', 'real']} loggedIn onRate={onRate} />);
    const vpx = screen.getByTestId('platform-rating-vpx');
    const vpxStars = within(vpx).getAllByRole('button', { name: /^Rate \d star/ });
    expect(vpxStars.filter(el => el.className.includes('text-neon-amber'))).toHaveLength(4);

    const real = screen.getByTestId('platform-rating-real');
    fireEvent.click(within(real).getAllByRole('button', { name: /^Rate \d star/ })[1]!);
    expect(onRate).toHaveBeenCalledWith('real', 2);
  });

  it('renders nothing for a guest when no platform has a rating', () => {
    render(<PlatformRatings info={{ ...base, by_platform: [] }} engines={['vpx']} loggedIn={false} />);
    expect(screen.queryByTestId('platform-ratings')).not.toBeInTheDocument();
  });

  it('shows a collapsed "Rate by platform" toggle to a logged-in viewer when none exist', () => {
    const onRate = vi.fn();
    render(<PlatformRatings info={base} engines={['vpx', 'real']} loggedIn onRate={onRate} />);
    const toggle = screen.getByRole('button', { name: /Rate by platform/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('platform-rating-vpx')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByTestId('platform-rating-vpx')).toBeInTheDocument();
    expect(screen.getByTestId('platform-rating-real')).toBeInTheDocument();
  });
});
