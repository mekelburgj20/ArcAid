/**
 * W56 (ADR 0033 §4) — the room's top-level "Start attempts" list.
 *
 * In a Limited-attempts tournament whose host turned on "Require Start
 * attempts", a player's plays on a table go to the Global Scoreboard (and use
 * no attempt) until they press Start attempts for that table. The button used
 * to live only on the game page; this list puts it on every room scoreboard
 * card and in the "Your scores go to" strip.
 *
 * ONE read, `GET /api/rooms/:roomId/attempt-starts/me`, answers both: every
 * open game of this room in such a tournament that the viewer is allowed in,
 * with whether they pressed it. The press is the existing per-game POST.
 *
 * W82 — the same read now lists EVERY open limited-attempts game the viewer
 * is in (start-required or not) with their own counts, for the card's
 * "N attempts left" badge. `started`/`startedTs` mean something only when
 * `requireStart` is true: gate the press (and "needs starting") on it.
 */
export type RoomAttemptStart = {
  gameId: string;
  gameName: string;
  tournamentId: string;
  tournamentName: string | null;
  roundNo: number | null;
  started: boolean;
  startedTs: number | null;
  /** The tournament's attempt limit. */
  limit: number;
  /** The viewer's attempts on this table, void excluded. */
  used: number;
  /** `max(0, limit − used)`, from the server (the W81 rule, `lib/attemptsLeft.ts`). */
  left: number;
  /** Does the tournament make players press Start attempts first? */
  requireStart: boolean;
};

/**
 * Fired on `window` after a press, so the strip in `PublicLayout` (a separate
 * component from the Scoreboard page that owns the cards) re-reads the list.
 */
export const ATTEMPT_STARTS_CHANGED_EVENT = 'arcaid:attempt-starts-changed';

/** The list for this room, or `[]` on any failure (the controls simply don't render). */
export async function fetchRoomAttemptStarts(roomId: string, playerToken: string): Promise<RoomAttemptStart[]> {
  try {
    const res = await fetch(`/api/rooms/${roomId}/attempt-starts/me`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    if (!res.ok) return [];
    const body = await res.json() as { games?: unknown };
    return Array.isArray(body.games) ? body.games as RoomAttemptStart[] : [];
  } catch {
    return [];
  }
}

/** Press Start attempts on one table (the existing W38 POST). */
export async function pressAttemptStart(
  roomId: string, item: Pick<RoomAttemptStart, 'tournamentId' | 'gameId'>, playerToken: string,
): Promise<{ ok: true; startedTs: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `/api/rooms/${roomId}/tournaments/${item.tournamentId}/games/${item.gameId}/attempt-start`,
      { method: 'POST', headers: { Authorization: `Bearer ${playerToken}` } },
    );
    const body = await res.json().catch(() => ({})) as { error?: string; startedTs?: number };
    if (!res.ok || typeof body.startedTs !== 'number') {
      return { ok: false, error: body.error || 'Could not start your attempts' };
    }
    return { ok: true, startedTs: body.startedTs };
  } catch {
    return { ok: false, error: 'Could not start your attempts' };
  }
}

/** Where a game's name in the strip links: the room game page, which carries the full Start attempts box. */
export function gamePageHref(roomSlug: string, gameName: string): string {
  return `/${roomSlug}/games/${encodeURIComponent(gameName)}`;
}
