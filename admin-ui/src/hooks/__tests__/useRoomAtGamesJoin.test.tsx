import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useRoomAtGamesJoin } from '../useRoomAtGamesJoin';

/**
 * A40 (v2.237.0) — the scoreboard's Joined state comes from the server, per
 * player, not from this browser's localStorage: a join made on another device,
 * in the AtGames app ("I've joined") or seen in a pulled score shows here.
 */
describe('useRoomAtGamesJoin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const rows = [
    { gameId: 'g1', tournamentId: 't1', tournamentName: 'Card Night', code: 'CARD123', joinedVia: 'scores' },
    { gameId: 'g2', tournamentId: 't1', tournamentName: 'Card Night', code: 'CARD123', joinedVia: 'scores' },
    { gameId: 'g3', tournamentId: 't2', tournamentName: 'Other Night', code: 'OTHER12', joinedVia: null },
  ];

  it('reads Joined from the server rows, with the viewer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ games: rows }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRoomAtGamesJoin('r1', 'tok', vi.fn()));
    await act(async () => { await result.current.reload(); });

    await waitFor(() => expect(result.current.value).not.toBeNull());
    expect([...result.current.value!.joined]).toEqual(['t1']);
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/r1/atgames/joinable', { headers: { Authorization: 'Bearer tok' } });
  });

  it('ignores a stale per-browser mark from before A40', async () => {
    localStorage.setItem('arcaid_atgames_joined', JSON.stringify(['t2']));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ games: rows }) }));

    const { result } = renderHook(() => useRoomAtGamesJoin('r1', 'tok', vi.fn()));
    await act(async () => { await result.current.reload(); });

    await waitFor(() => expect(result.current.value).not.toBeNull());
    expect(result.current.value!.joined.has('t2')).toBe(false);
  });
});
