import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, ArrowLeft, Home, Trophy, Building2, Target } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useMyRooms } from '../hooks/useMyRooms';
import { PersonalBestsSection, type PersonalBestRow } from '../components/PersonalBestsSection';
import LoginButtons from '../components/LoginButtons';

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
 * Built on the MyRooms.tsx skeleton: same logged-out gate + return-path login
 * idiom, same nav header. Entry is account/user-menu ONLY (no global-nav
 * item, per plan decision). Scope selector is `All | <member rooms>` — no
 * separate Global scope; direct-Global bests surface in "All" via the
 * PersonalBestsSection "Global" chip (plan decision — no double-counting a
 * room best as its Global fan-out copy, see GET /api/me/stats doc comment in
 * src/api/routes/global.ts).
 */
export default function MyStats() {
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const { rooms: memberRooms, loading: roomsLoading } = useMyRooms();
  const [scope, setScope] = useState('all');
  const [data, setData] = useState<MyStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!playerToken) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    fetch(`/api/me/stats?scope=${encodeURIComponent(scope)}`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: MyStatsResponse) => { if (!cancelled) setData(json); })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playerToken, scope]);

  if (!discordUser) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <div className="text-center">
          <BarChart3 size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in to see your stats</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__mystats__', '/my-stats')}
            onGoogleLogin={() => loginWithGoogle('__mystats__', '/my-stats')}
            className="justify-center"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Navigation header */}
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div
          className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors cursor-pointer bg-transparent border-0 p-0"
          >
            <ArrowLeft size={16} />
            Back
          </button>
          <Link to="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
            <Home size={16} />
            Home
          </Link>
        </div>
      </nav>

      <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-2 mb-6">
          <BarChart3 size={20} className="text-neon-cyan" />
          <h1 className="font-display text-xl font-bold">My Stats</h1>
        </div>

        {/* Scope selector: All + one pill per member room. Nothing to switch
            between when the viewer has no room memberships yet. */}
        {!roomsLoading && memberRooms.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6" role="tablist" aria-label="Stats scope">
            <ScopePill active={scope === 'all'} onClick={() => setScope('all')}>
              All
            </ScopePill>
            {memberRooms.map(room => (
              <ScopePill key={room.roomId} active={scope === room.roomId} onClick={() => setScope(room.roomId)}>
                {room.name}
              </ScopePill>
            ))}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : loadError || !data ? (
          <div className="text-center py-12">
            <p className="text-muted">Could not load your stats.</p>
            <p className="text-xs text-faint mt-1">Try refreshing the page.</p>
          </div>
        ) : (
          <>
            {/* Overview tiles */}
            <div className="grid grid-cols-3 gap-3 mb-8">
              <StatTile icon={<Trophy size={16} className="text-neon-amber" />} label="Games with a best" value={data.overview.gamesWithBest} />
              <StatTile icon={<Building2 size={16} className="text-neon-cyan" />} label="Member rooms" value={data.overview.memberRooms} />
              <StatTile icon={<Target size={16} className="text-neon-magenta" />} label="Scores posted" value={data.overview.totalScores} />
            </div>

            {data.personalBests.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted">No personal bests yet.</p>
                <p className="text-xs text-faint mt-1">Submit a score in a room to see it here.</p>
              </div>
            ) : (
              <>
                {/* v2.83.0 owner semantics revision — room scope only: room
                    scope now shows a filtered subset (games where THIS
                    room's board is the player's overall best across every
                    room + Global), which reads as "missing games" without
                    this explainer. All scope needs no explainer — every game
                    is shown there by definition. */}
                {scope !== 'all' && (
                  <p className="text-xs text-faint mb-3">
                    Scores set in this room that are your overall personal best across all rooms and Global.
                  </p>
                )}
                {/* showRoomCaption only in the cross-room "All" scope — a
                    single-room scope already has that context from the pill. */}
                <PersonalBestsSection
                  personalBests={data.personalBests}
                  rankHeader="Rank"
                  showRoomCaption={scope === 'all'}
                  wrapTitles
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ScopePill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer border ${
        active
          ? 'bg-neon-cyan/10 border-neon-cyan/50 text-neon-cyan'
          : 'bg-transparent border-border text-muted hover:text-primary hover:border-neon-cyan/30'
      }`}
    >
      {children}
    </button>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 text-center">
      <div className="flex items-center justify-center gap-1 mb-1">{icon}</div>
      <p className="font-display font-bold text-2xl text-primary">{value.toLocaleString()}</p>
      <p className="text-faint text-[10px] uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}
