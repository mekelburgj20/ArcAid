import { Link } from 'react-router-dom';
import { ArrowUp, Crown, Flame, Pin, Trophy } from 'lucide-react';
import { PlayerAvatar, playerName } from './ScoreboardComponents';
import { formatScore } from '../lib/format';
import { catalogueImageFor } from '../lib/catalogueImage';
import { cardDetailHref, type GlobalGameCardGame } from './GlobalGameCard';

/**
 * The Global Scoreboard hero card — v2.70.0, "champion marquee".
 *
 * One per page, at grid position 1. Selection happens server-side
 * (`GlobalLeaderboardService.getHeroGame`), and the one thing this component
 * must get right about that decision is honesty: `is_hot` gates the HOT badge,
 * the "+n scores this week" line AND the ribbon's wording, so a neutral hero
 * (the server's below-threshold fallback) claims nothing it cannot back.
 * Rendering the weekly count — or the word "hottest" — unconditionally would
 * reintroduce exactly the "1 score = trending" claim the threshold exists to
 * prevent.
 *
 * ─── v2.70.0 — what changed, and why ───
 *
 * The v2.57 hero was a 2x2 tile: the same shape as a grid card, twice the size,
 * speaking the same vocabulary (a fidelity-category chip, engine pills, a cyan
 * frame). On desktop that read as oversized rather than as important, and on a
 * phone — where every card is already full-width — it barely read as different
 * at all. Three moves answer it. All three are presentation; the threshold
 * logic, the ranked rows and the P4 category-scoped board are untouched.
 *
 *   1. CHAMPION IDENTITY, NOT CATEGORY IDENTITY. The category chip and the
 *      engine pills are GONE from this card. Colour on this page already means
 *      "which fidelity band" — every grid card wears its band's neon — so a
 *      hero speaking that language was one more board among boards. It wears
 *      gold now and nothing else, and gold means champion. The board it ranks
 *      is still the game's biggest one and the detail link still carries
 *      `?category=`; the card simply stops NAMING it, because naming it was
 *      what made it look like a card rather than like a marquee.
 *   2. A MARQUEE FRAME. Gold border, gold spill across the card face, and — as
 *      of v2.72.0 — a single bright segment of light travelling clockwise round
 *      the perimeter, the attract mode of the rig above an arcade cabinet.
 *      (v2.71 chased discrete bulbs here; at reading distance they read as a
 *      dotted border with a tic rather than as light, so the ring became one
 *      continuous sweep.) All of it lives in `index.css` under `.gg-hero`,
 *      because it is colour tokens and keyframes; this file only supplies the
 *      ring and its rotor. A trophy ribbon straddles the top edge like a
 *      marquee's header plate.
 *   3. A BANNER, NOT A MONOLITH. Below `sm` the card stacks (art, then the
 *      champion) and breaks the page gutter. From `sm` up it goes HORIZONTAL —
 *      art left, everything else right — so the extra width the page gives it
 *      goes into being a header strip instead of into being tall. The grid
 *      placement that pairs with this lives on the page (`GlobalScoreboard`),
 *      which is where it belongs: this component stays layout-free.
 *
 * Colours come from `--sb-*` tokens throughout; there is no literal rgba() in
 * this file, so the card is correct under both polarities.
 */

export interface HeroGame extends GlobalGameCardGame {
  /** True only when the trailing-7-day leader cleared HERO_MIN_WEEKLY_SCORES. */
  is_hot: boolean;
  weekly_score_count: number;
}

/**
 * The attract sweep — a single bright segment travelling round the frame.
 *
 * Two `aria-hidden` empty elements, because that is exactly what they are:
 * decoration with no content, no semantics and no hit area. The outer one is
 * masked into a ring lying over the card's border; the inner one is the
 * oversized conic-gradient layer that rotates inside it. Everything about the
 * geometry, the segment's falloff and the lap time lives in `index.css` —
 * splitting it across two files would put half of the mask's arithmetic in
 * each.
 */
function AttractSweep() {
  return (
    <div className="gg-hero__attract" data-testid="hero-attract" aria-hidden="true">
      <span className="gg-hero__sweep" />
    </div>
  );
}

export default function GlobalHeroCard({ game, onSubmit, onTogglePin, className = '' }: {
  game: HeroGame;
  onSubmit: () => void;
  /** Undefined for anonymous viewers — the Pin action is not rendered at all. */
  onTogglePin?: () => void;
  /** Grid placement, supplied by the page so this component stays layout-free. */
  className?: string;
}) {
  const img = catalogueImageFor(game);
  const displayName = game.display_name || game.name;
  const rows = game.top_scores || [];
  const champion = rows[0] ?? null;
  const runnerUp = rows[1] ?? null;
  const delta = champion && runnerUp ? champion.score - runnerUp.score : null;

  /**
   * The design's eyebrow reads `{MFR} · {YEAR} · {n} PLAYERS`. There is no
   * player-count API and inventing one is out of scope (same reason the page
   * drops the "{total} games · {n} players" line), so the third segment is the
   * score count we actually have.
   */
  const eyebrow = [
    game.manufacturer || 'Unknown',
    game.year ? String(game.year) : null,
    `${game.score_count.toLocaleString()} ${game.score_count === 1 ? 'score' : 'scores'}`,
  ].filter(Boolean).join(' · ');

  const championName = champion ? playerName(champion) : null;
  const championScore = champion ? formatScore(champion.score) : null;
  const detailHref = cardDetailHref(game.global_game_id, game.category);

  return (
    <section
      aria-label={`Featured game: ${displayName}`}
      data-testid="global-hero-card"
      /* NOT `overflow-hidden`: the ribbon straddles the top edge and the
         frame's bloom falls outside it. The art panel clips itself instead —
         it is the only child that needs to. */
      className={`gg-hero relative flex flex-col rounded-[14px] ${className}`}
    >
      <AttractSweep />

      {/*
        The header plate. Straddles the top edge the way a cabinet's marquee
        sits proud of its board, and is `pointer-events-none` so it never eats
        a click meant for the card behind it.

        The wording tracks `is_hot`. "Hottest board" is a claim about the last
        seven days that only holds above the server's threshold; below it the
        server is simply picking something to feature, and the plate says so.
      */}
      <div
        data-testid="hero-ribbon"
        className="pointer-events-none absolute -top-[11px] left-5 z-[4] inline-flex items-center gap-1.5 rounded-[4px] px-2.5 py-[4px] font-mono text-[10px] font-extrabold uppercase leading-none tracking-[1.2px] shadow-md"
        style={{ background: 'var(--sb-hero-ribbon-bg)', color: 'var(--sb-hero-ribbon-fg)' }}
      >
        <Trophy className="h-3 w-3" aria-hidden="true" />
        {game.is_hot ? 'Hottest board' : 'Featured board'}
      </div>

      {/* Below `sm` this stacks; from `sm` up it is the banner's two halves. */}
      <div className="relative z-[1] flex flex-1 flex-col sm:flex-row">
        {/*
          Art. A contained panel rather than the full-bleed background it was
          through v2.69: at banner proportions a background image puts the
          champion's name and score over whatever half of a backglass happens
          to be bright there, and no single scrim fixes that across every
          image. Boxed, the art is always art and the type is always on the
          card's own surface.
        */}
        <div className="relative m-3 mb-0 h-[150px] shrink-0 overflow-hidden rounded-[8px] sm:m-3 sm:mr-0 sm:h-auto sm:min-h-[184px] sm:w-[36%]">
          <Link to={detailHref} className="absolute inset-0 block" aria-label={`${displayName} details`}>
            {img ? (
              <img src={img} alt="" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-deep text-[12px] text-muted">
                No image
              </div>
            )}
          </Link>
          {/* HOT badge + weekly delta ride the art, where they read as a
              sticker on the marquee rather than as one more metadata line
              competing with the eyebrow beside it. */}
          {game.is_hot && (
            <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-[3px] bg-neon-magenta px-2.5 py-[3px] text-[9px] font-extrabold uppercase tracking-[1px] text-white">
                <Flame className="h-2.5 w-2.5" aria-hidden="true" />
                Hot
              </span>
              <span
                className="rounded-[3px] px-2 py-[3px] text-[9px] font-semibold"
                style={{ background: 'var(--sb-art-btn-bg)', color: 'var(--sb-art-title)' }}
              >
                +{game.weekly_score_count.toLocaleString()} {game.weekly_score_count === 1 ? 'score' : 'scores'} this week
              </span>
            </div>
          )}
        </div>

        {/* The right half — title, champion, actions.

            `sm:justify-between` rather than centred: the grid stretches this
            card to its row's height (whatever the tallest card in that row
            happens to be), so the content column always has more room than it
            needs. Centring left a band of dead space above and below and the
            card read as underfilled; spreading the three blocks to top,
            middle and bottom uses the same height as deliberate structure —
            a title plate, its champion, its actions. Below `sm` the column is
            content-height and the property is inert, so it is scoped up. */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3 pt-2.5 sm:justify-between sm:p-4 sm:pb-5">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[1px] text-neon-cyan">{eyebrow}</div>
            <h2 className="mt-1 font-display text-[26px] font-extrabold leading-[1.05] [text-wrap:balance] sm:text-[32px] lg:text-[38px]">
              <Link to={detailHref} className="text-primary no-underline">
                {displayName}
              </Link>
            </h2>
          </div>

          {champion && (
            /* The champion block is the card's subject, so it is the one thing
               inside the frame with a frame of its own — a gold-washed plate,
               reading as a piece of the marquee that surrounds it. */
            <div
              data-testid="hero-champion"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border px-3 py-2"
              style={{
                background: 'var(--sb-hero-champ-bg)',
                borderColor: 'var(--sb-hero-champ-border)',
              }}
            >
              <PlayerAvatar
                username={championName as string}
                discordUserId={champion.discord_user_id}
                avatarHash={champion.avatar_hash}
                avatarUrl={champion.avatar_url}
                size={48}
              />
              <div className="min-w-0 flex-1">
                <div
                  className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[1px]"
                  style={{ color: 'var(--sb-hero-gold)' }}
                >
                  <Crown className="h-[11px] w-[11px]" aria-hidden="true" />
                  Champion
                </div>
                <div className="truncate font-display text-[16px] font-bold text-primary sm:text-[18px]">
                  {championName}
                </div>
                {delta != null && delta > 0 && (
                  <div className="truncate text-[10px] text-muted">
                    +{formatScore(delta)} over #2
                  </div>
                )}
              </div>
              {/* The score takes its OWN LINE on a phone (`w-full`, and the
                  plate wraps) rather than being shrunk to fit beside the name.
                  A 9-figure pinball score is ~11 monospace characters; at 390
                  wide, avatar + name + score on one line truncated the
                  champion, and the champion's name is the one string on this
                  card that must never end in an ellipsis. Given a line of its
                  own it can stay big, which is what a marquee readout wants
                  anyway. From `sm` up there is room and it returns to the
                  right-hand end of the row. */}
              <div
                className="w-full shrink-0 text-right font-mono text-[24px] font-bold leading-none sm:w-auto sm:text-left sm:text-[26px] lg:text-[30px]"
                style={{ color: 'var(--sb-hero-gold)', textShadow: 'var(--sb-hero-score-glow)' }}
                title={(championScore as string).endsWith('T') ? champion.score.toLocaleString() : undefined}
              >
                {championScore}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSubmit}
              className="inline-flex items-center gap-1.5 rounded-md bg-neon-cyan px-[18px] py-[9px] text-[12px] font-bold text-deep transition hover:brightness-110"
            >
              <ArrowUp className="h-3 w-3" aria-hidden="true" />
              Submit your score
            </button>
            {onTogglePin && (
              <button
                type="button"
                onClick={onTogglePin}
                aria-pressed={Boolean(game.is_pinned)}
                aria-label={game.is_pinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-[9px] text-[12px] font-bold text-primary transition hover:brightness-110"
              >
                <Pin className={`h-3 w-3 ${game.is_pinned ? 'fill-current text-neon-amber' : ''}`} aria-hidden="true" />
                {game.is_pinned ? 'Pinned' : 'Pin'}
              </button>
            )}
            <Link
              to={detailHref}
              className="inline-flex items-center rounded-md border border-border px-3 py-[9px] text-[12px] font-bold text-primary no-underline transition hover:brightness-110"
            >
              Full leaderboard →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
