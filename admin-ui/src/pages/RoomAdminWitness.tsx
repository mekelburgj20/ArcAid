import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import EventLobbyRoster, { type LobbyEntry } from '../components/EventLobbyRoster';
import type { LobbyStatus } from '../lib/lobbyStatus';
import { useRoom } from '../contexts/RoomContext';
import { useRoomTimezone } from '../hooks/useRoomTimezone';
import { api } from '../lib/api';
import { formatInZone } from '../lib/timezone';
import { roomLines, type Routing } from '../lib/witnessScoresGoTo';
import WitnessBuildChip from '../components/WitnessBuildChip';

/**
 * The runner's live device view (v2.187.0, W5) — `/:slug/admin/witness`.
 *
 * What a room admin looks at while running a night: every paired Witness
 * device of a member of THIS room (or a player entered directly into one of
 * its tournaments), whether it is reporting in, when it last checked in, which
 * table is open on it right now and where its scores go; above that, the
 * check-in lobby of each live event as counts, so the runner knows when to
 * start. Polled every 20 s (skipped while the tab is hidden), like EventDetail;
 * no socket. Read-only: nothing here writes.
 *
 * The routing words are `roomLines` — the SAME function behind the player's
 * own "Your scores go to" line — fed the server's per-device routing entry, so
 * the runner reads exactly what the player reads.
 */

type DeviceOnline = 'online' | 'offline' | 'unknown';

interface AdminDevice {
  deviceId: string;
  deviceType: 'atgames' | 'desktop';
  label: string | null;
  /** W60: the Witness build the device last reported; null = it never said. */
  appVersion?: string | null;
  appVersionAt?: string | null;
  userId: string;
  playerName: string;
  member: boolean;
  online: DeviceOnline;
  heartbeatAt: string | null;
  lastSeenAt: string | null;
  lastCheckinAt: string | null;
  openTable: string | null;
  openSince: string | null;
  routing: Routing | null;
  target: string;
}

interface AdminEvent {
  tournamentId: string;
  name: string;
  state: string;
  counts: Record<LobbyStatus, number>;
  roster: LobbyEntry[];
}

interface Payload {
  devices: AdminDevice[];
  events: AdminEvent[];
}

const POLL_MS = 20_000;

const ONLINE_META: Record<DeviceOnline, { label: string; dot: string; text: string; hint: string }> = {
  online: {
    label: 'Online',
    dot: 'bg-neon-green',
    text: 'text-neon-green',
    hint: 'The device has reported in within the last five minutes.',
  },
  offline: {
    label: 'Not responding',
    dot: 'bg-neon-amber',
    text: 'text-neon-amber',
    hint: 'The device has not been heard from for over five minutes. Is it on and connected?',
  },
  unknown: {
    label: 'Unknown',
    dot: 'bg-faint',
    text: 'text-faint',
    hint: 'This device has never sent a heartbeat (an older cabinet build), so its state cannot be told.',
  },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wider text-faint">{label}</dt>
      <dd className="text-sm text-primary break-words">{children}</dd>
    </div>
  );
}

function DeviceCard({ d, timezone }: { d: AdminDevice; timezone: string }) {
  const online = ONLINE_META[d.online];
  const typeWord = d.deviceType === 'desktop' ? 'PC' : 'Cabinet';
  const routing = d.routing ? roomLines([d.routing])[0] : null;
  return (
    <li
      className="rounded-lg border border-border bg-surface p-3 sm:p-4"
      data-testid="witness-admin-device"
    >
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3">
        <Field label="Player">
          {d.playerName}
          {!d.member && <span className="ml-1 text-xs text-faint">(entered, not a member)</span>}
        </Field>
        <Field label="Device">
          {typeWord}{d.label ? ` · ${d.label}` : ''}
          <span className="block mt-0.5"><WitnessBuildChip version={d.appVersion} /></span>
        </Field>
        <Field label="Status">
          <span className={`inline-flex items-center gap-1.5 ${online.text}`} title={online.hint}>
            <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${online.dot}`} />
            {online.label}
          </span>
        </Field>
        <Field label="Last check-in">
          {d.lastCheckinAt ? formatInZone(d.lastCheckinAt, timezone) : 'Never'}
        </Field>
        <Field label="Table open now">
          {d.openTable
            ? <span className="text-neon-amber">{d.openTable}{d.openSince ? ` · since ${formatInZone(d.openSince, timezone)}` : ''}</span>
            : <span className="text-faint">None</span>}
        </Field>
        <Field label="Sends scores to">
          {routing
            ? <span className={routing.ok ? '' : 'text-neon-amber'}>{routing.text}</span>
            : <span className="text-faint">Not known</span>}
          <span className="block text-xs text-muted">Target: {d.target}</span>
        </Field>
      </dl>
    </li>
  );
}

function CountsLine({ counts }: { counts: Record<LobbyStatus, number> }) {
  const parts: Array<[string, number]> = [
    ['Ready', counts.ready],
    ['Exit the table', counts.table_open],
    ['Not checked in', counts.no_checkin],
    ['Not responding', counts.offline],
    ['No device', counts.no_cabinet],
  ];
  if (counts.not_routed > 0) parts.push(['Device not sending here', counts.not_routed]);
  return (
    <p className="text-sm text-primary mb-2 break-words" data-testid="witness-admin-counts">
      {parts.map(([label, n], i) => (
        <span key={label}>
          {i > 0 && <span className="text-faint"> · </span>}
          {label} <strong>{n}</strong>
        </span>
      ))}
    </p>
  );
}

export default function RoomAdminWitness() {
  const { roomId } = useRoom();
  const { timezone } = useRoomTimezone(roomId);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by the Refresh button, the 20 s poll and the tab coming back; the
  // fetch effect below re-runs on every bump (and on a room change).
  const [tick, setTick] = useState(0);
  const manual = useRef(false);

  useEffect(() => {
    let live = true;
    api.get<Payload>(`/rooms/${roomId}/admin/witness/devices`)
      .then(body => { if (live) { setData(body); setError(''); } })
      .catch(err => { if (live) setError((err as Error)?.message || 'Could not load the Witness devices.'); })
      .finally(() => {
        if (live && manual.current) { manual.current = false; setRefreshing(false); }
      });
    return () => { live = false; };
  }, [roomId, tick]);

  // The manual button shows a spinner; the background polls stay quiet.
  const refresh = () => {
    manual.current = true;
    setRefreshing(true);
    setTick(t => t + 1);
  };

  // Poll while the tab is visible; catch up the moment it becomes visible again.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) setTick(t => t + 1); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) setTick(t => t + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!data && !error) return <LoadingState message="Loading Witness devices..." />;

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-primary">Witness devices</h1>
          <p className="text-sm text-muted mt-1">
            Paired Arcaid Witness devices of this room's players, updated every 20 seconds. Table names and times
            are what each device already reports; nothing comes from the player's PC.
          </p>
        </div>
        <NeonButton variant="secondary" onClick={refresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </NeonButton>
      </div>

      {error && <p className="text-sm text-neon-amber mb-3" role="alert">{error}</p>}

      {data?.events.map(ev => (
        <NeonCard key={ev.tournamentId} title={`${ev.name} · check-in lobby`} glowColor="cyan" className="mb-4">
          <CountsLine counts={ev.counts} />
          {ev.roster.length === 0
            ? <p className="text-sm text-muted">Nobody has checked in yet.</p>
            : <EventLobbyRoster entries={ev.roster} compact />}
        </NeonCard>
      ))}

      {data && (
        data.devices.length === 0 ? (
          <NeonCard>
            <p className="text-sm text-muted">No Witness devices are paired by members of this room yet.</p>
          </NeonCard>
        ) : (
          <ul className="space-y-3" data-testid="witness-admin-devices">
            {data.devices.map(d => <DeviceCard key={d.deviceId} d={d} timezone={timezone} />)}
          </ul>
        )
      )}
    </div>
  );
}
