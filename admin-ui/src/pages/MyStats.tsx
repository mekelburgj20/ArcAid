import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useMyRooms } from '../hooks/useMyRooms';
import { useRetryingLoad } from '../hooks/useRetryingLoad';
import { PersonalBestsSection, type PersonalBestRow } from '../components/PersonalBestsSection';
import LoginButtons from '../components/LoginButtons';
import LoadFailedNotice from '../components/LoadFailedNotice';
import ArcaidPage from '../components/parts/ArcaidPage';
import Panel, { PanelGroup } from '../components/parts/Panel';
import { ButtonLink } from '../components/parts/Button';
import StatTiles from '../components/parts/StatTiles';
import { RailTabs } from '../components/parts/Tabs';
import { tabPanelProps } from '../components/parts/tabPanel';
import { SkeletonRows, SkeletonTiles } from '../components/parts/Skeleton';
import EmptyState from '../components/parts/EmptyState';

interface MyStatsOverview {
  gamesWithBest: number;
  memberRooms: number;
  totalScores: number;
}

interface MyStatsResponse {
  scope: string;
  overview: MyStatsOverview;
  personalBests: PersonalBestRow[];
}

/**
 * My Stats v1 (v2.82.0, Identity arc Phase 3 — plan docs/contracts/my-stats-v282-plan.md).
 *
 * Entry is account/user-menu ONLY (no global-nav item, per plan decision).
 * Scope selector is `All | <member rooms>` — no separate Global scope;
 * direct-Global bests surface in "All" via the PersonalBestsSection "Global"
 * chip (plan decision — no double-counting a room best as its Global fan-out
 * copy, see GET /api/me/stats doc comment in src/api/routes/global.ts).
 *
 * G22: the page wears the Arcaid look, and its read retries by itself (G31),
 * so a failed load is "couldn't load", never a silent empty page.
 */
export default function MyStats() {
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const { rooms: memberRooms, loading: roomsLoading } = useMyRooms();
  const [scope, setScope] = useState('all');
  // The answer is stored with the scope it was asked for, so a switch never shows the old scope's bests.
  const [answer, setAnswer] = useState<{ scope: string; json: MyStatsResponse } | null>(null);

  const { load, phase } = useRetryingLoad(
    () => fetch(`/api/me/stats?scope=${encodeURIComponent(scope)}`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    }),
    async res => {
      const json = await res.json();
      if (!(json && json.overview && Array.isArray(json.personalBests))) throw new Error('shape');
      setAnswer({ scope, json });
    },
    `${playerToken}|${scope}`,
  );
  useEffect(() => { if (playerToken) load(); }, [playerToken, scope, load]);

  if (!discordUser) {
    return (
      <ArcaidPage title="My Stats" bare>
        <div className="text-center px-6">
          <BarChart3 size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in to see your stats</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__mystats__', '/my-stats')}
            onGoogleLogin={() => loginWithGoogle('__mystats__', '/my-stats')}
            className="justify-center"
          />
        </div>
      </ArcaidPage>
    );
  }

  const data = answer && answer.scope === scope ? answer.json : null;
  const showTabs = !roomsLoading && memberRooms.length > 0;

  const panels = (
    <>
      {!data && phase !== 'loading' ? (
        <Panel wide title="Overview">
          {phase === 'retrying' ? (
            <LoadFailedNotice what="your stats" onRetry={load} className="py-8" />
          ) : (
            <>
              <p className="text-muted">Could not load your stats.</p>
              <p className="text-xs text-muted mt-1">Try refreshing the page.</p>
            </>
          )}
        </Panel>
      ) : (
        <>
          <Panel wide title="Overview">
            {data ? (
              <StatTiles
                tiles={[
                  { label: 'Games with a best', value: data.overview.gamesWithBest.toLocaleString() },
                  { label: 'Member rooms', value: data.overview.memberRooms.toLocaleString() },
                  { label: 'Scores posted', value: data.overview.totalScores.toLocaleString() },
                ]}
              />
            ) : (
              <SkeletonTiles count={3} label="Loading your stats" />
            )}
          </Panel>
          <Panel wide title="Personal Bests">
            {!data ? (
              <SkeletonRows count={4} label="Loading your personal bests" />
            ) : data.personalBests.length === 0 ? (
              <EmptyState
                title="No personal bests yet."
                action={<ButtonLink to="/my-rooms" variant="secondary">Open My Rooms</ButtonLink>}
              >
                Submit a score in a room to see it here.
              </EmptyState>
            ) : (
              <>
                {/* v2.83.0 owner semantics revision — room scope only: room
                    scope shows a filtered subset (games where THIS room's
                    board is the player's overall best across every room +
                    Global), which reads as "missing games" without this
                    explainer. All scope needs none — every game is shown. */}
                {scope !== 'all' && (
                  <p className="text-xs text-muted mb-3">
                    Scores set in this room that are your overall personal best across all rooms and Global.
                  </p>
                )}
                {/* showRoomCaption only in the cross-room "All" scope — a
                    single-room scope already has that context from the tab. */}
                <PersonalBestsSection
                  heading={false}
                  personalBests={data.personalBests}
                  rankHeader="Rank"
                  showRoomCaption={scope === 'all'}
                  wrapTitles
                />
              </>
            )}
          </Panel>
        </>
      )}
    </>
  );

  return (
    <ArcaidPage title="My Stats" width="wide">
      <PanelGroup id="my-stats" tone="cyan" title="Your stats">
        {showTabs && (
          <div className="lg:col-span-2">
            <RailTabs
              label="Stats scope"
              idPrefix="mystats-scope"
              tabs={[{ id: 'all', label: 'All' }, ...memberRooms.map(r => ({ id: r.roomId, label: r.name }))]}
              value={scope}
              onChange={setScope}
            />
          </div>
        )}
        {showTabs ? (
          <div className="lg:col-span-2 flex flex-col gap-5" {...tabPanelProps('mystats-scope', scope)}>{panels}</div>
        ) : (
          <div className="lg:col-span-2 flex flex-col gap-5">{panels}</div>
        )}
      </PanelGroup>
    </ArcaidPage>
  );
}
