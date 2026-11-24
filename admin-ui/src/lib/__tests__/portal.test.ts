import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPortal, getPortalPatiently, PortalUnavailableError } from '../portal';

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

  // G31 (v2.265.4) — "failed for now" is a different error from "no such room".
  it('rejects with PortalUnavailableError for a refused request, a server error and a dropped connection', async () => {
    const refused = { ok: false, status: 429, headers: { get: (n: string) => (n === 'Retry-After' ? '17' : null) } };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null } })
      .mockRejectedValueOnce(new TypeError('Failed to fetch')));

    const first = await getPortal('busy').catch(e => e);
    expect(first).toBeInstanceOf(PortalUnavailableError);
    expect(first.retryAfterMs).toBe(17_000);
    expect(await getPortal('busy').catch(e => e)).toBeInstanceOf(PortalUnavailableError);
    expect(await getPortal('busy').catch(e => e)).toBeInstanceOf(PortalUnavailableError);
  });

  it('rejects with a plain error for a room that does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } }));
    const err = await getPortal('nowhere').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PortalUnavailableError);
  });
});

describe('getPortalPatiently', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const down = { ok: false, status: 502, headers: { get: () => null } };
  const room = (slug: string) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ id: 'r9', roomId: 'r9', slug, name: 'Patient Room' }),
  });

  it('keeps asking until the room answers, and says it is waiting', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(down)
      .mockResolvedValueOnce(down)
      .mockResolvedValue(room('patient-a'));
    vi.stubGlobal('fetch', fetchMock);
    const onWaiting = vi.fn();
    let got: { name: string } | null = null;
    void getPortalPatiently('patient-a', { onWaiting }).then(p => { got = p; });

    await vi.advanceTimersByTimeAsync(0);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(got).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(got).toMatchObject({ name: 'Patient Room' });
  });

  it('rejects at once for a room that does not exist', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);
    const settled = getPortalPatiently('patient-none').catch(e => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops asking when the caller leaves', async () => {
    const fetchMock = vi.fn().mockResolvedValue(down);
    vi.stubGlobal('fetch', fetchMock);
    const leaving = new AbortController();
    void getPortalPatiently('patient-gone', { signal: leaving.signal });
    await vi.advanceTimersByTimeAsync(0);
    leaving.abort();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
