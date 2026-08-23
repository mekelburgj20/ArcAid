import { Medal, Plus, Minus, BadgeCheck, ChevronRight } from 'lucide-react';
import type { RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import PlayerNameLink from '../PlayerNameLink';
import FitRowName from './FitRowName';
import { ARCADE_RANK_TINTS } from './arcadeNeon';
import type { ScoreHistoryEntry } from './useScoreExpand';
import { resolveRowClick, opensQuickView, QUICK_VIEW_HINT } from '../../lib/scoreGesture';
import { formatScore, parseServerDate } from '../../lib/format';

/**
 * The Arcade card's podium — places 1-3, filled or open.
 *
 * ─── Why this is its own file ───
 *
 * It is a SWAP SEAM. The owner is sending a replacement podium design, and the
 * whole point of extracting it (following the `ShowcaseCard`/`ShowcasePodium`
 * precedent exactly) is that dropping that design in should be a one-file
 * change with no edits to `ArcadeCard`. Two rules keep it that way:
 *
 *   1. ALL rank-1-3 rendering lives here. `ArcadeCard` renders ranks 4+ with
 *      its own row component and never reaches into this file for one.
 *      (`ShowcaseCard` splits the same way: `ShowcasePodium` for the podium,
 *      `ScoreList` for the tail.) The small amount of duplicated row markup
 *      between the two is the price of the seam and is paid deliberately — a
 *      shared row would travel with the podium on every swap.
 *   2. Colours are CSS TOKENS, never literal hex. Gold/silver/bronze come from
 *      the `--sb-row-*` family (which already carries the light-polarity
 *      overrides: `.theme-light`, `.theme-arctic`, `.theme-paper`), and the
 *      card's category neon
 *      arrives as the inherited `--arc-neon` custom property. A replacement
 *      design that reads the same tokens is theme-correct for free.
 *
 * ─── What it renders ───
 *
 * Three places, ALWAYS — a floor, not a ceiling, exactly as the Global
 * Scoreboard card does. An unfilled place keeps its medal and offers "Claim
 * this spot", which fires the card's submit flow. An empty podium is therefore
 * recognisably the same object as a full one, and it says what is ON OFFER
 * rather than that the board is empty.
 *
 * Room-card behaviour the Global original has no equivalent for is carried
 * here too: the verified badge, the inline score-history expand (`+`/`-` with
 * the history panel dropping directly under the row), and `PlayerNameLink` on
 * the username. Names use `FitRowName` (scale-to-fit), never `truncate` — the
 * no-ellipsis doctrine applies to player names as much as to game titles.
 */

/** The three places a card always shows, filled or not.
 *  (Not exported — non-component exports break fast-refresh; the tint table
 *  moved to `arcadeNeon.ts` for the same reason.) */
const ARCADE_PODIUM_RANKS = [1, 2, 3] as const;

export interface ArcadePodiumProps {
  /** Top 3 (or fewer) — index order, not rank-keyed. */
  entries: RankedEntry[];
  /** Room slug, for the player-stats link on usernames. */
  slug: string;
  /** The signed-in viewer's iScored username, so their row can be marked. */
  viewerUsername?: string;
  /** Fired by an empty place's "Claim this spot" button. */
  onClaim?: (rank: number) => void;
  hasMultiple?: (username: string) => boolean;
  expandedPlayer?: string | null;
  playerHistory?: ScoreHistoryEntry[];
  historyLoading?: boolean;
  onTogglePlayer?: (username: string) => void;
  /** v2.109.0 (score-gesture-photos) — opens the game quick popup. */
  onOpenQuickView?: () => void;
}

/** The expanded per-player score history, dropped under its row. */
function ExpandedHistory({ playerHistory, historyLoading, onOpenQuickView }: {
  playerHistory?: ScoreHistoryEntry[];
  historyLoading?: boolean;
  /** v2.109.0 (score-gesture-photos) — a nested row's click also opens the popup. */
  onOpenQuickView?: () => void;
}) {
  return (
    <div className="mx-2 mt-0.5 mb-1 rounded bg-deep/50 px-2 py-1" data-testid="arcade-history">
      {historyLoading ? (
        <p className="py-0.5 text-[11px] text-faint">Loading…</p>
      ) : (playerHistory && playerHistory.length > 0) ? (
        <div className="space-y-0.5">
          {playerHistory.map(h => (
            <div
              key={h.id}
              className={`flex items-center justify-between text-[11px] ${onOpenQuickView ? 'cursor-pointer' : ''}`}
              onClick={onOpenQuickView}
            >
              <span className="text-muted">{h.score.toLocaleString()}</span>
              <span className="text-faint">{parseServerDate(h.created_at)?.toLocaleDateString() ?? ''}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-0.5 text-[11px] text-faint">No additional scores.</p>
      )}
    </div>
  );
}

/** A filled podium place. */
function PodiumRow({
  entry, rank, slug, isViewer, canExpand, isExpanded, onToggle, onOpenQuickView,
}: {
  entry: RankedEntry;
  rank: number;
  slug: string;
  isViewer: boolean;
  canExpand: boolean;
  isExpanded: boolean;
  onToggle?: () => void;
  /** v2.109.0 (score-gesture-photos) — opens the quick popup. */
  onOpenQuickView?: () => void;
}) {
  const tint = ARCADE_RANK_TINTS[rank];
  const abbreviated = formatScore(entry.score);
  // The viewer's own row wins the tint even at rank 1-3: "this is me" is the
  // more useful signal on a board someone opened to find themselves on.
  const bg = isViewer ? 'var(--sb-row-you-bg)' : (tint?.bg ?? 'transparent');
  const border = isViewer ? 'var(--sb-row-you-border)' : (tint?.border ?? 'transparent');
  const onRowClick = resolveRowClick(canExpand, isExpanded, () => onToggle?.(), onOpenQuickView);
  const showHint = opensQuickView(canExpand, isExpanded, !!onOpenQuickView);

  return (
    <div
      data-testid={`arcade-place-${rank}`}
      className={`flex items-center gap-2 rounded-[6px] border px-2 py-[6px] ${onRowClick ? 'cursor-pointer' : ''}`}
      style={{ background: bg, borderColor: border }}
      onClick={onRowClick}
      title={showHint ? QUICK_VIEW_HINT : undefined}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">
        <Medal className={`h-[18px] w-[18px] ${tint.medal}`} aria-label={tint.label} />
      </span>
      <PlayerAvatar
        username={playerName(entry)}
        discordUserId={entry.discord_user_id}
        avatarHash={entry.avatar_hash}
        avatarUrl={entry.avatar_url}
        size={26}
      />
      <FitRowName origin="left" className={`sb-art-text min-w-0 flex-1 sb-row-name text-[16px] ${isViewer ? 'font-bold' : 'font-medium'}`}>
        <PlayerNameLink
          slug={slug}
          entry={entry}
          onClick={e => e.stopPropagation()}
          className="text-primary no-underline transition-colors hover:text-neon-cyan"
        />
      </FitRowName>
      {entry.verified && (
        <span className="inline-flex shrink-0 items-center text-neon-green" title="Verified by an admin" aria-label="Verified score">
          <BadgeCheck size={13} />
        </span>
      )}
      <span
        className={`sb-art-text shrink-0 sb-row-score font-mono text-[16px] font-bold tabular-nums ${rank === 1 ? 'text-neon-amber' : isViewer ? 'text-neon-cyan' : 'text-primary'}`}
        title={abbreviated.endsWith('T') ? entry.score.toLocaleString() : undefined}
      >
        {abbreviated}
      </span>
      {canExpand && isExpanded ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
          className="shrink-0 p-1 -m-1 text-neon-cyan cursor-pointer"
          aria-label="Hide score history"
          title="Hide score history"
        >
          <Minus size={12} />
        </button>
      ) : canExpand ? (
        <Plus size={12} className="shrink-0 text-faint" />
      ) : showHint ? (
        <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />
      ) : null}
    </div>
  );
}

/**
 * An unclaimed podium place.
 *
 * A <button> firing the card's submit flow — the same flow the scoreboard's
 * `+` control opens. The dashed circle stands in for the absent avatar so a
 * mixed podium (1st taken, 2nd and 3rd open) keeps one aligned column of names.
 */
export function ArcadeClaimRow({ rank, onClaim }: { rank: number; onClaim?: () => void }) {
  const tint = ARCADE_RANK_TINTS[rank];
  return (
    <button
      type="button"
      onClick={onClaim}
      data-testid={`arcade-claim-place-${rank}`}
      /* Named for the PLACE, so `getByLabelText('1st place')` keeps meaning
         "somebody holds first" and can't be satisfied by an empty row. */
      aria-label={`Claim ${tint.label}`}
      title={`Nobody holds ${tint.label} on this board yet — submit a score and take it`}
      className="arc-claim-row flex w-full items-center gap-2 rounded-[6px] border border-dashed px-2 py-[6px] text-left transition-colors"
      style={{ borderColor: tint.border }}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">
        <Medal className={`h-[18px] w-[18px] opacity-80 ${tint.medal}`} aria-hidden="true" />
      </span>
      <span
        className="h-[26px] w-[26px] shrink-0 rounded-full border border-dashed"
        style={{ borderColor: tint.border }}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 text-[16px] font-semibold text-muted">
        Claim this spot
      </span>
      <span
        className="shrink-0 text-[16px] font-bold leading-none"
        style={{ color: 'var(--arc-neon)' }}
        aria-hidden="true"
      >
        →
      </span>
    </button>
  );
}

export default function ArcadePodium({
  entries,
  slug,
  viewerUsername,
  onClaim,
  hasMultiple,
  expandedPlayer,
  playerHistory,
  historyLoading,
  onTogglePlayer,
  onOpenQuickView,
}: ArcadePodiumProps) {
  const lowerViewer = viewerUsername?.toLowerCase();

  return (
    <div className="space-y-1.5" data-testid="arcade-podium">
      {ARCADE_PODIUM_RANKS.map(rank => {
        const entry = entries[rank - 1];
        if (!entry) {
          return <ArcadeClaimRow key={`place-${rank}`} rank={rank} onClaim={() => onClaim?.(rank)} />;
        }
        const canExpand = hasMultiple?.(entry.iscored_username) ?? false;
        const isExpanded = expandedPlayer === entry.iscored_username;
        return (
          <div key={`place-${rank}`}>
            <PodiumRow
              entry={entry}
              rank={rank}
              slug={slug}
              isViewer={!!lowerViewer && entry.iscored_username.toLowerCase() === lowerViewer}
              canExpand={canExpand}
              isExpanded={isExpanded}
              onToggle={() => onTogglePlayer?.(entry.iscored_username)}
              onOpenQuickView={onOpenQuickView}
            />
            {isExpanded && (
              <ExpandedHistory playerHistory={playerHistory} historyLoading={historyLoading} onOpenQuickView={onOpenQuickView} />
            )}
          </div>
        );
      })}
    </div>
  );
}
