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

      {/* System Status Bar */}
      <NeonCard glowColor="cyan" className="mb-6" title="System Status">
        <div className="flex gap-8 flex-wrap">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${data?.systemHealth.botOnline ? 'bg-neon-green pulse' : 'bg-neon-magenta'}`} />
            <span className="text-sm font-medium">{data?.systemHealth.botOnline ? 'Bot Online' : 'Bot Offline'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-sm">Active Tournaments:</span>
            <span className="font-display font-bold text-neon-cyan">{data?.activeTournaments.length ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-sm">Active Players:</span>
            <span className="font-display font-bold text-neon-green">{data?.uniquePlayersAcrossTournaments ?? 0}</span>
          </div>
        </div>
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
