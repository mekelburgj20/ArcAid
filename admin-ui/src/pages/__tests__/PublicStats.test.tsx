import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PublicStats from '../PublicStats';
import { RoomContext } from '../../contexts/RoomContext';

/** v2.240.0 (B25) — avatars on the Players list, table art on the Games list. */

const PLAYERS = [
  { discord_user_id: '111111111111111111', iscored_username: 'PeteG', display_name: 'Pete', games_played: 4, wins: 2, avg_finish_position: 1.5, top5_rate: 1, champion_streak: 1, avatar_hash: 'petehash', avatar_url: null },
  { discord_user_id: 'iscored:anon', iscored_username: 'Anon', display_name: null, games_played: 1, wins: 0, avg_finish_position: 3, top5_rate: 1, champion_streak: 0, avatar_hash: null, avatar_url: null },
];
const GAMES = [
  { name: 'Godzilla', submissions: 9, players: 4, top_score: 1000, last_activity: null, image_url: '/api/catalogue-images/godzilla.png' },
  { name: 'Funhouse', submissions: 2, players: 2, top_score: 10, last_activity: null, image_url: null },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = url.includes('/stats/enhanced/players') ? PLAYERS
      : url.includes('/stats/games-activity') ? GAMES
      : url.includes('/stats/overview') ? null
      : [];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderStats() {
  return render(
    <MemoryRouter initialEntries={['/rtx/stats']}>
      <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx', roomName: 'RTX' }}>
        <Routes>
          <Route path="/:slug/stats" element={<PublicStats />} />
        </Routes>
      </RoomContext.Provider>
    </MemoryRouter>,
  );
}

describe('PublicStats — avatars and table art', () => {
  it('the Players list shows each player\'s avatar beside their name', async () => {
    renderStats();
    const avatar = await screen.findByAltText('Pete');
    expect(avatar.getAttribute('src')).toContain('petehash');
    expect(screen.getByText('Anon')).toBeInTheDocument();
  });

  it('the Games list shows each table\'s art, or its initials', async () => {
    renderStats();
    await screen.findByAltText('Pete');
    fireEvent.click(screen.getByRole('tab', { name: /Games/ }));

    const row = (await screen.findByText('Godzilla')).closest('a')!;
    expect(within(row).getByTestId('game-art')).toHaveAttribute('src', '/api/catalogue-images/godzilla.png');
    const other = screen.getByText('Funhouse').closest('a')!;
    expect(within(other).getByTestId('game-art-fallback')).toHaveTextContent('FU');
  });
});
