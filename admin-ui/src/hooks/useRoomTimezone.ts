import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DEFAULT_TIMEZONE, resolveRoomTimezone } from '../lib/timezone';

type State = { timezone: string; loaded: boolean };

/**
 * The room's default timezone (`ROOM_TIMEZONE` setting) via the existing room
 * settings GET. DEFAULT_TIMEZONE with `loaded: false` until it arrives; on a
 * failed read it settles on DEFAULT_TIMEZONE with `loaded: true`, which is what
 * every admin surface showed before the setting existed.
 */
export function useRoomTimezone(roomId: string | undefined): State {
  // Keyed by the room it was read for, so a roomId change reads as "not loaded"
  // without a synchronous reset inside the effect.
  const [result, setResult] = useState<{ roomId: string; timezone: string } | null>(null);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    api.get<Record<string, string>>(`/rooms/${roomId}/settings`)
      .then(settings => {
        if (!cancelled) setResult({ roomId, timezone: resolveRoomTimezone(settings) });
      })
      .catch(() => {
        if (!cancelled) setResult({ roomId, timezone: DEFAULT_TIMEZONE });
      });
    return () => { cancelled = true; };
  }, [roomId]);

  if (!roomId) return { timezone: DEFAULT_TIMEZONE, loaded: true };
  if (result?.roomId !== roomId) return { timezone: DEFAULT_TIMEZONE, loaded: false };
  return { timezone: result.timezone, loaded: true };
}
