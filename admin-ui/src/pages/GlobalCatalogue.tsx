import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import DataTable from '../components/DataTable';
import RAGameSearch from '../components/RAGameSearch';
import { Search, RefreshCw, ChevronDown, ChevronUp, Check, X, Trash2, ExternalLink, GitMerge, AlertTriangle, Layers, Flag } from 'lucide-react';

interface GlobalGame {
  id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  type: string;
  subtype: string | null;
  platforms: string;
  themes: string;
  features: string;
  status: string;
  imported_from: string | null;
  /** v2.12.0: JSON array of additional source names absorbed via merge or
   *  cross-source upsert. Display alongside imported_from. */
  merged_from_sources: string | null;
  opdb_id: string | null;
  vps_id: string | null;
  igdb_id: number | null;
  external_url: string | null;
  /** v2.13.0: JSON array of structured download entries (format/url/version). */
  table_download_urls: string | null;
  local_image_path: string | null;
  created_at: string;
  /** RA on-demand import (§3). Already on the wire — `SELECT *`. */
  ra_id: number | null;
  score_eligibility: string | null;
  ra_leaderboard_count: number | null;
}

interface SyncLog {
  id: string;
  source: string;
  /** running | success | partial | error | interrupted */
  status: string;
  records_imported: number;
  records_updated: number;
  records_skipped: number;
  errors: string | null;
  started_at: string;
  completed_at: string | null;
  /** igdb-import-hardening: live progress, present once migration 131 has run. */
  heartbeat_at?: string | null;
  pages_done?: number | null;
  records_fetched?: number | null;
  expected_total?: number | null;
}

/** Pages are 500 rows; the count endpoint gives us the denominator. */
const SYNC_PAGE_SIZE = 500;

function syncProgressLabel(log: SyncLog): string | null {
  if (log.status !== 'running') return null;
  const fetched = log.records_fetched ?? 0;
  const pagesDone = log.pages_done ?? 0;
  const expected = log.expected_total ?? null;
  if (!expected) {
    return pagesDone > 0 ? `page ${pagesDone} · ${fetched} fetched` : 'starting…';
  }
  const pagesTotal = Math.max(1, Math.ceil(expected / SYNC_PAGE_SIZE));
  const pct = Math.min(100, Math.round((fetched / expected) * 100));
  return `page ${pagesDone}/${pagesTotal} · ${fetched}/${expected} (${pct}%)`;
}

interface CatalogueCounts {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
}

/**
 * Dedup audit — flags rows whose ipdb_url looks like a thematic reference
 * rather than a real-machine identity claim (virtual-only manufacturer /
 * missing manufacturer sharing an IPDB id with a real machine). See
 * isVirtualOnlyManufacturer doctrine, ADR 0014.
 */
interface DedupSuspect {
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  ipdb_url: string | null;
  imported_from: string | null;
  platforms: string;
  status: string;
  created_at: string;
}

interface SharedIpdbGroupRow {
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  status: string;
  imported_from: string | null;
}

interface SharedIpdbGroup {
  ipdbId: string;
  suggestedAction: string;
  rows: SharedIpdbGroupRow[];
}

interface DedupAuditResult {
  summary: { suspectCount: number; sharedGroupCount: number; scannedRows: number };
  suspects: DedupSuspect[];
  sharedIpdbGroups: SharedIpdbGroup[];
}

/** Response of POST /admin/catalogue/merge-ipdb-duplicates (v2.13.0 safe
 *  bulk-merge; surfaced on the Dedup Audit card as of v2.21.2). */
interface BulkMergeResult {
  dryRun: boolean;
  totalDupGroups: number;
  merged: number;
  skipped: number;
  log: Array<{
    ipdb: string;
    action: 'merged' | 'skipped';
    reason?: string;
    targetId?: string;
    sourceIds?: string[];
    rows: Array<{ id: string; name: string; manufacturer: string | null; year: number | null; imported_from: string | null }>;
  }>;
}

/** Report-a-problem (v2.25.0) — one row of GET /admin/catalogue/feedback. */
interface GameFeedbackItem {
  id: string;
  global_game_id: string;
  game_name: string;
  reporter_discord_id: string;
  field: string;
  current_value: string | null;
  suggested_value: string | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolution_note: string | null;
  live_name: string | null;
  manufacturer: string | null;
  year: number | null;
  field_sources: string | null;
  ipdb_url: string | null;
  opdb_id: string | null;
  vps_id: string | null;
  /** v2.49.0 — resolved via user_profiles. */
  reporter_display_name: string | null;
  reporter_username: string | null;
}

const FEEDBACK_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  manufacturer: 'Manufacturer',
  year: 'Year',
  platforms: 'Platforms',
  artwork: 'Artwork',
  duplicate: 'Duplicate game',
  not_score_eligible: 'Not score-eligible',
  other: 'Other',
};

/** Which source last wrote the disputed field ('{}' / unknown → null). */
function feedbackFieldSource(item: GameFeedbackItem): string | null {
  try {
    const fs = JSON.parse(item.field_sources || '{}');
    return typeof fs?.[item.field] === 'string' ? fs[item.field] : null;
  } catch {
    return null;
  }
}

const SOURCE_LABELS: Record<string, string> = {
  vps: 'VPS',
  opdb: 'OPDB',
  igdb: 'IGDB',
  wizard: 'Wizard',
  'steam-pinball': 'Steam Pinball',
  'fx-vr': 'FX VR',
  'atgames': 'AtGames',
  // RA is the one source whose route slug and sync_logs key differ
  // (`sync-ra-masterlist` vs `ra_masterlist`), so BOTH spellings are mapped:
  // the button resolves through the first, the status card through the second.
  'ra-masterlist': 'RA Master List',
  ra_masterlist: 'RA Master List',
};

/**
 * Button key → the `sync_logs.source` the run will actually write. Identity for
 * every source but RA, whose route is `sync-ra-masterlist` while its log key is
 * `ra_masterlist` (`RAMasterListService.RA_SYNC_SOURCE`). Without this the
 * completion poll below would wait forever on a row that never appears.
 */
const SYNC_LOG_SOURCE: Record<string, string> = {
  'ra-masterlist': 'ra_masterlist',
};

/** Muted, admin-only reading of the RA score-eligibility verdict (§5). */
const ELIGIBILITY_HINTS: Record<string, string> = {
  novelty: "RA boards suggest this isn't high-score-based",
  time: 'RA boards suggest this is time-based, not high-score-based',
};

const STATUS_COLORS: Record<string, string> = {
  success: 'text-neon-green',
  error: 'text-red-400',
  partial: 'text-yellow-400',
  running: 'text-neon-cyan',
  // A run whose process died. Distinct from `error` — nothing went wrong with
  // the data, the job just never got to finish, and re-running resumes it.
  interrupted: 'text-orange-400',
};

const PAGE_SIZE = 200;

export default function GlobalCatalogue() {
  const [games, setGames] = useState<GlobalGame[]>([]);
  const [totalMatching, setTotalMatching] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState<CatalogueCounts>({ total: 0, approved: 0, pending: 0, rejected: 0 });
  const [syncStatus, setSyncStatus] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [expandedGame, setExpandedGame] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ source: string; message: string } | null>(null);
  const [mergeSource, setMergeSource] = useState<GlobalGame | null>(null);
  const [mergeRestrictIds, setMergeRestrictIds] = useState<string[] | null>(null);

  // v2.25.0 report-a-problem review queue
  const [feedbackItems, setFeedbackItems] = useState<GameFeedbackItem[] | null>(null);
  const [feedbackView, setFeedbackView] = useState<'open' | 'resolved'>('open');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [feedbackNotes, setFeedbackNotes] = useState<Record<string, string>>({});
  /** §5 — narrow the queue to the "not score-eligible" flags. */
  const [eligibilityOnly, setEligibilityOnly] = useState(false);

  // §4 — RA on-demand import panel (collapsed until asked for).
  const [raPanelOpen, setRaPanelOpen] = useState(false);
  const [raQuery, setRaQuery] = useState('');

  const [auditData, setAuditData] = useState<DedupAuditResult | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [stripping, setStripping] = useState(false);
  const [bulkMerging, setBulkMerging] = useState(false);
  const [bulkMergeResult, setBulkMergeResult] = useState<BulkMergeResult | null>(null);

  const loadFeedback = useCallback(async (view: 'open' | 'resolved') => {
    setFeedbackLoading(true);
    try {
      const rows = await api.get<GameFeedbackItem[]>(
        `/admin/catalogue/feedback${view === 'resolved' ? '?status=resolved' : ''}`,
      );
      setFeedbackItems(rows || []);
    } catch (err) {
      console.error('Failed to load game feedback:', err);
      setFeedbackItems([]);
    } finally {
      setFeedbackLoading(false);
    }
  }, []);

  useEffect(() => { loadFeedback(feedbackView); }, [feedbackView, loadFeedback]);

  const handleResolveFeedback = async (id: string, resolution: 'fixed' | 'upstream' | 'dismissed') => {
    setResolvingId(id);
    try {
      await api.post(`/admin/catalogue/feedback/${id}/resolve`, {
        resolution,
        note: feedbackNotes[id]?.trim() || undefined,
      });
      await loadFeedback(feedbackView);
    } catch (err) {
      console.error('Failed to resolve feedback:', err);
      alert(err instanceof Error ? err.message : 'Resolve failed');
    } finally {
      setResolvingId(null);
    }
  };

  /**
   * §4 — after an import, put the admin ON the row. `setSearch` is what brings
   * it into the (server-filtered, paginated) list; expanding it saves the click
   * that would otherwise be needed to see the eligibility verdict and RA ids.
   */
  const handleRAImported = useCallback((result: { game: { id: string; name: string } }) => {
    setSearch(result.game?.name || '');
    setExpandedGame(result.game?.id ?? null);
  }, []);

  const loadData = useCallback(async () => {
    setLoadError(null);
    try {
      const [gamesRes, countsRes, syncRes] = await Promise.all([
        api.get<{ data: GlobalGame[]; total?: number; hasMore: boolean }>('/admin/catalogue/games' +
          buildQuery({ search, type: filterType, status: filterStatus, source: filterSource, limit: String(PAGE_SIZE) })),
        api.get<CatalogueCounts>('/admin/catalogue/counts'),
        api.get<SyncLog[]>('/admin/catalogue/sync-status'),
      ]);
      setGames(gamesRes.data || []);
      setTotalMatching(gamesRes.total ?? gamesRes.data?.length ?? 0);
      setHasMore(Boolean(gamesRes.hasMore));
      setCounts(countsRes);
      setSyncStatus(syncRes || []);
    } catch (err) {
      console.error('Failed to load global catalogue:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load catalogue data');
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, [search, filterType, filterStatus, filterSource]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<{ data: GlobalGame[]; total?: number; hasMore: boolean }>(
        '/admin/catalogue/games' + buildQuery({
          search, type: filterType, status: filterStatus, source: filterSource,
          limit: String(PAGE_SIZE), offset: String(games.length),
        })
      );
      setGames(prev => [...prev, ...(res.data || [])]);
      setHasMore(Boolean(res.hasMore));
    } catch (err) {
      console.error('Failed to load more games:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [games.length, hasMore, loadingMore, search, filterType, filterStatus, filterSource]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSync = async (source: string) => {
    setSyncing(source);
    setSyncResult(null);
    try {
      // Kick off background sync. Backend returns 202 immediately.
      await api.post<{ success: boolean; started: boolean; source: string }>(
        `/admin/catalogue/sync-${source}`, {}
      );

      setSyncResult({
        source,
        message: `${SOURCE_LABELS[source]} sync started in background. Polling for completion...`,
      });

      // Poll sync-status every 2s until this source's log has a completed_at
      const startedAt = Date.now();
      const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes safety cap

      while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const logs = await api.get<SyncLog[]>('/admin/catalogue/sync-status');
          setSyncStatus(logs);
          const latest = logs.find(l => l.source === (SYNC_LOG_SOURCE[source] || source));
          // Live progress while it works — a bulk IGDB run is hours long and
          // "started in background" was the last thing the admin heard.
          if (latest && !latest.completed_at) {
            const progress = syncProgressLabel(latest);
            if (progress) {
              setSyncResult({ source, message: `${SOURCE_LABELS[source]} sync running — ${progress}` });
            }
          }
          if (latest && latest.completed_at) {
            const imported = latest.records_imported || 0;
            const updated = latest.records_updated || 0;
            const skipped = latest.records_skipped || 0;
            if (latest.status === 'error') {
              setSyncResult({
                source,
                message: `${SOURCE_LABELS[source]} sync failed. Check logs for details.` +
                  ' Syncing again resumes from where it stopped.',
              });
            } else {
              const expected = latest.expected_total ?? null;
              const fetched = latest.records_fetched ?? 0;
              setSyncResult({
                source,
                message: `${SOURCE_LABELS[source]}: ${imported} imported, ${updated} updated` +
                  (skipped ? `, ${skipped} skipped` : '') +
                  (latest.status === 'partial'
                    ? expected
                      ? ` (partial — ${fetched} of ~${expected} rows; sync again to resume)`
                      : ' (partial — some errors)'
                    : ''),
              });
            }
            await loadData();
            return;
          }
        } catch {
          // Transient poll failure — keep trying
        }
      }

      setSyncResult({
        source,
        message: `${SOURCE_LABELS[source]} sync is still running after 15 minutes — that is expected for a ` +
          `full bulk import. It keeps going in the background; this card shows live progress.`,
      });
      await loadData();
    } catch (err) {
      // A 409 (single-flight: a run is already in flight) arrives here as the
      // server's message. It is not a failure to report as one.
      const message = err instanceof Error ? err.message : String(err);
      const alreadyRunning = message.toLowerCase().includes('already running');
      setSyncResult({
        source,
        message: alreadyRunning
          ? `${SOURCE_LABELS[source]}: ${message}`
          : `${SOURCE_LABELS[source]} sync failed to start: ${message}`,
      });
      if (alreadyRunning) await loadData();
    } finally {
      setSyncing(null);
    }
  };

  const handleStatusChange = async (gameId: string, newStatus: string) => {
    try {
      await api.patch(`/admin/catalogue/games/${gameId}/status`, { status: newStatus });
      await loadData();
    } catch (err) {
      console.error('Failed to update game status:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to update game status');
    }
  };

  const handleDelete = async (gameId: string) => {
    if (!confirm('Delete this game from the global catalogue?')) return;
    try {
      await api.delete(`/admin/catalogue/games/${gameId}`);
      await loadData();
    } catch (err) {
      console.error('Failed to delete game:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to delete game');
    }
  };

  const handleMergeOpen = (game: GlobalGame) => {
    setMergeRestrictIds(null);
    setMergeSource(game);
  };

  const handleGroupMerge = async (group: SharedIpdbGroup, rowId: string) => {
    setAuditError(null);
    try {
      const full = await api.get<GlobalGame>(`/admin/catalogue/games/${rowId}`);
      setMergeRestrictIds(group.rows.map(r => r.id).filter(id => id !== rowId));
      setMergeSource(full);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Failed to load game for merge');
    }
  };

  const runAudit = async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await api.get<DedupAuditResult>('/admin/catalogue/dedup-audit');
      setAuditData(res);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Failed to run dedup audit');
      setAuditData(null);
    } finally {
      setAuditLoading(false);
    }
  };

  const stripIds = async (ids: string[]) => {
    if (ids.length === 0) return;
    setStripping(true);
    setAuditError(null);
    try {
      await api.post<{ stripped: number; skipped: number; results: unknown }>(
        '/admin/catalogue/dedup-audit/strip', { ids }
      );
      await runAudit();
      await loadData();
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Failed to strip IPDB links');
    } finally {
      setStripping(false);
    }
  };

  const handleStripOne = (id: string) => {
    if (!confirm('Strip the IPDB link from this game? The entry itself is kept — only the thematic IPDB reference is removed.')) return;
    stripIds([id]);
  };

  const handleStripAll = () => {
    if (!auditData || auditData.suspects.length === 0) return;
    if (!confirm(`Strip IPDB links from all ${auditData.suspects.length} suspect(s)? This cannot be undone.`)) return;
    stripIds(auditData.suspects.map(s => s.id));
  };

  // v2.21.2: surface the existing v2.13.0 safe bulk-merge endpoint on the
  // audit card — merges shared-IPDB groups that pass the strict heuristic
  // (same year, normalized-manufacturer agreement, no community/digital
  // markers) and reports per-group skip reasons for the rest.
  const runBulkMerge = async (dry: boolean) => {
    if (!dry && !confirm('Execute safe bulk-merge? Groups passing the strict heuristic (same year, compatible manufacturers) will be merged into one catalogue entry each. Run the dry-run preview first if unsure.')) return;
    setBulkMerging(true);
    setAuditError(null);
    try {
      const res = await api.post<BulkMergeResult>(
        `/admin/catalogue/merge-ipdb-duplicates${dry ? '?dry=true' : ''}`, {}
      );
      setBulkMergeResult(res);
      if (!dry) {
        await runAudit();
        await loadData();
      }
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Bulk merge failed');
    } finally {
      setBulkMerging(false);
    }
  };

  const visibleFeedback = (feedbackItems ?? []).filter(
    item => !eligibilityOnly || item.field === 'not_score_eligible',
  );

  if (loading) return <LoadingState message="Loading catalogue..." />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Global Game Catalogue</h1>

      {/* Overview counts */}
      <NeonCard glowColor="cyan" className="mb-6" title="Catalogue Overview">
        <div className="flex gap-8 flex-wrap">
          <Stat label="Total Games" value={counts.total} color="cyan" />
          <Stat label="Approved" value={counts.approved} color="green" />
          <Stat label="Pending Review" value={counts.pending} color="yellow" />
          <Stat label="Rejected" value={counts.rejected} color="red" />
        </div>
      </NeonCard>

      {/* Sync controls + health */}
      <NeonCard glowColor="magenta" className="mb-6" title="Catalogue Sync">
        <div className="flex flex-wrap gap-3 mb-4">
          {['vps', 'wizard', 'opdb', 'igdb', 'steam-pinball', 'fx-vr', 'atgames', 'ra-masterlist'].map(source => (
            <NeonButton
              key={source}
              variant="secondary"
              onClick={() => handleSync(source)}
              disabled={syncing !== null}
              className="flex items-center gap-2"
            >
              <RefreshCw size={14} className={syncing === source ? 'animate-spin' : ''} />
              Sync {SOURCE_LABELS[source]}
            </NeonButton>
          ))}
        </div>

        {syncResult && (
          <div className={`text-sm mb-4 p-2 rounded ${syncResult.message.includes('failed') ? 'bg-red-900/30 text-red-300' : 'bg-green-900/30 text-green-300'}`}>
            {syncResult.message}
          </div>
        )}

        {/* Last sync status per source */}
        {syncStatus.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {syncStatus.map(log => {
              const progress = syncProgressLabel(log);
              return (
                <div key={log.id} className="bg-surface-alt rounded p-3 text-sm">
                  <div className="font-bold text-xs uppercase tracking-wider text-muted mb-1">
                    {SOURCE_LABELS[log.source] || log.source}
                  </div>
                  <div className={`flex items-center gap-1.5 ${STATUS_COLORS[log.status] || 'text-muted'}`}>
                    {log.status === 'running' && <RefreshCw size={12} className="animate-spin shrink-0" />}
                    {log.status}
                  </div>
                  {progress && (
                    <div className="text-neon-cyan text-xs mt-1">{progress}</div>
                  )}
                  {log.status === 'interrupted' && (
                    <div className="text-orange-400 text-xs mt-1">
                      stopped mid-run — sync again to resume
                    </div>
                  )}
                  <div className="text-muted text-xs mt-1">
                    {log.records_imported} new, {log.records_updated} updated
                  </div>
                  <div className="text-muted text-xs">
                    {formatDate(log.heartbeat_at || log.completed_at || log.started_at)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </NeonCard>

      {/* Contract §4 — the third surface of the shared RA search. Same
          component as the room-admin add flow and the Global Scoreboard; the
          /admin endpoint twin is the only difference. Behind a toggle because
          this is an occasional tool, not part of the page's default reading. */}
      <NeonCard glowColor="cyan" className="mb-6" title="RetroAchievements Import">
        <p className="text-sm text-muted mb-3">
          Search the synced RetroAchievements master list and import one game on demand.
          The import is the approval — the game lands <span className="text-primary">approved</span>{' '}
          and is immediately usable by every room.
        </p>
        <NeonButton
          variant="secondary"
          onClick={() => setRaPanelOpen(o => !o)}
          className="flex items-center gap-2"
        >
          <Search size={14} />
          {raPanelOpen ? 'Hide RA search' : 'Search RetroAchievements'}
        </NeonButton>
        {raPanelOpen && (
          <div className="mt-4">
            <input
              type="text"
              value={raQuery}
              onChange={e => setRaQuery(e.target.value)}
              placeholder="Search RetroAchievements by title…"
              className="w-full px-3 py-2 bg-surface-alt border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan mb-3"
            />
            <RAGameSearch
              basePath="/admin/ra-catalogue"
              authMode="admin"
              query={raQuery}
              canImport
              actionLabel="Import"
              heading="Master-list results"
              showEligibility
              showConfigHint
              onImported={handleRAImported}
            />
          </div>
        )}
      </NeonCard>

      {/* Dedup audit — flags thematic-reference IPDB links masquerading as identity claims */}
      <NeonCard glowColor="amber" className="mb-6" title="Dedup Audit">
        <p className="text-sm text-muted mb-4">
          Flags catalogue rows whose IPDB link looks like a thematic reference rather than a
          real-machine identity claim — virtual-only manufacturers, "Original" fan tables, or a
          missing manufacturer sharing an IPDB id with a real machine.
        </p>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <NeonButton
            variant="secondary"
            onClick={runAudit}
            disabled={auditLoading}
            className="flex items-center gap-2"
          >
            <RefreshCw size={14} className={auditLoading ? 'animate-spin' : ''} />
            {auditLoading ? 'Running Audit...' : 'Run Audit'}
          </NeonButton>
          {auditData && (
            <span className="text-sm text-muted">
              {auditData.summary.suspectCount} suspect{auditData.summary.suspectCount === 1 ? '' : 's'}
              {' · '}
              {auditData.summary.sharedGroupCount} shared-IPDB group{auditData.summary.sharedGroupCount === 1 ? '' : 's'}
              {' · '}
              {auditData.summary.scannedRows.toLocaleString()} rows scanned
            </span>
          )}
          {auditData && auditData.summary.sharedGroupCount > 0 && (
            <>
              <NeonButton
                variant="secondary"
                onClick={() => runBulkMerge(true)}
                disabled={bulkMerging}
                className="text-xs py-1 px-3"
              >
                {bulkMerging ? 'Working…' : 'Preview Safe Bulk-Merge'}
              </NeonButton>
              <NeonButton
                variant="danger"
                onClick={() => runBulkMerge(false)}
                disabled={bulkMerging}
                className="text-xs py-1 px-3"
              >
                Execute Safe Bulk-Merge
              </NeonButton>
            </>
          )}
        </div>

        {bulkMergeResult && (
          <div className="mb-4 p-3 rounded bg-surface border border-border text-sm">
            <div className="font-medium mb-1">
              Safe bulk-merge {bulkMergeResult.dryRun ? 'preview (no changes made)' : 'executed'}:
              {' '}{bulkMergeResult.merged} group{bulkMergeResult.merged === 1 ? '' : 's'} merge{bulkMergeResult.dryRun ? 'able' : 'd'},
              {' '}{bulkMergeResult.skipped} skipped
            </div>
            {bulkMergeResult.log.filter(l => l.action === 'skipped').length > 0 && (
              <div className="text-xs text-muted space-y-0.5 max-h-48 overflow-y-auto">
                {bulkMergeResult.log.filter(l => l.action === 'skipped').map(l => (
                  <div key={l.ipdb}>
                    IPDB {l.ipdb} — skipped ({l.reason}): {l.rows.map(r => `${r.name} (${r.manufacturer || '?'}${r.year ? `, ${r.year}` : ''})`).join(' · ')}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {auditError && (
          <div className="mb-4 p-3 rounded bg-red-900/30 border border-red-700 text-red-300 text-sm">
            <strong>Error:</strong> {auditError}
          </div>
        )}

        {auditData && auditData.summary.suspectCount === 0 && auditData.summary.sharedGroupCount === 0 && (
          <div className="text-muted text-center py-6 text-sm">
            No suspects — catalogue is clean.
          </div>
        )}

        {auditData && auditData.suspects.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h4 className="text-xs font-display font-bold uppercase tracking-wider text-neon-amber flex items-center gap-1">
                <AlertTriangle size={12} /> Suspects ({auditData.suspects.length})
              </h4>
              <NeonButton
                variant="danger"
                onClick={handleStripAll}
                disabled={stripping}
                className="text-xs py-1 px-3"
              >
                {stripping ? 'Stripping…' : `Strip All (${auditData.suspects.length})`}
              </NeonButton>
            </div>
            <DataTable<DedupSuspect>
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  render: s => (
                    <div>
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-muted">
                        {s.manufacturer || 'Unknown'}{s.year ? `, ${s.year}` : ''}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'ipdb',
                  header: 'IPDB',
                  render: s => s.ipdb_url ? (
                    <a
                      href={s.ipdb_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-neon-cyan hover:underline"
                    >
                      <ExternalLink size={12} /> View
                    </a>
                  ) : <span className="text-muted text-xs">-</span>,
                },
                {
                  key: 'source',
                  header: 'Source',
                  render: s => <span className="text-xs text-muted uppercase">{s.imported_from || 'manual'}</span>,
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: s => (
                    <NeonButton
                      variant="secondary"
                      onClick={() => handleStripOne(s.id)}
                      disabled={stripping}
                      className="text-xs py-1 px-3"
                    >
                      Strip IPDB
                    </NeonButton>
                  ),
                },
              ]}
              data={auditData.suspects}
              keyExtractor={s => s.id}
            />
          </div>
        )}

        {auditData && auditData.sharedIpdbGroups.length > 0 && (
          <div>
            <h4 className="text-xs font-display font-bold uppercase tracking-wider text-neon-cyan mb-2 flex items-center gap-1">
              <Layers size={12} /> Shared-IPDB Groups ({auditData.sharedIpdbGroups.length})
            </h4>
            <div className="space-y-2">
              {auditData.sharedIpdbGroups.map(group => (
                <SharedGroupCard key={group.ipdbId} group={group} onMergeRow={handleGroupMerge} />
              ))}
            </div>
          </div>
        )}
      </NeonCard>

      {/* v2.25.0 — report-a-problem review queue */}
      <NeonCard className="mb-6" title="Game Info Reports">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <p className="text-sm text-muted">
            <Flag size={13} className="inline mr-1.5 -mt-0.5" />
            User-filed reports on catalogue metadata. Fix the entry (edit it in the list below), or
            answer "upstream" when the field comes from IPDB/VPS/OPDB (see the source badge).
          </p>
          <div className="flex gap-1">
            {/* §5 — the eligibility flags are a different job from metadata
                corrections (delete/merge vs. edit a field), so the queue can be
                narrowed to just them rather than being read end-to-end. */}
            <button
              onClick={() => setEligibilityOnly(o => !o)}
              data-testid="feedback-eligibility-filter"
              aria-pressed={eligibilityOnly}
              className={`px-3 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
                eligibilityOnly
                  ? 'border-yellow-500/50 bg-yellow-900/30 text-yellow-300'
                  : 'border-border text-muted hover:text-primary'
              }`}
            >
              Eligibility flags
            </button>
            {(['open', 'resolved'] as const).map(v => (
              <button
                key={v}
                onClick={() => setFeedbackView(v)}
                className={`px-3 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
                  feedbackView === v
                    ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan'
                    : 'border-border text-muted hover:text-primary'
                }`}
              >
                {v === 'open' ? `Open${feedbackItems && feedbackView === 'open' ? ` (${feedbackItems.length})` : ''}` : 'Resolved'}
              </button>
            ))}
          </div>
        </div>

        {feedbackLoading ? (
          <div className="text-muted text-sm py-4 text-center">Loading reports…</div>
        ) : visibleFeedback.length === 0 ? (
          <div className="text-muted text-sm py-4 text-center">
            {eligibilityOnly
              ? 'No score-eligibility flags here.'
              : feedbackView === 'open' ? 'No open reports — all clear.' : 'No resolved reports yet.'}
          </div>
        ) : (
          <div className="space-y-3">
            {visibleFeedback.map(item => {
              const src = feedbackFieldSource(item);
              const removed = item.live_name === null;
              return (
                <div key={item.id} className="bg-raised border border-border rounded-lg p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-primary">{item.live_name ?? item.game_name}</span>
                        {removed && (
                          <span className="px-1.5 py-0.5 text-[10px] uppercase rounded bg-surface border border-border text-faint">
                            game removed
                          </span>
                        )}
                        {/* §5 — the eligibility flag is not a metadata
                            correction, so it does not wear the metadata
                            badge's colour. Amber marks "decide whether this
                            game belongs in the catalogue at all". */}
                        <span
                          data-testid="feedback-field-badge"
                          data-field={item.field}
                          className={`px-1.5 py-0.5 text-[10px] uppercase rounded border ${
                            item.field === 'not_score_eligible'
                              ? 'bg-yellow-900/30 border-yellow-500/40 text-yellow-300'
                              : 'bg-neon-cyan/10 border-neon-cyan/30 text-neon-cyan'
                          }`}
                        >
                          {FEEDBACK_FIELD_LABELS[item.field] || item.field}
                        </span>
                        <span
                          className="px-1.5 py-0.5 text-[10px] uppercase rounded bg-surface border border-border text-muted"
                          title="Which source last wrote this field (unknown for rows untouched since v2.25.0)"
                        >
                          {src === 'manual' ? 'Source: manual (ours)' : src ? `Source: ${SOURCE_LABELS[src] || src}` : 'Source: unknown'}
                        </span>
                      </div>
                      <div className="text-sm text-muted mt-1.5">
                        {item.field === 'not_score_eligible' ? (
                          <>
                            Reporter says this game isn't score-based.
                            {' '}
                            {item.current_value
                              ? <>RA's verdict at import: <span className="text-primary">{item.current_value.replace('_', ' ')}</span>.</>
                              : 'No RetroAchievements verdict on file.'}
                          </>
                        ) : (
                          <>
                            {item.current_value != null && <>Current: <span className="text-primary">{item.current_value}</span></>}
                            {item.suggested_value && <>{item.current_value != null && ' → '}Suggested: <span className="text-neon-green">{item.suggested_value}</span></>}
                          </>
                        )}
                      </div>
                      {item.note && <p className="text-sm text-muted mt-1 whitespace-pre-wrap">{item.note}</p>}
                      <div className="text-xs text-faint mt-1.5 flex items-center gap-3 flex-wrap">
                        <span title={item.reporter_discord_id}>
                          Reporter: {item.reporter_display_name || item.reporter_username || item.reporter_discord_id}
                        </span>
                        <span>{new Date(item.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</span>
                        {item.ipdb_url && (
                          <a href={item.ipdb_url} target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline inline-flex items-center gap-1">
                            <ExternalLink size={10} /> IPDB
                          </a>
                        )}
                        {item.opdb_id && (
                          <a href={`https://opdb.org/machines/${item.opdb_id}`} target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline inline-flex items-center gap-1">
                            <ExternalLink size={10} /> OPDB
                          </a>
                        )}
                        {!removed && (
                          <button
                            onClick={() => { setSearch(item.live_name ?? item.game_name); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }}
                            className="text-neon-cyan hover:underline cursor-pointer"
                          >
                            Find in list
                          </button>
                        )}
                      </div>
                    </div>

                    {item.resolved_at ? (
                      <div className="text-xs text-muted text-right shrink-0">
                        <span className={`px-2 py-0.5 rounded border text-[10px] uppercase ${
                          item.resolution === 'fixed' ? 'border-neon-green/40 text-neon-green'
                          : item.resolution === 'upstream' ? 'border-neon-cyan/40 text-neon-cyan'
                          : 'border-border text-muted'
                        }`}>{item.resolution}</span>
                        {item.resolution_note && <p className="mt-1 max-w-[240px]">{item.resolution_note}</p>}
                      </div>
                    ) : (
                      <div className="shrink-0 space-y-2 w-full sm:w-auto">
                        <input
                          value={feedbackNotes[item.id] || ''}
                          onChange={e => setFeedbackNotes(n => ({ ...n, [item.id]: e.target.value }))}
                          placeholder="Resolution note (optional)"
                          maxLength={1000}
                          className="w-full sm:w-64 px-2 py-1 bg-surface border border-border rounded text-xs text-primary placeholder-faint focus:outline-none focus:border-neon-cyan"
                        />
                        <div className="flex gap-1.5 justify-end">
                          <NeonButton className="text-xs py-1 px-2" disabled={resolvingId === item.id} onClick={() => handleResolveFeedback(item.id, 'fixed')}>
                            Fixed
                          </NeonButton>
                          <NeonButton variant="secondary" className="text-xs py-1 px-2" disabled={resolvingId === item.id} onClick={() => handleResolveFeedback(item.id, 'upstream')}>
                            Upstream
                          </NeonButton>
                          <NeonButton variant="ghost" className="text-xs py-1 px-2" disabled={resolvingId === item.id} onClick={() => handleResolveFeedback(item.id, 'dismissed')}>
                            Dismiss
                          </NeonButton>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </NeonCard>

      {/* Search + filters */}
      <NeonCard className="mb-6" title="Browse Games">
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder="Search games..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-surface-alt border border-border rounded pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neon-cyan"
            />
          </div>
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-primary"
          >
            <option value="" className="bg-surface-alt text-primary">All Types</option>
            <option value="pinball" className="bg-surface-alt text-primary">Pinball</option>
            <option value="arcade" className="bg-surface-alt text-primary">Arcade</option>
            <option value="video_game" className="bg-surface-alt text-primary">Video Game</option>
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-primary"
          >
            <option value="" className="bg-surface-alt text-primary">All Status</option>
            <option value="approved" className="bg-surface-alt text-primary">Approved</option>
            <option value="pending_review" className="bg-surface-alt text-primary">Pending Review</option>
            <option value="rejected" className="bg-surface-alt text-primary">Rejected</option>
          </select>
          <select
            value={filterSource}
            onChange={e => setFilterSource(e.target.value)}
            className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-primary"
          >
            <option value="" className="bg-surface-alt text-primary">All Sources</option>
            <option value="vps" className="bg-surface-alt text-primary">VPS</option>
            <option value="opdb" className="bg-surface-alt text-primary">OPDB</option>
            <option value="igdb" className="bg-surface-alt text-primary">IGDB</option>
            <option value="wizard" className="bg-surface-alt text-primary">Wizard</option>
            <option value="manual" className="bg-surface-alt text-primary">Manual</option>
          </select>
        </div>

        {/* Error banner */}
        {loadError && (
          <div className="mb-3 p-3 rounded bg-red-900/30 border border-red-700 text-red-300 text-sm">
            <strong>Error:</strong> {loadError}
            <button
              onClick={() => { setLoading(true); loadData(); }}
              className="ml-3 underline hover:text-red-200"
            >
              Retry
            </button>
          </div>
        )}

        {/* Game list */}
        <div className="text-sm text-muted mb-2">
          {games.length} of {totalMatching.toLocaleString()} games shown
        </div>
        <div className="space-y-1">
          {games.map(game => (
            <GameRow
              key={game.id}
              game={game}
              expanded={expandedGame === game.id}
              onToggle={() => setExpandedGame(expandedGame === game.id ? null : game.id)}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
              onMerge={handleMergeOpen}
            />
          ))}
          {games.length === 0 && !loadError && (
            <div className="text-muted text-center py-8">
              No games found. Try adjusting your filters or sync a source.
            </div>
          )}
        </div>
        {hasMore && (
          <div className="mt-4 flex justify-center">
            <NeonButton
              variant="secondary"
              onClick={loadMore}
              disabled={loadingMore}
              className="flex items-center gap-2"
            >
              {loadingMore ? 'Loading...' : `Load More (${(totalMatching - games.length).toLocaleString()} remaining)`}
            </NeonButton>
          </div>
        )}
      </NeonCard>

      {mergeSource && (
        <MergeModal
          source={mergeSource}
          restrictToIds={mergeRestrictIds ?? undefined}
          onClose={() => { setMergeSource(null); setMergeRestrictIds(null); }}
          onComplete={async () => {
            setMergeSource(null);
            setMergeRestrictIds(null);
            await loadData();
            if (auditData) await runAudit();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const colorClass = {
    cyan: 'text-neon-cyan',
    green: 'text-neon-green',
    yellow: 'text-yellow-400',
    red: 'text-red-400',
  }[color] || 'text-white';

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted text-sm">{label}:</span>
      <span className={`font-display font-bold text-lg ${colorClass}`}>{(value ?? 0).toLocaleString()}</span>
    </div>
  );
}

function GameRow({
  game,
  expanded,
  onToggle,
  onStatusChange,
  onDelete,
  onMerge,
}: {
  game: GlobalGame;
  expanded: boolean;
  onToggle: () => void;
  onStatusChange: (id: string, status: string) => void;
  onDelete: (id: string) => void;
  onMerge: (game: GlobalGame) => void;
}) {
  const platforms: string[] = JSON.parse(game.platforms || '[]');
  const sources = deriveSources(game);
  const eligibilityHint = game.score_eligibility
    ? ELIGIBILITY_HINTS[game.score_eligibility] || null
    : null;
  const statusBadge = {
    approved: 'bg-green-900/40 text-green-300',
    pending_review: 'bg-yellow-900/40 text-yellow-300',
    rejected: 'bg-red-900/40 text-red-300',
  }[game.status] || 'bg-gray-800 text-gray-400';

  return (
    <div className="bg-surface-alt rounded border border-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/5 transition-colors"
      >
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        <span className="font-medium truncate min-w-0">{game.name}</span>
        {game.manufacturer && (
          <span className="text-muted text-xs hidden md:inline whitespace-nowrap">
            {game.manufacturer}{game.year ? `, ${game.year}` : ''}
          </span>
        )}
        {platforms.length > 0 && (
          <div className="hidden lg:flex gap-1 flex-wrap min-w-0">
            {platforms.map(p => (
              <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan whitespace-nowrap">
                {p}
              </span>
            ))}
          </div>
        )}
        <span className="text-xs px-2 py-0.5 rounded bg-surface capitalize ml-auto whitespace-nowrap">
          {game.type.replace('_', ' ')}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded ${statusBadge} whitespace-nowrap`}>
          {game.status.replace('_', ' ')}
        </span>
        {sources.length > 0 && (
          <span className="text-xs text-muted uppercase whitespace-nowrap">
            {sources.join(', ')}
          </span>
        )}
        {/* §5 — the import-time verdict as a MUTED admin signal, so a
            "not score-eligible" report is corroborated rather than being the
            only evidence. Never shown to players. */}
        {eligibilityHint && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/30 text-yellow-300 whitespace-nowrap hidden xl:inline"
            title={eligibilityHint}
            data-testid="catalogue-eligibility-hint"
          >
            {game.score_eligibility === 'time' ? 'time-based?' : 'not score-based?'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Detail label="Platforms" value={platforms.join(', ') || 'None'} />
            <Detail label="Subtype" value={game.subtype || '-'} />
            <Detail label="OPDB ID" value={game.opdb_id || '-'} />
            <Detail label="VPS ID" value={game.vps_id || '-'} />
            <Detail label="IGDB ID" value={game.igdb_id?.toString() || '-'} />
            <Detail label="Source" value={sources.length > 0 ? sources.join(', ') : 'manual'} />
            {game.ra_id != null && (
              <>
                <Detail label="RA ID" value={String(game.ra_id)} />
                <Detail
                  label="Score Eligibility"
                  value={
                    (game.score_eligibility || 'unknown').replace('_', ' ') +
                    (game.ra_leaderboard_count != null
                      ? ` (${game.ra_leaderboard_count} board${game.ra_leaderboard_count === 1 ? '' : 's'})`
                      : '')
                  }
                />
              </>
            )}
          </div>
          {eligibilityHint && (
            <p className="text-xs text-muted">{eligibilityHint}</p>
          )}

          {(() => {
            // v2.13.0: surface all source links rather than just external_url.
            // Multi-source rows (vps + wizard) carry the second source's URL
            // in table_download_urls with a `format` label set by the merge
            // primitive — show them all here.
            type DownloadEntry = { format?: string; url: string; version?: string };
            let entries: DownloadEntry[] = [];
            try {
              const parsed = JSON.parse(game.table_download_urls || '[]');
              if (Array.isArray(parsed)) entries = parsed.filter((e): e is DownloadEntry => !!e?.url);
            } catch { /* ignore malformed JSON */ }
            // Add external_url as a separate entry only if not already in the list.
            const seen = new Set(entries.map(e => e.url));
            if (game.external_url && !seen.has(game.external_url)) {
              entries.push({ format: 'source', url: game.external_url });
            }
            if (entries.length === 0) return null;
            return (
              <div>
                <div className="text-muted text-xs uppercase tracking-wider mb-1">Sources</div>
                <div className="flex flex-wrap gap-2">
                  {entries.map((e, i) => (
                    <a
                      key={`${e.url}-${i}`}
                      href={e.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-neon-cyan hover:bg-neon-cyan/10 no-underline"
                      title={e.url}
                    >
                      <ExternalLink size={12} />
                      {(e.format || 'source').toUpperCase()}{e.version ? ` v${e.version}` : ''}
                    </a>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="flex gap-2 pt-2 flex-wrap">
            {game.status !== 'approved' && (
              <NeonButton variant="primary" onClick={() => onStatusChange(game.id, 'approved')} className="text-xs py-1 px-3 flex items-center gap-1">
                <Check size={12} /> Approve
              </NeonButton>
            )}
            {game.status !== 'rejected' && (
              <NeonButton variant="secondary" onClick={() => onStatusChange(game.id, 'rejected')} className="text-xs py-1 px-3 flex items-center gap-1">
                <X size={12} /> Reject
              </NeonButton>
            )}
            <NeonButton variant="secondary" onClick={() => onMerge(game)} className="text-xs py-1 px-3 flex items-center gap-1">
              <GitMerge size={12} /> Merge into…
            </NeonButton>
            <NeonButton variant="danger" onClick={() => onDelete(game.id)} className="text-xs py-1 px-3 flex items-center gap-1">
              <Trash2 size={12} /> Delete
            </NeonButton>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted text-xs uppercase tracking-wider">{label}</div>
      <div className="truncate">{value}</div>
    </div>
  );
}

const GROUP_ACTION_BADGES: Record<string, string> = {
  merge: 'bg-yellow-900/40 text-yellow-300',
  'strip-virtual-side': 'bg-purple-900/40 text-purple-300',
  review: 'bg-blue-900/40 text-blue-300',
};

/** One shared-IPDB group from the dedup audit. Rows sharing the same real-machine
 *  IPDB id are candidates to merge into a single catalogue entry. */
function SharedGroupCard({
  group,
  onMergeRow,
}: {
  group: SharedIpdbGroup;
  onMergeRow: (group: SharedIpdbGroup, rowId: string) => void;
}) {
  return (
    <div className="bg-surface-alt rounded border border-border p-3">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <a
          href={`https://www.ipdb.org/machine.cgi?id=${encodeURIComponent(group.ipdbId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-neon-cyan hover:underline"
        >
          <ExternalLink size={12} /> IPDB #{group.ipdbId}
        </a>
        <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${GROUP_ACTION_BADGES[group.suggestedAction] || 'bg-gray-800 text-gray-400'}`}>
          {group.suggestedAction}
        </span>
      </div>
      <div className="space-y-1">
        {group.rows.map(row => (
          <div key={row.id} className="flex items-center gap-2 flex-wrap text-xs bg-surface rounded px-2 py-1.5">
            <span className="font-medium">{row.name}</span>
            <span className="text-muted">{row.manufacturer || 'Unknown'}{row.year ? `, ${row.year}` : ''}</span>
            <span className="text-muted uppercase">{row.imported_from || 'manual'}</span>
            <span className="text-muted">{row.status.replace('_', ' ')}</span>
            {group.suggestedAction === 'merge' && group.rows.length > 1 && (
              <NeonButton
                variant="secondary"
                onClick={() => onMergeRow(group, row.id)}
                className="text-[11px] py-0.5 px-2 ml-auto flex items-center gap-1"
              >
                <GitMerge size={11} /> Merge via tool
              </NeonButton>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * v2.12.1: derive the displayed source list to match the backend filter.
 * Backend treats a row as "in VPS" if it has vps_id, "in Wizard" if it has
 * wizard_auto/wizard_manual in features, etc. — independently of where the
 * row was first imported. The display follows the same evidence-based rule
 * so legacy rows with imported_from=null still show their actual sources.
 */
function deriveSources(game: GlobalGame): string[] {
  const merged: string[] = (() => {
    if (!game.merged_from_sources) return [];
    try {
      const parsed = JSON.parse(game.merged_from_sources);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch { return []; }
  })();
  const features: string[] = (() => {
    try {
      const parsed = JSON.parse(game.features || '[]');
      return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
    } catch { return []; }
  })();
  const evidence: string[] = [];
  if (game.vps_id) evidence.push('vps');
  if (game.opdb_id) evidence.push('opdb');
  if (game.igdb_id) evidence.push('igdb');
  // An RA-imported row carries `ra_id` whether or not `imported_from` was set
  // (an RA import onto an existing IGDB row ENRICHES it, §3), so the badge has
  // to read the external id, not the provenance string.
  if (game.ra_id) evidence.push('ra');
  if (features.includes('wizard_auto') || features.includes('wizard_manual')) evidence.push('wizard');
  return Array.from(new Set([
    ...(game.imported_from ? [game.imported_from] : []),
    ...merged,
    ...evidence,
  ]));
}

function buildQuery(params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, v]) => v);
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Merge dialog. The clicked row is the SOURCE; the admin picks a target from
 * a search-driven candidate list. The source is deleted on commit and its
 * content (download URLs, themes, designers, table authors, features,
 * description, images) is unioned onto the target via GlobalGameService.merge.
 *
 * UX guidance shown in the modal: pick the row WITH the external IDs as
 * target — the merge primitive only fills target gaps from source, so picking
 * the rich row as source loses iScored sync hooks (vps_id / opdb_id).
 */
function MergeModal({
  source,
  onClose,
  onComplete,
  restrictToIds,
}: {
  source: GlobalGame;
  onClose: () => void;
  onComplete: () => void;
  /** When set (dedup-audit "shared IPDB group" entry point), the candidate list is
   *  pre-scoped to exactly these row ids (fetched by id, not by name search) instead
   *  of the free-text search below — the group's rows may not share a name. */
  restrictToIds?: string[];
}) {
  const [search, setSearch] = useState(source.name);
  const [candidates, setCandidates] = useState<GlobalGame[]>([]);
  const [searching, setSearching] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<GlobalGame | null>(null);

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Pre-scoped mode: fetch the group's other rows by id — skips free-text search
  // entirely since rows in a shared-IPDB group may not share a name.
  useEffect(() => {
    if (!restrictToIds) return;
    const ids = restrictToIds.filter(id => id !== source.id);
    if (ids.length === 0) { setCandidates([]); return; }
    let cancelled = false;
    setSearching(true);
    (async () => {
      try {
        const results = await Promise.all(ids.map(id => api.get<GlobalGame>(`/admin/catalogue/games/${id}`)));
        if (!cancelled) setCandidates(results.filter((g): g is GlobalGame => !!g));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load group members');
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [restrictToIds, source.id]);

  // Debounced search against the same endpoint the catalogue list uses.
  // Skipped entirely in pre-scoped mode (see effect above).
  useEffect(() => {
    if (restrictToIds) return;
    const term = search.trim();
    if (!term) { setCandidates([]); return; }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.get<{ data: GlobalGame[] }>(
          '/admin/catalogue/games' + buildQuery({ search: term, limit: '25' })
        );
        // Hide the source itself from the candidate list.
        setCandidates((res.data || []).filter(g => g.id !== source.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [search, source.id, restrictToIds]);

  const runMerge = async () => {
    if (!confirmTarget) return;
    setMerging(true);
    setError(null);
    try {
      await api.post('/admin/catalogue/games/merge', {
        targetId: confirmTarget.id,
        sourceId: source.id,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed');
      setMerging(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <div>
            <h2 className="font-display text-xl font-bold text-primary">Merge into…</h2>
            <p className="text-sm text-muted mt-1">
              Source: <span className="text-primary">{source.name}</span>
              {source.manufacturer && <> ({source.manufacturer}{source.year ? `, ${source.year}` : ''})</>}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer p-1 -mr-1 -mt-1"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-muted bg-raised/40 border border-border rounded p-3">
            <p className="mb-1">
              <span className="text-neon-amber font-medium">Pick the row WITH external IDs (vps_id, opdb_id, ipdb_url) as the target.</span>
            </p>
            <p>
              The source is deleted; its data is unioned onto target. Platforms,
              themes, designers, table authors, download/tutorial/rules URLs all
              merge. Target keeps its name, manufacturer, year, and existing IDs.
            </p>
          </div>

          {restrictToIds ? (
            <div className="text-xs text-muted bg-surface-alt border border-border rounded p-2">
              Showing the other row(s) sharing this IPDB link. Pick the target to merge{' '}
              <span className="text-primary">{source.name}</span> into.
            </div>
          ) : (
            <div>
              <label className="text-xs text-muted block mb-1">Find target</label>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
                placeholder="Search by name…"
                className="w-full bg-surface-alt border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neon-cyan"
              />
            </div>
          )}

          {error && (
            <div className="text-sm p-2 rounded bg-red-900/30 text-red-300 border border-red-700">
              {error}
            </div>
          )}

          <div className="space-y-1">
            {searching && <p className="text-muted text-xs">Searching…</p>}
            {!searching && candidates.length === 0 && search.trim() && (
              <p className="text-muted text-xs">No other rows match.</p>
            )}
            {candidates.map(c => {
              const platforms: string[] = JSON.parse(c.platforms || '[]');
              const ids = [
                c.vps_id ? `vps:${c.vps_id.slice(0, 6)}…` : null,
                c.opdb_id ? `opdb:${c.opdb_id.slice(0, 6)}…` : null,
                c.igdb_id ? `igdb:${c.igdb_id}` : null,
              ].filter(Boolean);
              const candidateSources = deriveSources(c);
              return (
                <button
                  key={c.id}
                  onClick={() => setConfirmTarget(c)}
                  className="w-full text-left bg-surface-alt rounded border border-border p-3 hover:border-neon-cyan/40 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{c.name}</span>
                    {c.manufacturer && (
                      <span className="text-muted text-xs">
                        ({c.manufacturer}{c.year ? `, ${c.year}` : ''})
                      </span>
                    )}
                    <span className="text-xs px-1.5 py-0.5 rounded bg-surface text-muted ml-auto">
                      {candidateSources.length > 0 ? candidateSources.join(', ') : 'manual'}
                    </span>
                  </div>
                  <div className="text-xs text-muted mt-1 flex gap-3 flex-wrap">
                    {platforms.length > 0 && <span>platforms: {platforms.join(', ')}</span>}
                    {ids.length > 0 && (
                      <span className="text-neon-cyan">{ids.join(' · ')}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {confirmTarget && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
            onClick={e => { if (e.target === e.currentTarget && !merging) setConfirmTarget(null); }}
          >
            <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-md p-5">
              <h3 className="font-display text-lg font-bold mb-2">Confirm merge</h3>
              <p className="text-sm text-muted mb-4">
                Merge <span className="text-primary font-medium">{source.name}</span>
                {' '}into <span className="text-primary font-medium">{confirmTarget.name}</span>?
              </p>
              <p className="text-xs text-muted mb-4">
                Source row will be deleted. Scores, library links, ratings,
                comments, and tags move to target. Target's external IDs are
                preserved; gaps fill from source.
              </p>
              <div className="flex justify-end gap-2">
                <NeonButton variant="ghost" onClick={() => setConfirmTarget(null)} disabled={merging}>
                  Cancel
                </NeonButton>
                <NeonButton variant="danger" onClick={runMerge} disabled={merging}>
                  {merging ? 'Merging…' : 'Merge'}
                </NeonButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
