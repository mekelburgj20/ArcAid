import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Medal, Pin, Upload } from 'lucide-react';
import { PlayerAvatar, playerName } from './ScoreboardComponents';
import RoomTag from './RoomTag';
import { formatScore } from '../lib/format';
import { catalogueImageFor } from '../lib/catalogueImage';
// v2.58.0 (ADR 0016): the catalogue still stores legacy platform ids, but the
// UI speaks engine/device everywhere else — `getLegacyPlatformLabel` folds one
// to the other so `vpxs` reads "VPX" here exactly as it does on a score row.
import { getCardCategoryLabel, getLegacyPlatformLabel, UNSPECIFIED_CATEGORY } from '../lib/scoreProvenance';
import { planRows, type Density } from '../lib/scoreboardDensity';

/**
 * The Global Scoreboard game card — v2.50.0 (A2)'s art-first card, extracted
 * out of `pages/GlobalScoreboard.tsx` in v2.55.0.
 *
 * It is extracted because TWO surfaces render it: the /scoreboard grid and the
 * "My Pins" carousel above it (`PinnedCarousel.tsx`). The pinned cards are
 * required to look identical to the grid's, and the only durable way to
 * guarantee that is for them to BE the same component — a copy diverges the
 * first time either one is touched.
 *
 * Nothing about the rendering changed in the extraction. The one addition is
 * the optional `badge` slot (the carousel's rank-delta pill), which renders
 * nothing at all when the prop is absent, i.e. everywhere the grid uses it.
 */

export interface TopScoreEntry {
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. Renders in place of iscored_username when set. */
  display_name?: string | null;
  score: number;
  avatar_hash: string | null;
  discord_user_id: string;
  origin_room_slug: string | null;
  origin_room_logo_url: string | null;
  /** Sprint 13 — admin-set short label; falls back to slug-derived when null. */
  origin_room_short_tag: string | null;
  /** v2.52.0 (A4): present on `neighbors` entries only — the card's own rows
   *  derive rank from their index, but a neighbour row can start at any rank. */
  rank?: number;
}

/**
 * Everything the card reads off a game. Deliberately narrower than the
 * scoreboard page's `TopGame` (which also carries sort/websocket fields) so the
 * pins payload — a different endpoint — can satisfy it without shipping fields
 * nothing renders.
 */
export interface GlobalGameCardGame {
  global_game_id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  image_url: string | null;
  local_image_path: string | null;
  wheel_image_path: string | null;
  /** JSON string. */
  platforms: string;
  score_count: number;
  top_scores: TopScoreEntry[];
  /**
   * v2.59.0 (ADR 0016 P4) — which board this card is: `real` / `simulation` /
   * `arcade_style` / `video` / `unspecified`, or null when the game has no
   * scores at all. Every figure on the card is scoped to it.
   */
  category?: string | null;
  /** v2.59.0 (P4) — `${global_game_id}::${category ?? 'none'}`; the React key. */
  card_id?: string;
  /**
   * v2.63.0 — DISPLAY ONLY, and only ever set on a zero-score card. The band
   * this game's catalogue engines unambiguously imply, so a `Claim 1st →` card
   * can name the board the first score will open. Never feeds `card_id` (which
   * stays `::none`) and never feeds the detail-page deep link (there is no
   * board to link to yet).
   */
  prospective_category?: string | null;
  /** v2.52.0 (A4) — per-viewer context. Absent entirely for anonymous viewers. */
  is_pinned?: boolean;
  my_rank?: number | null;
  my_score?: number | null;
  /** Ranks my_rank-1 … my_rank+1; only the entry at `my_rank` is read. */
  neighbors?: TopScoreEntry[];
}

/**
 * Density planning lives in `lib/scoreboardDensity.ts` — it is a pure function
 * over the payload, and a component module that also exports helpers breaks
 * Fast Refresh. Re-exported here because callers reach for it through the card.
 */
export type { Density, PlannedRow, RowPlan } from '../lib/scoreboardDensity';

/**
 * The card's fidelity-category chip — v2.59.0 (ADR 0016 P4).
 *
 * This is the label that tells a player WHICH BOARD they are looking at, now
 * that one game can render several cards. Shared with `GlobalHeroCard` so the
 * two surfaces can't drift.
 *
 * Renders nothing for a null category (a game with no scores has no board to
 * name — "Unspecified" there would claim scores of unrecorded provenance that
 * don't exist). The `unspecified` bucket itself renders MUTED and carries a
 * tooltip saying what it means: it is not a fidelity band, and styling it like
 * one would assert comparability the data cannot support.
 *
 * v2.63.0 — `prospective` flips the copy from a statement about scores that
 * exist to one about the board a first score would open. Same label and same
 * treatment, because it names the same band; different tooltip, because
 * "this board only ranks…" is false where there is no board yet.
 */
export function CategoryChip({ category, prospective = false }: {
  category?: string | null;
  prospective?: boolean;
}) {
  const label = getCardCategoryLabel(category);
  if (!label) return null;
  const isUnspecified = category === UNSPECIFIED_CATEGORY;
  return (
    <span
      data-testid="category-chip"
      data-category={category as string}
      data-prospective={prospective ? 'true' : undefined}
      className="rounded-[3px] border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.4px]"
      style={{
        background: 'var(--sb-pill-bg)',
        borderColor: isUnspecified ? 'var(--sb-cat-muted-border)' : 'var(--sb-cat-border)',
        color: isUnspecified ? 'var(--sb-cat-muted-fg)' : 'var(--sb-cat-fg)',
      }}
      title={isUnspecified
        ? "These scores don't say which game engine produced them, so they can't be compared with the rest."
        : prospective
          ? `No scores yet — the first one will open a ${label} board.`
          : `${label} scores — this board only ranks scores from ${label.toLowerCase()} sources.`}
    >
      {label}
    </span>
  );
}

/**
 * The detail-page link for one card — v2.63.0.
 *
 * `?category=` is what makes a card and the board it opens the same thing: two
 * cards of a game share a page, and without the param the page would have to
 * guess which of them was clicked (it defaults to the biggest board, which is
 * wrong for every other card).
 *
 * A zero-score card links BARE, even when it carries a prospective band. That
 * band names a board that does not exist yet, so deep-linking it would ask the
 * page to preselect a tab it cannot render.
 */
export function cardDetailHref(globalGameId: string, category?: string | null): string {
  return category
    ? `/games/${globalGameId}?category=${encodeURIComponent(category)}`
    : `/games/${globalGameId}`;
}

/** Dashed rule with a centred ellipsis — the "…and then, you" separator. */
function BreakLine() {
  return (
    <div className="mx-2 mt-1 border-t border-dashed border-border pt-1 text-center text-[8px] leading-none text-faint">
      · · ·
    </div>
  );
}

function parsePlatforms(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * Per-rank row tint/border + medal color. Every value is an A1 `--sb-*` /
 * `--color-medal-*` token so the card works under both polarities — never a
 * literal rgba(). Ranks 4+ have no entry (transparent row, `#n` rank cell).
 */
const RANK_TINTS: Record<number, { bg: string; border: string; medal: string; label: string }> = {
  1: { bg: 'var(--sb-row-gold-bg)', border: 'var(--sb-row-gold-border)', medal: 'text-neon-amber', label: '1st place' },
  2: { bg: 'var(--sb-row-silver-bg)', border: 'var(--sb-row-silver-border)', medal: 'text-medal-silver', label: '2nd place' },
  3: { bg: 'var(--sb-row-bronze-bg)', border: 'var(--sb-row-bronze-border)', medal: 'text-medal-bronze', label: '3rd place' },
};

export function LeaderboardRow({ entry, rank, isYou = false, isNext = false }: {
  entry: TopScoreEntry;
  rank: number;
  isYou?: boolean;
  /** v2.57.0 (A5a) — the player exactly one rank above the viewer, in `mine`
   *  density. Gets the amber "next to beat" treatment. */
  isNext?: boolean;
}) {
  const tint = RANK_TINTS[rank];
  const name = playerName(entry);
  const abbreviated = formatScore(entry.score);
  // A4: the viewer's own row wins the tint even at rank 1-3 — "this is me" is
  // the more useful signal on a card the viewer opened to find themselves on.
  // A5a: "next to beat" outranks the medal tint for the same reason, and only
  // ever applies in `mine` density (the caller sets the flag).
  const bg = isYou ? 'var(--sb-row-you-bg)'
    : isNext ? 'var(--sb-row-next-bg)'
    : (tint?.bg ?? 'transparent');
  const border = isYou ? 'var(--sb-row-you-border)'
    : isNext ? 'var(--sb-row-next-border)'
    : (tint?.border ?? 'transparent');

  return (
    <div
      className="flex items-center gap-2 rounded-[5px] border px-2 py-[5px]"
      style={{ background: bg, borderColor: border }}
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        {tint ? (
          <Medal className={`w-3 h-3 ${tint.medal}`} aria-label={tint.label} />
        ) : (
          <span className="font-mono text-[10px] font-bold text-muted">#{rank}</span>
        )}
      </span>
      <PlayerAvatar
        username={name}
        discordUserId={entry.discord_user_id}
        avatarHash={entry.avatar_hash}
        size={18}
      />
      {/* Name and room badge travel together, hard left. Previously the name
          span carried `flex-1`, which pushed the badge to the far right edge
          and visually detached it from the player it belongs to. The group
          takes the slack instead, so the badge sits immediately after the
          username and the score still right-aligns. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={`min-w-0 truncate text-[11px] ${isYou ? 'font-bold' : 'font-medium'}`}>
          {name}
          {isYou && (
            <span className="ml-1.5 rounded-[2px] px-1 py-px align-middle text-[8px] font-bold uppercase tracking-[0.5px] text-neon-cyan"
              style={{ background: 'var(--sb-row-you-bg)' }}>
              You
            </span>
          )}
          {isNext && !isYou && (
            <span className="ml-1.5 rounded-[2px] px-1 py-px align-middle text-[8px] font-bold uppercase tracking-[0.5px] text-neon-amber"
              style={{ background: 'var(--sb-row-next-bg)' }}>
              Next
            </span>
          )}
        </span>
        {entry.origin_room_slug && (
          <RoomTag
            shortTag={entry.origin_room_short_tag || entry.origin_room_slug}
            size={16}
            logoUrl={entry.origin_room_logo_url}
            href={`/scoreboard?room=${encodeURIComponent(entry.origin_room_slug)}`}
            title={`Filter to ${entry.origin_room_short_tag || entry.origin_room_slug}`}
          />
        )}
      </span>
      <span
        className={`shrink-0 font-mono text-[11px] font-bold ${rank === 1 ? 'text-neon-amber' : 'text-primary'}`}
        title={abbreviated.endsWith('T') ? entry.score.toLocaleString() : undefined}
      >
        {abbreviated}
      </span>
    </div>
  );
}

/**
 * v2.50.0 (A2) — art-first card. Structure: art block (110px) with the title
 * on a scrim, then ranks 1-6, then a footer with the score count and a solid
 * Submit. No podium, no placeholder rows, no star row.
 */
export default function GlobalGameCard({ game, onSubmit, onTogglePin, badge, density = 'top6' }: {
  game: GlobalGameCardGame;
  onSubmit: () => void;
  /** Undefined for anonymous viewers — the hotspot is not rendered at all. */
  onTogglePin?: () => void;
  /** v2.55.0 — optional pill rendered left of the category chip. The pins
   *  carousel passes its rank-delta badge; the grid passes nothing. */
  badge?: ReactNode;
  /** v2.57.0 (A5a) — page-level density. Defaults to the pre-A5a behaviour, so
   *  callers that don't offer the toggle (the pins carousel) are unchanged. */
  density?: Density;
}) {
  const img = catalogueImageFor(game);
  const displayName = game.display_name || game.name;
  const { rows: planned, prompt } = planRows(game, density);
  /**
   * v2.64.0 — the catalogue's engine list is HOVER-ONLY on a card now.
   *
   * The card used to render `platforms[0]` as a visible chip. Since v2.62.0
   * that array holds engine ids, and per-category cards made the chip a lie:
   * both of Creature from the Black Lagoon's cards (Simulation and
   * Arcade-Style) showed the same catalogue-level "FUTURE PINBALL", implying
   * the scores on each board came from that engine. They don't — the card's
   * board is named by the category chip, and the engines below it can be any
   * of the game's. The visible chip is gone; the full deduped list survives as
   * the art block's tooltip, where it reads as game metadata rather than as a
   * claim about these scores.
   */
  const platformList = [...new Set(
    parsePlatforms(game.platforms).map(p => getLegacyPlatformLabel(p, false)),
  )].join(' · ');
  // v2.63.0 — a zero-score card names the band its FIRST score would open,
  // when the catalogue says so unambiguously. `category` still wins wherever
  // it exists; the fallback only ever fires for a card with no board.
  const chipCategory = game.category ?? game.prospective_category ?? null;
  const chipIsProspective = !game.category && Boolean(game.prospective_category);
  const categoryLabel = getCardCategoryLabel(chipCategory);

  /**
   * A4 — the "YOU" row. Appended only when the viewer has a rank AND that rank
   * falls outside the rows already rendered; inside the top 6 they are already
   * on the card and a duplicate row would be worse than none.
   *
   * The row itself comes from `neighbors` (which carries the full entry shape
   * including avatar and origin room), not from a synthesised stub.
   *
   * A5a: `mine` density already plans the viewer's neighbourhood into the row
   * list, so this appendix is a `top6`-only affordance.
   */
  const myRank = game.my_rank ?? null;
  const youEntry = (density === 'top6' && myRank != null && myRank > planned.length)
    ? (game.neighbors || []).find(n => n.rank === myRank) ?? null
    : null;

  return (
    /* v2.65.0 — the card carries its own elevation, and carries MORE of it
       below `sm`. At one column there is no neighbouring card to imply an edge,
       so a hairline border alone left each card reading as part of one
       continuous column; the stronger shadow is what makes it a discrete
       object. Both values are tokens, so the light polarity gets neutral
       elevation rather than a black bloom. */
    <div className="group relative flex h-full flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[var(--sb-card-shadow-strong)] transition-colors duration-150 hover:border-[var(--sb-card-hover-border)] sm:shadow-[var(--sb-card-shadow)]">
      {/* A4 — pin hotspot. A SIBLING of the art <Link>, not a child: a button
          nested inside an anchor is invalid and swallows the anchor's
          activation on some browsers.

          The button is a transparent 44×44 hit target anchored at the card's
          top-left corner, with the 22px visual chip inset 6px inside it. That
          is how the design's 22px control gets a ≥44px touch target WITHOUT a
          negative-inset wrapper, which the card's `overflow-hidden` would clip
          away exactly where the extra area was needed. */}
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={Boolean(game.is_pinned)}
          aria-label={game.is_pinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
          title={game.is_pinned ? 'Unpin this game' : 'Pin this game'}
          className="absolute left-0 top-0 z-10 h-11 w-11"
        >
          <span
            className="absolute left-1.5 top-1.5 flex h-[22px] w-[22px] items-center justify-center rounded border transition-colors"
            style={{ background: 'var(--sb-art-btn-bg)', borderColor: 'var(--sb-art-btn-border)' }}
          >
            <Pin
              className={`h-[11px] w-[11px] ${game.is_pinned ? 'fill-current text-neon-amber' : 'text-primary'}`}
              aria-hidden="true"
            />
          </span>
        </button>
      )}

      {/* 1. Art block — the whole thing links to the game detail page. */}
      <Link
        to={cardDetailHref(game.global_game_id, game.category)}
        className="relative block h-[110px] shrink-0 no-underline"
        title={platformList ? `Available on: ${platformList}` : undefined}
      >
        {img ? (
          <img
            src={img}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-deep text-[11px] text-muted">
            No image
          </div>
        )}
        <div className="absolute inset-0" style={{ background: 'var(--sb-art-scrim)' }} />
        {/* The card's chip row: the category chip that names THIS board, plus
            an optional caller-supplied badge (the pins carousel's rank delta).
            v2.64.0 dropped the engine pill that used to sit to its right.

            Both slots are optional — a zero-score card whose catalogue engines
            span two bands has neither — so the wrapper renders only when there
            is something to put in it, and never leaves an empty flex row over
            the art. It still wraps, and `max-w` still reserves the pin
            hotspot's 44px corner, for a badge + chip pair on a phone card. */}
        {(badge || categoryLabel) && (
          <div className="absolute right-1.5 top-1.5 flex max-w-[calc(100%-3.25rem)] flex-wrap items-center justify-end gap-1">
            {badge}
            <CategoryChip category={chipCategory} prospective={chipIsProspective} />
          </div>
        )}
        {/* v2.65.0 — the title block gets its breathing room from inset, not
            from a taller art block: the 110px banner height is unchanged, the
            text simply stops crowding the card's edges. */}
        <div className="absolute inset-x-3.5 bottom-2.5">
          <h3
            className="font-display text-[13px] font-bold leading-[1.15] [text-wrap:pretty]"
            style={{ color: 'var(--sb-art-title)', textShadow: 'var(--sb-title-shadow)' }}
          >
            {displayName}
          </h3>
          <div className="mt-0.5 text-[9.5px]" style={{ color: 'var(--sb-art-meta)' }}>
            {game.manufacturer || 'Unknown'}{game.year ? ` · ${game.year}` : ''}
          </div>
        </div>
      </Link>

      {/* 2. Leaderboard — exactly as many rows as there are scores, max 6.
             3. Empty state — dashed "Claim 1st" CTA, no placeholder podium. */}
      <div className="flex-1 px-3.5 py-3.5">
        {planned.length > 0 ? (
          <div className="space-y-1">
            {planned.map(row => (
              <div key={`${row.rank}-${row.entry.discord_user_id}-${row.entry.iscored_username}`}>
                {/* A5a — the break line only appears where the plan actually
                    skips ranks, so ranks 1-4 (contiguous) never draw one. */}
                {row.gapBefore && <BreakLine />}
                <LeaderboardRow
                  entry={row.entry}
                  rank={row.rank}
                  isYou={row.isYou}
                  isNext={row.isNext}
                />
              </div>
            ))}
            {/* A5a — `mine` density with no score of your own: what it takes to
                get on the board, rather than a list you're absent from. */}
            {prompt && (
              <div className="mt-1 rounded-md border border-dashed border-neon-cyan/35 px-2 py-1.5 text-center">
                <div className="text-[10px] font-bold uppercase tracking-[0.5px] text-neon-cyan">
                  No score yet
                </div>
                <div className="text-[10px] text-muted">
                  #{prompt.rank} needs {formatScore(prompt.score)} to qualify
                </div>
              </div>
            )}
            {/* A4 — the viewer's own row, appended when they rank below the
                rows above (Top 6 density only). */}
            {youEntry && (
              <LeaderboardRow entry={youEntry} rank={myRank as number} isYou />
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            className="w-full rounded-md border border-dashed border-neon-cyan/35 px-1 py-2 text-[11px] text-neon-cyan hover:bg-neon-cyan/10 transition-colors"
          >
            Claim 1st →
          </button>
        )}
      </div>

      {/* 4. Footer — a CONTAINED strip since v2.65.0.
             It used to be a hairline `border-border/50` rule with the same
             background as the card body, which on a stacked phone layout put
             the Submit button in undifferentiated space directly above the
             next card's art. Users read it as the button for the game BELOW.
             A filled band with its own top border makes the button visibly
             part of THIS card. Applied at every width, not just under `sm` —
             it reads as intentional structure on desktop too, and a
             breakpoint-forked footer would drift. */}
      <div
        className="mt-auto flex items-center justify-between gap-2 border-t px-3.5 py-2.5"
        style={{
          background: 'var(--sb-card-footer-bg)',
          borderTopColor: 'var(--sb-card-footer-border)',
        }}
      >
        <span className="text-[10px] text-muted">
          {game.score_count.toLocaleString()} {game.score_count === 1 ? 'score' : 'scores'}
        </span>
        <button
          type="button"
          onClick={onSubmit}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-neon-cyan px-2.5 py-1 text-[10px] font-bold text-deep transition hover:brightness-110"
          title="Submit your score"
        >
          <Upload className="w-3 h-3" />
          Submit
        </button>
      </div>
    </div>
  );
}
