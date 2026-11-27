import { useEffect, useState } from 'react';
import { ButtonLink } from '../parts/Button';
import { roomFetch } from '../../lib/roomFetch';
import { tournamentRecapPath } from '../../lib/tournamentLinks';
import type { LiveRunsResponse } from '../../lib/runRecapTypes';

/**
 * One chip per ACTIVE run of this tournament ("<Table> · so far →") to its
 * recap. Optional furniture: renders nothing while loading, on a failure or
 * when no run is live.
 */
export default function LiveRunsStrip({ roomId, slug, tournamentId }: {
  roomId: string;
  slug: string | undefined;
  tournamentId: string;
}) {
  const [loaded, setLoaded] = useState<{ tid: string; runs: LiveRunsResponse['runs'] } | null>(null);
  const runs = loaded && loaded.tid === tournamentId ? loaded.runs : [];

  useEffect(() => {
    let cancelled = false;
    roomFetch(`/api/rooms/${roomId}/tournaments/${encodeURIComponent(tournamentId)}/runs/live`)
      .then(r => (r.ok ? r.json() : null))
      .then((json: LiveRunsResponse | null) => {
        if (!cancelled && json && Array.isArray(json.runs)) setLoaded({ tid: tournamentId, runs: json.runs });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [roomId, tournamentId]);

  if (!slug || runs.length === 0) return null;
  return (
    <div className="mb-5 flex flex-wrap gap-2" data-testid="live-runs-strip">
      {runs.map(r => (
        <ButtonLink
          key={r.game_id}
          to={tournamentRecapPath(slug, tournamentId, r.game_id)}
          variant="secondary"
          size="sm"
          className="max-w-full text-left break-words"
        >
          {r.game_name} {'·'} so far {'→'}
        </ButtonLink>
      ))}
    </div>
  );
}
