import { Link } from 'react-router-dom';
import { ArrowUp, Crown, Flame, Pin } from 'lucide-react';
import { PlayerAvatar, playerName } from './ScoreboardComponents';
import { formatScore } from '../lib/format';
import { catalogueImageFor } from '../lib/catalogueImage';
import { getLegacyPlatformLabel } from '../lib/scoreProvenance';
import { CategoryChip, cardDetailHref, type GlobalGameCardGame } from './GlobalGameCard';

/**
 * The Global Scoreboard hero card — v2.57.0 (A5a).
 *
 * One per page, at grid position 1, spanning 2x2 from `md` up. Full-bleed art
 * under the 90-degree scrim, badges top-left, platform pills top-right, and a
 * bottom-aligned content block: eyebrow, title, champion, actions.
 *
 * Selection happens server-side (`GlobalLeaderboardService.getHeroGame`). The
 * one thing this component must get right about that decision is honesty:
 * `is_hot` gates BOTH the HOT badge and the "+n scores this week" line, so a
 * neutral hero (the server's below-threshold fallback) shows neither. Rendering
 * the weekly count unconditionally would reintroduce exactly the "1 score =
 * trending" claim the threshold exists to prevent.
 *
 * Colours come from `--sb-*` tokens throughout; there is no literal rgba() in
 * this file, so the card is correct under both polarities.
 */

export interface HeroGame extends GlobalGameCardGame {
  /** True only when the trailing-7-day leader cleared HERO_MIN_WEEKLY_SCORES. */
  is_hot: boolean;
  weekly_score_count: number;
}

function parsePlatforms(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
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
  // v2.58.0 (ADR 0016): label in engine/device vocabulary, then dedupe — a game
  // listed on both `vpx` and `vpxs` is one engine and must not render the same
  // pill twice. Dedupe BEFORE the slice, or the cap spends a slot on a repeat.
  const platforms = [...new Set(
    parsePlatforms(game.platforms).map(p => getLegacyPlatformLabel(p)),
  )].slice(0, 2);
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

  return (
    <section
      aria-label={`Featured game: ${displayName}`}
      className={`relative flex min-h-[320px] flex-col overflow-hidden rounded-[14px] border ${className}`}
      style={{ borderColor: 'var(--sb-hero-border)', boxShadow: 'var(--sb-hero-glow)' }}
    >
      {img ? (
        <img src={img} alt="" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-deep" />
      )}
      {/* 90-degree scrim: text sits on the dark left side, art breathes right. */}
      <div className="absolute inset-0" style={{ background: 'var(--sb-hero-scrim)' }} aria-hidden="true" />

      {/* Badges (left) + platform pills (right) */}
      <div className="relative flex items-start justify-between gap-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {game.is_hot && (
            <>
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
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {/* P4 — the hero is chosen at GAME level and its eyebrow still
              reports the game's total score count, but the rows below are its
              highest-scoring category's board, so the chip names that board.
              Without it the champion line would silently mix engines. */}
          <CategoryChip category={game.category} />
          {platforms.map(p => (
            <span
              key={p}
              className="rounded-[3px] border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.4px] text-neon-cyan"
              style={{ background: 'var(--sb-pill-bg)', borderColor: 'var(--sb-pill-border)' }}
            >
              {p}
            </span>
          ))}
        </div>
      </div>

      {/* Content block — bottom-aligned, on the scrim's dark side. */}
      <div className="relative mt-auto max-w-[560px] p-[22px] pt-0">
        <div className="font-mono text-[10px] uppercase tracking-[1px] text-neon-cyan">{eyebrow}</div>
        <h2 className="mt-1 font-display text-[26px] font-extrabold leading-none [text-wrap:pretty] sm:text-[34px]">
          <Link
            to={cardDetailHref(game.global_game_id, game.category)}
            className="no-underline"
            style={{ color: 'var(--sb-art-title)', textShadow: 'var(--sb-title-shadow)' }}
          >
            {displayName}
          </Link>
        </h2>

        {champion && (
          <div className="mt-4 flex items-center gap-3">
            <PlayerAvatar
              username={championName as string}
              discordUserId={champion.discord_user_id}
              avatarHash={champion.avatar_hash}
              size={46}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[1px] text-neon-amber">
                <Crown className="h-[11px] w-[11px]" aria-hidden="true" />
                Champion
              </div>
              <div
                className="truncate font-display text-[15px] font-bold"
                style={{ color: 'var(--sb-art-title)' }}
              >
                {championName}
              </div>
              <div
                className="font-mono text-[22px] font-bold text-neon-amber"
                style={{ textShadow: 'var(--sb-hero-score-glow)' }}
                title={(championScore as string).endsWith('T') ? champion.score.toLocaleString() : undefined}
              >
                {championScore}
              </div>
              {delta != null && delta > 0 && (
                <div className="text-[10px]" style={{ color: 'var(--sb-art-meta)' }}>
                  +{formatScore(delta)} over #2
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
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
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-[9px] text-[12px] font-bold transition hover:brightness-110"
              style={{
                background: 'var(--sb-art-btn-bg)',
                borderColor: 'var(--sb-art-btn-border)',
                color: 'var(--sb-art-title)',
              }}
            >
              <Pin className={`h-3 w-3 ${game.is_pinned ? 'fill-current text-neon-amber' : ''}`} aria-hidden="true" />
              {game.is_pinned ? 'Pinned' : 'Pin'}
            </button>
          )}
          <Link
            to={cardDetailHref(game.global_game_id, game.category)}
            className="inline-flex items-center rounded-md border px-3 py-[9px] text-[12px] font-bold no-underline transition hover:brightness-110"
            style={{
              background: 'var(--sb-art-btn-bg)',
              borderColor: 'var(--sb-art-btn-border)',
              color: 'var(--sb-art-title)',
            }}
          >
            Full leaderboard →
          </Link>
        </div>
      </div>
    </section>
  );
}
