import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import MemberAdminPicker, { type PickableMember } from '../MemberAdminPicker';

/**
 * Member-picker admin add (ROADMAP "membership & privacy arc" rider).
 *
 * The point of this component is provider-agnostic promotion: a `google:*`
 * member must be pickable and POST-able exactly like a Discord member, since
 * before this component the only path to promoting a Google-authed member
 * was pasting their opaque `google:*` id — practically impossible. These
 * tests exercise it through props (roomId/members/excludeIds/callbacks)
 * rather than through Settings.tsx, matching the RAGameSearch idiom.
 */

function member(overrides: Partial<PickableMember> = {}): PickableMember {
  return {
    userId: 'discord-1',
    displayName: 'ChuckRibbits',
    avatarHash: null,
    avatarUrl: null,
    ...overrides,
  };
}

function ok(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

describe('MemberAdminPicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders room members with name + avatar affordance', () => {
    const members = [
      member({ userId: 'discord-1', displayName: 'ChuckRibbits' }),
      member({ userId: 'google:abc123', displayName: 'GoogleGamer' }),
    ];

    render(
      <MemberAdminPicker roomId="room-1" members={members} excludeIds={new Set()} onAdded={() => {}} />,
    );

    expect(screen.getByText('ChuckRibbits')).toBeInTheDocument();
    expect(screen.getByText('GoogleGamer')).toBeInTheDocument();
  });

  it('excludes members who are already admins of this room', () => {
    const members = [
      member({ userId: 'discord-1', displayName: 'AlreadyAdmin' }),
      member({ userId: 'discord-2', displayName: 'PromoteMe' }),
    ];

    render(
      <MemberAdminPicker
        roomId="room-1"
        members={members}
        excludeIds={new Set(['discord-1'])}
        onAdded={() => {}}
      />,
    );

    expect(screen.queryByText('AlreadyAdmin')).not.toBeInTheDocument();
    expect(screen.getByText('PromoteMe')).toBeInTheDocument();
  });

  it('shows an empty state when every member is already an admin', () => {
    const members = [member({ userId: 'discord-1', displayName: 'AlreadyAdmin' })];

    render(
      <MemberAdminPicker
        roomId="room-1"
        members={members}
        excludeIds={new Set(['discord-1'])}
        onAdded={() => {}}
      />,
    );

    expect(screen.getByTestId('member-admin-picker-empty')).toHaveTextContent('already an admin');
  });

  it('filters the list by the search query', () => {
    const members = [
      member({ userId: 'discord-1', displayName: 'ChuckRibbits' }),
      member({ userId: 'discord-2', displayName: 'Krobs' }),
    ];

    render(
      <MemberAdminPicker roomId="room-1" members={members} excludeIds={new Set()} onAdded={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText('Search room members'), { target: { value: 'krob' } });

    expect(screen.queryByText('ChuckRibbits')).not.toBeInTheDocument();
    expect(screen.getByText('Krobs')).toBeInTheDocument();
  });

  it('selecting a Discord member POSTs the admin-add endpoint with their raw snowflake id', async () => {
    const fetchMock = vi.fn(() => ok({ success: true }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const onAdded = vi.fn();

    render(
      <MemberAdminPicker
        roomId="room-1"
        members={[member({ userId: '123456789012345678', displayName: 'ChuckRibbits' })]}
        excludeIds={new Set()}
        onAdded={onAdded}
      />,
    );

    fireEvent.click(screen.getByText('ChuckRibbits'));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/rooms/room-1/admins/discord');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      discord_user_id: '123456789012345678',
    });
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ userId: '123456789012345678' }));
  });

  it('selecting a Google-authed member POSTs the same endpoint with their google:* id — provider-agnostic', async () => {
    const fetchMock = vi.fn(() => ok({ success: true }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const onAdded = vi.fn();

    render(
      <MemberAdminPicker
        roomId="room-1"
        members={[member({ userId: 'google:abc123', displayName: 'GoogleGamer' })]}
        excludeIds={new Set()}
        onAdded={onAdded}
      />,
    );

    fireEvent.click(screen.getByText('GoogleGamer'));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/rooms/room-1/admins/discord');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      discord_user_id: 'google:abc123',
    });
  });

  it('surfaces a failed add via onError without calling onAdded', async () => {
    const fetchMock = vi.fn(() => ok({ error: 'Boom' }, 500));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const onAdded = vi.fn();
    const onError = vi.fn();

    render(
      <MemberAdminPicker
        roomId="room-1"
        members={[member({ userId: 'discord-1', displayName: 'ChuckRibbits' })]}
        excludeIds={new Set()}
        onAdded={onAdded}
        onError={onError}
      />,
    );

    fireEvent.click(screen.getByText('ChuckRibbits'));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Boom'));
    expect(onAdded).not.toHaveBeenCalled();
  });

  describe('select mode (onSelect)', () => {
    it('calls onSelect with the clicked member and issues no POST', async () => {
      const fetchMock = vi.fn(() => ok({ success: true }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
      const onSelect = vi.fn();

      render(
        <MemberAdminPicker
          members={[member({ userId: '123456789012345678', displayName: 'ChuckRibbits' })]}
          excludeIds={new Set()}
          onSelect={onSelect}
        />,
      );

      fireEvent.click(screen.getByText('ChuckRibbits'));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ userId: '123456789012345678', displayName: 'ChuckRibbits' }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not call onAdded when onSelect is provided', async () => {
      const fetchMock = vi.fn(() => ok({ success: true }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
      const onSelect = vi.fn();
      const onAdded = vi.fn();

      render(
        <MemberAdminPicker
          members={[member({ userId: 'discord-1', displayName: 'ChuckRibbits' })]}
          excludeIds={new Set()}
          onSelect={onSelect}
          onAdded={onAdded}
        />,
      );

      fireEvent.click(screen.getByText('ChuckRibbits'));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onAdded).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still respects excludeIds and search filtering in select mode', () => {
      const members = [
        member({ userId: 'discord-1', displayName: 'AlreadyExcluded' }),
        member({ userId: 'discord-2', displayName: 'PickMe' }),
      ];
      const onSelect = vi.fn();

      render(
        <MemberAdminPicker
          members={members}
          excludeIds={new Set(['discord-1'])}
          onSelect={onSelect}
        />,
      );

      expect(screen.queryByText('AlreadyExcluded')).not.toBeInTheDocument();
      expect(screen.getByText('PickMe')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Search room members'), { target: { value: 'nope' } });
      expect(screen.getByText(/No members match/)).toBeInTheDocument();
    });

    it('applies label/copy overrides without touching default-mode text', () => {
      const onSelect = vi.fn();
      render(
        <MemberAdminPicker
          members={[member({ userId: 'discord-1', displayName: 'ChuckRibbits' })]}
          excludeIds={new Set()}
          onSelect={onSelect}
          label="Pick a nominee"
        />,
      );
      expect(screen.getByText('Pick a nominee')).toBeInTheDocument();
      expect(screen.queryByText('Add from room members')).not.toBeInTheDocument();
    });
  });
});
