import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Reports from '../Reports';

/**
 * S22 Phase 1 content moderation (v2.43.0) — Reports page render test.
 * Mocks the underlying fetch (lib/api.ts's transport) rather than the `api`
 * module itself — matches the existing convention (see RoomMembers.test.tsx).
 */

function mockFetch(opts: {
  roomsPending?: unknown[];
  namesPending?: unknown[];
  scoresPending?: unknown[];
}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/admin/reports') && url.includes('type=room') && url.includes('status=pending')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.roomsPending ?? []) });
    }
    if (url.includes('/admin/reports') && url.includes('type=player_name') && url.includes('status=pending')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.namesPending ?? []) });
    }
    if (url.includes('/admin/reports') && url.includes('status=resolved')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes('/admin/score-reports') && url.includes('status=pending')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.scoresPending ?? []) });
    }
    if (url.includes('/admin/score-reports') && url.includes('status=resolved')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderReports() {
  return render(
    <MemoryRouter initialEntries={['/admin/reports']}>
      <Reports />
    </MemoryRouter>,
  );
}

describe('Reports page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Rooms tab by default with a pending room report', async () => {
    mockFetch({
      roomsPending: [{
        id: 1, target_type: 'room', target_key: 'room:r1', game_room_id: 'r1',
        target_user_id: null, target_name: 'Sketchy Room', reporter_user_id: 'discord-1',
        reason: 'Spamming links', created_at: new Date().toISOString(),
        resolved_at: null, resolved_by: null, resolution: null,
        room_name: 'Sketchy Room', room_slug: 'sketchy', reporter_display_name: 'Alice',
        reporter_username: null, target_display_name: null, target_username: null,
      }],
    });

    renderReports();

    await waitFor(() => expect(screen.getByText('Sketchy Room')).toBeInTheDocument());
    expect(screen.getByText(/Spamming links/)).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('switches to the Player Names tab and loads name reports', async () => {
    mockFetch({
      roomsPending: [],
      namesPending: [{
        id: 2, target_type: 'player_name', target_key: 'name:global:troll', game_room_id: 'r1',
        target_user_id: null, target_name: 'BadName', reporter_user_id: 'discord-2',
        reason: null, created_at: new Date().toISOString(),
        resolved_at: null, resolved_by: null, resolution: null,
        room_name: 'Some Room', room_slug: 'some-room', reporter_display_name: null,
        reporter_username: 'Bob', target_display_name: null, target_username: null,
      }],
    });

    renderReports();
    await waitFor(() => expect(screen.getByText('No pending room reports.')).toBeInTheDocument());

    screen.getByText('Player Names').click();
    await waitFor(() => expect(screen.getByText('BadName')).toBeInTheDocument());
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  it('m1: player-name headline is the reported target_name SNAPSHOT, not the current resolved identity — the resolved identity renders as secondary "Currently:" context', async () => {
    mockFetch({
      roomsPending: [],
      namesPending: [{
        id: 3, target_type: 'player_name', target_key: 'name:discord-renamed:oldbadname', game_room_id: 'r1',
        target_user_id: 'discord-renamed', target_name: 'OldBadName', reporter_user_id: 'discord-2',
        reason: null, created_at: new Date().toISOString(),
        resolved_at: null, resolved_by: null, resolution: null,
        room_name: 'Some Room', room_slug: 'some-room', reporter_display_name: null,
        reporter_username: 'Bob', target_display_name: 'NewCleanName', target_username: null,
      }],
    });

    renderReports();
    await waitFor(() => expect(screen.getByText('No pending room reports.')).toBeInTheDocument());

    screen.getByText('Player Names').click();
    // Headline is the snapshot, not the renamed current identity.
    await waitFor(() => expect(screen.getByText('OldBadName')).toBeInTheDocument());
    // The current identity appears only as secondary context.
    expect(screen.getByText(/Currently: NewCleanName/)).toBeInTheDocument();
  });

  it('switches to the Scores tab and loads the pre-existing score-reports queue', async () => {
    mockFetch({
      scoresPending: [{
        id: 'sr-1', score_id: 'gs-1', reporter_discord_id: 'discord-3',
        reason: 'Impossible score', created_at: new Date().toISOString(),
        resolved_at: null, resolved_by: null, resolution: null,
        global_game_id: 'gg-1', player_id: 'discord-offender', iscored_username: 'Offender',
        score: 999999999, origin_type: 'global', score_deleted_at: null,
        game_name: 'Some Pinball Machine',
      }],
    });

    renderReports();
    await waitFor(() => expect(screen.getByText('No pending room reports.')).toBeInTheDocument());
    screen.getByText('Scores').click();
    await waitFor(() => expect(screen.getByText(/Some Pinball Machine/)).toBeInTheDocument());
    expect(screen.getByText(/Impossible score/)).toBeInTheDocument();
    expect(screen.getByText('Hard Delete')).toBeInTheDocument();
    expect(screen.getByText('Ban Player')).toBeInTheDocument();
  });

  it('empty state renders for the Rooms tab', async () => {
    mockFetch({});
    renderReports();
    await waitFor(() => expect(screen.getByText('No pending room reports.')).toBeInTheDocument());
  });
});
