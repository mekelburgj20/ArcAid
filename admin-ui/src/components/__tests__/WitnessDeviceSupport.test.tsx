import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import WitnessDeviceSupport, { type WitnessSupportDevice } from '../WitnessDeviceSupport';

const DEV: WitnessSupportDevice = {
    atgamesUniqueId: 'dev1', deviceType: 'atgames', appVersion: '1.1.0',
    autoUpdate: true, testBuilds: false, stagedVersion: null, offeredVersion: null, logsSupported: true,
};

function req(status: string, extra: Record<string, unknown> = {}) {
    return {
        id: 'r1', deviceId: 'dev1', status, requestedAt: '2026-11-13T10:00:00Z', readyAt: null,
        sizeBytes: null, failReason: null, expiresAt: '2026-11-20T10:00:00Z', ...extra,
    };
}

function stubFetch(requests: unknown[] = [], extra?: (url: string, init?: RequestInit) => unknown) {
    const fn = vi.fn((url: string, init?: RequestInit) => {
        const custom = extra?.(url, init);
        if (custom) return Promise.resolve(custom);
        if (url === '/api/me/witness/log-requests') {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ requests }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, request: req('pending') }) });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

const renderIt = (d: WitnessSupportDevice, onChanged = vi.fn()) =>
    render(<WitnessDeviceSupport device={d} playerToken="tok" onChanged={onChanged} />);

afterEach(() => { vi.unstubAllGlobals(); });

describe('WitnessDeviceSupport', () => {
    it('renders nothing for a desktop device', () => {
        stubFetch();
        const { container } = renderIt({ ...DEV, deviceType: 'desktop' });
        expect(container.innerHTML).toBe('');
    });

    it('an unsupported cabinet gets the needs-1.1.0 line and no button or checkbox', () => {
        stubFetch();
        renderIt({ ...DEV, logsSupported: false });
        expect(screen.getByText('Log download needs Arcaid Witness 1.1.0 or newer on this cabinet.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Get logs/ })).toBeNull();
        expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('Get logs POSTs and shows the pending copy', async () => {
        const fn = stubFetch([]);
        renderIt(DEV);
        fireEvent.click(await screen.findByRole('button', { name: /Get logs/ }));
        await screen.findByText(/Asked your cabinet for its logs/);
        const post = fn.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST');
        expect(post![0]).toBe('/api/me/witness/devices/dev1/log-requests');
    });

    it('a ready request offers Download with the size', async () => {
        stubFetch([req('ready', { sizeBytes: 2048 })]);
        renderIt(DEV);
        expect(await screen.findByRole('button', { name: /Download logs/ })).toBeTruthy();
        expect(screen.getByText(/2 KB/)).toBeTruthy();
        expect(screen.getByText(/Save the file, then send it to Arcaid support/)).toBeTruthy();
    });

    it('expired and failed requests explain themselves', async () => {
        stubFetch([req('expired', { failReason: 'no_answer' })]);
        const a = renderIt(DEV);
        expect(await screen.findByText(/Your cabinet did not answer/)).toBeTruthy();
        a.unmount();
        stubFetch([req('failed', { failReason: 'no_space' })]);
        renderIt(DEV);
        expect(await screen.findByText(/could not send its logs \(no_space\)/)).toBeTruthy();
    });

    it('toggling auto update PATCHes the body', async () => {
        const fn = stubFetch([]);
        const onChanged = vi.fn();
        renderIt(DEV, onChanged);
        fireEvent.click(screen.getByLabelText('Update this cabinet automatically'));
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
        const patch = fn.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
        expect(patch[0]).toBe('/api/me/witness/devices/dev1/updates');
        expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ autoUpdate: false });
    });

    it('test builds is disabled while auto update is off, and PATCHes when on', async () => {
        const fn = stubFetch([]);
        const a = renderIt({ ...DEV, autoUpdate: false });
        expect((screen.getByLabelText('Get test builds early') as HTMLInputElement).disabled).toBe(true);
        a.unmount();
        renderIt(DEV);
        fireEvent.click(screen.getByLabelText('Get test builds early'));
        await waitFor(() => expect(fn.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
        const patch = fn.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
        expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ testBuilds: true });
    });

    it('shows staged before offered', () => {
        stubFetch();
        const a = renderIt({ ...DEV, stagedVersion: '1.2.0', offeredVersion: '1.2.0' });
        expect(screen.getByText(/Version 1.2.0 is downloaded/)).toBeTruthy();
        expect(screen.queryByText(/is available/)).toBeNull();
        a.unmount();
        renderIt({ ...DEV, offeredVersion: '1.3.0' });
        expect(screen.getByText(/Version 1.3.0 is available/)).toBeTruthy();
    });
});
