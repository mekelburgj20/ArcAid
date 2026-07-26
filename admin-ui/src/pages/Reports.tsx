import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, Ban, Trash2, ShieldAlert, ShieldCheck, UserX } from 'lucide-react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { useToast } from '../components/Toast';

/**
 * S22 content moderation — super-admin Reports queue.
 *
 * Phase 1 (v2.43.0): three tabs — Rooms | Player Names (both backed by the
 * content_reports table via ContentReportService) | Scores (the
 * pre-existing score_reports admin endpoints, wired to a UI for the first
 * time). Modeled on JoinRequests.tsx's structure (pending list + resolved
 * history, NeonCard/NeonButton) plus GlobalCatalogue.tsx's feedback-queue
 * pattern (open/resolved toggle, per-row resolution note).
 *
 * Phase 2 (v2.44.0) adds the remediation "teeth": a fourth Bans tab (list +
 * add-ban form + lift, backed by the Phase-1 bans endpoints which had no UI
 * consumer yet), a "Suspend room" quick action on room-report rows, and
 * "Reset display name" / "Ban identity" quick actions on player-name rows.
 */

type ReportTab = 'rooms' | 'names' | 'scores' | 'bans';

interface ContentReportRow {
  id: number;
  target_type: 'room' | 'player_name';
  target_key: string;
  game_room_id: string | null;
  target_user_id: string | null;
  target_name: string | null;
  reporter_user_id: string;
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  room_name: string | null;
  room_slug: string | null;
  /** S22 Phase 2 (v2.44.0) — hides "Suspend room" once already suspended. */
  room_suspended_at: string | null;
  reporter_display_name: string | null;
  reporter_username: string | null;
  target_display_name: string | null;
  target_username: string | null;
}

interface ScoreReportRow {
  id: string;
  score_id: string;
  reporter_discord_id: string;
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  global_game_id: string | null;
  player_id: string | null;
  iscored_username: string | null;
  score: number | null;
  origin_type: string | null;
  score_deleted_at: string | null;
  game_name: string | null;
}

/** S22 Phase 2 (v2.44.0) — mirrors ScoreReportService's UserBan shape. */
interface BanRow {
  id: string;
  discord_user_id: string;
  reason: string | null;
  banned_by: string;
  banned_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function reporterLabel(r: ContentReportRow): string {
  return r.reporter_display_name || r.reporter_username || r.reporter_user_id;
}

/**
 * m1 fix (S22 Phase 1 adversarial review): the headline for a player_name
 * report must be the `target_name` SNAPSHOT — the offending string as
 * reported at the time — not the target's current resolved profile
 * identity. A player can rename after being reported; the report is about
 * the name they used, not whoever they are now. The resolved identity (when
 * known) renders as secondary context via `targetCurrentIdentity`.
 */
function targetHeadline(r: ContentReportRow): string {
  return r.target_name || 'Unknown name';
}

/** Current resolved profile identity, if different from the reported snapshot — secondary context only. */
function targetCurrentIdentity(r: ContentReportRow): string | null {
  const current = r.target_display_name || r.target_username || null;
  if (!current || current === r.target_name) return null;
  return current;
}

/** S22 Phase 2 (v2.44.0) — client-side status derivation for the Bans tab. */
function banStatus(b: BanRow): 'active' | 'expired' | 'lifted' {
  if (b.lifted_at) return 'lifted';
  if (b.expires_at && new Date(b.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

const TABS: Array<{ key: ReportTab; label: string }> = [
  { key: 'rooms', label: 'Rooms' },
  { key: 'names', label: 'Player Names' },
  { key: 'scores', label: 'Scores' },
  { key: 'bans', label: 'Bans' },
];

type ConfirmAction =
  | { kind: 'hard-delete'; report: ScoreReportRow }
  | { kind: 'score-ban'; report: ScoreReportRow }
  | { kind: 'suspend-room'; report: ContentReportRow }
  | { kind: 'reset-name'; report: ContentReportRow }
  | { kind: 'ban-identity'; report: ContentReportRow }
  | { kind: 'lift-ban'; ban: BanRow };

export default function Reports() {
  const { toast } = useToast();
  const [tab, setTab] = useState<ReportTab>('rooms');
  const [showResolved, setShowResolved] = useState(false);

  const [contentPending, setContentPending] = useState<ContentReportRow[]>([]);
  const [contentResolved, setContentResolved] = useState<ContentReportRow[]>([]);
  const [scorePending, setScorePending] = useState<ScoreReportRow[]>([]);
  const [scoreResolved, setScoreResolved] = useState<ScoreReportRow[]>([]);
  const [bans, setBans] = useState<BanRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | number | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [confirmTarget, setConfirmTarget] = useState<ConfirmAction | null>(null);
  // m9 fix (S22 Phase 2 adversarial review) — each confirm-with-input modal
  // (score-ban / suspend-room / ban-identity) gets its OWN reason/duration
  // state. Previously score-ban and ban-identity shared one `banReason` +
  // `banDurationDays` pair, so a duration typed for one report could bleed
  // into a DIFFERENT report's ban if the admin opened a second modal without
  // the first one's `finally` block having cleared it (e.g. via Cancel,
  // which never cleared state at all). Reset explicitly on both open (the
  // "open*" helpers below) and cancel.
  const [scoreBanDurationDays, setScoreBanDurationDays] = useState('');
  const [scoreBanReason, setScoreBanReason] = useState('');
  const [suspendReason, setSuspendReason] = useState('');
  const [banIdentityDurationDays, setBanIdentityDurationDays] = useState('');
  const [banIdentityReason, setBanIdentityReason] = useState('');
  // Inline "done" feedback for Reset display name (contract: "show the
  // result inline" — the report row itself doesn't disappear until
  // separately dismissed/resolved, so this renders next to it).
  const [resetResults, setResetResults] = useState<Record<number, string>>({});

  // Bans tab — standalone add-ban form fields.
  const [banFormId, setBanFormId] = useState('');
  const [banFormDuration, setBanFormDuration] = useState('');
  const [banFormReason, setBanFormReason] = useState('');
  const [addingBan, setAddingBan] = useState(false);

  const contentType = tab === 'rooms' ? 'room' : tab === 'names' ? 'player_name' : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'bans') {
        const list = await api.get<BanRow[]>('/admin/bans');
        setBans(list || []);
      } else if (contentType) {
        const [pending, resolved] = await Promise.all([
          api.get<ContentReportRow[]>(`/admin/reports?type=${contentType}&status=pending`),
          api.get<ContentReportRow[]>(`/admin/reports?type=${contentType}&status=resolved`),
        ]);
        setContentPending(pending || []);
        setContentResolved(resolved || []);
      } else {
        const [pending, resolved] = await Promise.all([
          api.get<ScoreReportRow[]>('/admin/score-reports?status=pending'),
          api.get<ScoreReportRow[]>('/admin/score-reports?status=resolved'),
        ]);
        setScorePending(pending || []);
        setScoreResolved(resolved || []);
      }
    } catch {
      toast('Could not load reports', 'error');
    } finally {
      setLoading(false);
    }
  }, [tab, contentType, toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDismissContent = async (id: number) => {
    setActingOn(id);
    try {
      await api.post(`/admin/reports/${id}/dismiss`, {});
      toast('Report dismissed', 'success');
      await refresh();
    } catch {
      toast('Failed to dismiss report', 'error');
    } finally {
      setActingOn(null);
    }
  };

  const handleResolveContent = async (id: number) => {
    const resolution = resolutionNotes[id]?.trim();
    if (!resolution) {
      toast('Enter a resolution note first', 'error');
      return;
    }
    setActingOn(id);
    try {
      await api.post(`/admin/reports/${id}/resolve`, { resolution });
      toast('Report resolved', 'success');
      setResolutionNotes((prev) => { const next = { ...prev }; delete next[id]; return next; });
      await refresh();
    } catch {
      toast('Failed to resolve report', 'error');
    } finally {
      setActingOn(null);
    }
  };

  const handleScoreAction = async (
    reportId: string,
    action: 'dismiss' | 'soft-delete' | 'hard-delete' | 'ban',
    body?: Record<string, unknown>,
  ) => {
    setActingOn(reportId);
    try {
      await api.post(`/admin/score-reports/${reportId}/${action}`, body || {});
      toast(
        action === 'dismiss' ? 'Report dismissed'
          : action === 'soft-delete' ? 'Score soft-deleted'
          : action === 'hard-delete' ? 'Score permanently deleted'
          : 'Player banned',
        'success',
      );
      await refresh();
    } catch (err) {
      // m6 (S22 Phase 1 adversarial review) — surface the server's actual
      // message (e.g. "Cannot ban an iScored-synced name...") instead of a
      // generic failure toast, so the admin knows WHY the action was rejected.
      toast(err instanceof Error ? err.message : 'Action failed', 'error');
    } finally {
      setActingOn(null);
      setConfirmTarget(null);
      setScoreBanDurationDays('');
      setScoreBanReason('');
    }
  };

  /** S22 Phase 2 (v2.44.0) — "Suspend room" quick action from a room report. */
  const handleSuspendRoom = async (report: ContentReportRow) => {
    if (!report.game_room_id) return;
    setActingOn(report.id);
    try {
      await api.post(`/admin/rooms/${report.game_room_id}/suspend`, { reason: suspendReason.trim() || undefined });
      toast('Room suspended', 'success');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to suspend room', 'error');
    } finally {
      setActingOn(null);
      setConfirmTarget(null);
      setSuspendReason('');
    }
  };

  /** S22 Phase 2 (v2.44.0) — "Reset display name" quick action from a player_name report. */
  const handleResetDisplayName = async (report: ContentReportRow) => {
    if (!report.target_user_id) return;
    setActingOn(report.id);
    try {
      await api.patch(`/admin/users/${report.target_user_id}/display-name`, { displayName: null });
      setResetResults((prev) => ({ ...prev, [report.id]: 'Display name cleared.' }));
      toast('Display name reset', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to reset display name', 'error');
    } finally {
      setActingOn(null);
      setConfirmTarget(null);
    }
  };

  /** S22 Phase 2 (v2.44.0) — "Ban identity" quick action from a player_name report. */
  const handleBanIdentity = async (report: ContentReportRow) => {
    if (!report.target_user_id) return;
    setActingOn(report.id);
    try {
      await api.post('/admin/bans', {
        discordUserId: report.target_user_id,
        durationDays: banIdentityDurationDays ? parseInt(banIdentityDurationDays, 10) : null,
        reason: banIdentityReason.trim() || undefined,
      });
      toast('Identity banned', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to ban identity', 'error');
    } finally {
      setActingOn(null);
      setConfirmTarget(null);
      setBanIdentityDurationDays('');
      setBanIdentityReason('');
    }
  };

  // m9 fix (S22 Phase 2 adversarial review) — dedicated "open" helpers so
  // each confirm-with-input modal starts from a clean slate every time,
  // regardless of what a PREVIOUS open/cancel left behind.
  const openScoreBanModal = (report: ScoreReportRow) => {
    setScoreBanDurationDays('');
    setScoreBanReason('');
    setConfirmTarget({ kind: 'score-ban', report });
  };
  const openSuspendRoomModal = (report: ContentReportRow) => {
    setSuspendReason('');
    setConfirmTarget({ kind: 'suspend-room', report });
  };
  const openBanIdentityModal = (report: ContentReportRow) => {
    setBanIdentityDurationDays('');
    setBanIdentityReason('');
    setConfirmTarget({ kind: 'ban-identity', report });
  };

  /** S22 Phase 2 (v2.44.0) — Bans tab: lift an active ban. */
  const handleLiftBan = async (ban: BanRow) => {
    setActingOn(ban.id);
    try {
      await api.post(`/admin/bans/${ban.id}/lift`, {});
      toast('Ban lifted', 'success');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to lift ban', 'error');
    } finally {
      setActingOn(null);
      setConfirmTarget(null);
    }
  };

  /** S22 Phase 2 (v2.44.0) — Bans tab: standalone add-ban form. */
  const handleAddBan = async () => {
    const id = banFormId.trim();
    if (!id) return;
    setAddingBan(true);
    try {
      await api.post('/admin/bans', {
        discordUserId: id,
        durationDays: banFormDuration ? parseInt(banFormDuration, 10) : null,
        reason: banFormReason.trim() || undefined,
      });
      toast('Identity banned', 'success');
      setBanFormId('');
      setBanFormDuration('');
      setBanFormReason('');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to ban identity', 'error');
    } finally {
      setAddingBan(false);
    }
  };

  if (loading) return <LoadingState message="Loading reports…" />;

  const contentRows = showResolved ? contentResolved : contentPending;
  const scoreRows = showResolved ? scoreResolved : scorePending;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-4">Reports</h1>
      <p className="text-muted text-sm mb-6">
        Player-filed reports on rooms, names, and scores, plus the identity ban list. Dismiss a report that needs no
        action, or resolve it with a note once you've taken action (Suspend room, Reset display name, Ban identity, etc.).
      </p>

      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex gap-1 bg-raised border border-border rounded-lg p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors cursor-pointer border-0 ${
                tab === t.key ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-transparent text-muted hover:text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab !== 'bans' && (
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Show resolved
          </label>
        )}
      </div>

      {tab === 'bans' ? (
        <div className="space-y-6">
          <NeonCard title="Ban an identity" glowColor="amber">
            <div className="space-y-3">
              <div>
                <label className="text-xs text-faint block mb-1">Discord ID or google:&lt;sub&gt;</label>
                <input
                  type="text"
                  value={banFormId}
                  onChange={(e) => setBanFormId(e.target.value)}
                  placeholder="123456789012345678"
                  className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50"
                />
                <p className="text-xs text-faint mt-1">
                  iScored-synced names (iscored:*) can't be banned — they have no login identity. Use Soft/Hard
                  Delete on the Scores tab instead.
                </p>
              </div>
              <div className="flex gap-3 flex-wrap">
                <div className="flex-1 min-w-[140px]">
                  <label className="text-xs text-faint block mb-1">Duration (days, optional)</label>
                  <input
                    type="number"
                    min={1}
                    value={banFormDuration}
                    onChange={(e) => setBanFormDuration(e.target.value)}
                    placeholder="Permanent"
                    className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50"
                  />
                </div>
                <div className="flex-[2] min-w-[200px]">
                  <label className="text-xs text-faint block mb-1">Reason (optional)</label>
                  <input
                    type="text"
                    value={banFormReason}
                    onChange={(e) => setBanFormReason(e.target.value)}
                    maxLength={500}
                    className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50"
                  />
                </div>
              </div>
              <NeonButton variant="danger" onClick={handleAddBan} disabled={addingBan || !banFormId.trim()}>
                <Ban size={14} className="inline -mt-0.5 mr-1" />
                {addingBan ? 'Banning...' : 'Ban Identity'}
              </NeonButton>
            </div>
          </NeonCard>

          <NeonCard title="All bans" glowColor="cyan">
            {bans.length === 0 ? (
              <p className="text-faint text-sm">No bans yet.</p>
            ) : (
              <div className="space-y-2">
                {bans.map((b) => {
                  const status = banStatus(b);
                  return (
                    <div key={b.id} className="bg-raised border border-border rounded px-4 py-3 flex items-start justify-between gap-4 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-primary">{b.discord_user_id}</p>
                        <p className="text-xs text-faint mt-0.5">
                          Banned by {b.banned_by} · {timeAgo(b.banned_at)}
                          {b.expires_at ? ` · expires ${new Date(b.expires_at).toLocaleDateString()}` : ' · permanent'}
                        </p>
                        {b.reason && <p className="text-sm text-muted mt-1">"{b.reason}"</p>}
                        {status === 'lifted' && (
                          <p className="text-xs text-faint mt-1">Lifted by {b.lifted_by || 'admin'}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className={`text-xs px-2 py-0.5 rounded border ${
                            status === 'active'
                              ? 'bg-neon-magenta/10 text-neon-magenta border-neon-magenta/30'
                              : status === 'expired'
                                ? 'bg-raised text-faint border-border'
                                : 'bg-neon-green/10 text-neon-green border-neon-green/30'
                          }`}
                        >
                          {status === 'active' ? 'Active' : status === 'expired' ? 'Expired' : 'Lifted'}
                        </span>
                        {status === 'active' && (
                          <NeonButton
                            variant="ghost"
                            className="text-xs px-3 py-1.5"
                            onClick={() => setConfirmTarget({ kind: 'lift-ban', ban: b })}
                            disabled={actingOn === b.id}
                          >
                            <ShieldCheck size={13} className="inline -mt-0.5 mr-1" />
                            Lift
                          </NeonButton>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </NeonCard>
        </div>
      ) : contentType ? (
        <NeonCard title={showResolved ? 'Resolved' : 'Pending'} glowColor={showResolved ? 'cyan' : 'amber'}>
          {contentRows.length === 0 ? (
            <p className="text-faint text-sm">
              {showResolved ? 'No resolved reports yet.' : `No pending ${tab === 'rooms' ? 'room' : 'name'} reports.`}
            </p>
          ) : (
            <div className="space-y-3">
              {contentRows.map((r) => (
                <div key={r.id} className="bg-raised border border-border rounded px-4 py-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-primary">
                        {tab === 'rooms' ? (r.room_name || r.target_name || 'Unknown room') : targetHeadline(r)}
                        {tab === 'rooms' && r.room_slug && (
                          <Link
                            to={`/${r.room_slug}`}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 text-xs text-neon-cyan hover:underline inline-flex items-center gap-1"
                          >
                            /{r.room_slug} <ExternalLink size={11} />
                          </Link>
                        )}
                        {tab === 'rooms' && r.room_suspended_at && (
                          <span className="ml-2 text-xs px-2 py-0.5 rounded bg-neon-magenta/10 text-neon-magenta border border-neon-magenta/30 inline-flex items-center gap-1">
                            <ShieldAlert size={11} /> SUSPENDED
                          </span>
                        )}
                      </p>
                      {tab === 'names' && r.room_name && (
                        <p className="text-xs text-faint mt-0.5">in room: {r.room_name}</p>
                      )}
                      {tab === 'names' && targetCurrentIdentity(r) && (
                        <p className="text-xs text-faint mt-0.5">Currently: {targetCurrentIdentity(r)}</p>
                      )}
                      <p className="text-xs text-faint mt-0.5">
                        Reported by {reporterLabel(r)} · {timeAgo(r.created_at)}
                      </p>
                      {r.reason && <p className="text-sm text-muted mt-1.5">"{r.reason}"</p>}
                      {resetResults[r.id] && (
                        <p className="text-xs text-neon-green mt-1.5">{resetResults[r.id]}</p>
                      )}
                      {showResolved && (
                        <p className="text-xs text-faint mt-1.5">
                          Resolved by {r.resolved_by || 'admin'} ({r.resolution}) · {r.resolved_at && timeAgo(r.resolved_at)}
                        </p>
                      )}
                    </div>
                    {!showResolved && (
                      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                        {tab === 'rooms' && r.game_room_id && (
                          <Link
                            to="/admin/rooms"
                            className="text-xs text-muted hover:text-primary border border-border rounded px-3 py-1.5 no-underline"
                          >
                            Manage rooms
                          </Link>
                        )}
                        {tab === 'rooms' && r.game_room_id && !r.room_suspended_at && (
                          <NeonButton
                            variant="danger"
                            className="text-xs px-3 py-1.5"
                            onClick={() => openSuspendRoomModal(r)}
                            disabled={actingOn === r.id}
                          >
                            <ShieldAlert size={13} className="inline -mt-0.5 mr-1" />
                            Suspend room
                          </NeonButton>
                        )}
                        {tab === 'names' && r.target_user_id && (
                          <>
                            <NeonButton
                              variant="secondary"
                              className="text-xs px-3 py-1.5"
                              onClick={() => setConfirmTarget({ kind: 'reset-name', report: r })}
                              disabled={actingOn === r.id}
                            >
                              Reset display name
                            </NeonButton>
                            {/* m8 fix (S22 Phase 2 adversarial review) — an
                                iscored:* synthetic id has no login identity to
                                ban (same guard the server enforces on both
                                ban routes); hide the action entirely rather
                                than let the admin hit a 400. */}
                            {!r.target_user_id.startsWith('iscored:') && (
                              <NeonButton
                                variant="danger"
                                className="text-xs px-3 py-1.5"
                                onClick={() => openBanIdentityModal(r)}
                                disabled={actingOn === r.id}
                              >
                                <UserX size={13} className="inline -mt-0.5 mr-1" />
                                Ban identity
                              </NeonButton>
                            )}
                          </>
                        )}
                        <NeonButton
                          variant="ghost"
                          className="text-xs px-3 py-1.5"
                          onClick={() => handleDismissContent(r.id)}
                          disabled={actingOn === r.id}
                        >
                          Dismiss
                        </NeonButton>
                      </div>
                    )}
                  </div>
                  {!showResolved && (
                    <div className="flex items-center gap-2 mt-2">
                      <input
                        type="text"
                        placeholder="Resolution note…"
                        value={resolutionNotes[r.id] || ''}
                        onChange={(e) => setResolutionNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        className="flex-1 bg-surface border border-border rounded px-2 py-1 text-xs text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50"
                      />
                      <NeonButton
                        className="text-xs px-3 py-1.5"
                        onClick={() => handleResolveContent(r.id)}
                        disabled={actingOn === r.id}
                      >
                        <Check size={13} className="inline -mt-0.5 mr-1" />
                        Resolve
                      </NeonButton>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </NeonCard>
      ) : (
        <NeonCard title={showResolved ? 'Resolved' : 'Pending'} glowColor={showResolved ? 'cyan' : 'amber'}>
          {scoreRows.length === 0 ? (
            <p className="text-faint text-sm">{showResolved ? 'No resolved reports yet.' : 'No pending score reports.'}</p>
          ) : (
            <div className="space-y-3">
              {scoreRows.map((r) => (
                <div key={r.id} className="bg-raised border border-border rounded px-4 py-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-primary">
                        {r.game_name || 'Unknown game'} — {r.iscored_username || r.player_id || 'Unknown player'}
                        {typeof r.score === 'number' && <span className="text-faint"> · {r.score.toLocaleString()}</span>}
                      </p>
                      <p className="text-xs text-faint mt-0.5">
                        Reported by {r.reporter_discord_id} · {timeAgo(r.created_at)}
                        {r.score_deleted_at && <span className="text-neon-magenta"> · score already deleted</span>}
                      </p>
                      {r.reason && <p className="text-sm text-muted mt-1.5">"{r.reason}"</p>}
                      {showResolved && (
                        <p className="text-xs text-faint mt-1.5">
                          Resolved by {r.resolved_by || 'admin'} ({r.resolution}) · {r.resolved_at && timeAgo(r.resolved_at)}
                        </p>
                      )}
                    </div>
                    {!showResolved && (
                      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                        <NeonButton
                          variant="ghost"
                          className="text-xs px-3 py-1.5"
                          onClick={() => handleScoreAction(r.id, 'dismiss')}
                          disabled={actingOn === r.id}
                        >
                          Dismiss
                        </NeonButton>
                        <NeonButton
                          variant="secondary"
                          className="text-xs px-3 py-1.5"
                          onClick={() => handleScoreAction(r.id, 'soft-delete')}
                          disabled={actingOn === r.id}
                        >
                          Soft Delete
                        </NeonButton>
                        <NeonButton
                          variant="danger"
                          className="text-xs px-3 py-1.5"
                          onClick={() => setConfirmTarget({ kind: 'hard-delete', report: r })}
                          disabled={actingOn === r.id}
                        >
                          <Trash2 size={13} className="inline -mt-0.5 mr-1" />
                          Hard Delete
                        </NeonButton>
                        <NeonButton
                          variant="danger"
                          className="text-xs px-3 py-1.5"
                          onClick={() => openScoreBanModal(r)}
                          disabled={actingOn === r.id}
                        >
                          <Ban size={13} className="inline -mt-0.5 mr-1" />
                          Ban Player
                        </NeonButton>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </NeonCard>
      )}

      {confirmTarget?.kind === 'hard-delete' && (
        <ConfirmModal
          title="Permanently delete this score?"
          message="This removes the score and its photo permanently. This cannot be undone."
          confirmLabel="Hard Delete"
          onConfirm={() => handleScoreAction(confirmTarget.report.id, 'hard-delete')}
          onCancel={() => setConfirmTarget(null)}
        />
      )}

      {confirmTarget?.kind === 'score-ban' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={() => setConfirmTarget(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Ban player"
            className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-primary mb-2">Ban this player?</h3>
            <p className="text-muted mb-4 text-sm">
              Bans the player and soft-deletes the reported score. Leave duration blank for a permanent ban.
            </p>
            <label className="block text-xs text-faint mb-1">Duration (days, optional)</label>
            <input
              type="number"
              min={1}
              value={scoreBanDurationDays}
              onChange={(e) => setScoreBanDurationDays(e.target.value)}
              placeholder="Permanent"
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-3"
            />
            <label className="block text-xs text-faint mb-1">Reason (optional)</label>
            <input
              type="text"
              value={scoreBanReason}
              onChange={(e) => setScoreBanReason(e.target.value)}
              maxLength={500}
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-4"
            />
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => { setConfirmTarget(null); setScoreBanDurationDays(''); setScoreBanReason(''); }}>Cancel</NeonButton>
              <NeonButton
                variant="danger"
                onClick={() => handleScoreAction(confirmTarget.report.id, 'ban', {
                  durationDays: scoreBanDurationDays ? parseInt(scoreBanDurationDays, 10) : null,
                  reason: scoreBanReason || undefined,
                })}
              >
                Ban Player
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {confirmTarget?.kind === 'suspend-room' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm"
          onClick={() => { setConfirmTarget(null); setSuspendReason(''); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Suspend room"
            className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-primary mb-2">
              Suspend "{confirmTarget.report.room_name || confirmTarget.report.target_name || 'this room'}"?
            </h3>
            <p className="text-muted mb-4 text-sm">
              This hides the room from the public listing and blocks ALL access — including the room's own admins —
              until you unsuspend it (Game Rooms manager).
            </p>
            <label className="block text-xs text-faint mb-1">Reason (optional, internal)</label>
            <input
              type="text"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Why is this room being suspended?"
              maxLength={500}
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-4"
            />
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => { setConfirmTarget(null); setSuspendReason(''); }}>Cancel</NeonButton>
              <NeonButton variant="danger" onClick={() => handleSuspendRoom(confirmTarget.report)}>
                Suspend Room
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {confirmTarget?.kind === 'reset-name' && (
        <ConfirmModal
          title="Reset this player's display name?"
          message="Clears their chosen display name. Renders fall back to their username/id until they set a new one."
          confirmLabel="Reset Name"
          onConfirm={() => handleResetDisplayName(confirmTarget.report)}
          onCancel={() => setConfirmTarget(null)}
        />
      )}

      {confirmTarget?.kind === 'ban-identity' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm"
          onClick={() => { setConfirmTarget(null); setBanIdentityDurationDays(''); setBanIdentityReason(''); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Ban identity"
            className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-primary mb-2">Ban this identity?</h3>
            <p className="text-muted mb-4 text-sm">
              Blocks future logins for this identity (and any linked identity). Leave duration blank for a permanent ban.
            </p>
            <label className="block text-xs text-faint mb-1">Duration (days, optional)</label>
            <input
              type="number"
              min={1}
              value={banIdentityDurationDays}
              onChange={(e) => setBanIdentityDurationDays(e.target.value)}
              placeholder="Permanent"
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-3"
            />
            <label className="block text-xs text-faint mb-1">Reason (optional)</label>
            <input
              type="text"
              value={banIdentityReason}
              onChange={(e) => setBanIdentityReason(e.target.value)}
              maxLength={500}
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-4"
            />
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => { setConfirmTarget(null); setBanIdentityDurationDays(''); setBanIdentityReason(''); }}>Cancel</NeonButton>
              <NeonButton variant="danger" onClick={() => handleBanIdentity(confirmTarget.report)}>
                Ban Identity
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {confirmTarget?.kind === 'lift-ban' && (
        <ConfirmModal
          title="Lift this ban?"
          message={`Restores login access for ${confirmTarget.ban.discord_user_id}.`}
          confirmLabel="Lift Ban"
          onConfirm={() => handleLiftBan(confirmTarget.ban)}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
