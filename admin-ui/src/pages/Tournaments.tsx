import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { api, getToken } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import TournamentBadge from '../components/TournamentBadge';
import DataTable from '../components/DataTable';
import LoadingState from '../components/LoadingState';
import CardStyleEditorSheet from '../components/scoreboard/CardStyleEditorSheet';
import TournamentFormFields, {
  useTournamentForm,
  getPlatformRuleConflicts,
} from '../components/TournamentForm';
import { toPayload, tournamentToFormState, type Tournament } from '../lib/tournamentFormPayload';
import { relativeTimeFrom } from '../lib/format';

export type { Tournament };

type RunInfo = {
  lastRun: { outcome: string; summary: string | null; finishedAt: string } | null;
  nextFireAt: string | null;
};

const formatRunAgo = relativeTimeFrom;

function formatNextFire(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  // Render in the tournament's configured timezone (+ abbreviation) so this
  // matches the Schedule column instead of the viewer's browser-local tz.
  if (tz) { opts.timeZone = tz; opts.timeZoneName = 'short'; }
  return d.toLocaleString([], opts);
}

function formatCadenceDisplay(cadenceJson: string): string {
  try {
    const c = JSON.parse(cadenceJson);
    const cron = c.cron || '';
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;
    const min = parts[0]; const hr = parts[1]; const dom = parts[2]; const dow = parts[4];
    const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const tz = c.timezone ? ` ${c.timezone.split('/').pop()?.replace(/_/g, ' ')}` : '';
    if (dom === 'L') return `Last day of month at ${time}${tz}`;
    if (dom !== '*') return `${ordinal(parseInt(dom))} of month at ${time}${tz}`;
    if (dow !== '*') return `${days[parseInt(dow)] || dow} at ${time}${tz}`;
    return `Daily at ${time}${tz}`;
  } catch { return 'Not set'; }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

interface ActiveGame {
  id: string;
  name: string;
  display_name: string | null;
  tournament_id: string;
  tournament_name: string;
  tournament_type: string;
  iscored_id: string | null;
  start_date: string;
  catalogue_style_id: string | null;
  style_header_disabled: number;
  /** v2.115.0 — per-game background framing (null = unframed). */
  bg_zoom: number | null;
  bg_pos_x: number | null;
  bg_pos_y: number | null;
}

interface RetainedCompletedGame {
  id: string;
  name: string;
  display_name: string | null;
  tournament_id: string;
  tournament_name: string;
  tournament_type: string;
  iscored_id: string | null;
  status: 'COMPLETED';
  end_date: string;
}

/** Minimal shape used by the Delete dialog — both ActiveGame and
 *  RetainedCompletedGame are structurally compatible. */
type DeletableGame = { id: string; name: string; tournament_name: string };

export default function Tournaments() {
  const room = useRoom();
  const { toast } = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [runInfo, setRunInfo] = useState<Record<string, RunInfo>>({});
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Tournament | null>(null);
  const [editTarget, setEditTarget] = useState<Tournament | null>(null);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [activeGames, setActiveGames] = useState<ActiveGame[]>([]);
  const [retainedCompleted, setRetainedCompleted] = useState<RetainedCompletedGame[]>([]);
  const [deactivateTarget, setDeactivateTarget] = useState<ActiveGame | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [deleteGameTarget, setDeleteGameTarget] = useState<DeletableGame | null>(null);
  const [deleteGameConfirm, setDeleteGameConfirm] = useState('');
  const [deletingGame, setDeletingGame] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [styleTarget, setStyleTarget] = useState<ActiveGame | null>(null);
  const [libraryHasDefault, setLibraryHasDefault] = useState(false);
  const [displayNameTarget, setDisplayNameTarget] = useState<ActiveGame | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [reloadingScheduler, setReloadingScheduler] = useState(false);
  // Per-row pause/resume busy flag (per-id, not a bare boolean, so only the
  // toggled row shows the busy label while other rows stay clickable).
  const [pausingId, setPausingId] = useState<string | null>(null);
  // Upgraded tournament-delete modal state: blocker list (ACTIVE/QUEUED games
  // returned by the BE 409), the auto-deactivate opt-in, and a busy flag.
  const [deleteBlockers, setDeleteBlockers] = useState<{ id: string; name: string; status: string }[]>([]);
  const [autoDeactivate, setAutoDeactivate] = useState(false);
  const [deletingTournament, setDeletingTournament] = useState(false);

  const handleReloadScheduler = async () => {
    setReloadingScheduler(true);
    try {
      await api.post(`/rooms/${room.roomId}/scheduler/reload`, {});
      toast('Schedules refreshed', 'success');
    } catch {
      toast('Failed to refresh schedules', 'error');
    } finally {
      setReloadingScheduler(false);
    }
  };

  const createForm = useTournamentForm();
  const editForm = useTournamentForm();

  const fetchTournaments = async () => {
    try {
      setTournaments(await api.get<Tournament[]>(`/rooms/${room.roomId}/tournaments`));
    } catch {
      toast('Failed to load tournaments', 'error');
    } finally {
      setLoading(false);
    }
    // Last-run outcome + next-fire per tournament (S10) — best-effort; never
    // block the tournaments table on the health endpoint.
    try {
      const health = await api.get<{ maintenance: Array<{ tournamentId: string } & RunInfo> }>(
        `/rooms/${room.roomId}/admin/health`,
      );
      const map: Record<string, RunInfo> = {};
      for (const m of health.maintenance) map[m.tournamentId] = { lastRun: m.lastRun, nextFireAt: m.nextFireAt };
      setRunInfo(map);
    } catch { /* best-effort */ }
  };

  // Catalogue-derived list of platforms available in this room. Replaces the
  // legacy `game_room_settings.PLATFORMS` static list (often drifted from the
  // catalogue, hence the "No platforms configured" empty state on the create
  // form when the setting was unset). The endpoint returns canonical IDs;
  // TournamentFormFields folds them into engine + device chip lists (ADR 0016
  // P2 §2) — the catalogue is still a legacy-id list, the rules no longer are.
  const fetchPlatforms = async () => {
    try {
      const data = await api.get<{ platforms: string[] }>(`/rooms/${room.roomId}/platforms/available`);
      setPlatforms(data.platforms || []);
    } catch {
      // Silent fail keeps the create form responsive even if the endpoint hiccups.
    }
  };

  const fetchActiveGames = async () => {
    try {
      setActiveGames(await api.get<ActiveGame[]>(`/rooms/${room.roomId}/games/active`));
    } catch {}
  };

  const fetchRetainedCompleted = async () => {
    try {
      setRetainedCompleted(await api.get<RetainedCompletedGame[]>(`/rooms/${room.roomId}/games/retained-completed`));
    } catch {}
  };


  const handleReorderLineup = async () => {
    setReordering(true);
    try {
      await api.post(`/rooms/${room.roomId}/tournaments/reorder-lineup`, {});
      toast('iScored lineup reordered', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to reorder lineup', 'error');
    } finally {
      setReordering(false);
    }
  };

  // Pause/Resume a tournament by flipping is_active via the dedicated PATCH
  // endpoint. The BE reloads the scheduler so a paused tournament's cron stops
  // firing immediately. Re-fetch after so the row's badge/label reflect the
  // new value (fetch-after-mutate pattern used by every handler here).
  const handlePauseToggle = async (t: Tournament) => {
    const next = t.is_active !== 0 ? false : true; // currently active -> pause
    setPausingId(t.id);
    try {
      await api.patch(`/rooms/${room.roomId}/tournaments/${t.id}/active`, { is_active: next });
      toast(next ? 'Tournament resumed' : 'Tournament paused', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to update tournament', 'error');
    } finally {
      setPausingId(null);
      await fetchTournaments();
    }
  };

  const handleDeactivate = async (dbOnly: boolean = false) => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      const result = await api.post<{
        success: boolean;
        gameName: string;
        tournamentName: string;
        iscoredStatus?: 'locked' | 'failed' | 'shared' | 'skipped';
        iscoredError?: string;
        finalSyncedScores?: number;
      }>(`/rooms/${room.roomId}/games/${deactivateTarget.id}/deactivate`, { dbOnly });
      const name = deactivateTarget.name;
      const captured = result.finalSyncedScores ?? 0;
      const capturedSuffix = captured > 0 ? ` (captured ${captured} late score${captured === 1 ? '' : 's'})` : '';
      if (dbOnly) {
        toast(`${name} deactivated (DB only — iScored untouched)`, 'success');
      } else if (result.iscoredStatus === 'locked') {
        toast(`${name} deactivated and locked on iScored${capturedSuffix}`, 'success');
      } else if (result.iscoredStatus === 'shared') {
        toast(`${name} deactivated (iScored game still active in another tournament — left unlocked)`, 'success');
      } else if (result.iscoredStatus === 'failed') {
        toast(`${name} deactivated locally — iScored lock failed (${result.iscoredError ?? 'unknown'}). Lock it manually on iScored or use Delete.`, 'error');
      } else {
        toast(`${name} deactivated (iScored not configured)`, 'success');
      }
      setDeactivateTarget(null);
      await fetchActiveGames();
      await fetchTournaments();
    } catch (err: any) {
      toast(err.message || 'Failed to deactivate game', 'error');
    } finally {
      setDeactivating(false);
    }
  };

  // Destructive variant of Deactivate. Use only when the game was activated
  // for the wrong tournament (or otherwise should never have existed). Final-
  // syncs scores, deletes from iScored, orphans local scores (preserves
  // player history per ADR 0005), DELETEs the games row.
  const handleDeleteGame = async () => {
    if (!deleteGameTarget) return;
    setDeletingGame(true);
    try {
      const result = await api.delete<{
        success: boolean;
        gameName: string;
        tournamentName: string | null;
        iscoredStatus?: 'deleted' | 'failed' | 'shared' | 'skipped';
        iscoredError?: string;
        finalSyncedScores?: number;
        scoresOrphaned?: { submissions: number; scoreHistory: number; globalScores: number };
      }>(`/rooms/${room.roomId}/games/${deleteGameTarget.id}`);
      const name = deleteGameTarget.name;
      const captured = result.finalSyncedScores ?? 0;
      const capturedSuffix = captured > 0 ? ` (captured ${captured} late score${captured === 1 ? '' : 's'})` : '';
      const orphaned = result.scoresOrphaned;
      const orphanSuffix = orphaned && (orphaned.submissions || orphaned.scoreHistory || orphaned.globalScores)
        ? ` Orphaned ${orphaned.submissions}/${orphaned.scoreHistory}/${orphaned.globalScores} score rows (sub/hist/global) — player history preserved.`
        : '';
      if (result.iscoredStatus === 'deleted') {
        toast(`${name} deleted from Arcaid and iScored${capturedSuffix}.${orphanSuffix}`, 'success');
      } else if (result.iscoredStatus === 'shared') {
        toast(`${name} deleted from Arcaid (iScored game still active in another tournament — left in place).${orphanSuffix}`, 'success');
      } else if (result.iscoredStatus === 'failed') {
        toast(`${name} deleted from Arcaid — iScored delete failed (${result.iscoredError ?? 'unknown'}). Remove it manually on iScored.`, 'error');
      } else {
        toast(`${name} deleted from Arcaid (iScored not configured).${orphanSuffix}`, 'success');
      }
      setDeleteGameTarget(null);
      setDeleteGameConfirm('');
      await fetchActiveGames();
      await fetchRetainedCompleted();
      await fetchTournaments();
    } catch (err: any) {
      toast(err.message || 'Failed to delete game', 'error');
    } finally {
      setDeletingGame(false);
    }
  };

  useEffect(() => { fetchTournaments(); fetchPlatforms(); fetchActiveGames(); fetchRetainedCompleted(); }, []);

  const handleCreate = async () => {
    if (!createForm.state.name.trim() || !createForm.state.tag.trim()) return;
    try {
      await api.post(`/rooms/${room.roomId}/tournaments`, toPayload(createForm.state, { id: uuidv4(), is_active: true }));
      createForm.reset();
      toast('Tournament created', 'success');
      fetchTournaments();
    } catch {
      toast('Failed to create tournament', 'error');
    }
  };

  // Tournament delete. The shared `api.delete` helper flattens non-OK responses
  // to `throw new Error(error.error)` and DISCARDS the structured `games[]`
  // array the BE returns on a 409 block (api.ts:99-103). We can't touch api.ts
  // here, so this path uses a raw fetch to read the full 409 body (the
  // ACTIVE/QUEUED blocker list) and keep the modal open showing it. When
  // `autoDeactivate` is set we pass the flag so the BE deactivates the live
  // game(s) first, then drops the tournament.
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeletingTournament(true);
    try {
      const token = getToken();
      const res = await fetch(`/api/rooms/${room.roomId}/tournaments/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ autoDeactivate }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409 && Array.isArray(err.games)) {
          // Block: live games present and auto-deactivate not requested. Surface
          // the blocker list + the now-required checkbox; keep the modal open.
          setDeleteBlockers(err.games);
          toast(err.error || 'Tournament still has live games', 'error');
        } else {
          toast(err.error || 'Failed to delete tournament', 'error');
        }
        return;
      }
      toast('Tournament deleted', 'success');
      setDeleteTarget(null);
      setDeleteBlockers([]);
      setAutoDeactivate(false);
      // Auto-deactivate may have flipped a game to COMPLETED, so refresh the
      // active + retained-completed tables too.
      await fetchTournaments();
      await fetchActiveGames();
      await fetchRetainedCompleted();
    } catch (err: any) {
      toast(err.message || 'Failed to delete tournament', 'error');
    } finally {
      setDeletingTournament(false);
    }
  };

  const openEdit = (t: Tournament) => {
    setEditTarget(t);
    editForm.reset(tournamentToFormState(t));
  };

  const handleEditSave = async () => {
    if (!editTarget || !editForm.state.name.trim() || !editForm.state.tag.trim()) return;
    setEditSaving(true);
    try {
      await api.put(
        `/rooms/${room.roomId}/tournaments/${editTarget.id}`,
        toPayload(editForm.state, {
          guild_id: editTarget.guild_id || '',
          discord_role_id: editTarget.discord_role_id || '',
          // Preserve the row's paused/active state. Without this the PUT would
          // re-assert is_active and silently resume a paused tournament.
          is_active: editTarget.is_active !== 0,
        })
      );
      toast('Tournament updated', 'success');
      setEditTarget(null);
      fetchTournaments();
    } catch {
      toast('Failed to update tournament', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  if (loading) return <LoadingState message="Loading tournaments..." />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Tournaments</h1>

      {/* Tournament List */}
      <NeonCard className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted">Active Tournaments</h3>
          <NeonButton variant="ghost" onClick={handleReorderLineup} disabled={reordering} className="text-xs px-3 py-1">
            {reordering ? 'Reordering...' : 'Sync iScored Lineup'}
          </NeonButton>
        </div>
        <DataTable<Tournament>
          columns={[
            { key: 'name', header: 'Name', render: t => (
              <span>
                <span className={t.is_active === 0 ? 'font-medium opacity-50' : 'font-medium'}>{t.name}</span>
                {t.is_active === 0 && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded bg-border/30 text-muted border border-border opacity-60">Paused</span>
                )}
              </span>
            )},
            { key: 'type', header: 'Tag', render: t => <TournamentBadge type={t.type} /> },
            { key: 'mode', header: 'Mode', render: t => (
              <span className={`text-xs px-2 py-0.5 rounded ${t.mode === 'pinball' ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan'}`}>
                {t.mode === 'pinball' ? 'Pinball' : 'Video Game'}
              </span>
            )},
            { key: 'display_order', header: 'Pos', render: t => (
              <span className="text-sm text-muted font-mono">{t.display_order ?? 0}</span>
            )},
            { key: 'max_active_games', header: 'Slots', render: t => (
              <span className="text-sm text-muted font-mono">{t.max_active_games ?? 1}</span>
            )},
            { key: 'cadence', header: 'Schedule', render: t => (
              <span className="text-sm text-neon-amber">{formatCadenceDisplay(t.cadence)}</span>
            )},
            { key: 'lastRun', header: 'Last run', render: t => {
              const info = runInfo[t.id];
              if (!info?.lastRun) return <span className="text-faint text-xs">—</span>;
              const o = info.lastRun.outcome;
              const color = o === 'error' ? 'text-neon-magenta' : o === 'skipped' ? 'text-muted' : 'text-neon-green';
              const label = o === 'error' ? 'Error' : o === 'skipped' ? 'Skipped' : 'OK';
              return (
                <span className={`text-xs ${color}`} title={info.lastRun.summary || undefined}>
                  {label} · {formatRunAgo(info.lastRun.finishedAt)}
                </span>
              );
            }},
            { key: 'nextFire', header: 'Next fire', render: t => {
              if (t.is_active === 0) return <span className="text-faint text-xs">paused</span>;
              const info = runInfo[t.id];
              if (!info?.nextFireAt) return <span className="text-faint text-xs">—</span>;
              let tz: string | undefined;
              try { tz = JSON.parse(t.cadence)?.timezone; } catch { /* fall back to browser-local */ }
              return <span className="text-xs text-muted">{formatNextFire(info.nextFireAt, tz)}</span>;
            }},
            { key: 'actions', header: '', render: t => (
              <div className="flex gap-2 justify-end">
                <NeonButton variant="ghost" onClick={() => handlePauseToggle(t)} disabled={pausingId === t.id} className="text-xs px-2 py-1">
                  {pausingId === t.id ? '...' : (t.is_active === 0 ? 'Resume' : 'Pause')}
                </NeonButton>
                <NeonButton variant="ghost" onClick={() => openEdit(t)} className="text-xs px-2 py-1">Edit</NeonButton>
                <NeonButton variant="danger" onClick={() => { setDeleteTarget(t); setDeleteBlockers([]); setAutoDeactivate(false); }} className="text-xs px-2 py-1">Delete</NeonButton>
              </div>
            ), className: 'text-right' },
          ]}
          data={tournaments}
          keyExtractor={t => t.id}
          emptyMessage="No tournaments configured yet."
        />
      </NeonCard>

      {/* Active Games */}
      <NeonCard title="Active Games" className="mb-6">
        <DataTable<ActiveGame>
          columns={[
            { key: 'name', header: 'Game', render: g => (
              <div>
                <span className="font-medium">{g.display_name || g.name}</span>
                {g.display_name && <span className="text-xs text-faint ml-1">({g.name})</span>}
              </div>
            )},
            { key: 'tournament_name', header: 'Tournament', render: g => (
              <div className="flex items-center gap-2">
                <TournamentBadge type={g.tournament_type} />
                <span className="text-muted">{g.tournament_name}</span>
              </div>
            )},
            { key: 'start_date', header: 'Started', render: g => (
              <span className="text-sm text-muted">{g.start_date ? new Date(g.start_date).toLocaleString() : '—'}</span>
            )},
            { key: 'iscored_id', header: 'iScored', render: g => (
              <span className={`text-xs ${g.iscored_id ? 'text-neon-green' : 'text-faint'}`}>{g.iscored_id ? 'Linked' : 'No'}</span>
            )},
            { key: 'style', header: 'Style', render: g => (
              <span className={`text-xs ${g.catalogue_style_id ? 'text-neon-green' : 'text-faint'}`}>
                {g.catalogue_style_id ? 'Set' : 'None'}
              </span>
            )},
            { key: 'actions', header: '', render: g => (
              <div className="flex justify-end gap-1">
                <NeonButton variant="ghost" onClick={() => {
                  setDisplayNameTarget(g);
                  setDisplayNameInput(g.display_name || '');
                }} className="text-xs px-2 py-1">Edit</NeonButton>
                <NeonButton variant="secondary" onClick={async () => {
                  try {
                    const libStyle = await api.get<{ catalogueStyleId: string | null }>(`/rooms/${room.roomId}/game_library/${encodeURIComponent(g.name)}/style`);
                    setLibraryHasDefault(!!libStyle.catalogueStyleId);
                  } catch { setLibraryHasDefault(false); }
                  setStyleTarget(g);
                }} className="text-xs px-2 py-1">Style</NeonButton>
                <NeonButton variant="danger" onClick={() => setDeactivateTarget(g)} className="text-xs px-2 py-1">Deactivate</NeonButton>
                <NeonButton variant="danger" onClick={() => { setDeleteGameTarget(g); setDeleteGameConfirm(''); }} className="text-xs px-2 py-1">Delete</NeonButton>
              </div>
            ), className: 'text-right' },
          ]}
          data={activeGames}
          keyExtractor={g => g.id}
          emptyMessage="No active games."
        />
      </NeonCard>

      {/* Retained Completed Games — sit on the public leaderboard until the
          tournament's cleanup_rule fires (mode='scheduled' or 'retain' count>0).
          Surfaces them so admins can Delete one before the scheduled cleanup. */}
      <NeonCard title="Retained Completed Games" className="mb-6">
        <p className="text-xs text-muted mb-3">
          Completed games still visible on the public leaderboard. They'll be removed automatically by the tournament's scheduled cleanup; use Delete to remove one now (e.g. an end-of-round game with no scores you'd rather not display).
        </p>
        <DataTable<RetainedCompletedGame>
          columns={[
            { key: 'name', header: 'Game', render: g => (
              <div>
                <span className="font-medium">{g.display_name || g.name}</span>
                {g.display_name && <span className="text-xs text-faint ml-1">({g.name})</span>}
              </div>
            )},
            { key: 'tournament_name', header: 'Tournament', render: g => (
              <div className="flex items-center gap-2">
                <TournamentBadge type={g.tournament_type} />
                <span className="text-muted">{g.tournament_name}</span>
              </div>
            )},
            { key: 'end_date', header: 'Ended', render: g => (
              <span className="text-sm text-muted">{g.end_date ? new Date(g.end_date).toLocaleString() : '—'}</span>
            )},
            { key: 'iscored_id', header: 'iScored', render: g => (
              <span className={`text-xs ${g.iscored_id ? 'text-neon-green' : 'text-faint'}`}>{g.iscored_id ? 'Linked (locked)' : 'Cleared'}</span>
            )},
            { key: 'actions', header: '', render: g => (
              <div className="flex justify-end gap-1">
                <NeonButton variant="danger" onClick={() => { setDeleteGameTarget(g); setDeleteGameConfirm(''); }} className="text-xs px-2 py-1">Delete</NeonButton>
              </div>
            ), className: 'text-right' },
          ]}
          data={retainedCompleted}
          keyExtractor={g => g.id}
          emptyMessage="No retained completed games on the public leaderboard."
        />
      </NeonCard>

      {/* Create Form */}
      <NeonCard glowColor="cyan" title="Create New Tournament">
        <TournamentFormFields
          state={createForm.state}
          set={createForm.set}
          platforms={platforms}
        />
        <NeonButton
          onClick={handleCreate}
          disabled={
            !createForm.state.name.trim()
            || !createForm.state.tag.trim()
            || getPlatformRuleConflicts(createForm.state.platformRules).length > 0
          }
        >
          Create Tournament
        </NeonButton>
      </NeonCard>

      <div className="flex justify-end mt-4 mb-6">
        <NeonButton variant="ghost" onClick={handleReloadScheduler} disabled={reloadingScheduler} className="text-xs">
          {reloadingScheduler ? 'Refreshing...' : 'Refresh Schedules'}
        </NeonButton>
      </div>

      {/* Deactivate Confirm */}
      {deactivateTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md">
            <h2 className="font-display text-lg font-bold mb-2">Deactivate Game</h2>
            <p className="text-muted text-sm mb-4">
              Deactivate <span className="text-primary font-medium">"{deactivateTarget.name}"</span> from {deactivateTarget.tournament_name}? Scores are preserved and the iScored game stays visible (locked, no new submissions).
            </p>
            <div className="space-y-2 mb-4">
              <NeonButton
                variant="danger"
                className="w-full"
                onClick={() => handleDeactivate(false)}
                disabled={deactivating}
              >
                {deactivating ? 'Deactivating...' : 'Deactivate + Lock on iScored'}
              </NeonButton>
              <NeonButton
                variant="secondary"
                className="w-full"
                onClick={() => handleDeactivate(true)}
                disabled={deactivating}
              >
                DB Only (don't touch iScored)
              </NeonButton>
            </div>
            <NeonButton variant="ghost" onClick={() => setDeactivateTarget(null)} disabled={deactivating}>
              Cancel
            </NeonButton>
          </div>
        </div>
      )}

      {/* Delete Game Confirm — destructive, type-to-confirm */}
      {deleteGameTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-red-500/40 rounded-lg p-6 w-full max-w-md">
            <h2 className="font-display text-lg font-bold mb-2 text-red-400">Delete Game</h2>
            <p className="text-muted text-sm mb-2">
              Permanently remove <span className="text-primary font-medium">"{deleteGameTarget.name}"</span> from <span className="text-primary font-medium">{deleteGameTarget.tournament_name}</span>?
            </p>
            <ul className="text-xs text-muted list-disc ml-5 mb-4 space-y-1">
              <li>Late iScored scores (if any) are pulled into Arcaid first.</li>
              <li>The game is removed from iScored (unless another active tournament shares it).</li>
              <li>The games row is deleted from Arcaid; player score rows are orphaned (kept for personal history).</li>
            </ul>
            <p className="text-xs text-muted mb-2">Use this only when the game was activated in the wrong tournament. For a normal end-of-round, use Deactivate.</p>
            <p className="text-xs mb-1">Type <span className="font-mono text-red-300">{deleteGameTarget.name}</span> to confirm:</p>
            <input
              type="text"
              autoFocus
              value={deleteGameConfirm}
              onChange={(e) => setDeleteGameConfirm(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-1 text-sm font-mono mb-4"
              placeholder={deleteGameTarget.name}
            />
            <div className="flex gap-2">
              <NeonButton
                variant="danger"
                className="flex-1"
                onClick={handleDeleteGame}
                disabled={deletingGame || deleteGameConfirm !== deleteGameTarget.name}
              >
                {deletingGame ? 'Deleting...' : 'Delete game permanently'}
              </NeonButton>
              <NeonButton variant="ghost" onClick={() => { setDeleteGameTarget(null); setDeleteGameConfirm(''); }} disabled={deletingGame}>
                Cancel
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* v2.124.0 (C3) — the card-art editor, replacing `StylePicker`'s
          "Select Art Pack" modal. This page edits ONE ACTIVATED GAME
          (`games.*`), with the optional library twin the modal already had, so
          the target is the game row and "Set as this game's room default" is
          kept exactly as before. */}
      {styleTarget && (
        <CardStyleEditorSheet
          roomId={room.roomId}
          slug={room.roomSlug}
          roomName={room.roomName}
          target={{ kind: 'game', gameId: styleTarget.id, gameName: styleTarget.name }}
          source={{
            gameName: styleTarget.name,
            displayName: styleTarget.display_name,
            catalogueStyleId: styleTarget.catalogue_style_id,
            styleHeaderDisabled: styleTarget.style_header_disabled === 1,
            bgZoom: styleTarget.bg_zoom,
            bgPosX: styleTarget.bg_pos_x,
            bgPosY: styleTarget.bg_pos_y,
            tournamentName: styleTarget.tournament_name,
            tournamentType: styleTarget.tournament_type,
          }}
          showDefaultOption
          libraryHasDefault={libraryHasDefault}
          toast={toast}
          onApplied={fetchActiveGames}
          onClose={() => setStyleTarget(null)}
        />
      )}

      {/* Display Name Edit Modal */}
      {displayNameTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setDisplayNameTarget(null)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="font-display text-lg font-bold mb-1">Edit Display Name</h2>
            <p className="text-xs text-muted mb-4">Game: {displayNameTarget.name}</p>
            <div className="mb-4">
              <label className="text-xs text-muted block mb-1">Display Name (leave empty to use game name)</label>
              <input
                type="text"
                value={displayNameInput}
                onChange={e => setDisplayNameInput(e.target.value)}
                placeholder={displayNameTarget.name}
                className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setDisplayNameTarget(null)} disabled={displayNameSaving}>Cancel</NeonButton>
              <NeonButton disabled={displayNameSaving} onClick={async () => {
                setDisplayNameSaving(true);
                try {
                  await api.patch(`/rooms/${room.roomId}/admin/games/${displayNameTarget.id}/display-name`, {
                    displayName: displayNameInput.trim() || null,
                  });
                  toast(displayNameInput.trim() ? 'Display name updated' : 'Display name cleared', 'success');
                  fetchActiveGames();
                  setDisplayNameTarget(null);
                } catch (err: any) {
                  toast(err.message, 'error');
                } finally {
                  setDisplayNameSaving(false);
                }
              }}>
                {displayNameSaving ? 'Saving...' : 'Save'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="font-display text-lg font-bold mb-4">Edit Tournament</h2>
            <TournamentFormFields
              state={editForm.state}
              set={editForm.set}
              platforms={platforms}
            />
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</NeonButton>
              <NeonButton
                onClick={handleEditSave}
                disabled={
                  editSaving
                  || !editForm.state.name.trim()
                  || !editForm.state.tag.trim()
                  || getPlatformRuleConflicts(editForm.state.platformRules).length > 0
                }
              >
                {editSaving ? 'Saving...' : 'Save Changes'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Delete Tournament Confirm — lists ACTIVE/QUEUED blockers (from the BE
          409) and offers an explicit auto-deactivate opt-in. Default behavior
          (checkbox off) is the block-with-listing; ticking it tells the BE to
          deactivate the live game(s) first, then delete. */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-red-500/40 rounded-lg p-6 w-full max-w-md">
            <h2 className="font-display text-lg font-bold mb-2 text-red-400">Delete Tournament</h2>
            <p className="text-muted text-sm mb-4">
              Permanently delete <span className="text-primary font-medium">"{deleteTarget.name}"</span>? This cannot be undone.
            </p>
            {deleteBlockers.length > 0 && (
              <div className="mb-4">
                <p className="text-[10px] uppercase tracking-wider text-muted mb-1">This tournament still has live games:</p>
                <ul className="text-xs text-muted list-disc ml-5 mb-2 space-y-1">
                  {deleteBlockers.map(g => (
                    <li key={g.id}>
                      {g.name}
                      <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded ${g.status === 'ACTIVE' ? 'bg-neon-green/15 text-neon-green' : 'bg-neon-amber/15 text-neon-amber'}`}>{g.status}</span>
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2 text-xs text-muted mb-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoDeactivate}
                    onChange={e => setAutoDeactivate(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Deactivate the active game(s) first, then delete this tournament. Without this, deletion is blocked.</span>
                </label>
              </div>
            )}
            <div className="flex gap-2">
              <NeonButton
                variant="danger"
                className="flex-1"
                onClick={handleDelete}
                disabled={deletingTournament || (deleteBlockers.length > 0 && !autoDeactivate)}
              >
                {deletingTournament ? 'Deleting...' : 'Delete tournament'}
              </NeonButton>
              <NeonButton
                variant="ghost"
                onClick={() => { setDeleteTarget(null); setDeleteBlockers([]); setAutoDeactivate(false); }}
                disabled={deletingTournament}
              >
                Cancel
              </NeonButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
