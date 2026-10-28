import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * W30 (v2.194.0) - the invite leads with the TOURNAMENT name and names the room
 * as "in <Room>" (invitees took the room name for the tournament).
 */

vi.mock('../../contexts/ViewerAuthContext', () => ({
  useViewerAuth: () => ({ playerToken: null, loginWithDiscord: vi.fn(), loginWithGoogle: vi.fn() }),
}));
vi.mock('../../components/LoginButtons', () => ({ default: () => <div /> }));

const { default: TournamentInvite } = await import('../TournamentInvite');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      tournamentId: 't1', tournamentName: 'Friday Night Flip', format: 'event',
      roomId: 'r1', roomSlug: 'wizard', roomName: 'Arcaid Witness Demo',
    }),
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('TournamentInvite (W30)', () => {
  it('leads with the tournament and puts the room beneath as "in <Room>"', async () => {
    render(
      <MemoryRouter initialEntries={['/tournament-invite/abc']}>
        <Routes><Route path="/tournament-invite/:code" element={<TournamentInvite />} /></Routes>
      </MemoryRouter>,
    );
    const h1 = await screen.findByRole('heading', { name: 'Friday Night Flip' });
    expect(h1).toBeInTheDocument();
    expect(screen.getByText(/^in Arcaid Witness Demo\./)).toBeInTheDocument();
  });
});
