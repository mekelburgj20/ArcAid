import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RetryingLoader,
  RETRY_AFTER_CAP_MS,
  RETRY_STEPS_MS,
  isTransientStatus,
  retryAfterMs,
  retryDelayMs,
  type LoadPhase,
} from '../loadRetry';

// G31 (v2.265.4) — a refused or dropped page load must be told apart from an
// empty answer, and asked again. Owner 2026-11-23: a room page whose requests
// were all refused (429) read "Waiting for active games" until a refresh.

const headers = (map: Record<string, string>) => ({
  headers: { get: (name: string) => map[name] ?? map[name.toLowerCase()] ?? null },
});
const answer = (status: number, extra: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, ...headers(extra) }) as unknown as Response;

describe('isTransientStatus', () => {
  it('treats a refused, timed-out or broken-server answer as "ask again"', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) expect(isTransientStatus(s)).toBe(true);
  });
  it('treats a definite answer as final', () => {
    for (const s of [200, 204, 400, 401, 403, 404]) expect(isTransientStatus(s)).toBe(false);
  });
  it('does not retry a test double that has no status', () => {
    expect(isTransientStatus(undefined as unknown as number)).toBe(false);
  });
});

describe('retryAfterMs', () => {
  it('reads Retry-After in seconds', () => {
    expect(retryAfterMs(headers({ 'Retry-After': '12' }))).toBe(12_000);
  });
  it('reads Retry-After as a date', () => {
    const now = Date.parse('2026-11-23T10:00:00Z');
    expect(retryAfterMs(headers({ 'Retry-After': 'Mon, 23 Nov 2026 10:00:30 GMT' }), now)).toBe(30_000);
  });
  it('falls back to the limiter\'s RateLimit-Reset', () => {
    expect(retryAfterMs(headers({ 'RateLimit-Reset': '41' }))).toBe(41_000);
  });
  it('is null when the server did not say, or there are no headers', () => {
    expect(retryAfterMs(headers({}))).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs({} as never)).toBeNull();
  });
});

describe('retryDelayMs', () => {
  const mid = () => 0.5;
  it('rises step by step and then holds the last step', () => {
    const waits = [0, 1, 2, 3, 4, 5, 6, 40].map(n => retryDelayMs(n, null, mid));
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]);
  });
  it('stays within 15% of the step', () => {
    expect(retryDelayMs(2, null, () => 0)).toBe(Math.round(RETRY_STEPS_MS[2] * 0.85));
    expect(retryDelayMs(2, null, () => 1)).toBe(Math.round(RETRY_STEPS_MS[2] * 1.15));
  });
  it('waits as long as the server asked, never less', () => {
    expect(retryDelayMs(0, headers({ 'Retry-After': '20' }), () => 0)).toBe(20_000);
    expect(retryDelayMs(0, headers({ 'Retry-After': '20' }), () => 1)).toBe(21_000);
  });
  it('caps what the server may ask for', () => {
    expect(retryDelayMs(0, headers({ 'Retry-After': '3600' }), () => 0)).toBe(RETRY_AFTER_CAP_MS);
  });
});

describe('RetryingLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(request: () => Promise<Response>) {
    const phases: LoadPhase[] = [];
    const applied: Response[] = [];
    const loader = new RetryingLoader({
      request,
      onOk: res => { applied.push(res); },
      onPhase: p => phases.push(p),
    });
    return { loader, phases, applied };
  }

  it('applies an ok answer and is ready, with no retry scheduled', async () => {
    const request = vi.fn().mockResolvedValue(answer(200));
    const { loader, phases, applied } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(1);
    expect(phases).toEqual(['ready']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a refused first load is "retrying", then asks again and recovers (the owner\'s report)', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(answer(429))
      .mockResolvedValueOnce(answer(429))
      .mockResolvedValue(answer(200));
    const { loader, phases, applied } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(phases).toEqual(['retrying']);
    expect(applied).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(applied).toHaveLength(1);
    expect(phases[phases.length - 1]).toBe('ready');
  });

  it('waits as long as the limiter said before asking again', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(answer(429, { 'Retry-After': '30' }))
      .mockResolvedValue(answer(200));
    const { loader } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a dropped connection (rejected fetch) and a 503 retry the same way', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(answer(503))
      .mockResolvedValue(answer(200));
    const { loader, phases } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(phases[phases.length - 1]).toBe('ready');
  });

  it('a definite refusal is an answer: ready, nothing applied, no retry', async () => {
    const request = vi.fn().mockResolvedValue(answer(403));
    const { loader, phases, applied } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(0);
    expect(phases).toEqual(['ready']);
  });

  it('a failed RELOAD keeps "ready" (the page keeps what it has) and still retries', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(answer(200))
      .mockResolvedValueOnce(answer(502))
      .mockResolvedValue(answer(200));
    const { loader, phases, applied } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(phases).not.toContain('retrying');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(applied).toHaveLength(2);
  });

  it('a body that cannot be read counts as a failure for now', async () => {
    const request = vi.fn().mockResolvedValue(answer(200));
    const phases: LoadPhase[] = [];
    let calls = 0;
    const loader = new RetryingLoader({
      request,
      onOk: () => { if (++calls === 1) throw new SyntaxError('Unexpected token <'); },
      onPhase: p => phases.push(p),
    });
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(phases).toEqual(['retrying']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(phases[phases.length - 1]).toBe('ready');
  });

  it('load() while a retry is pending replaces it (one request, not two)', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(answer(500))
      .mockResolvedValue(answer(200));
    const { loader } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    loader.load();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a slow old answer never overwrites a newer one', async () => {
    let releaseOld: (r: Response) => void = () => {};
    const old = new Promise<Response>(resolve => { releaseOld = resolve; });
    const newer = answer(200);
    const request = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(newer);
    const { loader, applied } = setup(request);
    loader.load();
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([newer]);
    releaseOld(answer(200));
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([newer]);
  });

  it('reset() drops what is in flight, cancels the retry and forgets the answer', async () => {
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>(resolve => { release = resolve; });
    const request = vi.fn()
      .mockResolvedValueOnce(answer(500))
      .mockReturnValueOnce(slow)
      .mockResolvedValue(answer(500));
    const { loader, phases, applied } = setup(request);
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    loader.reset();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);

    loader.load();
    loader.reset();
    release(answer(200));
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(0);

    // After a reset the next failure is a first-load failure again.
    phases.length = 0;
    loader.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(phases).toEqual(['retrying']);
    loader.reset();
  });
});
