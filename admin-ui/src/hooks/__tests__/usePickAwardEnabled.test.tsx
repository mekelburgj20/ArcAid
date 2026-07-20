import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePickAwardEnabled } from '../usePickAwardEnabled';

// S18 — usePickAwardEnabled now reads through the shared lib/portal cache
// instead of its own private fetch. This proves it still resolves
// true/false correctly, and that a portal already cached for the slug
// (e.g. by PublicLayout's own getPortal call) is reused with no extra
// network request.
describe('usePickAwardEnabled', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves enabled=true from a fresh fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'r1', roomId: 'r1', slug: 'roomA', name: 'Room A', pick_award_enabled: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePickAwardEnabled('roomA'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves enabled=false when the portal has no flag set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'r2', roomId: 'r2', slug: 'roomB', name: 'Room B' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePickAwardEnabled('roomB'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('reuses an already-cached portal (from getPortal) without an extra fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'r3', roomId: 'r3', slug: 'roomC', name: 'Room C', pick_award_enabled: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Prime the shared portal cache the same way PublicLayout would.
    const { getPortal } = await import('../../lib/portal');
    await getPortal('roomC');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { result } = renderHook(() => usePickAwardEnabled('roomC'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
    // Shared cache hit — no second network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
