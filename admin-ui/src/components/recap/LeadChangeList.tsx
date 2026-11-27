import { formatScore } from '../../lib/format';
import { formatRecapTime } from '../../lib/recapFormat';
import type { RecapLeadChange, RecapPlayerRow } from '../../lib/runRecapTypes';
import { LEAD_VERB, nameForKey } from './recapNames';

/** The lead changes as an ordered list: the text equivalent of the who-led chart. */
export default function LeadChangeList({ changes, players, timezone }: {
  changes: RecapLeadChange[];
  players: RecapPlayerRow[];
  timezone: string;
}) {
  if (changes.length === 0) return null;
  const winnerKey = players[0]?.key;
  return (
    <ol className="m-0 mt-3 p-0 list-none flex flex-col gap-1.5" data-testid="lead-change-list">
      {changes.map((c, i) => (
        <li key={`${c.at}-${i}`} className="text-sm leading-snug break-words">
          <span className="text-faint tabular-nums">{formatRecapTime(c.at, timezone)}</span>{' '}
          <span className={c.player_key === winnerKey ? 'text-neon-amber font-medium' : 'text-primary font-medium'}>
            {nameForKey(players, c.player_key)}
          </span>{' '}
          <span className="text-muted">{LEAD_VERB[c.kind]} with</span>{' '}
          <span className="tabular-nums text-primary" title={formatScore(c.score)}>{formatScore(c.score)}</span>
          {c.wins_it && <span className="text-neon-amber"> and wins it</span>}
        </li>
      ))}
    </ol>
  );
}
