import { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import Panel from '../parts/Panel';
import EmptyState from '../parts/EmptyState';
import { ListRow, ListRows } from '../parts/ListRow';
import LoadingState from '../LoadingState';
import LoadFailedNotice from '../LoadFailedNotice';
import { namesOf } from '../recap/SeasonRecapView';
import { roomFetch } from '../../lib/roomFetch';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { tournamentRecapPath } from '../../lib/tournamentLinks';
import type { RoomRecordsResponse } from '../../lib/runRecapTypes';

/**
 * B31.4 - the room's records: the longest streak, the most games in one run, the
 * most lead changes, the biggest comeback and the closest finish, each linking
 * to the run's recap. Names resolve at read on the server.
 */
export default function RoomRecordsSection({ roomId, slug }: { roomId: string; slug: string }) {
  const [data, setData] = useState<RoomRecordsResponse | null>(null);
  const { load, phase } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/stats/records`),
    async res => {
      const body = await res.json();
      if (!body || !Array.isArray(body.records)) throw new Error('Bad records body');
      setData(body);
    },
    roomId,
  );
  useEffect(() => {
    load();
  }, [roomId, load]);

  if (phase === 'retrying') return <LoadFailedNotice what="the records" onRetry={load} testId="room-records-load-failed" />;
  if (!data) return <LoadingState message="Loading the records..." />;

  if (data.records.length === 0) {
    return (
      <EmptyState title="No records yet">
        Records appear here once runs have finished with Arcaid Witness games on them.
      </EmptyState>
    );
  }

  return (
    <Panel wide title="Records" testId="room-records">
      <ListRows label="Room records">
        {data.records.map(r => {
          const who = namesOf(r.player_keys, data.players);
          const caption = [who, r.detail, r.run.game_name].filter(Boolean).join(' · ');
          return (
            <ListRow
              key={r.id}
              tile={<Trophy size={18} />}
              name={r.label}
              caption={caption}
              href={tournamentRecapPath(slug, r.run.tournament_id, r.run.game_id)}
              testId={`room-record-${r.id}`}
            />
          );
        })}
      </ListRows>
      <p className="mt-3 text-xs text-faint">
        From finished runs. Games are Arcaid Witness games; players who keep their play stats private are not counted.
      </p>
    </Panel>
  );
}
