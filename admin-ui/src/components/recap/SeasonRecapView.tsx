import { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import Panel from '../parts/Panel';
import StatTiles from '../parts/StatTiles';
import EmptyState from '../parts/EmptyState';
import { ListRow, ListRows } from '../parts/ListRow';
import PlayerNameLink from '../PlayerNameLink';
import LoadingState from '../LoadingState';
import LoadFailedNotice from '../LoadFailedNotice';
import { playerName } from '../ScoreboardComponents';
import { roomFetch } from '../../lib/roomFetch';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { tournamentRecapPath } from '../../lib/tournamentLinks';
import type { RecapPlayerRef, SeasonRecap } from '../../lib/runRecapTypes';

/**
 * B31.4 - a tournament's "By the numbers" (`?view=numbers` on the tournament
 * page): the season in tiles, its awards, and who won what. Names arrive in
 * `players` (resolved at read by the server) and are looked up by key; a key is
 * never rendered. Award details are server-built and carry no names.
 */

/** Names for a list of keys, in order, skipping any the server did not ship. */
export function namesOf(keys: string[], players: RecapPlayerRef[]): string {
  const byKey = new Map(players.map(p => [p.key, p]));
  return keys.map(k => byKey.get(k)).filter((p): p is RecapPlayerRef => !!p).map(p => playerName(p)).join(', ');
}

export default function SeasonRecapView({ roomId, slug, tournamentId }: { roomId: string; slug: string; tournamentId: string }) {
  const [recap, setRecap] = useState<SeasonRecap | null>(null);
  const { load, phase } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/tournaments/${encodeURIComponent(tournamentId)}/recap`),
    async res => {
      const body = await res.json();
      if (!body || !Array.isArray(body.standings) || !Array.isArray(body.awards)) throw new Error('Bad recap body');
      setRecap(body);
    },
    `${roomId}|${tournamentId}`,
  );
  useEffect(() => {
    load();
  }, [roomId, tournamentId, load]);

  if (phase === 'retrying') return <LoadFailedNotice what="the season recap" onRetry={load} testId="season-recap-load-failed" />;
  if (!recap) return <LoadingState message="Loading the season..." />;

  if (recap.runs === 0 && recap.live_runs === 0) {
    return (
      <EmptyState title="No finished runs yet">
        The season's numbers appear here once a run has finished.
      </EmptyState>
    );
  }

  const byKey = new Map(recap.players.map(p => [p.key, p]));
  const witnessGames = recap.standings.reduce((n, s) => n + (s.games ?? 0), 0);

  return (
    <div className="grid gap-5" data-testid="season-recap">
      <Panel wide title="The season">
        <StatTiles
          tiles={[
            { label: recap.runs === 1 ? 'Run' : 'Runs', value: recap.runs.toLocaleString() },
            { label: 'Players', value: recap.standings.length.toLocaleString() },
            { label: 'Witness games', value: witnessGames.toLocaleString() },
            { label: 'Running now', value: recap.live_runs.toLocaleString() },
          ]}
        />
        <p className="mt-3 text-xs text-faint">
          Finished runs only. Games are Arcaid Witness games; players who keep their play stats private are left out of them.
        </p>
      </Panel>

      {recap.awards.length > 0 && (
        <Panel wide title="Awards">
          <ListRows label="Season awards" testId="season-awards">
            {recap.awards.map(a => {
              const who = namesOf(a.player_keys, recap.players);
              const caption = [who, a.detail, a.run?.game_name].filter(Boolean).join(' · ');
              return (
                <ListRow
                  key={a.id}
                  tile={<Trophy size={18} />}
                  name={a.label}
                  caption={caption}
                  href={a.run ? tournamentRecapPath(slug, a.run.tournament_id, a.run.game_id) : undefined}
                  testId={`season-award-${a.id}`}
                />
              );
            })}
          </ListRows>
        </Panel>
      )}

      {recap.standings.length > 0 && (
        <Panel wide title="Standings">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="season-standings">
              <thead>
                <tr className="text-[10px] text-faint uppercase tracking-wider text-left">
                  <th className="py-2 pr-3 font-normal">Player</th>
                  <th className="py-2 px-2 font-normal text-center">Runs</th>
                  <th className="py-2 px-2 font-normal text-center">Won</th>
                  <th className="py-2 px-2 font-normal text-center">Podiums</th>
                  <th className="py-2 pl-2 font-normal text-center">Games</th>
                </tr>
              </thead>
              <tbody>
                {recap.standings.map(s => {
                  const ref = byKey.get(s.player_key);
                  return (
                    <tr key={s.player_key} className="border-t border-border/30">
                      <td className="py-2 pr-3 min-w-0">
                        {ref ? (
                          <PlayerNameLink slug={slug} entry={ref} className="text-primary hover:text-neon-cyan transition-colors no-underline break-words" />
                        ) : <span className="text-muted">Unknown player</span>}
                      </td>
                      <td className="py-2 px-2 text-center text-muted">{s.runs_played}</td>
                      <td className="py-2 px-2 text-center font-display text-neon-green">{s.runs_won}</td>
                      <td className="py-2 px-2 text-center text-muted">{s.podiums}</td>
                      <td
                        className="py-2 pl-2 text-center text-muted"
                        title={s.games == null ? 'This player keeps their play stats private' : undefined}
                      >
                        {s.games == null ? '—' : s.games.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
