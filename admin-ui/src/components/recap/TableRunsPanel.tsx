import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import StatTiles from '../parts/StatTiles';
import { playerName } from '../ScoreboardComponents';
import { roomFetch } from '../../lib/roomFetch';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { formatRecapScore } from '../../lib/recapFormat';
import { tournamentRecapPath } from '../../lib/tournamentLinks';
import type { TableRunsSummary } from '../../lib/runRecapTypes';

const NONE = '—';

/**
 * A table's runs ("By the numbers", B31.3): how often the room has run this
 * table, what usually wins it, and the recent runs, each linking to its recap.
 * Renders nothing until the table has a finished run.
 */
export default function TableRunsPanel({ roomId, slug, gameName }: { roomId: string; slug: string; gameName: string }) {
  const [data, setData] = useState<TableRunsSummary | null>(null);

  const { load, phase } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/tables/${encodeURIComponent(gameName)}/runs`),
    async res => {
      const body = await res.json();
      setData(body && typeof body.runs === 'number' ? body as TableRunsSummary : null);
    },
    `${roomId}|${gameName}`,
  );
  useEffect(() => { if (roomId && gameName) load(); }, [roomId, gameName, load]);

  if (phase !== 'ready' || !data || data.runs === 0) return null;

  const most = data.most_games_in_run;
  return (
    <div data-testid="table-runs">
      <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Runs of this table</h2>
      <div className="bg-surface border border-border rounded-lg p-4 sm:p-5">
        <StatTiles
          tiles={[
            { label: 'Runs', value: data.runs },
            {
              label: 'Typical winning score',
              value: data.typical_winning_score != null
                ? <span title={data.typical_winning_score.toLocaleString()}>{formatRecapScore(data.typical_winning_score)}</span>
                : NONE,
            },
            {
              label: 'Median game',
              value: data.median_game != null
                ? <span title={data.median_game.toLocaleString()}>{formatRecapScore(data.median_game)}</span>
                : NONE,
            },
            { label: 'Most games in one run', value: most ? most.games : NONE },
          ]}
        />
        {most && (
          <p className="text-muted text-sm mt-3 break-words">
            Most games in one run: {playerName(most.player)}, {most.games}.
          </p>
        )}
        <ul className="list-none m-0 p-0 mt-4">
          {data.recent.map(r => (
            <li key={r.game_id} className="border-t border-border/30 first:border-0">
              <Link
                to={tournamentRecapPath(slug, r.tournament_id, r.game_id)}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 no-underline hover:text-neon-cyan text-primary transition-colors"
              >
                <span className="font-medium break-words">{r.tournament_name}</span>
                {r.end_date && <span className="text-faint text-xs">{new Date(r.end_date).toLocaleDateString()}</span>}
                <span className="text-muted text-sm ml-auto break-words">
                  {r.winner ? playerName(r.winner) : NONE}
                  {r.winning_score != null && <span className="tabular-nums"> {formatRecapScore(r.winning_score)}</span>}
                  {` · ${r.players} ${r.players === 1 ? 'player' : 'players'}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
