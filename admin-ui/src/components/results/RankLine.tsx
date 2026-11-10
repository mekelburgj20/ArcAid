import { Link } from 'react-router-dom';
import { formatScore, scoreTitle } from '../../lib/format';
import { PlayerAvatar } from '../ScoreboardComponents';

/** What `RankLine` needs to draw a player's avatar. */
export interface AvatarSource {
  discordUserId?: string | null;
  avatarHash?: string | null;
  avatarUrl?: string | null;
}

const RANK_TINT = (rank: number) =>
  rank === 1 ? 'text-neon-amber' : rank === 2 ? 'text-neon-cyan' : rank === 3 ? 'text-neon-green' : 'text-faint';

/**
 * One ranked player line on the results pages: a run card's final standings
 * and the tournament page's per-table boards (moved out of TournamentDetail,
 * v2.241.0 B26). Stats surface: the rank number carries the podium, no trophy
 * icons (owner call, 2026-08-02). The score is content-sized and never
 * shrinks; the name beside it yields instead.
 */
export default function RankLine({ slug, rank, username, label, score, date, avatar, avatarSize = 40 }: {
  slug: string | undefined;
  rank: number;
  /** Routing key for `/players/:name` (the iScored name). */
  username: string;
  /** What to show (`display_name ?? iscored_username`). */
  label: string;
  score: number;
  /** By table only: when the score was set. Omitted on a run's board. */
  date?: string | null;
  avatar?: AvatarSource;
  avatarSize?: number;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={`font-display font-bold text-base w-7 text-center flex-shrink-0 ${RANK_TINT(rank)}`}>
        {rank}
      </span>
      {avatar && (
        <PlayerAvatar
          username={label}
          discordUserId={avatar.discordUserId}
          avatarHash={avatar.avatarHash}
          avatarUrl={avatar.avatarUrl}
          size={avatarSize}
        />
      )}
      {/* Name + date share the ONE flexible column: stacked on phones (where
          an inline date would starve the name), inline from `sm` up. */}
      <span className="min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
        <Link
          to={`/${slug}/players/${encodeURIComponent(username)}`}
          className={`min-w-0 truncate text-base no-underline hover:text-neon-cyan transition-colors ${
            rank === 1 ? 'text-neon-amber font-medium' : 'text-primary'
          }`}
        >
          {label}
        </Link>
        {date !== undefined && (
          <span className="flex-shrink-0 whitespace-nowrap text-xs text-faint">{shortDate(date) || '—'}</span>
        )}
      </span>
      <span
        className={`ml-auto flex-shrink-0 whitespace-nowrap tabular-nums font-display font-bold text-base ${
          rank === 1 ? 'text-neon-amber' : 'text-primary'
        }`}
        title={scoreTitle(score)}
      >
        {formatScore(score)}
      </span>
    </div>
  );
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
