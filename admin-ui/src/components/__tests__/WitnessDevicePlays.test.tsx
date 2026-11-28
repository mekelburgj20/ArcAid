import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WitnessDevicePlays from '../WitnessDevicePlays';
import { sittingCause, type DeviceSitting } from '../../lib/witnessPlays';

/** W131.3 (ADR 0045) - "Plays on this device": every play, by sitting, and who it went to. */

const play = (over: object) => ({
  key: 'k', playedAt: '2026-11-28 01:00:00', tableName: 'Medieval Madness', score: 1_234_567, deviceId: 'cab',
  destinations: [{ status: 'global', tournamentName: null, roundNo: null, roomName: null, roomSlug: null, gameName: null, globalGameId: null, reason: null }],
  userId: 'b', label: 'Bob', isYou: false, attribution: 'session', sessionId: 7, receivedAt: '2026-11-28 01:00:05',
  ...over,
});

const SITTINGS: DeviceSitting[] = [
  {
    userId: 'b', label: 'Bob', isYou: false,
    session: { id: 7, startedAt: '2026-11-28 00:30:00', endedAt: null, via: 'cabinet', startedByLabel: 'Bob', startedByYou: false },
    plays: [play({ key: 'p2', tableName: 'Twilight Zone' }), play({ key: 'p1' })] as DeviceSitting['plays'],
  },
  {
    userId: 'a', label: 'Alice', isYou: true, session: null,
    plays: [play({ key: 'p0', userId: 'a', label: 'Alice', isYou: true, attribution: 'fallback', sessionId: null })] as DeviceSitting['plays'],
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('WitnessDevicePlays', () => {
  it('opens to the device\'s sittings, each saying who and why', async () => {
    const fn = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sittings: SITTINGS }) }));
    vi.stubGlobal('fetch', fn);
    render(<MemoryRouter><WitnessDevicePlays deviceId="cab" deviceType="atgames" playerToken="tok" /></MemoryRouter>);
    expect(fn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Plays on this cabinet' }));
    const sittings = await screen.findAllByTestId('witness-sitting');
    expect(sittings).toHaveLength(2);
    expect(sittings[0]).toHaveTextContent('Bob');
    expect(sittings[0]).toHaveTextContent('2 games');
    expect(sittings[0]).toHaveTextContent(/Playing as chosen by Bob on the cabinet/);
    expect(sittings[1]).toHaveTextContent('You');
    expect(sittings[1]).toHaveTextContent('Nobody had chosen, so the default player');
    expect(sittings[1]).toHaveTextContent('by arrival time');
    expect((fn.mock.calls[0] as unknown[])[0]).toBe('/api/me/witness/devices/cab/plays?limit=60');
  });

  it('says so when there is nothing yet, and when it could not load', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sittings: [] }) })));
    const { unmount } = render(<MemoryRouter><WitnessDevicePlays deviceId="cab" deviceType="desktop" playerToken="tok" /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Plays on this PC' }));
    expect(await screen.findByText('No plays on this PC since you joined it yet.')).toBeTruthy();
    unmount();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })));
    render(<MemoryRouter><WitnessDevicePlays deviceId="cab" playerToken="tok" /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Plays on this cabinet' }));
    expect(await screen.findByText("Couldn't load the plays. Try Refresh.")).toBeTruthy();
  });

  it('names what decided a sitting with no session', () => {
    const base = { userId: 'a', label: 'Alice', isYou: true, session: null };
    expect(sittingCause({ ...base, plays: [play({ attribution: 'device' })] } as DeviceSitting, 'cabinet')).toBe('The cabinet said who was playing');
    expect(sittingCause({ ...base, plays: [play({ attribution: 'attempt' })] } as DeviceSitting, 'cabinet')).toBe('Followed the attempt it was started as');
    expect(sittingCause({ ...base, plays: [play({ attribution: null })] } as DeviceSitting, 'cabinet')).toBe('Reported before players could share a device');
  });
});
