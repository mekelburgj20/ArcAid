import { Link } from 'react-router-dom';
import { type ReactNode } from 'react';
import { usePlayerQuickView, type PlayerEntryLike } from '../contexts/PlayerQuickViewContext';
import { playerName } from './ScoreboardComponents';

interface Props {
  /** Room slug for navigation / context. */
  slug: string;
  /** Player entry — needs at minimum `iscored_username`. Optional fields
   *  (display_name, discord_user_id, avatar_hash) are used by the modal
   *  header. */
  entry: PlayerEntryLike;
  /** Tab the user came from. Threaded into the navigation URL so
   *  PlayerDetail's back link can return to the correct tab. */
  fromTab?: string | null;
  /** Additional class names (text color / weight etc.). */
  className?: string;
  /** Optional inline style (used by Showcase/ScoreList variants whose name
   *  color comes from the dynamic theme tokens). */
  style?: React.CSSProperties;
  /** Optional caller-provided onClick (typically `e => e.stopPropagation()`
   *  on rows that have their own click handler that shouldn't fire when the
   *  player name is clicked). Runs BEFORE the modal-trigger logic. */
  onClick?: (e: React.MouseEvent) => void;
  /** Override the rendered text. Defaults to `playerName(entry)`. */
  children?: ReactNode;
}

/**
 * v2.13.16 — wraps a player name in a Link that opens the PlayerQuickView
 * modal on plain left-click and falls through to the full PlayerDetail
 * page on modifier-click (ctrl/cmd/shift) so middle-click / cmd-click still
 * opens in a new tab. The Link's href is the real PlayerDetail URL with
 * `?from=<slug>&tab=<tab>` threaded through, so users who choose to
 * navigate directly land with the back link correctly preserved.
 *
 * Replaces inline `<Link to={`/${slug}/players/${name}`}>{name}</Link>`
 * patterns across the public scoreboard. Must be used inside a
 * `PlayerQuickViewProvider` (wired into PublicLayout).
 */
export default function PlayerNameLink({
  slug,
  entry,
  fromTab,
  className,
  style,
  onClick,
  children,
}: Props) {
  // null when no PlayerQuickViewProvider is mounted (e.g. admin Settings preview
  // / admin Leaderboard). In that case the name stays a plain Link to the full
  // player page instead of crashing the page.
  const quickView = usePlayerQuickView();

  const href = `/${slug}/players/${encodeURIComponent(entry.iscored_username)}?from=${encodeURIComponent(slug)}${fromTab ? `&tab=${fromTab}` : ''}`;

  return (
    <Link
      to={href}
      onClick={(e) => {
        // Caller-supplied onClick (e.g., e.stopPropagation()) runs first.
        onClick?.(e);
        // Plain left-click → open modal WHEN a provider is present. Without one,
        // fall through to the real <Link href>. Modifier-click always falls
        // through so middle-click / cmd-click / new-tab works.
        if (quickView && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          e.preventDefault();
          quickView.open({ slug, entry, fromTab });
        }
      }}
      className={className}
      style={style}
    >
      {children ?? playerName(entry)}
    </Link>
  );
}
