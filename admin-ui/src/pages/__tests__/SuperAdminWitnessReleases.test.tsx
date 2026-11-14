import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), patch: (...a: unknown[]) => patch(...a), delete: vi.fn(), upload: vi.fn() },
  ApiError: class extends Error {},
}));

import SuperAdminWitnessReleases from '../SuperAdminWitnessReleases';

const rel = (version: string, channel: string) => ({
  version, channel, size: 1352864, sha256: 'abcdef0123456789ffff', notes: null, uploadedAt: '2026-11-13T00:00:00Z',
});

beforeEach(() => {
  get.mockReset(); patch.mockReset();
  get.mockResolvedValue({
    releases: [rel('1.1.0', 'draft'), rel('1.2.0', 'beta')],
    devicesByVersion: [{ version: '', count: 2 }, { version: '1.0.9', count: 3 }],
  });
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
