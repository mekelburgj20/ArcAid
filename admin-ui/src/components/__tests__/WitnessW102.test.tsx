import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WitnessKitDownload from '../WitnessKitDownload';
import WitnessDeviceHealth from '../WitnessDeviceHealth';
import { roomLines, homeLines, type Routing } from '../../lib/witnessScoresGoTo';

afterEach(() => { vi.unstubAllGlobals(); });

function stubKit(body: unknown, videoUrl: string | null = null) {
    const fn = vi.fn((url: string) => {
        if (url === '/api/witness/guide') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ videoUrl }) });
        if (url === '/api/me/witness/kit') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        return Promise.resolve({
            ok: true, status: 200, blob: () => Promise.resolve(new Blob(['x'])),
            headers: { get: () => 'attachment; filename="arcaid-witness-kit-v1.1.1.zip"' },
        });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

describe('WitnessKitDownload', () => {
    it('shows the button, caption and guide link when available, and downloads with the token', async () => {
        const fn = stubKit({ available: true, version: '1.1.1', sizeBytes: 3 * 1024 * 1024 });
        (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x');
        (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
        render(<MemoryRouter><WitnessKitDownload playerToken="tok" /></MemoryRouter>);
        const btn = await screen.findByRole('button', { name: /Get Arcaid Witness/ });
        expect(screen.getByText('Version 1.1.1 · 3.0 MB')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'How to install' }).getAttribute('href')).toBe('/witness/install');
        fireEvent.click(btn);
        await waitFor(() => expect(fn.mock.calls.some(c => c[0] === '/api/me/witness/kit/download')).toBe(true));
        const call = fn.mock.calls.find(c => c[0] === '/api/me/witness/kit/download') as unknown[];
        expect((call[1] as RequestInit).headers).toEqual({ Authorization: 'Bearer tok' });
    });

    it('shows the install video link only when one is set, and only for https', async () => {
        stubKit({ available: true, version: '1.1.1', sizeBytes: 1024 }, 'https://example.com/v');
        const { unmount } = render(<MemoryRouter><WitnessKitDownload playerToken="tok" /></MemoryRouter>);
        const link = await screen.findByRole('link', { name: 'Watch the install video' });
        expect(link.getAttribute('href')).toBe('https://example.com/v');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        unmount();
        stubKit({ available: true, version: '1.1.1', sizeBytes: 1024 }, 'javascript:alert(1)');
        render(<MemoryRouter><WitnessKitDownload playerToken="tok" /></MemoryRouter>);
        await screen.findByRole('link', { name: 'How to install' });
        await new Promise(r => setTimeout(r, 10));
        expect(screen.queryByRole('link', { name: 'Watch the install video' })).toBeNull();
    });

    it('hides the install video link when none is set', async () => {
        stubKit({ available: true, version: '1.1.1', sizeBytes: 1024 }, null);
        render(<MemoryRouter><WitnessKitDownload playerToken="tok" /></MemoryRouter>);
        await screen.findByRole('link', { name: 'How to install' });
        expect(screen.queryByRole('link', { name: 'Watch the install video' })).toBeNull();
    });

    it('renders nothing when not available', async () => {
        const fn = stubKit({ available: false });
        const { container } = render(<MemoryRouter><WitnessKitDownload playerToken="tok" /></MemoryRouter>);
        await waitFor(() => expect(fn).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 10));
        expect(container.innerHTML).toBe('');
    });
});

describe('WitnessDeviceHealth', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    it('watching yes', () => {
        render(<WitnessDeviceHealth device={{ deviceType: 'atgames', watching: 'yes' }} />);
        expect(screen.getByText('Watching now')).toBeTruthy();
    });
    it('not watching: cabinet and desktop advice', () => {
        const a = render(<WitnessDeviceHealth device={{ deviceType: 'atgames', watching: 'no', heartbeatAt: ago(3 * 3600_000) }} />);
        expect(screen.getByText(/Not watching\. Last heard from 3h ago\./)).toBeTruthy();
        expect(screen.getByText(/Open the \[Arcaid Witness\] tile on the cabinet after it powers on\./)).toBeTruthy();
        a.unmount();
        render(<WitnessDeviceHealth device={{ deviceType: 'desktop', watching: 'no', heartbeatAt: ago(3 * 3600_000) }} />);
        expect(screen.getByText(/Start Castcade on the PC\./)).toBeTruthy();
    });
    it('unknown and absent show nothing', () => {
        const a = render(<WitnessDeviceHealth device={{ watching: 'unknown' }} />);
        expect(a.container.innerHTML).toBe('');
        a.unmount();
        const b = render(<WitnessDeviceHealth device={{}} />);
        expect(b.container.innerHTML).toBe('');
    });
    it('last score line names the table', () => {
        render(<WitnessDeviceHealth device={{ watching: 'unknown', lastScoreAt: ago(2 * 3600_000), lastScoreTable: 'Medieval Madness' }} />);
        expect(screen.getByText('Last score sent 2h ago: Medieval Madness')).toBeTruthy();
    });
});

describe('scores go to: not watching', () => {
    const row = (over: Partial<Routing>): Routing => ({
        deviceId: 'd1', deviceType: 'atgames', sendsHere: 'yes', why: null,
        targetRoomName: null, targetTournamentName: null, ...over,
    });
    it('cabinet gets the tile advice', () => {
        expect(roomLines([row({ watching: 'no' })])[0].text)
            .toBe('Your cabinet sends its scores here · not watching now, open the tile on the cabinet.');
    });
    it('desktop gets only the short words; yes/unknown/absent are unchanged', () => {
        expect(roomLines([row({ deviceType: 'desktop', watching: 'no' })])[0].text)
            .toBe('Your PC sends its scores here · not watching now.');
        for (const w of ['yes', 'unknown', undefined] as const) {
            expect(roomLines([row({ watching: w })])[0].text).toBe('Your cabinet sends its scores here.');
        }
    });
    it('home lines carry it too', () => {
        const l = homeLines([{ atgamesUniqueId: 'a', targetRoomId: null, targetRoomName: null, targetTournamentId: null, targetTournamentName: null, watching: 'no' }]);
        expect(l[0].text).toContain('not watching now, open the tile on the cabinet');
    });
});
