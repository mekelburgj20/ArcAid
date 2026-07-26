import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReportContentModal from '../ReportContentModal';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

/**
 * S22 Phase 1 content moderation (v2.43.0) — shared report modal. One
 * component covers both "report a room" and "report a player name"; this
 * test exercises it generically (target-agnostic by design) plus the three
 * response-outcome branches (success / duplicate / error).
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signInAs(discordId: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username: 'Tester', avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

function renderModal(props: Partial<React.ComponentProps<typeof ReportContentModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ViewerAuthProvider>
      <ReportContentModal
        title="Report this room"
        targetLabel="Test Room"
        endpoint="/global/rooms/room-1/report"
        onClose={onClose}
        {...props}
      />
    </ViewerAuthProvider>,
  );
  return { ...utils, onClose };
}

describe('ReportContentModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders the title and target label', () => {
    signInAs('discord-1');
    renderModal();
    expect(screen.getByText('Report this room')).toBeInTheDocument();
    expect(screen.getByText('Test Room')).toBeInTheDocument();
  });

  it('submits a report and shows the success message on 200', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderModal();
    fireEvent.click(screen.getByText('Submit Report'));

    await waitFor(() => expect(screen.getByText(/a moderator will review this/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/global/rooms/room-1/report',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ' + localStorage.getItem('arcaid_player_token') }),
      }),
    );
  });

  it('shows the duplicate message on 409', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'dup' }) }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderModal();
    fireEvent.click(screen.getByText('Submit Report'));

    await waitFor(() => expect(screen.getByText(/already reported this/)).toBeInTheDocument());
  });

  it('shows an error message on failure', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderModal();
    fireEvent.click(screen.getByText('Submit Report'));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('calls onClose on Cancel', () => {
    signInAs('discord-1');
    const { onClose } = renderModal();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('works generically for a player-name report (target-agnostic)', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderModal({
      title: 'Report this name',
      targetLabel: 'TrollName',
      endpoint: '/global/report-name',
      extraBody: { roomId: 'room-1', targetName: 'TrollName' },
    });
    fireEvent.click(screen.getByText('Submit Report'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/global/report-name');
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body).toEqual({ reason: undefined, roomId: 'room-1', targetName: 'TrollName' });
  });
});
