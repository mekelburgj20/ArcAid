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
    it('renders nothing for a desktop device the server says cannot be asked', () => {
        stubFetch();
        const { container } = renderIt({ ...DEV, deviceType: 'desktop', appVersion: null, logsSupported: false });
        expect(container.innerHTML).toBe('');
    });

    it('W102: a desktop (Castcade) device gets Get logs with its own wording and no update switches', async () => {
        const fn = stubFetch([]);
        renderIt({ ...DEV, deviceType: 'desktop', appVersion: null });
        expect(screen.queryByRole('checkbox')).toBeNull();
        fireEvent.click(await screen.findByRole('button', { name: /Get logs/ }));
        await screen.findByText(/Asked Castcade on that PC for its logs/);
        expect(screen.queryByText(/your cabinet/i)).toBeNull();
        const post = fn.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST');
        expect(post![0]).toBe('/api/me/witness/devices/dev1/log-requests');
    });

    it('W102: a ready desktop bundle says what Castcade sends', async () => {
        stubFetch([req('ready', { sizeBytes: 2048 })]);
        renderIt({ ...DEV, deviceType: 'desktop', appVersion: null });
        expect(await screen.findByRole('button', { name: /Send to Arcaid support/ })).toBeTruthy();
        expect(screen.getByText(/Sends Castcade's logs, its VR layer log and recent table journals/)).toBeTruthy();
        expect(screen.queryByRole('checkbox')).toBeNull();
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
        expect(screen.getByRole('button', { name: /Send to Arcaid support/ })).toBeTruthy();
        expect(screen.getByText(/Sends this cabinet's Witness log and VPX play records to the Arcaid team/)).toBeTruthy();
    });

    it('Send to Arcaid support POSTs the share and then shows the sent line without the button', async () => {
        const ready = req('ready', { sizeBytes: 2048, readyAt: '2026-11-13T10:05:00Z' });
        const fn = stubFetch([ready], (url, init) => {
            if (url === '/api/me/witness/log-requests/r1/share' && init?.method === 'POST') {
                return { ok: true, status: 200, json: () => Promise.resolve({ request: { ...ready, sharedAt: '2026-11-14T12:00:00Z' } }) };
            }
            return null;
        });
        renderIt(DEV);
        fireEvent.click(await screen.findByRole('button', { name: /Send to Arcaid support/ }));
        await screen.findByText(/Sent to Arcaid support on/);
        expect(screen.queryByRole('button', { name: /Send to Arcaid support/ })).toBeNull();
        expect(screen.getByRole('button', { name: /Download logs/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Remove logs/ })).toBeTruthy();
        expect(fn.mock.calls.some(c => c[0] === '/api/me/witness/log-requests/r1/share')).toBe(true);
    });

    it('an already shared request loads with the sent line', async () => {
        stubFetch([req('ready', { sizeBytes: 2048, sharedAt: '2026-11-14T12:00:00Z' })]);
        renderIt(DEV);
        expect(await screen.findByText(/Sent to Arcaid support on/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Send to Arcaid support/ })).toBeNull();
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

    describe('W105: fresh logs while a bundle is there', () => {
        const old = req('ready', { id: 'old', sizeBytes: 2048, readyAt: '2026-11-13T10:05:00Z' });
        const received = new Date('2026-11-13T10:05:00Z')
            .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

        it('a received bundle shows Download logs with its date and time, and Get fresh logs', async () => {
            stubFetch([old]);
            renderIt(DEV);
            expect(await screen.findByRole('button', { name: /Download logs/ })).toBeTruthy();
            expect(screen.getByTestId('witness-logs-received').textContent).toContain(`received ${received}`);
            const fresh = screen.getByRole('button', { name: /Get fresh logs/ }) as HTMLButtonElement;
            expect(fresh.disabled).toBe(false);
            expect(screen.queryByRole('button', { name: /^Get logs$/ })).toBeNull();
        });

        it('Get fresh logs POSTs without deleting anything, shows the waiting copy and keeps Download for the old bundle', async () => {
            const fn = stubFetch([old], (url, init) => {
                if (url === '/api/me/witness/devices/dev1/log-requests' && init?.method === 'POST') {
                    return { ok: true, status: 201, json: () => Promise.resolve({ request: req('pending', { id: 'new', requestedAt: '2026-11-15T09:00:00Z' }) }) };
                }
                return null;
            });
            renderIt(DEV);
            fireEvent.click(await screen.findByRole('button', { name: /Get fresh logs/ }));
            await screen.findByText(/Asked your cabinet for its logs/);
            expect(screen.getByText(/The logs below stay until the new ones arrive/)).toBeTruthy();
            expect(screen.getByRole('button', { name: /Download logs/ })).toBeTruthy();
            expect((screen.getByRole('button', { name: /Get fresh logs/ }) as HTMLButtonElement).disabled).toBe(true);
            expect(fn.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
        });

        it('loading with a pending request in front of a received bundle shows both', async () => {
            stubFetch([req('pending', { id: 'new', requestedAt: '2026-11-15T09:00:00Z' }), old]);
            renderIt(DEV);
            expect(await screen.findByText(/Asked your cabinet for its logs/)).toBeTruthy();
            expect(screen.getByRole('button', { name: /Download logs/ })).toBeTruthy();
            expect(screen.getByTestId('witness-logs-received').textContent).toContain(received);
        });

        it('a fresh request that expired explains itself and the old bundle stays downloadable', async () => {
            stubFetch([req('expired', { id: 'new', failReason: 'no_answer', requestedAt: '2026-11-15T09:00:00Z' }), old]);
            renderIt(DEV);
            expect(await screen.findByText(/Your cabinet did not answer/)).toBeTruthy();
            expect(screen.getByRole('button', { name: /Download logs/ })).toBeTruthy();
            expect((screen.getByRole('button', { name: /Get fresh logs/ }) as HTMLButtonElement).disabled).toBe(false);
        });

        it('another device\'s bundle is not shown here', async () => {
            const fn = stubFetch([{ ...old, deviceId: 'dev2' }]);
            renderIt(DEV);
            await waitFor(() => expect(fn).toHaveBeenCalledWith('/api/me/witness/log-requests', expect.anything()));
            await new Promise(r => setTimeout(r, 0));
            expect(screen.getByRole('button', { name: /Get logs/ })).toBeTruthy();
            expect(screen.queryByRole('button', { name: /Download logs/ })).toBeNull();
        });
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

    it('updatePending from the server decides whether the on-the-stick line shows', () => {
        stubFetch();
        const a = renderIt({ ...DEV, stagedVersion: '1.1.1', updatePending: true });
        expect(screen.getByText(/Version 1.1.1 is on the stick/)).toBeTruthy();
        a.unmount();
        renderIt({ ...DEV, stagedVersion: '1.1.0', updatePending: false });
        expect(screen.queryByText(/is on the stick/)).toBeNull();
    });

    it('shows staged before offered', () => {
        stubFetch();
        const a = renderIt({ ...DEV, stagedVersion: '1.2.0', offeredVersion: '1.2.0' });
        expect(screen.getByText('Version 1.2.0 is on the stick. Open the tile on the cabinet to finish the update.')).toBeTruthy();
        expect(screen.queryByText(/is available/)).toBeNull();
        a.unmount();
        renderIt({ ...DEV, offeredVersion: '1.3.0' });
        expect(screen.getByText(/Version 1.3.0 is available/)).toBeTruthy();
    });
});
