import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import WitnessDevicePeople, { type PeopleDevice } from '../WitnessDevicePeople';

/**
 * W131.3 (ADR 0045) - the people on a shared Witness device: Playing as, the
 * people list, Add a player (after the device reports its clock), Leave.
 */

const ALICE = { userId: 'a', label: 'Alice', role: 'owner', addedAt: '2026-11-01', pairedDevice: true, isYou: true };
const BOB = { userId: 'b', label: 'Bob', role: 'player', addedAt: '2026-11-20', pairedDevice: false, isYou: false };

function stub(players: object[] = [ALICE, BOB], over: Record<string, { status: number; body: object }> = {}) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.replace('/api/me/witness/devices/cab', '')}`;
    if (over[key]) {
      const { status, body } = over[key];
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }
    if (key === 'GET /players') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ players, defaultPlayerId: 'a' }) });
    if (key === 'POST /invites') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 'xyz', expiresAt: '2026-12-05 10:00:00', path: '/witness-invite/xyz' }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const SHARED: PeopleDevice = {
  atgamesUniqueId: 'cab', deviceType: 'atgames', role: 'owner', playerCount: 2, householdReady: true,
  playingAs: { userId: 'a', label: 'Alice', isDefault: true, isYou: true },
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('WitnessDevicePeople', () => {
  it('a shared device shows Playing as; switching posts the session', async () => {
    const fn = stub();
    const onChanged = vi.fn();
    render(<WitnessDevicePeople device={SHARED} playerToken="tok" onChanged={onChanged} />);
    const select = await screen.findByRole('combobox', { name: 'Playing as' });
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(screen.getByText(/Nobody has chosen, so plays on this cabinet go to Alice/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'b' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const post = fn.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST') as unknown[];
    expect(post[0]).toBe('/api/me/witness/devices/cab/session');
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ userId: 'b' });
  });

  it('a device with one person shows no Playing as', () => {
    stub([ALICE]);
    render(<WitnessDevicePeople device={{ ...SHARED, playerCount: 1 }} playerToken="tok" onChanged={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Playing as' })).toBeNull();
    expect(screen.getByRole('button', { name: 'People on this device (1)' })).toBeTruthy();
  });

  it('an owner adds a player by an invite link', async () => {
    stub();
    render(<WitnessDevicePeople device={SHARED} playerToken="tok" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'People on this device (2)' }));
    const list = await screen.findByTestId('witness-people-list-cab');
    await within(list).findByText('Bob', { selector: 'span' });
    expect(within(list).getByText('Owner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make owner' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add a player/ }));
    expect(await screen.findByText(`${window.location.origin}/witness-invite/xyz`)).toBeTruthy();
  });

  it('Add a player waits for a build that reports its clock', async () => {
    stub([ALICE]);
    render(<WitnessDevicePeople device={{ ...SHARED, playerCount: 1, householdReady: false }} playerToken="tok" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'People on this device (1)' }));
    expect(await screen.findByTestId('witness-people-not-ready')).toHaveTextContent('update Arcaid Witness on this cabinet first');
    expect(screen.queryByRole('button', { name: /Add a player/ })).toBeNull();
  });

  it('a player sees no owner controls and can leave', async () => {
    const fn = stub([{ ...ALICE, isYou: false }, { ...BOB, isYou: true }]);
    const onChanged = vi.fn();
    render(<WitnessDevicePeople device={{ ...SHARED, role: 'player', playingAs: { userId: 'a', label: 'Alice', isDefault: false, isYou: false } }} playerToken="tok" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'People on this device (2)' }));
    await screen.findByText('Bob');
    expect(screen.queryByRole('button', { name: /Add a player/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByRole('button', { name: "I'm playing" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    const buttons = await screen.findAllByRole('button', { name: 'Leave' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const del = fn.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'DELETE') as unknown[];
    expect(del[0]).toBe('/api/me/witness/devices/cab/players/b');
  });

  it('a refusal shows the server\'s words', async () => {
    stub([ALICE, BOB], { 'POST /invites': { status: 409, body: { error: 'A device can have at most 6 players', code: 'DEVICE_FULL' } } });
    render(<WitnessDevicePeople device={SHARED} playerToken="tok" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'People on this device (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: /Add a player/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('A device can have at most 6 players');
  });
});
