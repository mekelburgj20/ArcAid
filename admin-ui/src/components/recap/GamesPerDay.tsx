import type { RecapBucket } from '../../lib/runRecapTypes';

/** Witness games per day (or week) as rows: label, count, bar. The numbers are text, so the bars are optional. */
export default function GamesPerDay({ buckets }: { buckets: RecapBucket[] }) {
  const max = Math.max(1, ...buckets.map(b => b.games));
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1.5" data-testid="games-per-day">
      {buckets.map(b => (
        <li key={b.key} className="flex items-center gap-3 text-sm">
          <span className="w-24 flex-shrink-0 text-muted">{b.label}</span>
          <span className="w-10 flex-shrink-0 text-right tabular-nums text-primary">{b.games}</span>
          <span className="flex-1 min-w-0 h-2 rounded-sm bg-raised" aria-hidden="true">
            <span
              className="block h-full rounded-sm bg-neon-cyan"
              style={{ width: `${(b.games / max) * 100}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
