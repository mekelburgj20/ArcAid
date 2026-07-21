import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPortal } from '../portal';

// S18 — regression coverage for the shared portal cache. Pre-S18, every
// public page fetched /api/portal (or the full /api/rooms list) on its own;
// this module gives them one shared in-flight/settled promise per slug.
describe('getPortal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shares one network request across concurrent callers for the same slug', async () => {
    const portal = { id: 'r1', roomId: 'r1', slug: 'rtx_pinball', name: 'RTX Pinball' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(portal),
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([getPortal('rtx_pinball'), getPortal('rtx_pinball')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(portal);
    expect(b).toEqual(portal);
  });

  it('does not cache a failed lookup — a later call re-fetches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve(null) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'r2', roomId: 'r2', slug: 'other', name: 'Other Room' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPortal('other')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const result = await getPortal('other');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.name).toBe('Other Room');
  });

  it('normalizes roomId from id when the response omits roomId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'r4', slug: 'idonly', name: 'Id Only Room' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getPortal('idonly');
    expect(result.roomId).toBe('r4');
  });

  it('keys the cache case-insensitively on slug', async () => {
    const portal = { id: 'r3', roomId: 'r3', slug: 'MixedCase', name: 'Mixed Case Room' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(portal),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getPortal('MixedCase');
    await getPortal('mixedcase');
    await getPortal('MIXEDCASE');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
