import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, Ban, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { useToast } from '../components/Toast';

/**
 * S22 Phase 1 content moderation (v2.43.0) — super-admin Reports queue.
 * Three tabs: Rooms | Player Names (both backed by the new content_reports
 * table via ContentReportService) | Scores (the PRE-EXISTING score_reports
 * admin endpoints, wired to a UI for the first time — Phase 1 gives that
 * queue its first consumer). Modeled on JoinRequests.tsx's structure
 * (pending list + resolved history, NeonCard/NeonButton) plus
 * GlobalCatalogue.tsx's feedback-queue pattern (open/resolved toggle,
 * per-row resolution note).
 *
 * Full remediation "teeth" (suspend room, force-rename, ban enforcement
 * expansion) are Phase 2 (v2.44.0). This page's room-report action is a
 * shortcut link to the existing Game Rooms manager, where rename/delete
 * already live.
 */

type ReportTab = 'rooms' | 'names' | 'scores';

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

function targetLabel(r: ContentReportRow): string {
  return r.target_display_name || r.target_username || r.target_name || r.target_user_id || 'Unknown';
}

const TABS: Array<{ key: ReportTab; label: string }> = [
  { key: 'rooms', label: 'Rooms' },
  { key: 'names', label: 'Player Names' },
  { key: 'scores', label: 'Scores' },
];

export default function Reports() {
  const { toast } = useToast();
  const [tab, setTab] = useState<ReportTab>('rooms');
  const [showResolved, setShowResolved] = useState(false);

  const [contentPending, setContentPending] = useState<ContentReportRow[]>([]);
  const [contentResolved, setContentResolved] = useState<ContentReportRow[]>([]);
  const [scorePending, setScorePending] = useState<ScoreReportRow[]>([]);
  const [scoreResolved, setScoreResolved] = useState<ScoreReportRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | number | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [confirmTarget, setConfirmTarget] = useState<{ kind: 'hard-delete' | 'ban'; report: ScoreReportRow } | null>(null);
  const [banDurationDays, setBanDurationDays] = useState('');
  const [banReason, setBanReason] = useState('');

  const contentType = tab === 'rooms' ? 'room' : tab === 'names' ? 'player_name' : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (contentType) {
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
  }, [contentType, toast]);

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
    } catch {
      toast('Action failed', 'error');
    } finally {
      setActingOn(null);
      setConfirmTarget(null);
      setBanDurationDays('');
      setBanReason('');
    }
  };

  if (loading) return <LoadingState message="Loading reports…" />;

  const contentRows = showResolved ? contentResolved : contentPending;
  const scoreRows = showResolved ? scoreResolved : scorePending;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-4">Reports</h1>
      <p className="text-muted text-sm mb-6">
        Player-filed reports on rooms, names, and scores. Dismiss a report that needs no action, or resolve it with a
        note once you've taken action elsewhere (Game Rooms manager, Account Settings, etc.).
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
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
      </div>

      {contentType ? (
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
                        {tab === 'rooms' ? (r.room_name || r.target_name || 'Unknown room') : targetLabel(r)}
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
                      </p>
                      {tab === 'names' && r.room_name && (
                        <p className="text-xs text-faint mt-0.5">in room: {r.room_name}</p>
                      )}
                      <p className="text-xs text-faint mt-0.5">
                        Reported by {reporterLabel(r)} · {timeAgo(r.created_at)}
                      </p>
                      {r.reason && <p className="text-sm text-muted mt-1.5">"{r.reason}"</p>}
                      {showResolved && (
                        <p className="text-xs text-faint mt-1.5">
                          Resolved by {r.resolved_by || 'admin'} ({r.resolution}) · {r.resolved_at && timeAgo(r.resolved_at)}
                        </p>
                      )}
                    </div>
                    {!showResolved && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {tab === 'rooms' && r.game_room_id && (
                          <Link
                            to="/admin/rooms"
                            className="text-xs text-muted hover:text-primary border border-border rounded px-3 py-1.5 no-underline"
                          >
                            Manage rooms
                          </Link>
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
                          onClick={() => setConfirmTarget({ kind: 'ban', report: r })}
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

      {confirmTarget?.kind === 'ban' && (
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
              value={banDurationDays}
              onChange={(e) => setBanDurationDays(e.target.value)}
              placeholder="Permanent"
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-3"
            />
            <label className="block text-xs text-faint mb-1">Reason (optional)</label>
            <input
              type="text"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-4"
            />
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => setConfirmTarget(null)}>Cancel</NeonButton>
              <NeonButton
                variant="danger"
                onClick={() => handleScoreAction(confirmTarget.report.id, 'ban', {
                  durationDays: banDurationDays ? parseInt(banDurationDays, 10) : null,
                  reason: banReason || undefined,
                })}
              >
                Ban Player
              </NeonButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
