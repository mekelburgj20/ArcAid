import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import StarRating from './StarRating';
import { getEngineShortLabel } from '../lib/scoreProvenance';

/**
 * C2 - named ratings. Owner ruling: "stamp your name on it or don't rate at
 * all", so every rating payload (room `GET /:roomId/ratings/:gameName` and
 * global `GET /api/global/games/:id/rating`) ships `raters`, and this is the
 * ONE renderer for it on both game pages.
 *
 * `display_name` is already resolved server-side through the
 * display_name -> username -> earliest alias chain; never fall back to
 * `user_id` here (CLAUDE.md "Id-keyed surfaces").
 *
 * C3 - a rating can be per platform: one Rater entry per ROW, so a player who
 * rated the table in general and on one engine appears twice. `platform` is
 * '' (the table in general) or a canonical engine id.
 */
export interface Rater {
  user_id: string;
  display_name: string;
  rating: number;
  updated_at: string;
  platform: string;
}

/** One engine's aggregate beside the headline (platforms other than ''). */
export interface PlatformRatingAgg {
  platform: string;
  avg_rating: number;
  rating_count: number;
  user_rating: number | null;
}

/**
 * The rating payload of both game pages. `rating_count` counts distinct
 * players (one opinion per player); `user_ratings` is every row of the
 * viewer keyed by platform. `global_game_id` / `unified` ride only on the
 * room payload: `unified === false` is the room-only legacy store, which has
 * no platform axis.
 */
export interface RatingInfo {
  avg_rating: number;
  rating_count: number;
  user_rating: number | null;
  user_ratings?: Record<string, number>;
  by_platform?: PlatformRatingAgg[];
  raters?: Rater[];
  global_game_id?: string | null;
  unified?: boolean;
}

/** The small engine chip a per-platform rating carries (here and on the player page). */
export function RatingEngineChip({ platform }: { platform: string }) {
  return (
    <span
      className="px-1.5 py-px rounded border border-border text-[10px] text-muted"
      data-testid="rater-engine-chip"
    >
      {getEngineShortLabel(platform)}
    </span>
  );
}

interface RatedByListProps {
  raters: Rater[] | undefined;
  /** The caption is addressed to someone who can rate, so it shows only when logged in. */
  loggedIn: boolean;
  /** Distinct players (the payload's `rating_count`); the list may hold one player twice. */
  raterCount?: number;
}

export default function RatedByList({ raters, loggedIn, raterCount }: RatedByListProps) {
  const [open, setOpen] = useState(false);
  const list = Array.isArray(raters) ? raters : [];

  if (!loggedIn && list.length === 0) return null;

  return (
    <div className="mb-3 text-xs" data-testid="rated-by">
      {loggedIn && (
        <p className="text-faint mb-1">Ratings are public and carry your name.</p>
      )}
      {list.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-muted hover:text-primary transition-colors cursor-pointer bg-transparent border-0 p-0"
          >
            Rated by {raterCount ?? list.length}
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1">
              {list.map(r => (
                <li key={`${r.user_id}:${r.platform ?? ''}`} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex items-center flex-wrap gap-1.5">
                    <span className="text-primary break-words">{r.display_name}</span>
                    {r.platform && <RatingEngineChip platform={r.platform} />}
                  </span>
                  <span className="flex-shrink-0" aria-label={`${r.rating} star${r.rating === 1 ? '' : 's'}`}>
                    <StarRating rating={r.rating} size="sm" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
