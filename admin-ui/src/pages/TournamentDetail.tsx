import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Circle, Trophy } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';
import { playerName } from '../components/ScoreboardComponents';
import { TournamentTypeBadge } from '../components/TournamentTypeBadge';
import { useRoom } from '../contexts/RoomContext';

/**
 * `/:slug/tournaments/:tournamentId` — every score submitted during one
 * tournament, one card per game it featured. Reached by clicking a row on the
 * public History list.
 *
 * Deliberately NOT the room leaderboard: the boards here are scoped by
 * `submitted_during_tournament_id` server-side, so a player's all-time best on
 * a game does not leak into a tournament they didn't play. See
 * `TournamentScoresService` for why that column (and not `game_id`) is the key.
 */

interface ScoreRow {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  display_name: string | null;
  score: number;
  created_at: string | null;
}

interface Board {
  game_key: string;
  game_name: string;
  slot_count: number;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  winner: ScoreRow | null;
  scores: ScoreRow[];
}

interface TournamentScores {
  tournament: {
    id: string;
    name: string;
    type: string;
    is_active: boolean;
    first_start: string | null;
    last_end: string | null;
  };
  boards: Board[];
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Podium medals for ranks 1–3.
 *
 * The colours are the Global Scoreboard's own tokens (`GlobalGameCard`'s
 * `RANK_TINTS`), not new ones: gold reuses the already theme-aware amber,
 * silver and bronze are the `--color-medal-*` variables that ship a
 * light-polarity override. A tie for a place — two rank-1 rows — therefore
 * yields two gold trophies, because the treatment keys off the server's rank
 * and nothing else. Ranks 4+ get no trophy but still get the slot, so every
 * player name in a board starts at the same x.
 */
const RANK_MEDALS: Record<number, { color: string; label: string }> = {
  1: { color: 'text-neon-amber', label: '1st place' },
  2: { color: 'text-medal-silver', label: '2nd place' },
  3: { color: 'text-medal-bronze', label: '3rd place' },
};

/** "Jan 1 – Feb 3, 2026", collapsing to a single date when both ends match. */
function dateRange(from: string | null, to: string | null): string | null {
  const a = shortDate(from);
  const b = shortDate(to);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a || b;
}

export default function TournamentDetail() {
  const { roomSlug, roomId } = useRoom();
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const [data, setData] = useState<TournamentScores | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!roomId || !tournamentId) return;
    setLoading(true);
    setNotFound(false);
    fetch(`/api/rooms/${roomId}/tournaments/${tournamentId}/scores`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.ok ? r.json() : null;
      })
      .then(json => setData(json))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [roomId, tournamentId]);

  const backLink = (
    <Link
      to={`/${roomSlug}/history`}
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-neon-cyan transition-colors no-underline"
    >
      <ChevronLeft size={16} />
      History
    </Link>
  );

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {backLink}
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      </main>
    );
  }

  if (notFound || !data) {
    return (
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {backLink}
        <p className="text-muted text-center py-12">
          Tournament not found.
        </p>
      </main>
    );
  }

  const { tournament, boards } = data;
  const range = dateRange(tournament.first_start, tournament.last_end);

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
      {backLink}

      <header className="mt-3 mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="font-display text-xl sm:text-2xl font-bold text-primary min-w-0 break-words">
            {tournament.name}
          </h1>
          <TournamentTypeBadge type={tournament.type} />
          {tournament.is_active && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-neon-magenta" role="status">
              {/* `.pulse` is already nulled under prefers-reduced-motion by
                  index.css's global guard — no extra media query needed. */}
              <Circle className="pulse h-2 w-2 shrink-0 fill-current" strokeWidth={0} aria-hidden="true" data-testid="live-dot" />
              LIVE
            </span>
          )}
        </div>
        {range && <p className="mt-1 text-xs text-faint">{range}</p>}
      </header>

      {boards.length === 0 ? (
        <p className="text-muted text-center py-12">No scores were submitted during this tournament.</p>
      ) : (
        <div className="space-y-4">
          {boards.map(board => {
            const slotRange = dateRange(board.start_date, board.end_date);
            return (
              <section key={board.game_key} className="bg-surface border border-border rounded-lg overflow-hidden">
                {/* Card header stacks on phones: sharing one line with the slot
                    date range left the game name a ~90px sliver. */}
                <div className="px-4 py-3 border-b border-border/50 flex flex-col sm:flex-row sm:items-baseline gap-x-2 min-w-0">
                  <span className="flex items-baseline gap-2 min-w-0">
                    <Link
                      to={`/${roomSlug}/games/${encodeURIComponent(board.game_name)}`}
                      className="min-w-0 truncate font-display font-bold text-sm text-primary hover:text-neon-cyan transition-colors no-underline"
                    >
                      {board.game_name}
                    </Link>
                    {board.slot_count > 1 && (
                      <span className="flex-shrink-0 whitespace-nowrap text-[10px] uppercase tracking-wider text-neon-cyan">
                        Featured {board.slot_count}×
                      </span>
                    )}
                  </span>
                  {slotRange && (
                    <span className="sm:ml-auto flex-shrink-0 whitespace-nowrap text-xs text-faint">{slotRange}</span>
                  )}
                </div>

                <div className="divide-y divide-border/20">
                  {board.scores.map(row => {
                    const medal = RANK_MEDALS[row.rank];
                    return (
                    <div
                      key={`${row.iscored_username}-${row.rank}-${row.score}`}
                      className="flex items-center gap-3 px-4 py-2.5"
                    >
                      <span className={`font-display font-bold text-sm w-6 text-center flex-shrink-0 ${
                        row.rank === 1 ? 'text-neon-amber' :
                        row.rank === 2 ? 'text-neon-cyan' :
                        row.rank === 3 ? 'text-neon-green' :
                        'text-faint'
                      }`}>
                        {row.rank}
                      </span>
                      {/* Slot is always present so rank 4+ names align with the
                          podium's. */}
                      <span className="flex w-3 flex-shrink-0 items-center justify-center">
                        {medal && <Trophy size={12} className={medal.color} aria-label={medal.label} />}
                      </span>
                      {/* Name + date share the ONE flexible column: stacked on
                          phones (where an inline date would starve the name),
                          inline from `sm` up. The date stays visible at every
                          width — it's half the point of the page. */}
                      <span className="min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
                        <Link
                          to={`/${roomSlug}/players/${encodeURIComponent(row.iscored_username)}`}
                          className={`min-w-0 truncate text-sm no-underline hover:text-neon-cyan transition-colors ${
                            row.rank === 1 ? 'text-neon-amber font-medium' : 'text-primary'
                          }`}
                        >
                          {playerName(row)}
                        </Link>
                        <span className="flex-shrink-0 whitespace-nowrap text-xs text-faint">
                          {shortDate(row.created_at) || '—'}
                        </span>
                      </span>
                      {/* Score is content-sized and never shrinks; the name
                          beside it yields instead. Containment doctrine. */}
                      <span
                        className={`ml-auto flex-shrink-0 whitespace-nowrap tabular-nums font-display font-bold text-sm ${
                          row.rank === 1 ? 'text-neon-amber' : 'text-primary'
                        }`}
                        title={scoreTitle(row.score)}
                      >
                        {formatScore(row.score)}
                      </span>
                    </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
