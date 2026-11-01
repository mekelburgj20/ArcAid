/**
 * A14.1 - list ordering by rating. Lives in lib/ rather than beside
 * `components/RatingBadge.tsx` because a component module that also exports
 * helpers breaks Fast Refresh.
 */

export interface Rateable {
  avg_rating?: number;
  rating_count?: number;
  name: string;
}

/**
 * "Top rated" order: higher average first, then more raters, then name.
 * Unrated rows (no raters) always sort last, whatever their stored average.
 */
export function compareByRating(a: Rateable, b: Rateable): number {
  const aRated = (a.rating_count ?? 0) > 0;
  const bRated = (b.rating_count ?? 0) > 0;
  if (aRated !== bRated) return aRated ? -1 : 1;
  if (aRated && bRated) {
    const byAvg = (b.avg_rating ?? 0) - (a.avg_rating ?? 0);
    if (byAvg !== 0) return byAvg;
    const byCount = (b.rating_count ?? 0) - (a.rating_count ?? 0);
    if (byCount !== 0) return byCount;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
