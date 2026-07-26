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
  bans?: unknown[];
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
    // S22 Phase 2 (v2.44.0) — Bans tab.
    if (url.includes('/admin/bans')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.bans ?? []) });
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

  // m8 fix (S22 Phase 2 adversarial review) — an iscored:* synthetic
  // target_user_id has no login identity to ban; the "Ban identity" quick
  // action must be hidden (not just disabled) for it, while "Reset display
  // name" (which doesn't require a login identity) stays available.
  it('m8: hides "Ban identity" for an iscored:* target_user_id, but shows it for a real identity', async () => {
    mockFetch({
      roomsPending: [],
      namesPending: [
        {
          id: 10, target_type: 'player_name', target_key: 'name:iscored:troll99:troll', game_room_id: 'r1',
          target_user_id: 'iscored:troll99', target_name: 'IscoredTroll', reporter_user_id: 'discord-2',
          reason: null, created_at: new Date().toISOString(),
          resolved_at: null, resolved_by: null, resolution: null,
          room_name: 'Some Room', room_slug: 'some-room', reporter_display_name: null,
          reporter_username: 'Bob', target_display_name: null, target_username: null,
        },
        {
          id: 11, target_type: 'player_name', target_key: 'name:discord-real-1:realtroll', game_room_id: 'r1',
          target_user_id: 'discord-real-1', target_name: 'RealTroll', reporter_user_id: 'discord-2',
          reason: null, created_at: new Date().toISOString(),
          resolved_at: null, resolved_by: null, resolution: null,
          room_name: 'Some Room', room_slug: 'some-room', reporter_display_name: null,
          reporter_username: 'Bob', target_display_name: null, target_username: null,
        },
      ],
    });

    renderReports();
    await waitFor(() => expect(screen.getByText('No pending room reports.')).toBeInTheDocument());

    screen.getByText('Player Names').click();
    await waitFor(() => expect(screen.getByText('IscoredTroll')).toBeInTheDocument());
    expect(screen.getByText('RealTroll')).toBeInTheDocument();

    // Only ONE "Ban identity" button — for the real identity row, not the
    // iscored:* row. Both rows get "Reset display name".
    expect(screen.getAllByText('Ban identity')).toHaveLength(1);
    expect(screen.getAllByText('Reset display name')).toHaveLength(2);
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

  // S22 Phase 2 (v2.44.0) — Bans tab.
  it('switches to the Bans tab and lists active + lifted bans, with Lift only on the active one', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    mockFetch({
      bans: [
        {
          id: 'ban-1', discord_user_id: 'discord-active-1', reason: 'Spamming slurs',
          banned_by: 'admin-1', banned_at: new Date().toISOString(),
          expires_at: future, lifted_at: null, lifted_by: null,
        },
        {
          id: 'ban-2', discord_user_id: 'discord-lifted-1', reason: null,
          banned_by: 'admin-1', banned_at: new Date().toISOString(),
          expires_at: null, lifted_at: new Date().toISOString(), lifted_by: 'admin-2',
        },
      ],
    });

    renderReports();
    await waitFor(() => expect(screen.getByText('No pending room reports.')).toBeInTheDocument());

    screen.getByText('Bans').click();
    await waitFor(() => expect(screen.getByText('discord-active-1')).toBeInTheDocument());
    expect(screen.getByText('discord-lifted-1')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Lifted')).toBeInTheDocument();
    // Only the active ban gets a Lift button.
    expect(screen.getAllByText('Lift')).toHaveLength(1);
    // The add-ban form is present.
    expect(screen.getByText('Ban an identity')).toBeInTheDocument();
  });

  it('Bans tab hides the "Show resolved" toggle (bans are not pending/resolved-shaped)', async () => {
    mockFetch({ bans: [] });
    renderReports();
    await waitFor(() => expect(screen.getByText('No pending room reports.')).toBeInTheDocument());
    expect(screen.getByText('Show resolved')).toBeInTheDocument();
    screen.getByText('Bans').click();
    await waitFor(() => expect(screen.getByText('No bans yet.')).toBeInTheDocument());
    expect(screen.queryByText('Show resolved')).not.toBeInTheDocument();
  });
});
