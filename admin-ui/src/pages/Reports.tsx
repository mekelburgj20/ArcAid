import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, Ban, Trash2, ShieldAlert, ShieldCheck, UserX } from 'lucide-react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { useToast } from '../components/Toast';
import { parseServerDate, relativeTimeFrom } from '../lib/format';

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
 *
 * v2.47.0 (S22 follow-ups Workstream 2) adds a fifth Comments tab — flagged
 * `game_comments` rows (CommentReportService), super-admin-only per contract
 * decision 6 (room-admin visibility is future work). Actions: Dismiss (no
 * content action) / Remove (deletes the comment, confirm dialog first).
 */

type ReportTab = 'rooms' | 'names' | 'scores' | 'bans' | 'comments';

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
  /** v2.49.0 — resolved via user_profiles. */
  reporter_display_name: string | null;
  reporter_username: string | null;
  /** S23.6 — which table `score_id` points at. 'global' for every pre-S23 row. */
  score_source: 'global' | 'room_history';
  /** S23.6 — the reporting room for 'room_history' rows; null for global. */
  game_room_id: string | null;
  room_name: string | null;
}

/** v2.47.0 (S22 follow-ups Workstream 2) — mirrors CommentReportEnriched. */
interface CommentReportRow {
  id: number;
  comment_id: number;
  reporter_discord_id: string;
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  comment_body: string | null;
  comment_type: 'comment' | 'tip' | null;
  comment_display_name: string | null;
  comment_user_id: string | null;
  game_name: string | null;
  game_room_id: string | null;
  room_name: string | null;
  room_slug: string | null;
  /** v2.49.0 — resolved via user_profiles. */
  reporter_display_name: string | null;
  reporter_username: string | null;
}

/** S22 Phase 2 (v2.44.0) — mirrors ScoreReportService's UserBan shape.
 *  v2.49.0: game_room_id + resolved display fields (UserBanEnriched). */
interface BanRow {
  id: string;
  discord_user_id: string;
  reason: string | null;
  banned_by: string;
  banned_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
  game_room_id: string | null;
  room_name: string | null;
  discord_user_display_name: string | null;
  discord_user_username: string | null;
  banned_by_display_name: string | null;
  banned_by_username: string | null;
  lifted_by_display_name: string | null;
  lifted_by_username: string | null;
}

const timeAgo = relativeTimeFrom;

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
  if (b.expires_at && (parseServerDate(b.expires_at)?.getTime() ?? 0) <= Date.now()) return 'expired';
  return 'active';
}

/** v2.49.0 — resolved-name-or-raw-id fallback, mirrored across the Scores,
 *  Comments, and Bans tabs (each ships its own reporter/actor id + resolved
 *  display_name/username fields; the raw id is never the primary label,
 *  only a `title` tooltip / secondary line). */
function nameOrId(displayName: string | null | undefined, username: string | null | undefined, id: string): string {
  return displayName || username || id;
}

/** v2.49.0 — Bans tab scope column: "Global" or the owning room's name. */
function banScopeLabel(b: BanRow): string {
  return b.game_room_id ? (b.room_name || 'Unknown room') : 'Global';
}

/** S23.6 — Scores tab scope column, mirroring `banScopeLabel`: a report is
 *  either against a Global Scoreboard score or against one room's score. */
function scoreScopeLabel(r: ScoreReportRow): string {
  return r.score_source === 'room_history' ? (r.room_name || 'Unknown room') : 'Global';
}

const TABS: Array<{ key: ReportTab; label: string }> = [
  { key: 'rooms', label: 'Rooms' },
  { key: 'names', label: 'Player Names' },
  { key: 'scores', label: 'Scores' },
  { key: 'comments', label: 'Comments' },
  { key: 'bans', label: 'Bans' },
];

type ConfirmAction =
  | { kind: 'hard-delete'; report: ScoreReportRow }
  | { kind: 'score-ban'; report: ScoreReportRow }
  | { kind: 'suspend-room'; report: ContentReportRow }
  | { kind: 'reset-name'; report: ContentReportRow }
  | { kind: 'ban-identity'; report: ContentReportRow }
  | { kind: 'remove-comment'; report: CommentReportRow }
  | { kind: 'lift-ban'; ban: BanRow };

export default function Reports() {
  const { toast } = useToast();
  const [tab, setTab] = useState<ReportTab>('rooms');
  const [showResolved, setShowResolved] = useState(false);

  const [contentPending, setContentPending] = useState<ContentReportRow[]>([]);
  const [contentResolved, setContentResolved] = useState<ContentReportRow[]>([]);
  const [scorePending, setScorePending] = useState<ScoreReportRow[]>([]);
  const [scoreResolved, setScoreResolved] = useState<ScoreReportRow[]>([]);
  const [commentPending, setCommentPending] = useState<CommentReportRow[]>([]);
  const [commentResolved, setCommentResolved] = useState<CommentReportRow[]>([]);
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
  // Ban → content cascade (ROADMAP "Player Self-Service + Moderation" §C).
  // Default mirrors the server default (ScoreReportService.ban/banUser).
  const [banFormContentAction, setBanFormContentAction] = useState<'hide' | 'delete' | 'leave'>('hide');
  const [addingBan, setAddingBan] = useState(false);

  const contentType = tab === 'rooms' ? 'room' : tab === 'names' ? 'player_name' : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'bans') {
        const list = await api.get<BanRow[]>('/admin/bans');
        setBans(list || []);
      } else if (tab === 'comments') {
        const [pending, resolved] = await Promise.all([
          api.get<CommentReportRow[]>('/admin/comment-reports?status=pending'),
          api.get<CommentReportRow[]>('/admin/comment-reports?status=resolved'),
        ]);
        setCommentPending(pending || []);
        setCommentResolved(resolved || []);
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

  /** v2.47.0 (S22 follow-ups Workstream 2) — Comments tab: dismiss (no content action). */
  const handleDismissComment = async (id: number) => {
    setActingOn(id);
    try {
      await api.post(`/admin/comment-reports/${id}/dismiss`, {});
      toast('Report dismissed', 'success');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to dismiss report', 'error');
    } finally {
      setActingOn(null);
    }
  };

  /** v2.47.0 (S22 follow-ups Workstream 2) — Comments tab: remove (deletes the comment). */
  const handleRemoveComment = async (report: CommentReportRow) => {
    setActingOn(report.id);
    try {
      await api.post(`/admin/comment-reports/${report.id}/remove`, {});
      toast('Comment removed', 'success');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to remove comment', 'error');
    } finally {
      setActingOn(null);
      setConfirmTarget(null);
    }
  };

  /** S22 Phase 2 (v2.44.0) — Bans tab: lift an active ban. */
  const handleLiftBan = async (ban: BanRow) => {
    setActingOn(ban.id);
    try {
      const result = await api.post<{ success: boolean; restoredCount: number }>(`/admin/bans/${ban.id}/lift`, {});
      toast(
        result.restoredCount > 0
          ? `Ban lifted — ${result.restoredCount} hidden row${result.restoredCount === 1 ? '' : 's'} restored`
          : 'Ban lifted',
        'success'
      );
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
        contentAction: banFormContentAction,
      });
      toast('Identity banned', 'success');
      setBanFormId('');
      setBanFormDuration('');
      setBanFormReason('');
      setBanFormContentAction('hide');
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
  const commentRows = showResolved ? commentResolved : commentPending;

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
              <div>
                <label className="text-xs text-faint block mb-1">Their existing scores &amp; comments</label>
                <div className="space-y-1.5">
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="banFormContentAction"
                      className="mt-1"
                      checked={banFormContentAction === 'hide'}
                      onChange={() => setBanFormContentAction('hide')}
                    />
                    <span>
                      <span className="text-primary">Hide their existing content</span>
                      <span className="block text-xs text-faint">Removed from public view; restored automatically if this ban is lifted.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="banFormContentAction"
                      className="mt-1"
                      checked={banFormContentAction === 'delete'}
                      onChange={() => setBanFormContentAction('delete')}
                    />
                    <span>
                      <span className="text-primary">Delete</span>
                      <span className="block text-xs text-faint">Permanently removed; NOT restored if this ban is lifted.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="banFormContentAction"
                      className="mt-1"
                      checked={banFormContentAction === 'leave'}
                      onChange={() => setBanFormContentAction('leave')}
                    />
                    <span>
                      <span className="text-primary">Leave visible</span>
                      <span className="block text-xs text-faint">No change — their existing scores and comments stay up.</span>
                    </span>
                  </label>
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
                        <p className="text-sm font-medium text-primary" title={b.discord_user_id}>
                          {nameOrId(b.discord_user_display_name, b.discord_user_username, b.discord_user_id)}
                        </p>
                        <p className="text-xs text-faint mt-0.5">
                          <span className="px-1.5 py-0.5 rounded bg-surface border border-border mr-1.5">{banScopeLabel(b)}</span>
                          Banned by {nameOrId(b.banned_by_display_name, b.banned_by_username, b.banned_by)} · {timeAgo(b.banned_at)}
                          {b.expires_at ? ` · expires ${parseServerDate(b.expires_at)?.toLocaleDateString() ?? ""}` : ' · permanent'}
                        </p>
                        {b.reason && <p className="text-sm text-muted mt-1">"{b.reason}"</p>}
                        {status === 'lifted' && (
                          <p className="text-xs text-faint mt-1">
                            Lifted by {nameOrId(b.lifted_by_display_name, b.lifted_by_username, b.lifted_by || 'admin')}
                          </p>
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
      ) : tab === 'comments' ? (
        <NeonCard title={showResolved ? 'Resolved' : 'Pending'} glowColor={showResolved ? 'cyan' : 'amber'}>
          {commentRows.length === 0 ? (
            <p className="text-faint text-sm">{showResolved ? 'No resolved reports yet.' : 'No pending comment reports.'}</p>
          ) : (
            <div className="space-y-3">
              {commentRows.map((r) => (
                <div key={r.id} className="bg-raised border border-border rounded px-4 py-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-primary">
                        {r.game_name || 'Unknown game'}
                        {r.comment_type && (
                          <span className="ml-2 text-xs px-2 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30">
                            {r.comment_type === 'tip' ? 'Tip' : 'Comment'}
                          </span>
                        )}
                      </p>
                      {r.room_name && (
                        <p className="text-xs text-faint mt-0.5">
                          in room: {r.room_name}
                          {r.room_slug && (
                            <Link
                              to={`/${r.room_slug}`}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-1 text-xs text-neon-cyan hover:underline inline-flex items-center gap-1"
                            >
                              /{r.room_slug} <ExternalLink size={11} />
                            </Link>
                          )}
                        </p>
                      )}
                      <p className="text-xs text-faint mt-0.5">
                        By {r.comment_display_name || r.comment_user_id || 'Unknown'} · reported by{' '}
                        <span title={r.reporter_discord_id}>{nameOrId(r.reporter_display_name, r.reporter_username, r.reporter_discord_id)}</span>
                        {' '}· {timeAgo(r.created_at)}
                      </p>
                      {r.comment_body ? (
                        <p className="text-sm text-muted mt-1.5 bg-surface border border-border rounded px-2 py-1.5">"{r.comment_body}"</p>
                      ) : (
                        <p className="text-xs text-faint mt-1.5 italic">Comment no longer exists.</p>
                      )}
                      {r.reason && <p className="text-sm text-muted mt-1.5">Reason: "{r.reason}"</p>}
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
                          onClick={() => handleDismissComment(r.id)}
                          disabled={actingOn === r.id}
                        >
                          Dismiss
                        </NeonButton>
                        {r.comment_body && (
                          <NeonButton
                            variant="danger"
                            className="text-xs px-3 py-1.5"
                            onClick={() => setConfirmTarget({ kind: 'remove-comment', report: r })}
                            disabled={actingOn === r.id}
                          >
                            <Trash2 size={13} className="inline -mt-0.5 mr-1" />
                            Remove
                          </NeonButton>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </NeonCard>
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
                      <p className="text-sm font-medium text-primary flex items-center gap-2 flex-wrap">
                        <span>
                          {r.game_name || 'Unknown game'} — {r.iscored_username || r.player_id || 'Unknown player'}
                          {typeof r.score === 'number' && <span className="text-faint"> · {r.score.toLocaleString()}</span>}
                        </span>
                        {/* S23.6 scope chip — a score report is now either
                            against the Global Scoreboard or against one room. */}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-normal ${
                          r.score_source === 'room_history'
                            ? 'bg-neon-purple/10 text-neon-purple'
                            : 'bg-neon-cyan/10 text-neon-cyan'
                        }`}>
                          {scoreScopeLabel(r)}
                        </span>
                      </p>
                      <p className="text-xs text-faint mt-0.5">
                        Reported by <span title={r.reporter_discord_id}>{nameOrId(r.reporter_display_name, r.reporter_username, r.reporter_discord_id)}</span> · {timeAgo(r.created_at)}
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
                        {/* S23.6 — `global_scores` supports a soft-delete
                            tombstone, `score_history` does not: a room score is
                            removed outright (with the sync-suppression tombstone
                            so it can't come back). Offering "Soft Delete" there
                            would be a lie, so room rows get one Delete button. */}
                        {r.score_source === 'room_history' ? (
                          <NeonButton
                            variant="danger"
                            className="text-xs px-3 py-1.5"
                            onClick={() => setConfirmTarget({ kind: 'hard-delete', report: r })}
                            disabled={actingOn === r.id}
                          >
                            <Trash2 size={13} className="inline -mt-0.5 mr-1" />
                            Delete Score
                          </NeonButton>
                        ) : (
                          <>
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
                          </>
                        )}
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

      {confirmTarget?.kind === 'remove-comment' && (
        <ConfirmModal
          title="Remove this comment?"
          message="Permanently deletes the comment. This cannot be undone."
          confirmLabel="Remove"
          onConfirm={() => handleRemoveComment(confirmTarget.report)}
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
