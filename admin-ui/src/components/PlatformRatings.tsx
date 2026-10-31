import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import StarRating from './StarRating';
import type { RatingInfo } from './RatedByList';
import { getEngineShortLabel } from '../lib/scoreProvenance';

/**
 * C3 - the platform axis of a rating ("is the VPXS version better than
 * native?"). The ONE renderer for it on both game pages (room GameDetail when
 * the rating lives on the catalogue store, and the Global game page).
 *
 * Rows = the offered `engines`, then any other platform that already has ratings.
 * Each row: the engine label, the viewer's own stars for that platform
 * (clickable only when logged in and `onRate` is given), and the platform's
 * average + count when it has any.
 *
 * Visibility: once any platform rating exists the rows show expanded for
 * everyone. Before that, a guest sees nothing and a logged-in viewer gets a
 * collapsed "Rate by platform" toggle.
 */
interface PlatformRatingsProps {
  info: RatingInfo;
  engines: string[];
  loggedIn: boolean;
  onRate?: (platform: string, rating: number) => void;
}

export default function PlatformRatings({ info, engines, loggedIn, onRate }: PlatformRatingsProps) {
  const [open, setOpen] = useState(false);
  const byPlatform = Array.isArray(info.by_platform) ? info.by_platform.filter(p => p.platform) : [];
  const aggFor = new Map(byPlatform.map(p => [p.platform, p]));

  const rows: string[] = [];
  const seen = new Set<string>();
  for (const p of [...engines, ...byPlatform.map(b => b.platform)]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    rows.push(p);
  }

  const hasAny = byPlatform.length > 0;
  if (!hasAny && !loggedIn) return null;
  if (rows.length === 0) return null;

  const rate = loggedIn && onRate ? onRate : undefined;
  const expanded = hasAny || open;

  return (
    <div className="mb-3 text-xs" data-testid="platform-ratings">
      {hasAny ? (
        <p className="text-muted mb-1">By platform</p>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-muted hover:text-primary transition-colors cursor-pointer bg-transparent border-0 p-0"
        >
          Rate by platform
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      )}
      {expanded && (
        <ul className="mt-1.5 space-y-1">
          {rows.map(platform => {
            const agg = aggFor.get(platform);
            const label = getEngineShortLabel(platform);
            return (
              <li key={platform} className="flex items-center gap-3 flex-wrap" data-testid={`platform-rating-${platform}`}>
                <span className="text-primary min-w-[5rem] break-words">{label}</span>
                <span className="flex-shrink-0" role="group" aria-label={`Your rating on ${label}`}>
                  <StarRating
                    rating={info.user_ratings?.[platform] ?? 0}
                    onRate={rate ? (n => rate(platform, n)) : undefined}
                    size="sm"
                  />
                </span>
                {agg && agg.rating_count > 0 && (
                  <span className="text-muted">
                    {agg.avg_rating.toFixed(1)} ({agg.rating_count})
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
