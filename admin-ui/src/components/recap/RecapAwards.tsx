import { Trophy } from 'lucide-react';
import { ListRow, ListRows } from '../parts/ListRow';
import type { RecapAward, RecapPlayerRow } from '../../lib/runRecapTypes';
import { joinNames, nameForKey } from './recapNames';

/** One `ListRow` per award: label, who (ties share), the server's name-free detail. */
export default function RecapAwards({ awards, players }: { awards: RecapAward[]; players: RecapPlayerRow[] }) {
  return (
    <ListRows label="Awards" testId="recap-awards">
      {awards.map(a => (
        <ListRow
          key={a.id}
          tile={<Trophy size={18} aria-hidden="true" />}
          name={a.label}
          caption={joinNames(a.player_keys.map(k => nameForKey(players, k)))}
          below={<p className="m-0 text-sm text-muted break-words">{a.detail}</p>}
        />
      ))}
    </ListRows>
  );
}
