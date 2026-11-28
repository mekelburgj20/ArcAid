import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/** W131.3 (ADR 0045) - join a shared Witness device by an owner's invite link. */

const auth = vi.hoisted(() => ({
  state: { playerToken: 'tok' as string | null, loginWithDiscord: vi.fn(), loginWithGoogle: vi.fn() },
}));
vi.mock('../../contexts/ViewerAuthContext', () => ({ useViewerAuth: () => auth.state }));
vi.mock('../../components/LoginButtons', () => ({
  default: ({ onDiscordLogin }: { onDiscordLogin: () => void }) => <button onClick={onDiscordLogin}>Discord login</button>,
}));

const { default: WitnessInvite } = await import('../WitnessInvite');

const INVITE = {
  deviceType: 'atgames', deviceModelName: 'Legends Ultimate', deviceTail: '40F0',
  invitedBy: 'Alice', expiresAt: '2026-12-05 12:00:00', alreadyOnDevice: false,
};

function stub(opts: { invite?: object; readStatus?: number; acceptStatus?: number; acceptBody?: object } = {}) {
  const fn = vi.fn((url: string) => {
    if (url.endsWith('/accept')) {
      const status = opts.acceptStatus ?? 200;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(opts.acceptBody ?? { success: true, deviceId: 'cab' }) });
    }
    if (url.includes('/device-invites/')) {
      const status = opts.readStatus ?? 200;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(status < 400 ? { invite: opts.invite ?? INVITE } : { code: 'INVITE_INVALID' }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const renderInvite = () => render(
  <MemoryRouter initialEntries={['/witness-invite/abcDEF_123']}>
    <Routes>
      <Route path="/witness-invite/:code" element={<WitnessInvite />} />
      <Route path="/account/settings" element={<div>settings page</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { auth.state = { playerToken: 'tok', loginWithDiscord: vi.fn(), loginWithGoogle: vi.fn() }; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Join a shared device', () => {
  it('says what joining means, then joins', async () => {
    const fn = stub();
    renderInvite();
    await screen.findByText('Device ending in 40F0');
    expect(screen.getByText('Invited by Alice')).toBeTruthy();
    expect(fn.mock.calls[0][0]).toBe('/api/me/witness/device-invites/abcDEF_123');
    // Ruling 6: the page says the plays are shared before anyone joins.
    expect(screen.getByText(/Everyone on this cabinet sees every play on it/).className).toContain('aw-chip--attention');
    fireEvent.click(screen.getByRole('button', { name: 'Join this cabinet' }));
    expect((await screen.findByText("You're on this cabinet")).className).toContain('aw-chip--success');
    const post = fn.mock.calls.find(c => c[0] === '/api/me/witness/device-invites/abcDEF_123/accept') as unknown[];
    expect((post[1] as RequestInit).method).toBe('POST');
    expect(screen.getByRole('link', { name: /Account Settings/ }).getAttribute('href')).toBe('/account/settings#witness-devices');
  });

  it('a used or expired link says to ask for a new one', async () => {
    stub({ readStatus: 404 });
    renderInvite();
    expect(await screen.findByText('This invite link is not valid any more. Ask for a new one.')).toBeTruthy();
  });

  it('a refusal on join shows the server\'s words', async () => {
    stub({ acceptStatus: 409, acceptBody: { error: 'A device can have at most 6 players', code: 'DEVICE_FULL' } });
    renderInvite();
    fireEvent.click(await screen.findByRole('button', { name: 'Join this cabinet' }));
    expect(await screen.findByText('A device can have at most 6 players')).toBeTruthy();
  });

  it('someone already on the device is not offered Join', async () => {
    stub({ invite: { ...INVITE, alreadyOnDevice: true } });
    renderInvite();
    await screen.findByText('You are already on this cabinet.');
    expect(screen.queryByRole('button', { name: 'Join this cabinet' })).toBeNull();
  });

  it('a guest logs in and comes back to the same link', async () => {
    auth.state = { playerToken: null, loginWithDiscord: vi.fn(), loginWithGoogle: vi.fn() };
    stub();
    renderInvite();
    fireEvent.click(screen.getByRole('button', { name: 'Discord login' }));
    expect(auth.state.loginWithDiscord).toHaveBeenCalledWith('__global__', '/witness-invite/abcDEF_123');
  });
});
