import { Star } from 'lucide-react';

/**
 * A14.1 - the one compact rating badge every list renders: a filled star, the
 * per-rater average with one decimal, and the rater count in parentheses
 * ("4.2 (7)"). Renders nothing when nobody has rated the table, so callers
 * decide their own empty state.
 */
export default function RatingBadge({
  avg,
  count,
  className,
}: {
  avg?: number | null;
  count?: number | null;
  className?: string;
}) {
  if (!(count != null && count > 0)) return null;
  const average = (avg ?? 0).toFixed(1);
  return (
    <span
      data-testid="rating-badge"
      title={`Average rating ${average} from ${count} player${count === 1 ? '' : 's'}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap text-xs ${className ?? ''}`}
    >
      <Star size={11} fill="currentColor" className="text-neon-amber flex-shrink-0" aria-hidden="true" />
      <span className="text-primary font-medium tabular-nums">{average}</span>
      <span className="text-muted tabular-nums">({count})</span>
    </span>
  );
}
