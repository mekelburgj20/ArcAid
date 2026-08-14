import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canDeleteRow, isOwnScoreRow, rowHistoryId, deleteScoreHistory,
} from '../scoreDelete';
import type { ViewerClaims } from '../viewerClaims';

/**
 * v2.108.0 (F2) — the shared per-row delete gate. Mirrors the server tiers in
 * `DELETE /api/rooms/:roomId/score-history/:historyId`; it decides what to
 * RENDER, and every case here has a server-side twin in
 * `src/__tests__/score-self-delete.test.ts`.
 */

const ROOM = 'room-1';

const claims = (over: Partial<ViewerClaims> = {}): ViewerClaims => ({
  role: 'player', gameRoomIds: [], discordId: 'disc-ada', ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  history_id: 7, submitted_by_user_id: 'disc-ada', source: 'tournament', ...over,
});

describe('rowHistoryId', () => {
  it('prefers history_id, falls back to id', () => {
    expect(rowHistoryId({ history_id: 3, id: 9 })).toBe(3);
    expect(rowHistoryId({ id: 9 })).toBe(9);
    expect(rowHistoryId({})).toBeNull();
  });
});

describe('isOwnScoreRow', () => {
  it('matches the RAW submitted_by_user_id against the token id', () => {
    expect(isOwnScoreRow(row(), claims())).toBe(true);
    expect(isOwnScoreRow(row({ submitted_by_user_id: 'disc-ben' }), claims())).toBe(false);
  });

  it('is false for an unattributed row even when the display id would match', () => {
    // `discord_user_id` is a resolved DISPLAY identity — never an ownership
    // claim. A row with no `submitted_by_user_id` belongs to nobody.
    expect(isOwnScoreRow({ submitted_by_user_id: null }, claims())).toBe(false);
  });

  it('is false for a signed-out viewer', () => {
    expect(isOwnScoreRow(row(), null)).toBe(false);
    expect(isOwnScoreRow(row(), claims({ discordId: null }))).toBe(false);
  });
});

describe('canDeleteRow tiers', () => {
  it('super_admin may delete any row in any room', () => {
    const superAdmin = claims({ role: 'super_admin', discordId: 'disc-super' });
    expect(canDeleteRow(row({ submitted_by_user_id: 'someone-else' }), superAdmin, ROOM)).toBe(true);
  });

  it('room_admin may delete any row in a room they administer, and none elsewhere', () => {
    const admin = claims({ role: 'room_admin', discordId: 'disc-admin', gameRoomIds: [ROOM] });
    expect(canDeleteRow(row({ submitted_by_user_id: 'someone-else' }), admin, ROOM)).toBe(true);
    expect(canDeleteRow(row({ submitted_by_user_id: 'someone-else' }), admin, 'other-room')).toBe(false);
  });

  it('player may delete only their own rows', () => {
    expect(canDeleteRow(row(), claims(), ROOM)).toBe(true);
    expect(canDeleteRow(row({ submitted_by_user_id: 'disc-ben' }), claims(), ROOM)).toBe(false);
  });

  it('accepts all three sources — community included as of v2.108.0', () => {
    for (const source of ['tournament', 'sync', 'community']) {
      expect(canDeleteRow(row({ source }), claims(), ROOM)).toBe(true);
    }
  });

  it('refuses a row with no history id — nothing to act on', () => {
    expect(canDeleteRow({ submitted_by_user_id: 'disc-ada', source: 'tournament' }, claims(), ROOM)).toBe(false);
  });

  it('refuses without claims or without a room', () => {
    expect(canDeleteRow(row(), null, ROOM)).toBe(false);
    expect(canDeleteRow(row(), claims(), undefined)).toBe(false);
  });
});

describe('deleteScoreHistory', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('requires a token before it will call anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const res = await deleteScoreHistory(ROOM, 7, null);
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error message rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, json: () => Promise.resolve({ error: 'You can only delete your own scores' }),
    })) as unknown as typeof fetch);
    const res = await deleteScoreHistory(ROOM, 7, 'tok');
    expect(res).toEqual({ ok: false, error: 'You can only delete your own scores' });
  });

  it('DELETEs the row with a bearer token on success', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const res = await deleteScoreHistory(ROOM, 7, 'tok');
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM}/score-history/7`,
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
    );
  });
});
