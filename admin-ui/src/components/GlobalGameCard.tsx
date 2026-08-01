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
import { glitchVars } from '../lib/cardGlitch';

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
 * ─── v2.67.0 neon rebuild ───
 *
 * Four changes, all user-directed:
 *
 *   1. TITLE FIRST. The game name was set over the bottom of the art on a
 *      scrim; it now opens the card, top-left, immediately after the pin
 *      control, on the card's own surface. Art is a photograph, and a title
 *      laid over one is only ever as legible as that particular backglass —
 *      moving it off makes the type reliable at any size, which is what let
 *      it grow.
 *   2. TYPE AT ~1.6-2x. Title 13 -> 22px, player names 11 -> 16px, scores
 *      11 -> 16px, avatars 18 -> 26px, medals 12 -> 18px. Manufacturer/year
 *      stays deliberately secondary at 11px.
 *   3. AN ALWAYS-ON PODIUM. Every card renders places 1-3; an unfilled place
 *      keeps its medal and offers "Claim this spot", which opens the same
 *      submit flow the old dashed "Claim 1st ->" box did. Three rows is a
 *      FLOOR, not a ceiling — ranks 4+ still render whenever they exist.
 *   4. A NEON FRAME PER CATEGORY, glitching like the logo. The colour tokens
 *      and the glitch keyframes live in `index.css` under `.gg-card`, and the
 *      per-card desync (a hash of `card_id` into the animation timings) in
 *      `lib/cardGlitch.ts`; this file only picks the category key.
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
   * this game's catalogue engines unambiguously imply, so a claim card can
   * name the board the first score will open. Never feeds `card_id` (which
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
 *
 * v2.67.0 — inside a card the chip reads `--gg-neon`, so chip and frame are
 * literally one colour rather than two systems that happen to sit together.
 * The fallbacks are the pre-v2.67 magenta/muted pair, which is exactly what
 * `GlobalHeroCard` (no `--gg-neon` in scope) goes on rendering.
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
      className="rounded-[4px] border px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.5px]"
      style={{
        background: 'var(--sb-pill-bg)',
        borderColor: isUnspecified
          ? 'var(--gg-neon, var(--sb-cat-muted-border))'
          : 'var(--gg-neon, var(--sb-cat-border))',
        color: isUnspecified
          ? 'var(--gg-neon, var(--sb-cat-muted-fg))'
          : 'var(--gg-neon, var(--sb-cat-fg))',
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
    <div className="mx-2 mt-1 border-t border-dashed border-border pt-1 text-center text-[9px] leading-none text-faint">
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

/** The three places a card always shows, filled or not (v2.67.0). */
const PODIUM_RANKS = [1, 2, 3] as const;

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
      className="flex items-center gap-2 rounded-[6px] border px-2 py-[6px]"
      style={{ background: bg, borderColor: border }}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">
        {tint ? (
          <Medal className={`h-[18px] w-[18px] ${tint.medal}`} aria-label={tint.label} />
        ) : (
          <span className="font-mono text-[13px] font-bold text-muted">#{rank}</span>
        )}
      </span>
      <PlayerAvatar
        username={name}
        discordUserId={entry.discord_user_id}
        avatarHash={entry.avatar_hash}
        size={26}
      />
      {/* Name and room badge travel together, hard left. Previously the name
          span carried `flex-1`, which pushed the badge to the far right edge
          and visually detached it from the player it belongs to. The group
          takes the slack instead, so the badge sits immediately after the
          username and the score still right-aligns. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={`min-w-0 truncate text-[16px] ${isYou ? 'font-bold' : 'font-medium'}`}>
          {name}
          {isYou && (
            <span className="ml-1.5 rounded-[3px] px-1 py-px align-middle text-[10px] font-bold uppercase tracking-[0.5px] text-neon-cyan"
              style={{ background: 'var(--sb-row-you-bg)' }}>
              You
            </span>
          )}
          {isNext && !isYou && (
            <span className="ml-1.5 rounded-[3px] px-1 py-px align-middle text-[10px] font-bold uppercase tracking-[0.5px] text-neon-amber"
              style={{ background: 'var(--sb-row-next-bg)' }}>
              Next
            </span>
          )}
        </span>
        {entry.origin_room_slug && (
          <RoomTag
            shortTag={entry.origin_room_short_tag || entry.origin_room_slug}
            size={24}
            logoUrl={entry.origin_room_logo_url}
            href={`/scoreboard?room=${encodeURIComponent(entry.origin_room_slug)}`}
            title={`Filter to ${entry.origin_room_short_tag || entry.origin_room_slug}`}
          />
        )}
      </span>
      <span
        className={`shrink-0 font-mono text-[16px] font-bold ${rank === 1 ? 'text-neon-amber' : 'text-primary'}`}
        title={abbreviated.endsWith('T') ? entry.score.toLocaleString() : undefined}
      >
        {abbreviated}
      </span>
    </div>
  );
}

/**
 * An unclaimed podium place — v2.67.0.
 *
 * Replaces the single dashed "Claim 1st ->" box that used to stand in for the
 * entire leaderboard on a scoreless card. That box said the board was empty;
 * these rows say what is ON OFFER — three named places with their medals
 * already drawn. The medal keeps its gold/silver/bronze token, so an empty
 * podium is recognisably the same object as a full one.
 *
 * It is a <button> firing the card's `onSubmit`, i.e. the identical flow the
 * old box opened. The dashed circle stands in for the absent avatar so a mixed
 * podium (1st taken, 2nd and 3rd open) keeps one aligned column of names.
 */
export function ClaimRow({ rank, onClaim }: { rank: number; onClaim: () => void }) {
  const tint = RANK_TINTS[rank];
  return (
    <button
      type="button"
      onClick={onClaim}
      data-testid={`claim-place-${rank}`}
      /* Named for the PLACE, so `getByLabelText('1st place')` keeps meaning
         "somebody holds first" and can't be satisfied by an empty row. */
      aria-label={`Claim ${tint.label}`}
      title={`Nobody holds ${tint.label} on this board yet — submit a score and take it`}
      className="gg-claim-row flex w-full items-center gap-2 rounded-[6px] border border-dashed px-2 py-[6px] text-left transition-colors"
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
      <span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-muted">
        Claim this spot
      </span>
      <span
        className="shrink-0 text-[16px] font-bold leading-none"
        style={{ color: 'var(--gg-neon)' }}
        aria-hidden="true"
      >
        →
      </span>
    </button>
  );
}

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
   * v2.67.0 — which neon the frame wears. `none` is a declared key rather than
   * an absent attribute so "no band yet" and the stylesheet default are the
   * same stated thing rather than two paths that happen to agree.
   */
  const neonKey = chipCategory ?? 'none';
  const detailHref = cardDetailHref(game.global_game_id, game.category);

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

  /**
   * v2.67.0 — the podium is a floor, not a ceiling. Places 1-3 always render
   * (from the plan where the plan has them, `ClaimRow` where it doesn't), and
   * everything the plan puts BELOW third place renders after them exactly as
   * before, break lines included.
   */
  const plannedByRank = new Map(planned.map(row => [row.rank, row]));
  const belowPodium = planned.filter(row => row.rank > 3);

  return (
    /* The card carries its own elevation, and more of it below `sm`: at one
       column there is no neighbouring card to imply an edge, so a hairline
       alone left every card reading as part of one continuous ribbon.
       v2.67.0 folds that into `.gg-card` alongside the category frame and its
       glitch rings — all three live in index.css because they are colour
       tokens and keyframes, not layout. */
    <div
      data-testid="global-game-card"
      data-neon={neonKey}
      style={glitchVars(game.card_id ?? game.global_game_id)}
      className="gg-card group relative flex h-full min-h-[var(--sb-card-min-h)] flex-col overflow-hidden rounded-[10px] bg-surface"
    >
      {/* 1. Title row — pin, then the game name, then the board's chip. The
             name opens the card because it is the one thing every player
             scans for; it used to sit over the bottom of the art, where its
             legibility was a property of whichever backglass had loaded. */}
      <div className="relative z-[2] flex items-start gap-1.5 px-3 pt-3">
        {onTogglePin && (
          /* A 44x44 hit target with a 26px visual chip centred inside it —
             how a small control gets a thumb-sized target without a
             negative-inset wrapper, which the card's `overflow-hidden` would
             clip away exactly where the extra area was wanted. The negative
             margins pull the oversized box back so the visible chip still
             lines up with the card's 12px gutter and the title still starts
             immediately after it. */
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={Boolean(game.is_pinned)}
            aria-label={game.is_pinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
            title={game.is_pinned ? 'Unpin this game' : 'Pin this game'}
            className="relative -ml-2 -mr-1.5 -mt-2 h-11 w-11 shrink-0"
          >
            <span
              className="absolute left-[9px] top-[9px] flex h-[26px] w-[26px] items-center justify-center rounded-[5px] border transition-colors"
              style={{ background: 'var(--color-raised)', borderColor: 'var(--color-border)' }}
            >
              <Pin
                className={`h-[13px] w-[13px] ${game.is_pinned ? 'fill-current text-neon-amber' : 'text-primary'}`}
                aria-hidden="true"
              />
            </span>
          </button>
        )}

        <Link to={detailHref} className="min-w-0 flex-1 no-underline">
          <h3 className="font-display text-[22px] font-bold leading-[1.08] text-primary [text-wrap:balance]">
            {displayName}
          </h3>
          <div className="mt-1 text-[11px] text-muted">
            {game.manufacturer || 'Unknown'}{game.year ? ` · ${game.year}` : ''}
          </div>
        </Link>

        {/* Both slots are optional — a zero-score card whose catalogue engines
            span two bands has neither — so the wrapper renders only when there
            is something to put in it, and never leaves an empty flex column
            beside the title. `max-w` stops a badge + chip pair crowding the
            title out on a phone card. */}
        {(badge || categoryLabel) && (
          <div className="flex max-w-[45%] shrink-0 flex-wrap items-center justify-end gap-1">
            {badge}
            <CategoryChip category={chipCategory} prospective={chipIsProspective} />
          </div>
        )}
      </div>

      {/* 2. Art — no longer carrying text, so no scrim and no title block.
             Inset and rounded rather than full-bleed: a hard-edged band
             directly under the title read as a second card beginning. */}
      <Link
        to={detailHref}
        className="relative mx-3 mt-3 block h-[118px] shrink-0 overflow-hidden rounded-[6px] no-underline"
        title={platformList ? `Available on: ${platformList}` : undefined}
        aria-label={`${displayName} details`}
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
          <div className="absolute inset-0 flex items-center justify-center bg-deep text-[12px] text-muted">
            No image
          </div>
        )}
      </Link>

      {/* 3. Podium — places 1-3 always, then whatever ranks the density plan
             puts below them. */}
      <div className="flex-1 px-3 py-3">
        <div className="space-y-1.5">
          {PODIUM_RANKS.map(rank => {
            const row = plannedByRank.get(rank);
            return row ? (
              <LeaderboardRow
                key={`place-${rank}`}
                entry={row.entry}
                rank={rank}
                isYou={row.isYou}
                isNext={row.isNext}
              />
            ) : (
              <ClaimRow key={`place-${rank}`} rank={rank} onClaim={onSubmit} />
            );
          })}
          {belowPodium.map(row => (
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
              <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-neon-cyan">
                No score yet
              </div>
              <div className="text-[11px] text-muted">
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
        className="relative z-[2] mt-auto flex items-center justify-between gap-2 border-t px-3 py-2.5"
        style={{
          background: 'var(--sb-card-footer-bg)',
          borderTopColor: 'var(--sb-card-footer-border)',
        }}
      >
        <span className="text-[12px] text-muted">
          {game.score_count.toLocaleString()} {game.score_count === 1 ? 'score' : 'scores'}
        </span>
        <button
          type="button"
          onClick={onSubmit}
          className="inline-flex shrink-0 items-center gap-1.5 rounded bg-neon-cyan px-3 py-1.5 text-[13px] font-bold text-deep transition hover:brightness-110"
          title="Submit your score"
        >
          <Upload className="h-4 w-4" />
          Submit
        </button>
      </div>
    </div>
  );
}
