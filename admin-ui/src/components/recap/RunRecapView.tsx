import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import Button from '../parts/Button';
import EmptyState from '../parts/EmptyState';
import Panel, { PanelGroup } from '../parts/Panel';
import { Skeleton, SkeletonTiles } from '../parts/Skeleton';
import StatTiles from '../parts/StatTiles';
import LoadFailedNotice from '../LoadFailedNotice';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { roomFetch } from '../../lib/roomFetch';
import { tournamentResultsPath } from '../../lib/tournamentLinks';
import type { RunRecap } from '../../lib/runRecapTypes';
import CopyForDiscordButton from './CopyForDiscordButton';
import GamesPerDay from './GamesPerDay';
import LeadChangeList from './LeadChangeList';
import PlayerRunDetail from './PlayerRunDetail';
import RecapAwards from './RecapAwards';
import RecapHero from './RecapHero';
import RecapPlayerTable from './RecapPlayerTable';
import WhoLedChart from './WhoLedChart';

/**
 * "By the numbers" for one run (B31.2): `/:slug/tournaments/:tid?run=<gameId>&recap=1`.
 * Reads `GET /api/rooms/:roomId/runs/:gameId/recap`. An active run is "So far"
 * with a Refresh button (the page joins no socket, so `useLiveRefresh` does
 * not apply).
 */
export default function RunRecapView({ roomId, slug, tournamentId, gameId }: {
  roomId: string;
  slug: string | undefined;
  tournamentId: string;
  gameId: string;
}) {
  const [recap, setRecap] = useState<RunRecap | null>(null);
  const [recapFor, setRecapFor] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const { load, phase } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/runs/${encodeURIComponent(gameId)}/recap`),
    async res => {
      const json = await res.json() as RunRecap;
      if (!json || !Array.isArray(json.players) || !json.run) throw new Error('bad shape');
      setRecap(json);
      setRecapFor(gameId);
    },
    `${roomId}:${gameId}`,
  );

  useEffect(() => {
    load();
  }, [roomId, gameId, load]);

  const back = slug ? (
    <Link
      to={tournamentResultsPath(slug, tournamentId, gameId)}
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-neon-cyan transition-colors no-underline"
    >
      <ChevronLeft size={16} aria-hidden="true" />
      All runs
    </Link>
  ) : null;

  const data = recapFor === gameId ? recap : null;

  if (!data) {
    if (phase === 'loading') {
      return (
        <div data-testid="recap-loading">
          <div className="mb-4">{back}</div>
          <div className="flex flex-col gap-4">
            <Skeleton width="55%" height={24} />
            <SkeletonTiles count={4} label="Loading the recap" />
            <Skeleton width="100%" height={200} />
          </div>
        </div>
      );
    }
    if (phase === 'retrying') {
      return (
        <div>
          <div className="mb-4">{back}</div>
          <LoadFailedNotice what="the recap" onRetry={load} />
        </div>
      );
    }
    return (
      <div>
        <EmptyState title="This run has no recap" action={back}>
          It may have been removed, or it was never a tournament run.
        </EmptyState>
      </div>
    );
  }

  const { run, totals, players, awards, per_day: perDay } = data;
  const active = run.state === 'active';
  const openPlayer = openKey ? players.find(p => p.key === openKey) ?? null : null;
  const updated = new Date(data.generated_at);
  const dayTile = perDay ? String(perDay.length) : (totals.witness_games > 0 ? '1' : '—');

  return (
    <div data-testid="run-recap">
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {back}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {active && (
            <span className="text-xs text-faint" data-testid="recap-updated">
              Updated {Number.isNaN(updated.getTime()) ? '' : updated.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          {active && <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>}
          <CopyForDiscordButton text={data.discord_text} />
        </span>
      </div>

      <PanelGroup
        id="run-recap"
        tone="cyan"
        title={active ? 'By the numbers · So far' : 'By the numbers'}
        sub={active ? 'This run is still going; the numbers move as scores come in.' : undefined}
      >
        <Panel title="Result" wide>
          <RecapHero recap={data} />
          <div className="mt-4">
            <StatTiles
              tiles={[
                { label: 'Players', value: totals.players },
                { label: 'Witness games', value: totals.witness_games },
                { label: 'Lead changes', value: data.facts.lead_changes },
                { label: perDay?.[0]?.kind === 'week' ? 'Weeks' : 'Days', value: dayTile },
              ]}
            />
          </div>
        </Panel>

        {data.lead_steps.length > 0 && (
          <Panel title="Who led" wide>
            <WhoLedChart steps={data.lead_steps} changes={data.lead_changes} players={players} run={run} />
            <LeadChangeList changes={data.lead_changes} players={players} timezone={run.timezone} />
          </Panel>
        )}

        <Panel title="Players" wide>
          {players.length === 0 ? (
            <p className="m-0 text-sm text-muted">Nobody has posted a score in this run yet.</p>
          ) : (
            <RecapPlayerTable players={players} onOpen={setOpenKey} />
          )}
        </Panel>

        {awards.length > 0 && (
          <Panel title="Awards">
            <RecapAwards awards={awards} players={players} />
          </Panel>
        )}

        {perDay && perDay.length > 0 && (
          <Panel title={perDay[0]!.kind === 'week' ? 'Games per week' : 'Games per day'}>
            <GamesPerDay buckets={perDay} />
          </Panel>
        )}
      </PanelGroup>

      <p className="mt-4 text-xs text-faint">
        Only Arcaid Witness games count as games, averages and medians. Typed-in and synced scores count for best score and finish.
      </p>

      {openPlayer && (
        <PlayerRunDetail
          roomId={roomId}
          gameId={gameId}
          player={openPlayer}
          open
          onClose={() => setOpenKey(null)}
          maxAttempts={run.max_attempts}
        />
      )}
    </div>
  );
}
