import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import GameArt from '../GameArt';
import EmptyState from '../parts/EmptyState';
import { roomFetch } from '../../lib/roomFetch';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { runLineText } from '../../lib/runLineText';
import { tournamentRecapPath } from '../../lib/tournamentLinks';
import type { PlayerRunsResponse } from '../../lib/runRecapTypes';

/** First screen of runs; the rest sit behind "Show all". */
const FIRST = 20;

/**
 * A player's runs ("By the numbers", B31.3) on their page: one line per run,
 * newest first, each linking to the run's recap. Privacy is the server's: a
 * player who hides play stats arrives with `games`/`average` null.
 */
export default function PlayerRunsList({ roomId, slug, identifier }: { roomId: string; slug: string; identifier: string }) {
  const [data, setData] = useState<PlayerRunsResponse | null>(null);
  const [all, setAll] = useState(false);

  const { load, phase } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/players/${encodeURIComponent(identifier)}/runs`).then(r => {
      if (!r.ok && r.status === 404) setData(null);
      return r;
    }),
    async res => {
      const body = await res.json();
      setData(body && Array.isArray(body.runs) ? body as PlayerRunsResponse : null);
    },
    `${roomId}|${identifier}`,
  );
  useEffect(() => { if (roomId && identifier) load(); }, [roomId, identifier, load]);

  if (phase !== 'ready' || !data) return null;
  const runs = all ? data.runs : data.runs.slice(0, FIRST);

  return (
    <div data-testid="player-runs">
      <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Runs</h2>
      {data.runs.length === 0 ? (
        <EmptyState title="No runs yet">
          Runs show up here once this player has a score on a table in a tournament.
        </EmptyState>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          {runs.map(r => (
            <Link
              key={r.game_id}
              to={tournamentRecapPath(slug, r.tournament_id, r.game_id)}
              className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-border/30 last:border-0 no-underline text-primary hover:text-neon-cyan transition-colors"
            >
              <GameArt src={r.image_url} name={r.game_name} size={40} />
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words">
                  {r.game_name}
                  {r.state === 'active' && <span className="ml-2 text-xs text-neon-green uppercase tracking-wider">Live</span>}
                </p>
                <p className="text-faint text-xs break-words">{r.tournament_name}</p>
                <p className="text-muted text-sm tabular-nums" title={`best ${r.best.toLocaleString()}`}>{runLineText(r)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
      {data.play_stats === 'hidden' && data.runs.length > 0 && (
        <p className="text-faint text-xs mt-2">This player keeps their game counts private.</p>
      )}
      {!all && data.runs.length > FIRST && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-3 text-sm text-neon-cyan hover:underline bg-transparent border-0 cursor-pointer p-0"
        >
          Show all {data.runs.length}
        </button>
      )}
    </div>
  );
}
