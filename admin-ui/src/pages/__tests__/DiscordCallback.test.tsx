import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import DiscordCallback from '../DiscordCallback';

/**
 * Field report fix (v2.9x.0) — a room_admin/super_admin identity that logs
 * in via a LINKED provider (Google, completing back to a Discord account, or
 * vice versa) got no "Room admin" affordance: the `linked === true`
 * early-return branch stored the fresh token only as the player token and
 * never seeded the admin-token slot, unlike the plain-login branch a few
 * lines below it. These tests pin the fix — see `../../lib/adminSlotSeed.ts`.
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
function pastExp(): number {
  return Math.floor(Date.now() / 1000) - 3600;
}

function renderCallback(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth/discord/callback" element={<DiscordCallback onLogin={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DiscordCallback — linked-login admin-slot seeding', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('linked branch: seeds the admin slot when the returned token is room_admin-y', async () => {
    sessionStorage.setItem('arcaid_link_nonce', 'nonce-1');
    const adminToken = fakeJwt({ discordId: 'd-1', role: 'room_admin', gameRoomIds: ['room-1'], exp: futureExp() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: adminToken, refreshToken: 'r1', user: { discordId: 'd-1' }, linked: true }),
    }));

    renderCallback('/auth/discord/callback?code=abc&state=link:nonce-1');

    await waitFor(() => expect(localStorage.getItem('arcaid_player_token')).toBe(adminToken));
    expect(localStorage.getItem('arcaid_token')).toBe(adminToken);
    expect(localStorage.getItem('arcaid_admin_refresh_token')).toBe('r1');
  });

  it('linked branch: does NOT seed the admin slot for a plain player token', async () => {
    sessionStorage.setItem('arcaid_link_nonce', 'nonce-2');
    const playerToken = fakeJwt({ discordId: 'd-2', role: 'player', gameRoomIds: [], exp: futureExp() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: playerToken, refreshToken: 'r2', user: { discordId: 'd-2' }, linked: true }),
    }));

    renderCallback('/auth/discord/callback?code=abc&state=link:nonce-2');

    await waitFor(() => expect(localStorage.getItem('arcaid_player_token')).toBe(playerToken));
    expect(localStorage.getItem('arcaid_token')).toBeNull();
  });

  it('linked branch: does not overwrite a live, unexpired admin token already in the slot', async () => {
    sessionStorage.setItem('arcaid_link_nonce', 'nonce-3');
    const existingAdminToken = fakeJwt({ discordId: 'existing', role: 'super_admin', gameRoomIds: [], exp: futureExp() });
    localStorage.setItem('arcaid_token', existingAdminToken);
    const newAdminToken = fakeJwt({ discordId: 'd-3', role: 'room_admin', gameRoomIds: ['room-2'], exp: futureExp() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: newAdminToken, refreshToken: 'r3', user: { discordId: 'd-3' }, linked: true }),
    }));

    renderCallback('/auth/discord/callback?code=abc&state=link:nonce-3');

    await waitFor(() => expect(localStorage.getItem('arcaid_player_token')).toBe(newAdminToken));
    expect(localStorage.getItem('arcaid_token')).toBe(existingAdminToken); // untouched — higher-privilege session preserved
  });

  it('linked branch: re-seeds when the existing admin slot token is expired', async () => {
    sessionStorage.setItem('arcaid_link_nonce', 'nonce-4');
    const staleToken = fakeJwt({ discordId: 'stale', role: 'room_admin', gameRoomIds: [], exp: pastExp() });
    localStorage.setItem('arcaid_token', staleToken);
    const freshAdminToken = fakeJwt({ discordId: 'd-4', role: 'room_admin', gameRoomIds: ['room-3'], exp: futureExp() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: freshAdminToken, refreshToken: 'r4', user: { discordId: 'd-4' }, linked: true }),
    }));

    renderCallback('/auth/discord/callback?code=abc&state=link:nonce-4');

    await waitFor(() => expect(localStorage.getItem('arcaid_token')).toBe(freshAdminToken));
  });
});
