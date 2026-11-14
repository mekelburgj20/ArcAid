import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const auth = vi.hoisted(() => ({
  state: { playerToken: 'tok' as string | null, loginWithDiscord: vi.fn(), loginWithGoogle: vi.fn() },
}));
vi.mock('../../contexts/ViewerAuthContext', () => ({ useViewerAuth: () => auth.state }));
vi.mock('../../components/LoginButtons', () => ({
  default: ({ onDiscordLogin }: { onDiscordLogin: () => void }) => <button onClick={onDiscordLogin}>Discord login</button>,
}));

const { default: WitnessPair } = await import('../WitnessPair');
const { default: WitnessPairEntry } = await import('../WitnessPairEntry');
const { default: WitnessInstall } = await import('../WitnessInstall');

const INFO = {
  code: 'ABC123', deviceType: 'atgames', deviceModel: 'HA9920', deviceModelName: 'Legends Ultimate',
  deviceTail: '40F0', atgamesUsername: 'CabinetOwner', expiresAt: '2026-11-14T12:00:00Z',
  status: 'pending', alreadyYours: false,
};

function stub(opts: { info?: object; infoStatus?: number; approveStatus?: number; approveBody?: object; videoUrl?: string | null } = {}) {
  const fn = vi.fn((url: string) => {
    if (url === '/api/witness/guide') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ videoUrl: opts.videoUrl ?? null }) });
    }
    const approve = url.endsWith('/approve');
    if (url.includes('/pair-requests/')) {
      const status = approve ? (opts.approveStatus ?? 200) : (opts.infoStatus ?? 200);
      const body = approve ? (opts.approveBody ?? { ok: true }) : (opts.info ?? INFO);
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }
    if (url === '/api/me/witness/kit') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ available: true, version: '1.1.1', sizeBytes: 1048576 }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const renderPair = (path = '/pair/abc123') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/pair/:code" element={<WitnessPair />} />
      <Route path="/pair" element={<WitnessPairEntry />} />
      <Route path="/account/settings" element={<div>settings page</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { auth.state = { playerToken: 'tok', loginWithDiscord: vi.fn(), loginWithGoogle: vi.fn() }; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Pair by phone', () => {
  it('pending -> approve -> approved', async () => {
    const fn = stub();
    renderPair();
    await screen.findByText('Device ending in 40F0');
    expect(screen.getByText('AtGames name: CabinetOwner')).toBeTruthy();
    expect(screen.getByText('Legends Ultimate · HA9920')).toBeTruthy();
    expect(screen.getByText('Only approve if you are standing at this cabinet and this code is on its screen.')).toBeTruthy();
    expect(fn.mock.calls[0][0]).toBe('/api/me/witness/pair-requests/ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'Pair this cabinet' }));
    await screen.findByText('Approved. The cabinet finishes pairing in a few seconds.');
    const post = fn.mock.calls.find(c => c[0] === '/api/me/witness/pair-requests/ABC123/approve') as unknown[];
    expect((post[1] as RequestInit).method).toBe('POST');
    expect(screen.getByRole('link', { name: /Account Settings/ }).getAttribute('href')).toBe('/account/settings#witness-devices');
  });

  it('404 on read shows the not-valid copy', async () => {
    stub({ infoStatus: 404, info: { error: 'PAIR_REQUEST_NOT_FOUND' } });
    renderPair();
    await screen.findByText('That code is not valid or has expired. Start again on the cabinet.');
  });

  it('a 400 on approve shows the server message', async () => {
    stub({ approveStatus: 400, approveBody: { error: 'You have too many devices', code: 'DEVICE_LIMIT' } });
    renderPair();
    fireEvent.click(await screen.findByRole('button', { name: 'Pair this cabinet' }));
    await screen.findByText('You have too many devices');
  });

  it('a 404 on approve shows the not-valid copy', async () => {
    stub({ approveStatus: 404, approveBody: { error: 'PAIR_REQUEST_NOT_FOUND' } });
    renderPair();
    fireEvent.click(await screen.findByRole('button', { name: 'Pair this cabinet' }));
    await screen.findByText(/That code is not valid or has expired/);
  });

  it('alreadyYours says so', async () => {
    stub({ info: { ...INFO, alreadyYours: true } });
    renderPair();
    await screen.findByText('This cabinet is already on your account. Approving pairs it again.');
  });

  it('a guest is sent to log in and returned to the same URL', async () => {
    auth.state.playerToken = null;
    const fn = stub();
    renderPair();
    fireEvent.click(await screen.findByText('Discord login'));
    expect(auth.state.loginWithDiscord).toHaveBeenCalledWith('__global__', '/pair/ABC123');
    expect(fn).not.toHaveBeenCalled();
  });

  it('the code box upper-cases, strips spaces and goes to /pair/<code>', async () => {
    stub();
    renderPair('/pair');
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'ab c 123' } });
    expect((screen.getByLabelText('Pairing code') as HTMLInputElement).value).toBe('ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Device ending in 40F0');
  });
});

describe('Install guide', () => {
  const renderInstall = () => render(<MemoryRouter><WitnessInstall /></MemoryRouter>);

  it('renders the title, eight steps and the sections', async () => {
    stub();
    const { container } = renderInstall();
    expect(screen.getByRole('heading', { name: 'Install Arcaid Witness on your cabinet' })).toBeTruthy();
    expect(container.querySelectorAll('ol > li').length).toBe(8);
    expect(screen.getByText('Every time you turn the cabinet on')).toBeTruthy();
    expect(screen.getByText('Which tables post scores')).toBeTruthy();
    expect(screen.getByText(/Never delete the arcaid-witness folder/)).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain('free');
    expect(await screen.findByRole('button', { name: /Get Arcaid Witness/ })).toBeTruthy();
  });

  it('shows the install video link under the intro when one is set', async () => {
    stub({ videoUrl: 'https://example.com/v' });
    renderInstall();
    const link = await screen.findByRole('link', { name: 'Watch the install video' });
    expect(link.getAttribute('href')).toBe('https://example.com/v');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows no install video link when none is set', async () => {
    stub();
    renderInstall();
    await screen.findByRole('button', { name: /Get Arcaid Witness/ });
    expect(screen.queryByRole('link', { name: 'Watch the install video' })).toBeNull();
  });

  it('a guest sees Log in to download', () => {
    auth.state.playerToken = null;
    stub();
    renderInstall();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to download' }));
    expect(auth.state.loginWithDiscord).toHaveBeenCalledWith('__global__', '/witness/install');
  });
});
