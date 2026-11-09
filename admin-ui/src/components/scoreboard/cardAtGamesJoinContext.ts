import { createContext } from 'react';

/** One live round card a viewer can join on AtGames (`GET /:roomId/atgames/joinable`). */
export type AtGamesJoinable = {
  gameId: string;
  tournamentId: string;
  tournamentName: string;
  /** Null for a signed-out viewer (the server withholds it). */
  code: string | null;
};

/**
 * v2.234.0 (A36) — what a room scoreboard card needs to draw its "Join on
 * AtGames" control, in the strip where "Start attempts" sits. Provided ONCE by
 * the public Scoreboard page from one room-level read; no card fetches.
 *
 * No provider = no control (admin preview, kiosk). Its own module so the
 * component file exports only its component (`react-refresh/only-export-components`).
 */
export type CardAtGamesJoinValue = {
  byGameId: Record<string, AtGamesJoinable>;
  /** Tournaments this viewer joined in this browser (shows "Joined on AtGames"). */
  joined: Set<string>;
  open: (item: AtGamesJoinable) => void;
};

export const CardAtGamesJoinContext = createContext<CardAtGamesJoinValue | null>(null);
