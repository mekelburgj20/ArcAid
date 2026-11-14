import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), patch: (...a: unknown[]) => patch(...a), delete: vi.fn(), upload: vi.fn() },
  ApiError: class extends Error {},
  getToken: () => 'admin-tok',
}));

import SuperAdminWitnessReleases from '../SuperAdminWitnessReleases';

const rel = (version: string, channel: string) => ({
  version, channel, size: 1352864, sha256: 'abcdef0123456789ffff', notes: null, uploadedAt: '2026-11-13T00:00:00Z',
});

let sharedLogs: unknown[] = [];

beforeEach(() => {
  get.mockReset(); patch.mockReset();
  sharedLogs = [];
  get.mockImplementation((path: string) => path === '/admin/witness/shared-logs'
    ? Promise.resolve({ logs: sharedLogs })
    : Promise.resolve({
      releases: [rel('1.1.0', 'draft'), rel('1.2.0', 'beta')],
      devicesByVersion: [{ version: '', count: 2 }, { version: '1.0.9', count: 3 }],
    }));
  patch.mockResolvedValue({});
});

describe('SuperAdminWitnessReleases', () => {
  it('lists newest first and labels never-reported cabinets', async () => {
    render(<SuperAdminWitnessReleases />);
    await screen.findByText('1.2.0');
    const versions = screen.getAllByRole('row').slice(1, 3).map(r => r.querySelector('td')!.textContent);
    expect(versions).toEqual(['1.2.0', '1.1.0']);
    expect(screen.getAllByText('abcdef012345')).toHaveLength(2);
    expect(screen.getByText('never reported')).toBeTruthy();
  });

  it('shows the empty state when no logs were sent', async () => {
    render(<SuperAdminWitnessReleases />);
    expect(await screen.findByText('No logs sent yet.')).toBeTruthy();
    expect(screen.getByText('Witness releases and logs')).toBeTruthy();
  });

  it('lists sent logs and downloads one through the admin token', async () => {
    sharedLogs = [{
      id: 'a'.repeat(32), playerName: 'Pinball Pat', deviceModelName: 'HA9920', appVersion: '1.1.0',
      deviceTail: 'AB12CD', sharedAt: '2026-11-14T12:00:00Z', readyAt: '2026-11-14T11:00:00Z',
      sizeBytes: 2048, note: 'Scores stopped syncing on Tuesday', expiresAt: '2026-12-14T12:00:00Z',
    }];
    const fetchFn = vi.fn(() => Promise.resolve({
      ok: true, blob: () => Promise.resolve(new Blob(['x'])),
      headers: { get: () => 'attachment; filename="arcaid-witness-logs-20261114-1100.tar.gz"' },
    }));
    vi.stubGlobal('fetch', fetchFn);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    render(<SuperAdminWitnessReleases />);
    await screen.findByText('Pinball Pat');
    expect(screen.getByText(/HA9920/)).toBeTruthy();
    expect(screen.getByText('Scores stopped syncing on Tuesday')).toBeTruthy();
    expect(screen.queryByText('No logs sent yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download log from Pinball Pat' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/admin/witness/shared-logs/${'a'.repeat(32)}/download`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer admin-tok');
    vi.unstubAllGlobals();
  });

  it('moving to Everyone confirms, then PATCHes the channel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SuperAdminWitnessReleases />);
    const sel = await screen.findByLabelText('Channel for 1.1.0');
    fireEvent.change(sel, { target: { value: 'stable' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/witness/releases/1.1.0', { channel: 'stable' }));
    expect(confirm).toHaveBeenCalledWith('Offer 1.1.0 to every cabinet with automatic updates on?');
    confirm.mockRestore();
  });
});
