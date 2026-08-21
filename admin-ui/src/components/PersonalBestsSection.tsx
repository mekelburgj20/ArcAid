import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';
import { compareByRank } from '../lib/searchRank';

/**
 * A Personal Best row. Two call sites share this shape (v2.82.0 — moved from
 * PlayerDetail.tsx, see plan decision 5 at docs/contracts/my-stats-v282-plan.md):
 *
 * - PlayerDetail's room-scoped `/stats/enhanced/player/:id` — rows carry
 *   `room_rank`, no `source`/`room_slug`/`room_name`/`global_game_id`. The
 *   `slug` prop supplies the link target (the room the page is already in).
 * - My Stats' cross-room `GET /api/me/stats` — rows carry `rank` (same
 *   meaning as `room_rank`, renamed because a My Stats row isn't necessarily
 *   room-scoped) plus `source` ('room' | 'global') and, for room rows,
 *   `room_slug`/`room_name` (which room); for global rows, `global_game_id`.
 */
export interface PersonalBestRow {
  game_name: string;
  best_score: number;
  /** Legacy field — PlayerDetail rows only. */
  room_rank?: number;
  /** My Stats field — same meaning as `room_rank`. A real row always has one
   *  or the other. */
  rank?: number;
  total_players: number;
  achieved_at: string;
  /** My Stats provenance. Absent (PlayerDetail rows) renders exactly as
   *  before this section moved — no chip, no caption, `slug`-prop link. */
  source?: 'room' | 'global';
  room_slug?: string;
  room_name?: string;
  /** Room leg only (owner revision, screenshot review). When present and
   *  `showRoomCaption` is on, rendered as a small logo in place of the
   *  `room_name` text caption. Nullable — falls back to the text caption. */
  room_logo_url?: string | null;
  global_game_id?: string;
}

/** Back-compat alias — PlayerDetail imported this name before the move. */
export type PersonalBest = PersonalBestRow;

/**
 * Per-row link target (plan decision 5):
 *   - global row -> `/games/:global_game_id`, or no link if the id is missing.
 *   - room row carrying its own `room_slug` (My Stats, cross-room) ->
 *     `/:room_slug/games/:game_name`.
 *   - otherwise fall back to the `slug` prop (PlayerDetail — already inside
 *     the one room the row belongs to).
 *   - no link at all if none of the above resolve.
 */
function resolveBestLink(pb: PersonalBestRow, slug?: string): string | null {
  if (pb.source === 'global') {
    return pb.global_game_id ? `/games/${pb.global_game_id}` : null;
  }
  const roomSlug = pb.room_slug || slug;
  return roomSlug ? `/${roomSlug}/games/${encodeURIComponent(pb.game_name)}` : null;
}

/**
 * Shared header/row grid template. `grid-cols-4` (four equal fractions) used to
 * let a 10+ digit Best bleed into the Room Rank column at 390px.
 *
 * The score, rank and date tracks are `auto` — i.e. `minmax(min-content,
 * max-content)`, so they are never squeezed below the number they hold. A `rem`
 * floor was tried first and is wrong: `minmax(5.5rem, auto)` still lets the
 * track shrink to 5.5rem when space is tight, which clipped a 12-digit score at
 * 390px. The game name is the one flexible track (`minmax(0,1fr)`) and it
 * truncates instead — a truncated title is readable, a truncated number is not.
 *
 * Four content-sized columns plus a 12-digit score do not fit on a 390px phone
 * at all: the name track collapsed to 0 and the titles vanished. A first pass
 * reflowed to two columns (Game | Best) with rank + date as a caption, but the
 * name still shared its line with the number and truncated to "Attack from
 * Mar…". So below `sm` each row now STACKS: line 1 is the game name across
 * both tracks, line 2 is the rank/date caption left and the score right. Same
 * shape History uses; the number keeps its own space either way.
 *
 * One grid still holds both lines — a separate mobile list would duplicate
 * every game link in the DOM, which the section's tests count. `col-span-2`
 * on the name cell is what makes line 1 full-width, and the two desktop-only
 * cells simply drop out of flow.
 *
 * Column gaps come from per-cell padding, not `gap-x`: the row divider lives on
 * each cell (a shared grid has no row element to hang it on), and a column gap
 * would chop that divider into disconnected segments. The divider sits on the
 * row's LAST line, so on phones the name cell carries no rule (`sm:border-b`
 * only) and the line-2 cells carry it instead.
 */
const PERSONAL_BESTS_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]';

/** Header-strip cell: a grid child, so the row chrome lives on the cell.
 *  Hidden on phones — the stacked layout has no columns to label. */
const PB_HEAD = 'hidden sm:block py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider truncate';

/** Rows shown by default before the "Show all N" toggle is used. */
const PERSONAL_BESTS_DEFAULT_VISIBLE = 20;
/** Below this many rows a search box is more clutter than help. */
const PERSONAL_BESTS_SEARCH_THRESHOLD = 5;

/**
 * Searchable Personal Bests (ROADMAP line 11). The UNFILTERED list arrives
 * already ordered by rank ASC (`room_rank`/`rank`) from the backend — never
 * re-sort that view. Filtering is deliberately client-side (the endpoints
 * take no search param); the BE limit is raised to ~1000 so the list the FE
 * filters over is effectively complete.
 *
 * Search-relevance work package (2026-08-13): while a query IS active, the
 * FILTERED view is re-ranked nearest-exact-match first on `game_name` —
 * this only reorders matches already found by the filter below, it never
 * changes which rows are shown.
 *
 * Collapse/expand applies to the UNFILTERED view only — while a query is
 * active every match is shown, because a hidden match is exactly the failure
 * mode the search exists to prevent.
 */
export function PersonalBestsSection({
  personalBests,
  slug,
  rankHeader = 'Room Rank',
  showRoomCaption = false,
  wrapTitles = false,
}: {
  personalBests?: PersonalBestRow[];
  /** Room slug to link into when a row doesn't carry its own `room_slug`
   *  (the PlayerDetail call site — a single-room page). */
  slug?: string;
  /** Header label for the rank column. PlayerDetail keeps "Room Rank"
   *  (default); My Stats passes "Rank" since rows can span rooms + Global. */
  rankHeader?: string;
  /** v2.82.0 My Stats — show the room's identity under a room row's game
   *  name when browsing the cross-room "All" scope: the room's logo when it
   *  has one (`room_logo_url`), else the `room_name` text caption. Global
   *  rows show the "Global Scoreboard" chip instead, never this. Default off
   *  so PlayerDetail's single-room view is unaffected. */
  showRoomCaption?: boolean;
  /** v2.82.0 (owner revision) — wrap long game titles onto additional lines
   *  instead of ellipsizing. Standing owner preference ("fully readable, no
   *  ellipsis cutoff") first set on the dashboard cards, applied here for My
   *  Stats. Rows grow taller to fit — accepted. Default off so PlayerDetail
   *  keeps its existing truncating layout exactly as before. */
  wrapTitles?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  const all = personalBests ?? [];
  const trimmed = query.trim();
  const filtering = trimmed.length > 0;

  const matches = useMemo(() => {
    if (!filtering) return all;
    const needle = trimmed.toLowerCase();
    const found = all.filter(pb => pb.game_name.toLowerCase().includes(needle));
    found.sort(compareByRank(trimmed, pb => pb.game_name));
    return found;
  }, [all, filtering, trimmed]);

  if (all.length === 0) return null;

  const collapsed = !filtering && !showAll && matches.length > PERSONAL_BESTS_DEFAULT_VISIBLE;
  const visible = collapsed ? matches.slice(0, PERSONAL_BESTS_DEFAULT_VISIBLE) : matches;
  const showSearch = all.length > PERSONAL_BESTS_SEARCH_THRESHOLD;

  return (
    <div className="mt-8">
      <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Personal Bests</h2>

      {showSearch && (
        <div className="relative mb-3 max-w-sm">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search your games…"
            aria-label="Search your personal bests"
            className="w-full bg-surface border border-border rounded pl-8 pr-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none"
          />
        </div>
      )}

      {filtering && (
        <p className="text-faint text-xs mb-2">
          {matches.length} of {all.length} games
        </p>
      )}

      {/* Header and rows share ONE grid so the header labels sit over the
          columns they name. Two sibling grids (the previous shape) size their
          tracks independently, so the moment the score track grew for a long
          value the header drifted off it. */}
      <div className={`bg-surface border border-border rounded-lg overflow-hidden ${PERSONAL_BESTS_GRID} gap-y-0`}>
        <span className={`${PB_HEAD} pl-5 pr-3`}>Game</span>
        <span className={`${PB_HEAD} pr-5 sm:pr-4 text-right`}>Best</span>
        <span className={`${PB_HEAD} hidden sm:block pr-4 text-right`}>{rankHeader}</span>
        <span className={`${PB_HEAD} hidden sm:block pr-5 text-right`}>Date</span>
        {visible.length === 0 ? (
          <div className="col-span-2 sm:col-span-4 px-5 py-4 text-muted text-sm">No games match &ldquo;{trimmed}&rdquo;</div>
        ) : (
          visible.map((pb, i) => {
            const rankValue = pb.rank ?? pb.room_rank ?? 0;
            const link = resolveBestLink(pb, slug);
            const isGlobal = pb.source === 'global';
            // Owner revision (screenshot review) — the room's logo takes the
            // caption's place when the room has one; the room-name text is
            // the fallback for rooms without a logo, not shown alongside it.
            const roomLogoUrl = showRoomCaption && !isGlobal ? pb.room_logo_url : null;
            const roomCaption = showRoomCaption && !isGlobal && !roomLogoUrl && pb.room_name ? pb.room_name : null;
            const hasExtra = isGlobal || !!roomCaption || !!roomLogoUrl;

            const last = i === visible.length - 1;
            // Class strings are whole literals, never concatenated fragments —
            // Tailwind's scanner only sees complete utility names in source.
            const rule = last ? '' : 'border-b border-border/30';
            // Line 1 on phones: no rule (the row continues below); the rule
            // returns from `sm` up, where line 1 IS the row. Rows carrying a
            // chip/caption stack vertically even at `sm`+ (name + badge don't
            // fit one line next to a rank/date column), so they skip the
            // `items-center` single-line layout the plain case uses.
            const nameCell = hasExtra
              ? `flex flex-col items-start justify-center gap-0.5 pt-3 pb-1 sm:py-3 ${last ? '' : 'sm:border-b sm:border-border/30'}`
              : `flex items-center pt-3 pb-1 sm:py-3 ${last ? '' : 'sm:border-b sm:border-border/30'}`;
            // Line 2 on phones: carries the row's rule.
            const lineTwo = `flex items-center pb-3 pt-0 sm:py-3 ${rule}`;
            const cell = `flex items-center py-3 ${rule}`;

            // Class strings are whole literals (see note above) — the
            // truncate/wrap choice is a full swap, never a concatenated
            // `truncate`-minus fragment.
            const linkClass = wrapTitles
              ? 'max-w-full break-words whitespace-normal text-primary hover:text-neon-cyan no-underline transition-colors font-medium'
              : 'max-w-full truncate text-primary hover:text-neon-cyan no-underline transition-colors font-medium';
            const plainClass = wrapTitles
              ? 'max-w-full break-words whitespace-normal text-primary font-medium'
              : 'max-w-full truncate text-primary font-medium';

            const nameNode = link ? (
              <Link to={link} data-testid="pb-game-name" className={linkClass}>
                {pb.game_name}
              </Link>
            ) : (
              <span data-testid="pb-game-name" className={plainClass}>
                {pb.game_name}
              </span>
            );

            return (
              <Fragment key={i}>
                <span className={`${nameCell} col-span-2 sm:col-span-1 pl-5 pr-5 sm:pr-3 min-w-0`}>
                  {nameNode}
                  {isGlobal && (
                    // "Global Scoreboard" (not bare "Global") — a room score
                    // can ALSO fan out to the Global Scoreboard, so a bare
                    // "Global" chip on this row misread as "the only place
                    // this score counts". This wording names the venue
                    // instead of implying exclusivity. Wider padding than the
                    // old 3-char label needs to keep the pill from feeling
                    // cramped around the longer text.
                    <span className="text-[10px] px-2 py-0.5 rounded bg-neon-magenta/10 text-neon-magenta font-medium uppercase tracking-wider whitespace-nowrap">
                      Global Scoreboard
                    </span>
                  )}
                  {roomLogoUrl && (
                    <img
                      src={roomLogoUrl}
                      alt={pb.room_name ?? ''}
                      title={pb.room_name ?? undefined}
                      className="h-4 sm:h-5 rounded object-contain"
                    />
                  )}
                  {roomCaption && (
                    <span className="text-[10px] text-faint truncate max-w-full">{roomCaption}</span>
                  )}
                </span>
                {/* Phone-only caption carrying the two columns the reflow drops. */}
                <span className={`${lineTwo} sm:hidden pl-5 pr-3 min-w-0 text-faint text-[11px]`}>
                  <span className="min-w-0 truncate">
                    #{rankValue} of {pb.total_players} · {new Date(pb.achieved_at).toLocaleDateString()}
                  </span>
                </span>
                <span
                  className={`${lineTwo} justify-end pr-5 sm:pr-4 font-display font-bold text-neon-amber whitespace-nowrap tabular-nums`}
                  title={scoreTitle(pb.best_score)}
                >
                  {formatScore(pb.best_score)}
                </span>
                <span className={`${cell} hidden sm:flex justify-end pr-4 text-muted text-sm whitespace-nowrap`}>
                  #{rankValue} of {pb.total_players}
                </span>
                <span className={`${cell} hidden sm:flex justify-end pr-5 text-faint text-xs whitespace-nowrap`}>
                  {new Date(pb.achieved_at).toLocaleDateString()}
                </span>
              </Fragment>
            );
          })
        )}
      </div>

      {!filtering && matches.length > PERSONAL_BESTS_DEFAULT_VISIBLE && (
        <button
          type="button"
          onClick={() => setShowAll(v => !v)}
          className="mt-2 text-xs text-muted hover:text-neon-cyan transition-colors bg-transparent border-0 cursor-pointer p-0"
        >
          {showAll ? 'Show fewer' : `Show all ${matches.length}`}
        </button>
      )}
    </div>
  );
}
