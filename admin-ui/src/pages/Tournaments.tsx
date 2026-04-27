import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import TournamentBadge from '../components/TournamentBadge';
import DataTable from '../components/DataTable';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import StylePicker from '../components/StylePicker';
import TournamentFormFields, {
  useTournamentForm,
  parseCadence,
  parsePlatformRules,
  parseCleanupRule,
  getPlatformRuleConflicts,
  type TournamentFormState,
} from '../components/TournamentForm';

interface Tournament {
  id: string;
  name: string;
  type: string;
  mode: string;
  cadence: string;
  platform_rules: string;
  guild_id?: string;
  discord_channel_id?: string;
  discord_role_id?: string;
  is_active: number;
  display_order: number;
  max_active_games: number;
  cleanup_rule: string;
  winner_picks: number;
  auto_pick: number;
  eligibility_days: number;
  winner_pick_window_min: number;
  runnerup_pick_window_min: number;
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

/** Convert form state to API payload */
function toPayload(state: TournamentFormState, extra: Record<string, any> = {}) {
  return {
    name: state.name,
    type: state.tag.trim().toUpperCase(),
    mode: state.mode,
    cadence: { cron: state.schedule.cron, autoRotate: true, autoLock: true, timezone: state.schedule.timezone },
    platform_rules: state.platformRules,
    discord_channel_id: state.channel,
    display_order: state.displayOrder,
    max_active_games: state.maxActiveGames,
    cleanup_rule: state.cleanupRule,
    winner_picks: state.winnerPicks,
    auto_pick: state.autoPick,
    eligibility_days: state.eligibilityDays,
    winner_pick_window_min: state.winnerPickWindowMin,
    runnerup_pick_window_min: state.runnerupPickWindowMin,
    is_active: true,
    guild_id: '',
    discord_role_id: '',
    ...extra,
  };
}

/** Convert Tournament DB row to form state */
function tournamentToFormState(t: Tournament): TournamentFormState {
  return {
    name: t.name,
    tag: t.type,
    mode: t.mode || 'pinball',
    channel: t.discord_channel_id || '',
    displayOrder: t.display_order || 0,
    maxActiveGames: t.max_active_games || 1,
    winnerPicks: t.winner_picks !== 0,
    autoPick: t.auto_pick !== 0,
    eligibilityDays: t.eligibility_days ?? 120,
    winnerPickWindowMin: t.winner_pick_window_min ?? 60,
    runnerupPickWindowMin: t.runnerup_pick_window_min ?? 30,
    platformRules: parsePlatformRules(t.platform_rules),
    cleanupRule: parseCleanupRule(t.cleanup_rule),
    schedule: parseCadence(t.cadence),
  };
}

export default function Tournaments() {
  const room = useRoom();
  const { toast } = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
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
  };

  // Catalogue-derived list of platforms available in this room. Replaces the
  // legacy `game_room_settings.PLATFORMS` static list (often drifted from the
  // catalogue, hence the "No platforms configured" empty state on the create
  // form when the setting was unset). The endpoint returns canonical IDs;
  // TournamentFormFields renders them via `getPlatformDisplay`.
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
        toast(`${name} deleted from ArcAid and iScored${capturedSuffix}.${orphanSuffix}`, 'success');
      } else if (result.iscoredStatus === 'shared') {
        toast(`${name} deleted from ArcAid (iScored game still active in another tournament — left in place).${orphanSuffix}`, 'success');
      } else if (result.iscoredStatus === 'failed') {
        toast(`${name} deleted from ArcAid — iScored delete failed (${result.iscoredError ?? 'unknown'}). Remove it manually on iScored.`, 'error');
      } else {
        toast(`${name} deleted from ArcAid (iScored not configured).${orphanSuffix}`, 'success');
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
      await api.post(`/rooms/${room.roomId}/tournaments`, toPayload(createForm.state, { id: uuidv4() }));
      createForm.reset();
      toast('Tournament created', 'success');
      fetchTournaments();
    } catch {
      toast('Failed to create tournament', 'error');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/rooms/${room.roomId}/tournaments/${deleteTarget.id}`);
      toast('Tournament deleted', 'success');
      setDeleteTarget(null);
      fetchTournaments();
    } catch {
      toast('Failed to delete tournament', 'error');
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
            { key: 'name', header: 'Name', render: t => <span className="font-medium">{t.name}</span> },
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
            { key: 'actions', header: '', render: t => (
              <div className="flex gap-2 justify-end">
                <NeonButton variant="ghost" onClick={() => openEdit(t)} className="text-xs px-2 py-1">Edit</NeonButton>
                <NeonButton variant="danger" onClick={() => setDeleteTarget(t)} className="text-xs px-2 py-1">Delete</NeonButton>
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

      {/* Retained Completed Games — sit on the public scoreboard until the
          tournament's cleanup_rule fires (mode='scheduled' or 'retain' count>0).
          Surfaces them so admins can Delete one before the scheduled cleanup. */}
      <NeonCard title="Retained Completed Games" className="mb-6">
        <p className="text-xs text-muted mb-3">
          Completed games still visible on the public scoreboard. They'll be removed automatically by the tournament's scheduled cleanup; use Delete to remove one now (e.g. an end-of-round game with no scores you'd rather not display).
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
          emptyMessage="No retained completed games on the public scoreboard."
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
              <li>Late iScored scores (if any) are pulled into ArcAid first.</li>
              <li>The game is removed from iScored (unless another active tournament shares it).</li>
              <li>The games row is deleted from ArcAid; player score rows are orphaned (kept for personal history).</li>
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

      {/* Style Picker */}
      {styleTarget && (
        <StylePicker
          currentStyleId={styleTarget.catalogue_style_id}
          headerDisabled={styleTarget.style_header_disabled === 1}
          showDefaultOption
          showImageTypeSelector
          libraryHasDefault={libraryHasDefault}
          uploadPath={`/rooms/${room.roomId}/admin/styles/upload`}
          gameName={styleTarget.name}
          onClose={() => setStyleTarget(null)}
          onSelect={async (styleId, headerDisabled, setAsDefault, imageType) => {
            try {
              if (styleId) {
                if (imageType && imageType !== 'both') {
                  await api.put(`/rooms/${room.roomId}/admin/games/${styleTarget.id}/image`, {
                    styleId, imageType,
                  });
                } else {
                  await api.put(`/rooms/${room.roomId}/admin/games/${styleTarget.id}/style`, {
                    catalogueStyleId: styleId,
                    headerDisabled,
                  });
                }
                toast('Style applied', 'success');
              } else {
                await api.delete(`/rooms/${room.roomId}/admin/games/${styleTarget.id}/style`);
                toast('Style removed', 'success');
              }
              // Also update library default if requested
              if (setAsDefault) {
                try {
                  if (styleId) {
                    if (imageType && imageType !== 'both') {
                      await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.name)}/image`, {
                        styleId, imageType,
                      });
                    } else {
                      await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.name)}/style`, {
                        catalogueStyleId: styleId,
                        headerDisabled,
                      });
                    }
                    toast('Default style updated in library', 'success');
                  } else {
                    await api.delete(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.name)}/style`);
                  }
                } catch {
                  toast('Failed to update library default', 'error');
                }
              }
              fetchActiveGames();
            } catch (err: any) {
              toast(err.message, 'error');
            }
            setStyleTarget(null);
          }}
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

      {deleteTarget && (
        <ConfirmModal
          title="Delete Tournament"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
