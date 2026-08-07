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

  it('places "My Stats" between "My Rooms" and "All Game Rooms"', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('User menu'));

    const items = screen.getAllByRole('menuitem').map(el => el.textContent || '');
    const myRoomsIdx = items.findIndex(t => t.includes('My Rooms'));
    const myStatsIdx = items.findIndex(t => t.includes('My Stats'));
    const allRoomsIdx = items.findIndex(t => t.includes('All Game Rooms'));

    expect(myRoomsIdx).toBeGreaterThanOrEqual(0);
    expect(myStatsIdx).toBeGreaterThan(myRoomsIdx);
    expect(allRoomsIdx).toBeGreaterThan(myStatsIdx);
  });

  it('closes the menu after clicking "My Stats"', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('User menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /My Stats/ }));

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
