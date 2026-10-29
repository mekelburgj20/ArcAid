import { createContext } from 'react';
import type { RoomAttemptStart } from '../../lib/attemptStarts';

/**
 * W56 — what a room scoreboard card needs to draw its "Start attempts"
 * control. Provided ONCE by the public Scoreboard page from its single
 * room-level read (`GET /api/rooms/:roomId/attempt-starts/me`); no card
 * fetches anything itself.
 *
 * No provider = no control: the admin Leaderboard preview, the kiosk and any
 * other host of `ScoreboardSurface` render the cards exactly as before.
 *
 * Its own module (not an export of `CardAttemptStart.tsx`) so that file keeps
 * exporting only its component — `react-refresh/only-export-components`.
 */
export type CardAttemptStartValue = {
  /** The viewer's list, keyed on `games.id`. Only games in it get a control. */
  byGameId: Record<string, RoomAttemptStart>;
  /** The game whose press is in flight (its button reads "Starting…"). */
  pendingGameId: string | null;
  /** Press Start attempts for one listed game. */
  start: (item: RoomAttemptStart) => void;
};

export const CardAttemptStartContext = createContext<CardAttemptStartValue | null>(null);
