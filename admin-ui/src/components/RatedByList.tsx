import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import StarRating from './StarRating';

/**
 * C2 - named ratings. Owner ruling: "stamp your name on it or don't rate at
 * all", so every rating payload (room `GET /:roomId/ratings/:gameName` and
 * global `GET /api/global/games/:id/rating`) ships `raters`, and this is the
 * ONE renderer for it on both game pages.
 *
 * `display_name` is already resolved server-side through the
 * display_name -> username -> earliest alias chain; never fall back to
 * `user_id` here (CLAUDE.md "Id-keyed surfaces").
 */
export interface Rater {
  user_id: string;
  display_name: string;
  rating: number;
  updated_at: string;
}

interface RatedByListProps {
  raters: Rater[] | undefined;
  /** The caption is addressed to someone who can rate, so it shows only when logged in. */
  loggedIn: boolean;
}

export default function RatedByList({ raters, loggedIn }: RatedByListProps) {
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
            Rated by {list.length}
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1">
              {list.map(r => (
                <li key={r.user_id} className="flex items-center justify-between gap-3">
                  <span className="text-primary break-words min-w-0">{r.display_name}</span>
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
