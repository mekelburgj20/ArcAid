import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useRoomAtGamesJoin } from '../useRoomAtGamesJoin';
import { ToastProvider } from '../../components/Toast';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/** G23e: the "Join on AtGames" dialog is the Arcaid dialog. */

const ROW = { gameId: 'g1', tournamentId: 't1', tournamentName: 'Card Night', code: 'CARD123', joinedVia: null };

function Harness({ token, onLogin }: { token: string | null; onLogin: () => void }) {
  const { value, reload, dialog } = useRoomAtGamesJoin('r1', token, onLogin);
  return (
    <div>
      <button onClick={() => { void reload(); }}>load</button>
      <button onClick={() => value?.open(ROW as never)}>open</button>
      {dialog}
    </div>
  );
}

async function openDialog(token: string | null, onLogin = vi.fn()) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ games: [ROW] }) }));
  render(<ToastProvider><Harness token={token} onLogin={onLogin} /></ToastProvider>);
  await act(async () => { fireEvent.click(screen.getByText('load')); });
  await waitFor(() => fireEvent.click(screen.getByText('open')));
  await waitForRealDialog();
  return onLogin;
}

describe('useRoomAtGamesJoin — the dialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('opens as "Join on AtGames" with the round and its code, and Escape closes it', async () => {
    await openDialog('tok');
    expect(screen.getByRole('dialog', { name: 'Join on AtGames' })).toBeInTheDocument();
    expect(screen.getByText('CARD123')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a guest is asked to log in: Log in calls onLogin', async () => {
    const onLogin = await openDialog(null);
    expect(screen.getByText('Log in to Arcaid first, then join.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(onLogin).toHaveBeenCalled();
  });
});
