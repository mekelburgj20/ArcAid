import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TourController from '../TourController';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

/**
 * v2.48.0 — first-login player tutorial (tmp/first-login-tutorial-contract.md).
 * TourController owns only the gating decision (fetch + bail conditions);
 * TourOverlay's own test file covers step navigation and the finish/skip
 * persistence writes.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signInAs(discordId: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username: 'Tester', avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ViewerAuthProvider>
        <div data-tour="nav" />
        <TourController />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('TourController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never fetches when the viewer is not logged in', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('bails without fetching when ?submit-draft is present (PendingSubmissionWatcher owns that moment)', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball?submit-draft=abc');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bails without fetching when the session-dismissed flag is set', async () => {
    signInAs('discord-1');
    sessionStorage.setItem('arcaid_tutorial_dismissed', '1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches tutorial-status and, when seenAt is null, shows the tour after the settle delay', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ seenAt: null }) }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball');
    // Flush the GET's promise chain before advancing the 600ms settle timer.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(fetchMock).toHaveBeenCalledWith('/api/me/tutorial-status', expect.objectContaining({
      headers: { Authorization: expect.stringContaining('Bearer ') },
    }));
    expect(screen.getByRole('dialog', { name: 'Welcome tour' })).toBeInTheDocument();
  });

  it('never shows the tour when the server reports it already seen', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ seenAt: '2026-07-28T00:00:00.000Z' }) }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(700); });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('bails silently on a fetch failure — never blocks the page or throws', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn(() => Promise.reject(new Error('network down')));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(700); });

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
