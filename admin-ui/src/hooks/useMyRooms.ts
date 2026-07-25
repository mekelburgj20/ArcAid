import { useCallback, useEffect, useState } from 'react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import type { MemberRoom } from '../lib/landingRooms';

export interface UseMyRoomsResult {
  /** Rooms the signed-in user belongs to (empty, static for guests). */
  rooms: MemberRoom[];
  loading: boolean;
  isMember: (roomId: string) => boolean;
  /** POST /api/me/rooms/:roomId (source='self_join'). Optimistic — reverts on
   * failure. `meta` fills in the card fields for the optimistic row; omit if
   * the caller doesn't have them handy (a follow-up refetch will fill in the
   * real values, but the row still appears immediately with blanks). Resolves
   * `false` on failure (network error or non-2xx) so callers can surface it. */
  join: (roomId: string, meta?: { name?: string; slug?: string; logoUrl?: string | null }) => Promise<boolean>;
  /** DELETE /api/me/rooms/:roomId. Optimistic — restores the row on failure.
   * Never touches game_room_admins (server-side; see RoomMembershipService). */
  leave: (roomId: string) => Promise<boolean>;
  refetch: () => Promise<void>;
}

/**
 * Shared "My Game Rooms" membership state + explicit join/leave mutations
 * (v2.38.0 join-leave contract, tmp/join-leave-contract.md). Extracted so
 * LandingPage (bookmark toggle on room cards) and PublicLayout (room-page
 * join/leave affordance) share one fetch + one optimistic-update strategy
 * instead of duplicating the /api/me/rooms plumbing.
 *
 * Guests (no playerToken) get a static empty list — callers must gate
 * rendering of any join/leave UI on `discordUser` from useViewerAuth()
 * directly (this hook doesn't hide itself, it just has nothing to show).
 */
export function useMyRooms(): UseMyRoomsResult {
  const { playerToken } = useViewerAuth();
  const [rooms, setRooms] = useState<MemberRoom[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!playerToken) {
      setRooms([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/me/rooms', { headers: { Authorization: `Bearer ${playerToken}` } });
      if (res.ok) setRooms(await res.json());
    } catch {
      // best-effort — leave existing state on transient failure
    } finally {
      setLoading(false);
    }
  }, [playerToken]);

  useEffect(() => { load(); }, [load]);

  const isMember = useCallback(
    (roomId: string) => rooms.some(r => r.roomId === roomId),
    [rooms],
  );

  const join = useCallback(async (
    roomId: string,
    meta?: { name?: string; slug?: string; logoUrl?: string | null },
  ): Promise<boolean> => {
    if (!playerToken) return false;

    setRooms(prev => prev.some(r => r.roomId === roomId) ? prev : [
      ...prev,
      {
        roomId,
        name: meta?.name ?? '',
        slug: meta?.slug ?? '',
        logoUrl: meta?.logoUrl ?? null,
        joinedAt: new Date().toISOString(),
        source: 'self_join',
        lastActivityAt: null,
      },
    ]);

    try {
      const res = await fetch(`/api/me/rooms/${roomId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (!res.ok) throw new Error('join failed');
      return true;
    } catch {
      setRooms(prev => prev.filter(r => r.roomId !== roomId));
      return false;
    }
  }, [playerToken]);

  const leave = useCallback(async (roomId: string): Promise<boolean> => {
    if (!playerToken) return false;

    let removed: MemberRoom | undefined;
    setRooms(prev => {
      removed = prev.find(r => r.roomId === roomId);
      return prev.filter(r => r.roomId !== roomId);
    });

    try {
      const res = await fetch(`/api/me/rooms/${roomId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (!res.ok) throw new Error('leave failed');
      return true;
    } catch {
      setRooms(prev => (removed && !prev.some(r => r.roomId === roomId)) ? [...prev, removed] : prev);
      return false;
    }
  }, [playerToken]);

  return { rooms, loading, isMember, join, leave, refetch: load };
}
