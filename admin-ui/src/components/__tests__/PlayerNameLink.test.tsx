import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PlayerNameLink from '../PlayerNameLink';

// Regression (v2.13.16 black-screen bug): the player-name link is reused on
// admin pages (Settings live preview, admin Leaderboard) that deliberately do
// NOT mount PlayerQuickViewProvider. Pre-fix, usePlayerQuickView() threw
// "must be used inside PlayerQuickViewProvider", which crashed the entire
// admin page to a black screen. It must now degrade to a plain link.
describe('PlayerNameLink', () => {
  it('renders without a PlayerQuickViewProvider as a link to the player page (no crash)', () => {
    render(
      <MemoryRouter>
        <PlayerNameLink slug="rtx_pinball" entry={{ iscored_username: 'Ace' }} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Ace' });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toContain('/rtx_pinball/players/Ace');
  });
});
