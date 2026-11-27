import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UserMenu from '../UserMenu';

// v2.82.0 — My Stats menu item. Assertion shape mirrors PublicLayout.test.tsx's
// UserMenu item checks (~136-190): open the menu, find the item by its text,
// and assert its href / that it's an unconditional presence.

const USER = { discordId: 'user-1', username: 'Justin', avatar: null };

function renderMenu(props: Partial<React.ComponentProps<typeof UserMenu>> = {}) {
  return render(
    <MemoryRouter>
      <UserMenu user={USER} onLogout={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe('UserMenu', () => {
  it('shows a "My Stats" menu item linking to /my-stats, unconditionally', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('User menu'));

    const item = screen.getByRole('menuitem', { name: /My Stats/ });
    expect(item.getAttribute('href')).toBe('/my-stats');
  });

  // G35c retired the My Rooms page: its item went, and "All Game Rooms" (the
  // landing page, where your rooms are now) follows "My Stats".
  it('has no "My Rooms" item; "My Stats" comes before "All Game Rooms", which opens the landing page', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('User menu'));

    const items = screen.getAllByRole('menuitem');
    const texts = items.map(el => el.textContent || '');
    const myStatsIdx = texts.findIndex(t => t.includes('My Stats'));
    const allRoomsIdx = texts.findIndex(t => t.includes('All Game Rooms'));

    expect(texts.some(t => t.includes('My Rooms'))).toBe(false);
    expect(items.some(el => el.getAttribute('href') === '/my-rooms')).toBe(false);
    expect(myStatsIdx).toBeGreaterThanOrEqual(0);
    expect(allRoomsIdx).toBeGreaterThan(myStatsIdx);
    expect(items[allRoomsIdx]).toHaveAttribute('href', '/');
  });

  it('closes the menu after clicking "My Stats"', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('User menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /My Stats/ }));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  // v2.132.0 — "Scoreboard display" became "Display settings" and lost its
  // `showScoreboardPrefs` gate: the sheet is mounted app-wide now, so the
  // item is offered on every page and hides its own room-only section.
  it('shows a "Display settings" item unconditionally', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('User menu'));

    expect(screen.getByRole('menuitem', { name: /Display settings/ })).toBeInTheDocument();
    expect(screen.queryByText('Scoreboard display')).toBeNull();
  });

  it('dispatches open-scoreboard-prefs and closes the menu', () => {
    const onEvent = vi.fn();
    window.addEventListener('open-scoreboard-prefs', onEvent);
    renderMenu();
    fireEvent.click(screen.getByLabelText('User menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Display settings/ }));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    window.removeEventListener('open-scoreboard-prefs', onEvent);
  });
});
