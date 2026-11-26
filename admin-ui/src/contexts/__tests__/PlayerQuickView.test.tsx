import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlayerQuickViewProvider } from '../PlayerQuickViewContext';
import { ViewerAuthProvider } from '../ViewerAuthContext';
import PlayerNameLink from '../../components/PlayerNameLink';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/**
 * G23c (v2.271.0) — the player quick view on the Arcaid dialog: named by the
 * player, the same stats and links (the `?from` / `?tab` the full page's back
 * link reads), closed by Escape.
 */
const STATS = {
  discordUserId: '', iscoredUsername: 'ada', totalGamesPlayed: 12, totalWins: 3, winPercentage: 25,
  avg_finish_position: 2.5, top5_rate: 0.75, champion_streak: 2, bestGame: 'Attack from Mars',
  recentScores: [{ game_name: 'Medieval Madness', score: 4200000, date: '2026-11-20' }],
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/rooms') return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'room-1', slug: 'rtx_pinball' }]) });
    if (url.includes('/stats/enhanced/player/')) return Promise.resolve({ ok: true, json: () => Promise.resolve(STATS) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  }) as unknown as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Player quick view', () => {
  it('opens as a dialog named for the player, with the same stats and links, and Escape closes it', async () => {
    render(
      <MemoryRouter>
        <ViewerAuthProvider>
          <PlayerQuickViewProvider>
            <PlayerNameLink slug="rtx_pinball" fromTab="all-games" entry={{ iscored_username: 'ada', display_name: 'Ada Lovelace' }} />
          </PlayerQuickViewProvider>
        </ViewerAuthProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Ada Lovelace'));
    await waitForRealDialog();
    const dialog = screen.getByRole('dialog', { name: 'Ada Lovelace' });
    expect(within(dialog).getByText('iScored: ada')).toBeInTheDocument();
    expect(await within(dialog).findByText('Attack from Mars')).toBeInTheDocument();
    expect(within(dialog).getByText('4,200,000')).toBeInTheDocument();

    expect(within(dialog).getByText('View full player page').closest('a'))
      .toHaveAttribute('href', '/rtx_pinball/players/ada?from=rtx_pinball&tab=all-games');
    expect(within(dialog).getByText('All Players').closest('a'))
      .toHaveAttribute('href', '/rtx_pinball/players?tab=all-games');
    expect(within(dialog).getByText('Compare').closest('a'))
      .toHaveAttribute('href', '/rtx_pinball/compare?a=ada');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
