import { createContext } from 'react';

/**
 * v2.237.0 (A40) — how Arcaid knows the viewer is in an event's AtGames
 * tournament: joined through Arcaid (`arcaid`), found already in it at Arcaid's
 * Join (`verified`), an AtGames score already pulled (`scores`), or the player
 * said so (`self`, the only one they can take back). Stored per player on the
 * server, so every device and both surfaces agree.
 */
export type AtGamesJoinedVia = 'arcaid' | 'verified' | 'scores' | 'self';

/** One live round card a viewer can join on AtGames (`GET /:roomId/atgames/joinable`). */
export type AtGamesJoinable = {
  gameId: string;
  tournamentId: string;
  tournamentName: string;
  /** Null for a signed-out viewer (the server withholds it). */
  code: string | null;
  /** Null when Arcaid does not know the viewer is in it (always null signed out). */
  joinedVia?: AtGamesJoinedVia | null;
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
  /** Tournaments the viewer is known to be in (shows "Joined on AtGames"). */
  joined: Set<string>;
  open: (item: AtGamesJoinable) => void;
};

export const CardAtGamesJoinContext = createContext<CardAtGamesJoinValue | null>(null);
