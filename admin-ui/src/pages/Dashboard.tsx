import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import NeonCard from '../components/NeonCard';
import StatusBadge from '../components/StatusBadge';
import TournamentBadge from '../components/TournamentBadge';
import ScoreDisplay from '../components/ScoreDisplay';
import LoadingState from '../components/LoadingState';
import SetupChecklist from '../components/SetupChecklist';

interface DashboardData {
  activeTournaments: Array<{
    tournament_name: string;
    tournament_type: string;
    game_name: string;
    start_date: string;
    leader_name?: string;
    leader_score?: number;
    next_rotation_at?: string | null;
    participants?: number;
  }>;
  recentWinners: Array<{
    game_name: string;
    tournament_name: string;
    winner_name: string;
    winner_score: number;
    end_date: string;
  }>;
  systemHealth: {
    botOnline: boolean;
    setupComplete: boolean;
  };
  uniquePlayersAcrossTournaments?: number;
}

interface HealthData {
  discord: { enabled: boolean; ready: boolean; inGuild: boolean | null; guildId: string | null };
  iscored: { enabled: boolean; configured: boolean };
  poller: {
    running: boolean; paused: boolean; lastPollAt: number | null; lastSuccessAt: number | null;
    lastPollSucceeded: boolean; consecutiveErrors: number;
    accounts: Array<{ name: string; consecutiveErrors: number; lastSuccessAt: number | null; lastError: string | null }>;
  };
  maintenance: Array<{
    tournamentId: string; tournamentName: string; isActive: boolean;
    lastRun: { outcome: string; summary: string | null; finishedAt: string; durationMs: number | null } | null;
    nextFireAt: string | null;
  }>;
  version: { version: string; commit: string | null; builtAt: string | null };
}

function formatAgo(ms: number | null, now: number): string {
  if (!ms) return 'never';
  const diff = now - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatCountdown(targetIso: string | null | undefined, now: number): string | null {
  if (!targetIso) return null;
  const target = new Date(targetIso).getTime();
  if (Number.isNaN(target)) return null;
  const diff = target - now;
  if (diff <= 0) return 'rotating now…';
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

export default function Dashboard() {
  const room = useRoom();
  const [data, setData] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api.get<DashboardData>(`/rooms/${room.roomId}/dashboard`)
      .then(setData)
      .catch(err => {
        setError(err.message);
        // Fallback to basic status
        api.get<any>('/status').then(s => {
          setData({
            activeTournaments: [],
            recentWinners: [],
            systemHealth: { botOnline: s.status === 'online', setupComplete: !s.needsSetup }
          });
        }).catch(() => {});
      });
  }, [room.roomId]);

  // Tick every 30s so countdown labels stay fresh without a per-card timer.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Poll the real health endpoint (S10): Discord gateway readiness, iScored
  // sync status, per-tournament last-run. Best-effort — a failure leaves the
  // rest of the dashboard intact.
  useEffect(() => {
    let cancelled = false;
    const load = () => api.get<HealthData>(`/rooms/${room.roomId}/admin/health`)
      .then(h => { if (!cancelled) setHealth(h); })
      .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [room.roomId]);

  if (!data && !error) return <LoadingState message="Loading dashboard..." />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Dashboard</h1>

      {/* Setup Progress Checklist */}
      <SetupChecklist roomId={room.roomId} roomSlug={room.roomSlug} />

      {error && (
        <NeonCard glowColor="magenta" className="mb-6">
          <h3 className="text-neon-magenta font-bold mb-1">Connection Error</h3>
          <p className="text-muted text-sm">Could not load dashboard data. The backend may not support the dashboard endpoint yet.</p>
        </NeonCard>
      )}

      {/* System Status — real health (S10): Discord gateway readiness, iScored
          sync status, active counts, and running version. */}
      <NeonCard glowColor="cyan" className="mb-6" title="System Status">
        <div className="flex gap-x-8 gap-y-3 flex-wrap items-center">
          {/* Discord gateway */}
          <div className="flex items-center gap-2">
            {(() => {
              const enabled = health?.discord.enabled ?? true;
              const ready = health ? health.discord.ready : (data?.systemHealth.botOnline ?? false);
              const dot = !enabled ? 'bg-faint' : ready ? 'bg-neon-green pulse' : 'bg-neon-magenta';
              return (
                <>
                  <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
                  <span className="text-sm font-medium">{!enabled ? 'Discord disabled' : ready ? 'Bot Online' : 'Bot Offline'}</span>
                  {enabled && ready && health?.discord.guildId && (
                    <span className={`text-xs ${health.discord.inGuild ? 'text-faint' : 'text-neon-amber'}`}>
                      {health.discord.inGuild ? '· in server' : '· not in server'}
                    </span>
                  )}
                </>
              );
            })()}
          </div>

          {/* iScored sync — D3 (v2.32.0): mirrors the Discord-disabled
              treatment for a standalone/iScored-disabled room. Poller
              accounts are now scoped server-side to THIS room's own account
              (pre-fix this showed every OTHER room's poller health too), so
              "accounts.length > 0" here really does mean "this room polls
              an account". Enabled-but-unconfigured keeps the pre-existing
              behavior of simply not rendering the line. */}
          {health && health.iscored.enabled === false ? (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-faint" />
              <span className="text-sm font-medium">iScored disabled</span>
            </div>
          ) : health && health.poller.accounts.length > 0 ? (() => {
            const p = health.poller;
            const degraded = p.consecutiveErrors > 0 || p.accounts.some(a => a.consecutiveErrors > 0);
            const ok = p.lastPollSucceeded && !degraded;
            const dot = p.paused ? 'bg-neon-amber' : ok ? 'bg-neon-green pulse' : degraded ? 'bg-neon-magenta' : 'bg-faint';
            return (
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
                <span className="text-sm font-medium">{p.paused ? 'Sync paused' : ok ? 'iScored Sync' : degraded ? 'Sync degraded' : 'Sync idle'}</span>
                <span className="text-xs text-faint">· last {formatAgo(p.lastSuccessAt, now)}</span>
              </div>
            );
          })() : null}

          <div className="flex items-center gap-2">
            <span className="text-muted text-sm">Active Tournaments:</span>
            <span className="font-display font-bold text-neon-cyan">{data?.activeTournaments.length ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-sm">Active Players:</span>
            <span className="font-display font-bold text-neon-green">{data?.uniquePlayersAcrossTournaments ?? 0}</span>
          </div>

          {/* Running version */}
          {health?.version && (
            <span
              className="text-xs text-faint ml-auto font-mono"
              title={health.version.builtAt ? `Built ${new Date(health.version.builtAt).toLocaleString()}` : undefined}
            >
              v{health.version.version}{health.version.commit ? ` · ${health.version.commit.slice(0, 7)}` : ''}
            </span>
          )}
        </div>

        {/* Poller failure detail, if any */}
        {health && health.poller.accounts.some(a => a.consecutiveErrors > 0) && (
          <div className="mt-3 pt-3 border-t border-border text-xs text-neon-magenta space-y-0.5">
            {health.poller.accounts.filter(a => a.consecutiveErrors > 0).map(a => (
              <div key={a.name}>
                iScored “{a.name}”: {a.consecutiveErrors} consecutive failure(s){a.lastError ? ` — ${a.lastError}` : ''}
              </div>
            ))}
          </div>
        )}
      </NeonCard>

      {/* Active Games */}
      {data && data.activeTournaments.length > 0 && (
        <div className="mb-6">
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted mb-3">Active Now</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.activeTournaments.map((t, i) => {
              const countdown = formatCountdown(t.next_rotation_at, now);
              return (
                <NeonCard key={i} glowColor="cyan">
                  <div className="flex items-center justify-between mb-3">
                    <TournamentBadge type={t.tournament_type} />
                    <StatusBadge status="ACTIVE" />
                  </div>
                  <h3 className="font-bold text-lg mb-1">{t.game_name}</h3>
                  <p className="text-muted text-sm mb-3">{t.tournament_name}</p>
                  <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
                    <div className="bg-raised border border-border rounded px-2 py-1.5">
                      <div className="text-faint uppercase tracking-wider mb-0.5">Players</div>
                      <div className="font-display font-bold text-neon-green text-base">{t.participants ?? 0}</div>
                    </div>
                    <div className="bg-raised border border-border rounded px-2 py-1.5">
                      <div className="text-faint uppercase tracking-wider mb-0.5">Time Left</div>
                      <div className="font-display font-bold text-neon-amber text-base">
                        {countdown ?? <span className="text-faint font-normal">—</span>}
                      </div>
                    </div>
                  </div>
                  {t.leader_name && (
                    <div className="flex items-center justify-between pt-3 border-t border-border">
                      <span className="text-muted text-sm">Leader: <span className="text-primary">{t.leader_name}</span></span>
                      {t.leader_score != null && <ScoreDisplay score={t.leader_score} size="sm" />}
                    </div>
                  )}
                </NeonCard>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Winners */}
      {data && data.recentWinners.length > 0 && (
        <NeonCard title="Recent Winners">
          <div className="space-y-3">
            {data.recentWinners.slice(0, 5).map((w, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                <div>
                  <span className="font-medium">{w.winner_name}</span>
                  <span className="text-muted text-sm ml-2">{w.game_name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <ScoreDisplay score={w.winner_score} size="sm" />
                  <span className="text-faint text-xs">{new Date(w.end_date).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        </NeonCard>
      )}

      {data && data.activeTournaments.length === 0 && !error && (
        <NeonCard className="text-center py-8">
          <p className="text-muted">No active tournaments. Create one in the Tournaments page.</p>
        </NeonCard>
      )}
    </div>
  );
}
