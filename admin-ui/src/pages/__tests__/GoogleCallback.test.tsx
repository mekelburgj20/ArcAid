import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GoogleCallback from '../GoogleCallback';

/**
 * Field report fix (v2.9x.0) — mirrors DiscordCallback.test.tsx's coverage
 * for the same bug on the Google side of the link: a Discord room_admin who
 * completes a "Link Google account" flow (or logs in via an already-linked
 * Google identity) must ALSO get the admin-token slot seeded. See
 * `../../lib/adminSlotSeed.ts`.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function futureExp(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

function renderCallback(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth/google/callback" element={<GoogleCallback onLogin={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GoogleCallback — linked-login admin-slot seeding', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('linked branch: seeds the admin slot when the returned token is super_admin-y', async () => {
    sessionStorage.setItem('arcaid_link_nonce', 'nonce-1');
    const adminToken = fakeJwt({ discordId: 'd-1', role: 'super_admin', gameRoomIds: [], exp: futureExp() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: adminToken, refreshToken: 'r1', user: { discordId: 'd-1' }, linked: true }),
    }));

    renderCallback('/auth/google/callback?code=abc&state=link:nonce-1');

    await waitFor(() => expect(localStorage.getItem('arcaid_player_token')).toBe(adminToken));
    expect(localStorage.getItem('arcaid_token')).toBe(adminToken);
  });

  it('linked branch: does NOT seed the admin slot for a plain player token', async () => {
    sessionStorage.setItem('arcaid_link_nonce', 'nonce-2');
    const playerToken = fakeJwt({ discordId: 'd-2', role: 'player', gameRoomIds: [], exp: futureExp() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: playerToken, refreshToken: 'r2', user: { discordId: 'd-2' }, linked: true }),
    }));

    renderCallback('/auth/google/callback?code=abc&state=link:nonce-2');

    await waitFor(() => expect(localStorage.getItem('arcaid_player_token')).toBe(playerToken));
    expect(localStorage.getItem('arcaid_token')).toBeNull();
  });
});
