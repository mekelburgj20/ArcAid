import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import { Search, RefreshCw, ChevronDown, ChevronUp, Check, X, Trash2, ExternalLink, GitMerge } from 'lucide-react';

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
}

interface SyncLog {
  id: string;
  source: string;
  status: string;
  records_imported: number;
  records_updated: number;
  records_skipped: number;
  errors: string | null;
  started_at: string;
  completed_at: string | null;
}

interface CatalogueCounts {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
}

const SOURCE_LABELS: Record<string, string> = {
  vps: 'VPS',
  opdb: 'OPDB',
  igdb: 'IGDB',
  wizard: 'Wizard',
  'steam-pinball': 'Steam Pinball',
  'fx-vr': 'FX VR',
  'atgames': 'AtGames',
};

const STATUS_COLORS: Record<string, string> = {
  success: 'text-neon-green',
  error: 'text-red-400',
  partial: 'text-yellow-400',
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
          const latest = logs.find(l => l.source === source);
          if (latest && latest.completed_at) {
            const imported = latest.records_imported || 0;
            const updated = latest.records_updated || 0;
            const skipped = latest.records_skipped || 0;
            if (latest.status === 'error') {
              setSyncResult({
                source,
                message: `${SOURCE_LABELS[source]} sync failed. Check logs for details.`,
              });
            } else {
              setSyncResult({
                source,
                message: `${SOURCE_LABELS[source]}: ${imported} imported, ${updated} updated` +
                  (skipped ? `, ${skipped} skipped` : '') +
                  (latest.status === 'partial' ? ' (partial — some errors)' : ''),
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
        message: `${SOURCE_LABELS[source]} sync is still running after 15 minutes. Check the sync health dashboard.`,
      });
      await loadData();
    } catch (err) {
      setSyncResult({ source, message: `${SOURCE_LABELS[source]} sync failed to start: ${err}` });
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
    setMergeSource(game);
  };

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
          {['vps', 'wizard', 'opdb', 'igdb', 'steam-pinball', 'fx-vr', 'atgames'].map(source => (
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
            {syncStatus.map(log => (
              <div key={log.id} className="bg-surface-alt rounded p-3 text-sm">
                <div className="font-bold text-xs uppercase tracking-wider text-muted mb-1">
                  {SOURCE_LABELS[log.source] || log.source}
                </div>
                <div className={STATUS_COLORS[log.status] || 'text-muted'}>
                  {log.status}
                </div>
                <div className="text-muted text-xs mt-1">
                  {log.records_imported} new, {log.records_updated} updated
                </div>
                <div className="text-muted text-xs">
                  {formatDate(log.completed_at || log.started_at)}
                </div>
              </div>
            ))}
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
            className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-white"
            style={{ colorScheme: 'dark' }}
          >
            <option value="" className="bg-surface-alt text-white">All Types</option>
            <option value="pinball" className="bg-surface-alt text-white">Pinball</option>
            <option value="arcade" className="bg-surface-alt text-white">Arcade</option>
            <option value="video_game" className="bg-surface-alt text-white">Video Game</option>
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-white"
            style={{ colorScheme: 'dark' }}
          >
            <option value="" className="bg-surface-alt text-white">All Status</option>
            <option value="approved" className="bg-surface-alt text-white">Approved</option>
            <option value="pending_review" className="bg-surface-alt text-white">Pending Review</option>
            <option value="rejected" className="bg-surface-alt text-white">Rejected</option>
          </select>
          <select
            value={filterSource}
            onChange={e => setFilterSource(e.target.value)}
            className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-white"
            style={{ colorScheme: 'dark' }}
          >
            <option value="" className="bg-surface-alt text-white">All Sources</option>
            <option value="vps" className="bg-surface-alt text-white">VPS</option>
            <option value="opdb" className="bg-surface-alt text-white">OPDB</option>
            <option value="igdb" className="bg-surface-alt text-white">IGDB</option>
            <option value="wizard" className="bg-surface-alt text-white">Wizard</option>
            <option value="manual" className="bg-surface-alt text-white">Manual</option>
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
          onClose={() => setMergeSource(null)}
          onComplete={async () => {
            setMergeSource(null);
            await loadData();
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
          </div>

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
}: {
  source: GlobalGame;
  onClose: () => void;
  onComplete: () => void;
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

  // Debounced search against the same endpoint the catalogue list uses.
  useEffect(() => {
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
  }, [search, source.id]);

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
