import { Star } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * A14.1 - the one compact rating badge every list renders: a filled star, the
 * per-rater average with one decimal, and the rater count in parentheses
 * ("4.2 (7)"). Renders nothing when nobody has rated the table, so callers
 * decide their own empty state.
 *
 * A14.2 - with `to`, the badge is a link to the game page's ratings (callers
 * pass the game page href plus `#ratings`). Without it, a plain span.
 */
export default function RatingBadge({
  avg,
  count,
  className,
  to,
}: {
  avg?: number | null;
  count?: number | null;
  className?: string;
  to?: string;
}) {
  if (!(count != null && count > 0)) return null;
  const average = (avg ?? 0).toFixed(1);
  const title = `Average rating ${average} from ${count} player${count === 1 ? '' : 's'}`;
  const base = `inline-flex items-center gap-1 whitespace-nowrap text-xs ${className ?? ''}`;
  const body = (
    <>
      <Star size={11} fill="currentColor" className="text-neon-amber flex-shrink-0" aria-hidden="true" />
      <span className={`text-primary font-medium tabular-nums${to ? ' group-hover:text-neon-cyan transition-colors' : ''}`}>{average}</span>
      <span className="text-muted tabular-nums">({count})</span>
    </>
  );
  if (to) {
    return (
      <Link
        to={to}
        data-testid="rating-badge"
        title={`${title} - see the ratings`}
        className={`group no-underline ${base}`}
      >
        {body}
      </Link>
    );
  }
  return (
    <span data-testid="rating-badge" title={title} className={base}>
      {body}
    </span>
  );
}
