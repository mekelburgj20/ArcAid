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
  /** W126 — the viewer's practice state on this table; absent from a server that predates practice mode. */
  practice?: PracticeState;
};

/**
 * W126 (ADR 0043) — Practice mode. A player PAUSES their attempts on one
 * table; the games they START while paused are practice: no attempt used, off
 * the tournament board, on to the Global Scoreboard. `limit` is the
 * tournament's allowance per player per table (null = not offered, 0 =
 * unlimited, then `left` is null). `paused` is true only while the next game
 * would really be practice (the server reads an open pause with nothing left
 * as not paused).
 */
export type PracticeState = {
  offered: boolean;
  limit: number | null;
  used: number;
  left: number | null;
  paused: boolean;
  pausedTs: number | null;
};

/** The state of a table whose tournament offers no practice (and of a row from an older server). */
export const NO_PRACTICE: PracticeState = { offered: false, limit: null, used: 0, left: null, paused: false, pausedTs: null };

/** Is the viewer in practice mode on this table right now? */
export function isPracticing(item: Pick<RoomAttemptStart, 'practice'>): boolean {
  return item.practice?.paused === true;
}

/**
 * May the viewer press "Pause to practice" here? The same checks the server
 * makes, so the button is never one the press would refuse: practice is
 * offered and not already on, a practice game is left, an attempt is left
 * (there is nothing to protect once they are used), and Start attempts — when
 * the tournament requires it — has been pressed.
 */
export function canPausePractice(item: Pick<RoomAttemptStart, 'practice' | 'left' | 'requireStart' | 'started'>): boolean {
  const p = item.practice;
  if (!p?.offered || p.paused) return false;
  if (p.left === 0 || item.left <= 0) return false;
  return !item.requireStart || item.started;
}

/** "2 practice games left" / "1 practice game left" / "Unlimited practice games" / "No practice games left". */
export function practiceLeftText(p: Pick<PracticeState, 'limit' | 'left'>): string {
  if (p.limit === 0 || p.left == null) return 'Unlimited practice games';
  if (p.left === 0) return 'No practice games left';
  return `${p.left} practice game${p.left === 1 ? '' : 's'} left`;
}

/** What the paused state says, everywhere it is said. */
export const PRACTICE_ON_TEXT = 'Practice mode: games you start now use no attempt and do not count';

/**
 * The lead-in of the room line that names the tables the viewer is practicing
 * on ("Practice mode is on for: Congo"), so a player who forgot to resume sees
 * it on every room page before they play a game they meant to count.
 */
export const PRACTICE_MODE_ON_FOR = 'Practice mode is on for:';

/** The tables that line names (each once, list order), or null when the viewer is practicing on none. */
export function practicingTables(games: RoomAttemptStart[]): RoomAttemptStart[] | null {
  const seen = new Set<string>();
  const out = games.filter(g => isPracticing(g) && !seen.has(g.gameId) && seen.add(g.gameId));
  return out.length > 0 ? out : null;
}

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

/**
 * W126 — press "Pause to practice" (`pause`) or "Resume attempts" (`resume`)
 * on one table. Answers the viewer's new practice state; a refusal carries the
 * server's own sentence (no practice games left, not entered, table closed).
 */
export async function pressAttemptPause(
  roomId: string, item: Pick<RoomAttemptStart, 'tournamentId' | 'gameId'>, playerToken: string, action: 'pause' | 'resume',
): Promise<{ ok: true; practice: PracticeState } | { ok: false; error: string }> {
  const fallback = action === 'pause' ? 'Could not pause your attempts' : 'Could not resume your attempts';
  try {
    const res = await fetch(
      `/api/rooms/${roomId}/tournaments/${item.tournamentId}/games/${item.gameId}/attempt-${action}`,
      { method: 'POST', headers: { Authorization: `Bearer ${playerToken}` } },
    );
    const body = await res.json().catch(() => ({})) as { error?: string; practice?: PracticeState };
    if (!res.ok || !body.practice || typeof body.practice !== 'object') {
      return { ok: false, error: body.error || fallback };
    }
    return { ok: true, practice: body.practice };
  } catch {
    return { ok: false, error: fallback };
  }
}

/** Where a game's name in the strip links: the room game page, which carries the full Start attempts box. */
export function gamePageHref(roomSlug: string, gameName: string): string {
  return `/${roomSlug}/games/${encodeURIComponent(gameName)}`;
}
