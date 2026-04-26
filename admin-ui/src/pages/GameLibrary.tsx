import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import { api } from '../lib/api';
import { useOptionalRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import StarRating from '../components/StarRating';
import StylePicker from '../components/StylePicker';
import { getPlatformDisplay, normalizePlatformList } from '../lib/platforms';

interface GameRow {
  id?: string;
  name: string;
  display_name: string;
  manufacturer?: string | null;
  year?: number | null;
  mode: string;
  platforms: string;
  /** Per-room custom tags (room_game_tags). Variant-keyed via id. */
  room_tags?: string[];
  /** VPS catalogue metadata — searchable from the search bar. */
  designers?: string[];
  themes?: string[];
  table_authors?: string[];
  catalogue_aliases?: string[];
  catalogue_style_id?: string | null;
  style_header_disabled?: number;
}

const emptyAddForm = { name: '', mode: 'pinball', platforms: '' };
const ROWS_PER_PAGE = 100;

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

function parsePlatforms(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

function PlatformChips({ platforms: raw, roomTags }: { platforms: string; roomTags?: string[] }) {
  // Catalogue platforms render in cyan; per-room tags (custom platforms,
  // ADR 0008) render in amber so they're visually distinct from the global
  // catalogue's truth.
  const list = normalizePlatformList(parsePlatforms(raw));
  const tags = (roomTags ?? []).filter(t => t && t.length > 0);
  if (list.length === 0 && tags.length === 0) return <span className="text-faint text-sm">None</span>;
  return (
    <div className="flex gap-1 flex-wrap">
      {list.map(p => (
        <span key={`p-${p}`} className="text-xs px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30">{getPlatformDisplay(p)}</span>
      ))}
      {tags.map(t => (
        <span key={`t-${t}`} className="text-xs px-1.5 py-0.5 rounded bg-neon-amber/10 text-neon-amber border border-neon-amber/40" title="Room-only tag">{getPlatformDisplay(t)}</span>
      ))}
    </div>
  );
}

interface TournamentOption {
  id: string;
  name: string;
}

type SortKey = 'name' | 'mode' | 'platforms' | 'rating';
type SortDir = 'asc' | 'desc';

/**
 * Per-row tag editor. Renders existing tags as removable chips and lets the
 * admin add new tags via free-text input or by clicking a recently-used tag
 * from the room. Tags are normalized server-side; the displayed list is the
 * server's canonical response.
 */
function TagDialog({ game, existingTags, onAdd, onRemove, onClose }: {
  game: GameRow;
  existingTags: string[];
  onAdd: (tag: string) => Promise<void>;
  onRemove: (tag: string) => Promise<void>;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const tags = game.room_tags ?? [];
  const suggestions = existingTags.filter(t => !tags.includes(t)).slice(0, 8);

  const submit = async () => {
    const t = input.trim();
    if (!t) return;
    await onAdd(t);
    setInput('');
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md">
        <h2 className="font-display text-lg font-bold mb-1">Tag {game.name}</h2>
        {(game.manufacturer || game.year) && (
          <p className="text-xs text-faint mb-4">{[game.manufacturer, game.year].filter(Boolean).join(', ')}</p>
        )}
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 mb-3">
            {tags.map(t => (
              <span key={t} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-neon-amber/10 text-neon-amber border border-neon-amber/40">
                {getPlatformDisplay(t)}
                <button
                  onClick={() => onRemove(t)}
                  className="hover:text-primary -mr-0.5"
                  aria-label={`Remove tag ${t}`}
                >×</button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-faint mb-3">No tags yet.</p>
        )}
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder="e.g. WMS"
            maxLength={50}
            className="flex-1 px-3 py-1.5 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
            autoFocus
          />
          <NeonButton onClick={submit} disabled={!input.trim()}>Add</NeonButton>
        </div>
        {suggestions.length > 0 && (
          <div className="mb-3">
            <p className="text-xs text-faint mb-1">Existing tags in this room:</p>
            <div className="flex flex-wrap gap-1">
              {suggestions.map(t => (
                <button
                  key={t}
                  onClick={() => setInput(t)}
                  className="text-xs px-2 py-0.5 rounded border border-border text-muted hover:text-primary hover:border-border/80 transition-colors"
                >
                  {getPlatformDisplay(t)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end">
          <NeonButton variant="ghost" onClick={onClose}>Done</NeonButton>
        </div>
      </div>
    </div>
  );
}

/**
 * Bulk-tag dialog. Single tag string applied to all selected games on commit;
 * the server endpoint INSERT-OR-IGNOREs so re-applying an existing tag is a
 * no-op (counted in the response but harmless).
 */
function BulkTagDialog({ count, existingTags, onApply, onClose }: {
  count: number;
  existingTags: string[];
  onApply: (tag: string) => Promise<void>;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [applying, setApplying] = useState(false);

  const submit = async () => {
    if (!input.trim() || applying) return;
    setApplying(true);
    try {
      await onApply(input.trim());
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md">
        <h2 className="font-display text-lg font-bold mb-2">Bulk Tag</h2>
        <p className="text-muted text-sm mb-4">
          Apply a tag to <span className="text-primary font-medium">{count}</span> selected
          game{count !== 1 ? 's' : ''}. Tags appear alongside catalogue platforms and can be used
          in tournament platform rules (e.g. "Must be available on WMS").
        </p>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder="e.g. WMS"
            maxLength={50}
            className="flex-1 px-3 py-1.5 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
            autoFocus
            disabled={applying}
          />
        </div>
        {existingTags.length > 0 && (
          <div className="mb-3">
            <p className="text-xs text-faint mb-1">Existing tags in this room:</p>
            <div className="flex flex-wrap gap-1">
              {existingTags.map(t => (
                <button
                  key={t}
                  onClick={() => setInput(t)}
                  disabled={applying}
                  className="text-xs px-2 py-0.5 rounded border border-border text-muted hover:text-primary hover:border-border/80 transition-colors"
                >
                  {getPlatformDisplay(t)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <NeonButton variant="ghost" onClick={onClose} disabled={applying}>Cancel</NeonButton>
          <NeonButton onClick={submit} disabled={!input.trim() || applying}>
            {applying ? 'Applying…' : `Tag ${count}`}
          </NeonButton>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders [Prev] [1] [2] [3] ... [N] [Next]. Truncates the middle of the
 * page list with an ellipsis when the total is large; always shows page 1,
 * the last page, the current page, and the two neighbors of current.
 */
function Pagination({ page, totalPages, onPageChange, total, pageStart, pageEnd }: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  total: number;
  pageStart: number;
  pageEnd: number;
}) {
  if (totalPages <= 1) {
    return <p className="text-faint text-xs mt-3">{total} game{total !== 1 ? 's' : ''}</p>;
  }

  const pageNums: Array<number | 'ellipsis'> = [];
  const window = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  for (let i = 1; i <= totalPages; i++) {
    if (window.has(i)) pageNums.push(i);
  }
  // Insert ellipsis where there's a gap.
  const withGaps: Array<number | 'ellipsis'> = [];
  for (let i = 0; i < pageNums.length; i++) {
    withGaps.push(pageNums[i]);
    const next = pageNums[i + 1];
    if (typeof next === 'number' && typeof pageNums[i] === 'number' && next - (pageNums[i] as number) > 1) {
      withGaps.push('ellipsis');
    }
  }

  const btnClass = (active: boolean, disabled: boolean) =>
    `text-xs px-2.5 py-1 rounded border transition-colors ${
      disabled ? 'border-border/40 text-faint cursor-not-allowed'
      : active ? 'bg-neon-cyan/15 border-neon-cyan text-neon-cyan'
      : 'border-border text-muted hover:text-primary hover:border-border/80'
    }`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
      <p className="text-faint text-xs">
        Showing {pageStart + 1}–{pageEnd} of {total}
      </p>
      <div className="flex items-center gap-1">
        <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className={btnClass(false, page <= 1)}>
          Prev
        </button>
        {withGaps.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`e${i}`} className="px-1.5 text-faint text-xs">…</span>
          ) : (
            <button key={p} onClick={() => onPageChange(p)} className={btnClass(p === page, false)}>
              {p}
            </button>
          )
        )}
        <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} className={btnClass(false, page >= totalPages)}>
          Next
        </button>
      </div>
    </div>
  );
}

function SortHeader({ label, sortKey, currentKey, currentDir, onSort }: {
  label: string; sortKey: SortKey; currentKey: SortKey; currentDir: SortDir; onSort: (k: SortKey) => void;
}) {
  const active = currentKey === sortKey;
  return (
    <button
      onClick={() => onSort(sortKey)}
      className="flex items-center gap-1 text-xs font-display font-bold uppercase tracking-wider text-muted hover:text-primary transition-colors cursor-pointer"
    >
      {label}
      <span className={`text-[10px] ${active ? 'text-neon-cyan' : 'text-faint'}`}>
        {active ? (currentDir === 'asc' ? '▲' : '▼') : '▲▼'}
      </span>
    </button>
  );
}

export default function GameLibrary() {
  const room = useOptionalRoom();
  const prefix = room ? `/rooms/${room.roomId}` : '';
  const { toast } = useToast();
  const [games, setGames] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newGame, setNewGame] = useState<{ name: string; mode: string; platforms: string }>({ ...emptyAddForm });
  const [search, setSearch] = useState('');
  const [showPinball, setShowPinball] = useState(true);
  const [showVideoGame, setShowVideoGame] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<Set<string>>(new Set());
  const [communityRatings, setCommunityRatings] = useState<Record<string, { avg_rating: number; rating_count: number }>>({});
  const [userRatings, setUserRatings] = useState<Record<string, number>>({});
  const [activateTarget, setActivateTarget] = useState<string | null>(null);
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [activatingFor, setActivatingFor] = useState<string | null>(null);

  // v2.4.0 — Pin to scoreboard
  const [pinTarget, setPinTarget] = useState<string | null>(null);
  const [pinOnIScored, setPinOnIScored] = useState(true);
  const [pinSubmitting, setPinSubmitting] = useState(false);

  // Style picker
  const [styleTarget, setStyleTarget] = useState<GameRow | null>(null);

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Pagination
  const [page, setPage] = useState(1);

  // Inline platform add
  const [showAddPlatform, setShowAddPlatform] = useState(false);
  const [newPlatformName, setNewPlatformName] = useState('');

  // Bulk select state — `selectedIds` keys on `global_game_id`.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Tag UX. `tagTarget` drives the per-row Tag dialog; `bulkTagOpen` drives
  // the bulk-tag dialog when selectedIds.size > 0.
  const [tagTarget, setTagTarget] = useState<GameRow | null>(null);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkActivateOpen, setBulkActivateOpen] = useState(false);
  const [bulkPinOpen, setBulkPinOpen] = useState(false);

  // proposalCheck holds the response from POST /game_library/proposals so the
  // UI can render an inline "is this in the catalogue?" preview before submit.
  // After step 2 the only commit path is submit_to_global — exact/possible
  // matches just inform the user without presenting a "link existing" action.
  type GlobalGameLite = { id: string; name: string; manufacturer?: string | null; year?: number | null; type: string; platforms?: string };
  const [proposalCheck, setProposalCheck] = useState<{
    input: { name: string; type: 'pinball' | 'video_game'; platforms: string[] };
    exact: GlobalGameLite | null;
    possible: GlobalGameLite[];
  } | null>(null);
  const [proposalCommitting, setProposalCommitting] = useState(false);

  // CSV preview/commit flow. Post step 2: only submit_to_global decisions
  // matter; auto_link rows (already in catalogue) are skipped on commit.
  type PreviewBucket = 'auto_link' | 'auto_submit' | 'needs_review';
  type PreviewRow = {
    index: number;
    input: { name: string; manufacturer?: string | null; year?: number | null; type: 'pinball' | 'video_game'; platforms?: string[] };
    candidates: { exact: GlobalGameLite | null; possible: GlobalGameLite[] };
    bucket: PreviewBucket;
    suggestedDecision: 'submit_to_global' | null;
  };
  const [csvPreview, setCsvPreview] = useState<{ rows: PreviewRow[]; summary: Record<PreviewBucket, number> & { total: number } } | null>(null);
  // Per-row decisions for needs_review entries; auto_submit uses suggestedDecision.
  const [csvDecisions, setCsvDecisions] = useState<Record<number, { decision: 'submit_to_global' }>>({});
  const [csvCommitting, setCsvCommitting] = useState(false);

  const addPlatform = async () => {
    const name = newPlatformName.trim().toUpperCase();
    if (!name || !room) return;
    try {
      // Fetch current platforms, add new one, save back
      const settings = await api.get<Record<string, string>>(`/rooms/${room.roomId}/settings`);
      const existing: string[] = (() => { try { return JSON.parse(settings.PLATFORMS || '[]'); } catch { return []; } })();
      if (existing.includes(name)) {
        toast(`Platform "${name}" already exists`, 'error');
        return;
      }
      const updated = [...existing, name].sort();
      await api.post(`/rooms/${room.roomId}/settings`, { PLATFORMS: JSON.stringify(updated) });
      toast(`Platform "${name}" added`);
      setNewPlatformName('');
      setShowAddPlatform(false);
    } catch {
      toast('Failed to add platform', 'error');
    }
  };

  // Autocomplete for add-game name field
  const [suggestions, setSuggestions] = useState<Array<{ name: string; mode: string; platforms: string }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInputRef = useRef<HTMLDivElement>(null);

  const searchLibrary = useCallback(async (query: string) => {
    if (query.length < 2) { setSuggestions([]); setShowSuggestions(false); return; }
    try {
      const results = await api.get<Array<{ name: string; mode: string; platforms: string }>>(`${prefix}/game_library/search?q=${encodeURIComponent(query)}`);
      setSuggestions(results);
      setShowSuggestions(results.length > 0);
    } catch {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, [prefix]);

  const handleNameChange = (value: string) => {
    setNewGame(prev => ({ ...prev, name: value }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchLibrary(value), 300);
  };

  const selectSuggestion = (s: { name: string; mode: string; platforms: string }) => {
    const plats = parsePlatforms(s.platforms).join(', ');
    const mode = s.mode === 'video_game' ? 'videogame' : (s.mode || 'pinball');
    setNewGame(prev => ({ ...prev, name: s.name, mode, platforms: plats }));
    setShowSuggestions(false);
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (nameInputRef.current && !nameInputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchGames = async () => {
    try {
      setGames(await api.get<GameRow[]>(`${prefix}/game_library`));
    } catch {
      toast('Failed to load game library', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchRatings = async () => {
    try {
      const data = await api.get<{ ratings: Record<string, { avg_rating: number; rating_count: number }>; userRatings: Record<string, number> }>(`${prefix}/ratings`);
      setCommunityRatings(data.ratings);
      setUserRatings(data.userRatings);
    } catch {}
  };

  const handleRate = async (gameName: string, rating: number) => {
    try {
      const info = await api.post<{ avg_rating: number; rating_count: number; user_rating: number | null }>(`${prefix}/ratings/${encodeURIComponent(gameName)}`, { rating });
      setCommunityRatings(prev => ({ ...prev, [gameName]: { avg_rating: info.avg_rating, rating_count: info.rating_count } }));
      setUserRatings(prev => ({ ...prev, [gameName]: rating }));
    } catch {
      toast('Failed to save rating', 'error');
    }
  };

  const fetchTournaments = async () => {
    try {
      const rows = await api.get<TournamentOption[]>(`${prefix}/tournaments`);
      setTournaments(rows.filter((t: any) => t.is_active));
    } catch {}
  };

  useEffect(() => { fetchGames(); fetchTournaments(); fetchRatings(); }, []);

  const handleActivate = async (tournamentId: string) => {
    if (!activateTarget) return;
    setActivatingFor(tournamentId);
    try {
      await api.post(`${prefix}/tournaments/${tournamentId}/activate-game`, { gameName: activateTarget });
      toast(`${activateTarget} activated!`, 'success');
      setActivateTarget(null);
    } catch (err: any) {
      toast(err.message || 'Failed to activate game', 'error');
    } finally {
      setActivatingFor(null);
    }
  };

  const handlePin = async () => {
    if (!pinTarget || !room) return;
    setPinSubmitting(true);
    try {
      const result = await api.post<{ iscoredStatus: 'created' | 'failed' | 'skipped' }>(
        `/rooms/${room.roomId}/games/pin`,
        { gameName: pinTarget, createOnIScored: pinOnIScored },
      );
      if (result.iscoredStatus === 'failed') {
        toast(`${pinTarget} pinned locally (iScored mirror failed — retry from Game States)`, 'success');
      } else if (result.iscoredStatus === 'skipped' && pinOnIScored) {
        toast(`${pinTarget} pinned (iScored skipped — check room credentials)`, 'success');
      } else {
        toast(`${pinTarget} pinned to scoreboard`, 'success');
      }
      setPinTarget(null);
      setPinOnIScored(true);
    } catch (err: any) {
      toast(err.message || 'Failed to pin game', 'error');
    } finally {
      setPinSubmitting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          // v2.5.0: shape rows to match GameProposalSchema (name + optional
          // mfg/year/type/platforms). Legacy CSVs may still have a
          // `tournament_types` column where modern ones use `platforms`.
          const games = (results.data as Record<string, string>[]).map(row => {
            const platformsRaw = row.platforms || (row as any).tournament_types || '';
            const platforms = platformsRaw ? parsePlatforms(platformsRaw) : [];
            const yearStr = row.year || '';
            const yearNum = yearStr.trim() ? parseInt(yearStr, 10) : undefined;
            return {
              name: (row.name || '').trim(),
              type: row.mode === 'videogame' ? 'video_game' as const : 'pinball' as const,
              manufacturer: row.manufacturer?.trim() || undefined,
              year: Number.isFinite(yearNum) ? yearNum : undefined,
              platforms: platforms.length ? platforms : undefined,
            };
          }).filter(g => g.name);
          if (games.length === 0) {
            toast('CSV had no usable rows', 'error');
            return;
          }
          // Run dedup preview server-side. The FE keeps the response and the
          // user's per-row decisions in memory; commit replays them as a JSON array.
          const preview = await api.post<{ rows: PreviewRow[]; summary: Record<PreviewBucket, number> & { total: number } }>(
            `${prefix}/game_library/import-csv-preview`, { games },
          );
          // Pre-seed decisions for auto-submit rows. auto_link rows are
          // already in the catalogue (which IS the library) — nothing to commit.
          const seeded: Record<number, { decision: 'submit_to_global' }> = {};
          for (const r of preview.rows) {
            if (r.bucket === 'auto_submit') {
              seeded[r.index] = { decision: 'submit_to_global' };
            }
          }
          setCsvPreview(preview);
          setCsvDecisions(seeded);
          toast(`Preview ready: ${preview.summary.total} rows`, 'success');
        } catch (err: any) {
          toast(err.message || 'Preview failed', 'error');
        } finally {
          setImporting(false);
          e.target.value = '';
        }
      }
    });
  };

  // Commit the previewed CSV. Only auto_submit + needs_review rows the user
  // marked submit_to_global are sent; auto_link rows are already in the
  // catalogue and there's nothing to add.
  const commitCsvPreview = async () => {
    if (!csvPreview) return;
    const ready = csvPreview.rows
      .map(r => {
        const d = csvDecisions[r.index];
        if (!d) return null;
        return { input: r.input, decision: d.decision };
      })
      .filter(Boolean) as Array<{ input: PreviewRow['input']; decision: 'submit_to_global' }>;
    if (ready.length === 0) {
      toast('Nothing to submit — auto-link rows are already in the catalogue', 'error');
      return;
    }
    setCsvCommitting(true);
    try {
      const result = await api.post<{ ok: boolean; counts: { submitted_pending: number; errors: number }; errors?: Array<{ index: number; error: string }> }>(
        `${prefix}/game_library/import-csv-commit`, { games: ready },
      );
      const { counts } = result;
      const summary = `${counts.submitted_pending} pending` + (counts.errors ? ` · ${counts.errors} failed` : '');
      toast(summary, counts.errors ? 'error' : 'success');
      setCsvPreview(null);
      setCsvDecisions({});
      fetchGames();
    } catch (err: any) {
      toast(err.message || 'Commit failed', 'error');
    } finally {
      setCsvCommitting(false);
    }
  };

  const downloadTemplate = () => {
    const headers = ['name','manufacturer','year','mode','platforms'];
    const csv = headers.join(',') + '\n"Medieval Madness","Williams","1997","pinball","vpx,fp"';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'arcaid_games_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Add Game runs the proposals dedup preview before submit. After step 2
  // there's only one commit path (submit_to_global); exact/possible matches
  // are informational so the user can cancel rather than create a duplicate.
  const handleAddGame = async () => {
    if (!newGame.name.trim()) { toast('Game name required', 'error'); return; }
    if (!room) { toast('Room context required', 'error'); return; }
    setSaving(true);
    try {
      const type = newGame.mode === 'videogame' ? 'video_game' : 'pinball';
      const platforms = parsePlatforms(newGame.platforms);
      const result = await api.post<{ exact: GlobalGameLite | null; possible: GlobalGameLite[] }>(
        `${prefix}/game_library/proposals`,
        { name: newGame.name.trim(), type, platforms },
      );
      setProposalCheck({ input: { name: newGame.name.trim(), type, platforms }, ...result });
    } catch (err: any) {
      toast(err.message || 'Could not check the catalogue', 'error');
    } finally {
      setSaving(false);
    }
  };

  const commitProposal = async () => {
    if (!proposalCheck || !room) return;
    setProposalCommitting(true);
    try {
      await api.post(`${prefix}/game_library/submit_to_global`, {
        name: proposalCheck.input.name,
        type: proposalCheck.input.type,
        platforms: proposalCheck.input.platforms,
      });
      toast('Submitted to global catalogue for review', 'success');
      setProposalCheck(null);
      setNewGame({ ...emptyAddForm });
      setShowAddForm(false);
      fetchGames();
    } catch (err: any) {
      toast(err.message || 'Failed to submit game', 'error');
    } finally {
      setProposalCommitting(false);
    }
  };

  // v2.5.1: alias-fold + dedupe before building the filter pill row, so
  // legacy mixed-case data (`VPX` / `vpx`) and aliases (`FX3` /
  // `pinball_fx_classic`) collapse to one chip per real platform.
  // v2.6.x: room-tag chips (per-game custom platforms, ADR 0008) join the
  // pill row so admins can filter by them too.
  const allPlatforms = useMemo(() => {
    const fromCatalogue = games.flatMap(g => parsePlatforms(g.platforms));
    const fromTags = games.flatMap(g => g.room_tags ?? []);
    return normalizePlatformList([...fromCatalogue, ...fromTags]).sort();
  }, [games]);


  const togglePlatform = (p: string) => {
    setPlatformFilter(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  // Search parser: extract a `YYYY-YYYY` year-range token (with optional
  // whitespace around the hyphen) and treat the rest as a plain substring
  // query. Both clauses AND together. Strict pattern (4-digit years in
  // [1900, 2100]) so we don't accidentally consume a hyphen inside a real
  // game title.
  const parsedSearch = useMemo(() => {
    const raw = search.trim();
    if (!raw) return { minYear: null as number | null, maxYear: null as number | null, text: '' };
    const m = raw.match(/(?:^|\s)(\d{4})\s*-\s*(\d{4})(?=\s|$)/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a >= 1900 && a <= 2100 && b >= 1900 && b <= 2100) {
        const remainder = (raw.slice(0, m.index ?? 0) + raw.slice((m.index ?? 0) + m[0].length)).trim();
        return { minYear: Math.min(a, b), maxYear: Math.max(a, b), text: remainder };
      }
    }
    return { minYear: null, maxYear: null, text: raw };
  }, [search]);

  const filteredGames = games.filter(g => {
    if (!showPinball && (g.mode || 'pinball') === 'pinball') return false;
    if (!showVideoGame && g.mode === 'videogame') return false;
    if (platformFilter.size > 0) {
      // Normalize the game's platforms before comparing — handles mixed-case
      // pre-089 data without forcing the filter to match all variants. Room
      // tags participate in the same filter dimension (ADR 0008).
      const gPlats = normalizePlatformList([
        ...parsePlatforms(g.platforms),
        ...(g.room_tags ?? []),
      ]);
      if (!gPlats.some(p => platformFilter.has(p))) return false;
    }
    if (parsedSearch.minYear !== null && parsedSearch.maxYear !== null) {
      if (g.year == null || g.year < parsedSearch.minYear || g.year > parsedSearch.maxYear) return false;
    }
    if (parsedSearch.text) {
      const q = parsedSearch.text.toLowerCase();
      // Plain substring search across every metadata field a user might
      // reasonably know. Multi-word queries naturally disambiguate
      // ("Williams Electronics" vs designer "Steve Williams").
      const hay = [
        g.name,
        g.manufacturer || '',
        String(g.year || ''),
        g.platforms || '',
        ...(g.room_tags ?? []),
        ...(g.designers ?? []),
        ...(g.themes ?? []),
        ...(g.table_authors ?? []),
        ...(g.catalogue_aliases ?? []),
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sorted games. localeCompare uses { sensitivity: 'base' } so the FE order
  // matches the server's `COLLATE NOCASE` (case-insensitive). Variants of a
  // shared name fall back to (year, manufacturer) so e.g. all "Carnival"
  // entries render adjacent and oldest-first.
  const sortedGames = useMemo(() => {
    const sorted = [...filteredGames];
    const cmpStr = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = cmpStr(a.name, b.name);
          if (cmp === 0) cmp = (a.year ?? 9999) - (b.year ?? 9999);
          if (cmp === 0) cmp = cmpStr(a.manufacturer || '', b.manufacturer || '');
          break;
        case 'mode':
          cmp = cmpStr(a.mode || 'pinball', b.mode || 'pinball');
          if (cmp === 0) cmp = cmpStr(a.name, b.name);
          break;
        case 'platforms':
          cmp = cmpStr(a.platforms || '', b.platforms || '');
          if (cmp === 0) cmp = cmpStr(a.name, b.name);
          break;
        case 'rating': {
          const ra = communityRatings[a.name]?.avg_rating ?? 0;
          const rb = communityRatings[b.name]?.avg_rating ?? 0;
          cmp = ra - rb;
          if (cmp === 0) cmp = cmpStr(a.name, b.name);
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filteredGames, sortKey, sortDir, communityRatings]);

  // Reset to page 1 whenever the filtered/sorted set changes shape.
  useEffect(() => {
    setPage(1);
  }, [search, showPinball, showVideoGame, platformFilter, sortKey, sortDir]);

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePageSelectAll = (rows: GameRow[]) => {
    setSelectedIds(prev => {
      const allOnPageSelected = rows.every(r => r.id && prev.has(r.id));
      const next = new Set(prev);
      for (const r of rows) {
        if (!r.id) continue;
        if (allOnPageSelected) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const totalPages = Math.max(1, Math.ceil(sortedGames.length / ROWS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * ROWS_PER_PAGE;
  const pageRows = sortedGames.slice(pageStart, pageStart + ROWS_PER_PAGE);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // Bulk-tag handler — single API call (server-side INSERT OR IGNORE per id).
  const handleBulkTag = async (tag: string) => {
    if (!room || selectedIds.size === 0 || !tag.trim()) return;
    try {
      const res = await api.post<{ added: number }>(`${prefix}/games/bulk-tag`, {
        globalGameIds: [...selectedIds], tag: tag.trim(),
      });
      toast(`Tagged ${res.added} game${res.added !== 1 ? 's' : ''}`, 'success');
      setBulkTagOpen(false);
      clearSelection();
      fetchGames();
    } catch (err: any) {
      toast(err.message || 'Failed to apply tag', 'error');
    }
  };

  // Per-row tag add/remove. Reuses single-game endpoints; updates state from
  // the server response so the chip list mirrors persistence.
  const handleAddTagToGame = async (g: GameRow, tag: string) => {
    if (!room || !g.id || !tag.trim()) return;
    try {
      const res = await api.post<{ tags: string[] }>(`${prefix}/games/${g.id}/tags`, { tag: tag.trim() });
      setGames(prev => prev.map(x => x.id === g.id ? { ...x, room_tags: res.tags } : x));
      setTagTarget(prev => prev && prev.id === g.id ? { ...prev, room_tags: res.tags } : prev);
    } catch (err: any) {
      toast(err.message || 'Failed to add tag', 'error');
    }
  };

  const handleRemoveTagFromGame = async (g: GameRow, tag: string) => {
    if (!room || !g.id || !tag) return;
    try {
      const res = await api.delete<{ tags: string[] }>(`${prefix}/games/${g.id}/tags/${encodeURIComponent(tag)}`);
      setGames(prev => prev.map(x => x.id === g.id ? { ...x, room_tags: res.tags } : x));
      setTagTarget(prev => prev && prev.id === g.id ? { ...prev, room_tags: res.tags } : prev);
    } catch (err: any) {
      toast(err.message || 'Failed to remove tag', 'error');
    }
  };

  // Bulk activate: loop the existing single-game endpoint with light
  // concurrency (5 in flight) and a per-game best-effort summary.
  const handleBulkActivate = async (tournamentId: string) => {
    if (!room || selectedIds.size === 0) return;
    const idToName = new Map(games.filter(g => g.id).map(g => [g.id!, g.name]));
    const names = [...selectedIds].map(id => idToName.get(id)).filter((n): n is string => !!n);
    let ok = 0, fail = 0;
    const queue = [...names];
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift()!;
        try {
          await api.post(`${prefix}/tournaments/${tournamentId}/activate-game`, { gameName: name });
          ok++;
        } catch {
          fail++;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    toast(`Activated ${ok} game${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed` : ''}`, fail ? 'error' : 'success');
    setBulkActivateOpen(false);
    clearSelection();
  };

  // Bulk pin: same loop pattern. UNIQUE-pinned-per-room collisions surface as
  // failures in the summary rather than blocking the rest of the batch.
  const handleBulkPin = async (createOnIScored: boolean) => {
    if (!room || selectedIds.size === 0) return;
    const idToName = new Map(games.filter(g => g.id).map(g => [g.id!, g.name]));
    const names = [...selectedIds].map(id => idToName.get(id)).filter((n): n is string => !!n);
    let ok = 0, fail = 0;
    const queue = [...names];
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift()!;
        try {
          await api.post(`${prefix}/games/pin`, { gameName: name, createOnIScored });
          ok++;
        } catch {
          fail++;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    toast(`Pinned ${ok} game${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed (already pinned?)` : ''}`, fail ? 'error' : 'success');
    setBulkPinOpen(false);
    clearSelection();
  };

  if (loading) return <LoadingState message="Loading game library..." />;

  const selectClass = `${inputClass} cursor-pointer`;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="font-display text-2xl font-bold">Game Library</h1>
        <div className="flex flex-wrap gap-2 items-center">
          <NeonButton onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? 'Cancel' : 'Add Game'}
          </NeonButton>
          <label htmlFor="csv-upload" className="cursor-pointer">
            <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" id="csv-upload" disabled={importing} />
            <span className={`
              inline-flex items-center justify-center gap-2 px-4 py-2 rounded border text-sm font-medium
              transition-all duration-200 cursor-pointer
              bg-raised text-muted border-border hover:text-primary hover:border-border-glow
              ${importing ? 'opacity-40 cursor-not-allowed' : ''}
            `}>
              {importing ? 'Importing...' : 'Import CSV'}
            </span>
          </label>
          <div className="flex-1" />
          <NeonButton variant="ghost" onClick={downloadTemplate}>CSV Template</NeonButton>
        </div>
      </div>

      {showAddForm && (
        <NeonCard glowColor="cyan" className="mb-6 border-l-2 border-l-neon-cyan" title="Add New Game">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
            <div ref={nameInputRef} className="relative">
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Game Name *</label>
              <input
                type="text"
                value={newGame.name}
                onChange={e => handleNameChange(e.target.value)}
                onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                className={inputClass}
                autoComplete="off"
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute z-50 left-0 right-0 mt-1 bg-surface border border-default rounded shadow-lg max-h-48 overflow-y-auto">
                  {suggestions.map(s => (
                    <button
                      key={s.name}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-raised transition-colors flex items-center justify-between gap-2"
                      onClick={() => selectSuggestion(s)}
                    >
                      <span className="truncate">{s.name}</span>
                      <span className="text-xs text-faint flex-shrink-0">{parsePlatforms(s.platforms).join(', ') || s.mode}</span>
                    </button>
                  ))}
                </div>
              )}
              {!showSuggestions && newGame.name.length >= 2 && suggestions.length > 0 && (
                <p className="text-xs text-neon-amber mt-1">
                  Similar game found: {suggestions[0].name}{parsePlatforms(suggestions[0].platforms).length > 0 ? ` (${parsePlatforms(suggestions[0].platforms).join(', ')})` : ''}
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Mode</label>
              <select value={newGame.mode} onChange={e => setNewGame({...newGame, mode: e.target.value})} className={selectClass}>
                <option value="pinball">Pinball</option>
                <option value="videogame">Video Game</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Platforms</label>
              <input type="text" placeholder="e.g. vpx, fp" value={newGame.platforms} onChange={e => setNewGame({...newGame, platforms: e.target.value})} className={inputClass} />
            </div>
          </div>
          <NeonButton onClick={handleAddGame} disabled={saving}>
            {saving ? 'Checking…' : 'Check catalogue'}
          </NeonButton>
        </NeonCard>
      )}

      {/* Proposal result panel — rendered after Add Game ran a dedup check.
          The catalogue IS the library, so exact / possible matches are
          informational; the only commit path left is submit_to_global. */}
      {proposalCheck && (
        <NeonCard glowColor="cyan" className="mb-4 border-l-2 border-l-neon-cyan" title={
          proposalCheck.exact ? 'Already in the catalogue' :
          proposalCheck.possible.length > 0 ? 'Possible duplicates' :
          'New game — submit to catalogue?'
        }>
          {proposalCheck.exact ? (
            <>
              <p className="text-sm text-muted mb-3">
                <span className="text-primary font-medium">{proposalCheck.input.name}</span> is already in the catalogue:
              </p>
              <div className="bg-raised/50 px-3 py-2 rounded text-sm mb-3">
                <span className="text-primary font-medium">{proposalCheck.exact.name}</span>
                {(proposalCheck.exact.manufacturer || proposalCheck.exact.year) && (
                  <span className="text-faint ml-2">
                    ({[proposalCheck.exact.manufacturer, proposalCheck.exact.year].filter(Boolean).join(', ')})
                  </span>
                )}
              </div>
              <p className="text-xs text-faint mb-3">
                You can pin or activate it from the table below — no submission needed.
              </p>
              <NeonButton variant="ghost" onClick={() => setProposalCheck(null)} disabled={proposalCommitting}>
                Close
              </NeonButton>
            </>
          ) : proposalCheck.possible.length > 0 ? (
            <>
              <p className="text-sm text-muted mb-3">
                These existing entries have similar names — confirm none of them match before submitting{' '}
                <span className="text-primary font-medium">{proposalCheck.input.name}</span> as a new entry.
              </p>
              <div className="space-y-2 mb-3">
                {proposalCheck.possible.map(p => (
                  <div key={p.id} className="bg-raised/50 px-3 py-2 rounded text-sm">
                    <span className="text-primary font-medium">{p.name}</span>
                    {(p.manufacturer || p.year) && (
                      <span className="text-faint ml-2">
                        ({[p.manufacturer, p.year].filter(Boolean).join(', ')})
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2 flex-wrap pt-2 border-t border-border/30">
                <NeonButton variant="secondary" onClick={commitProposal} disabled={proposalCommitting}>
                  None of these — submit as new
                </NeonButton>
                <div className="flex-1" />
                <NeonButton variant="ghost" onClick={() => setProposalCheck(null)} disabled={proposalCommitting}>
                  Cancel
                </NeonButton>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted mb-3">
                No catalogue match for{' '}
                <span className="text-primary font-medium">{proposalCheck.input.name}</span>.
                Submit it for review — once approved by a super-admin, it'll be visible to all rooms.
              </p>
              <div className="flex gap-2 flex-wrap">
                <NeonButton onClick={commitProposal} disabled={proposalCommitting}>
                  Submit to global catalogue
                </NeonButton>
                <div className="flex-1" />
                <NeonButton variant="ghost" onClick={() => setProposalCheck(null)} disabled={proposalCommitting}>
                  Cancel
                </NeonButton>
              </div>
            </>
          )}
        </NeonCard>
      )}

      {/* v2.5.0: CSV preview panel — categorized rows + per-row decision UI. */}
      {csvPreview && (
        <NeonCard glowColor="cyan" className="mb-4 border-l-2 border-l-neon-cyan" title={`CSV Preview · ${csvPreview.summary.total} rows`}>
          <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
            <div className="bg-raised/50 px-3 py-2 rounded">
              <div className="text-faint text-xs uppercase tracking-wider">Auto-link</div>
              <div className="text-neon-green font-display text-lg">{csvPreview.summary.auto_link}</div>
            </div>
            <div className="bg-raised/50 px-3 py-2 rounded">
              <div className="text-faint text-xs uppercase tracking-wider">Auto-submit</div>
              <div className="text-neon-cyan font-display text-lg">{csvPreview.summary.auto_submit}</div>
            </div>
            <div className="bg-raised/50 px-3 py-2 rounded">
              <div className="text-faint text-xs uppercase tracking-wider">Needs review</div>
              <div className="text-neon-amber font-display text-lg">{csvPreview.summary.needs_review}</div>
            </div>
          </div>

          {csvPreview.summary.needs_review > 0 && (
            <div className="mb-4">
              <p className="text-xs text-muted mb-2">Pick a decision for each ambiguous row:</p>
              <div className="space-y-2">
                {csvPreview.rows.filter(r => r.bucket === 'needs_review').map(r => {
                  const decision = csvDecisions[r.index];
                  return (
                    <div key={r.index} className="bg-raised/50 px-3 py-2 rounded text-sm">
                      <div className="font-medium text-primary mb-2">{r.input.name}</div>
                      <div className="text-xs text-faint mb-2">Possible duplicates already in catalogue:</div>
                      <div className="space-y-1 mb-2">
                        {r.candidates.possible.map(p => (
                          <div key={p.id} className="px-2 py-1 rounded border border-border text-xs text-muted">
                            {p.name}
                            {(p.manufacturer || p.year) && <span className="text-faint ml-2">({[p.manufacturer, p.year].filter(Boolean).join(', ')})</span>}
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-1.5 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setCsvDecisions(prev => ({ ...prev, [r.index]: { decision: 'submit_to_global' } }))}
                          className={`text-xs px-2 py-1 rounded border transition-colors ${
                            decision?.decision === 'submit_to_global'
                              ? 'bg-neon-cyan/15 border-neon-cyan text-neon-cyan'
                              : 'border-border text-muted hover:text-primary hover:border-border/80'
                          }`}
                        >
                          Submit as new (pending)
                        </button>
                        <button
                          type="button"
                          onClick={() => setCsvDecisions(prev => { const n = { ...prev }; delete n[r.index]; return n; })}
                          className="text-xs px-2 py-1 rounded border border-border text-faint hover:text-muted transition-colors"
                        >
                          Skip
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <NeonButton onClick={commitCsvPreview} disabled={csvCommitting}>
              {csvCommitting ? 'Importing…' : `Import ${Object.keys(csvDecisions).length} rows`}
            </NeonButton>
            <NeonButton variant="ghost" onClick={() => { setCsvPreview(null); setCsvDecisions({}); }} disabled={csvCommitting}>
              Cancel
            </NeonButton>
          </div>
        </NeonCard>
      )}

      <NeonCard>
        <div className="flex flex-wrap items-end gap-3 sm:gap-4 mb-4">
          <div className="flex flex-col">
            <input
              type="text" placeholder="Search games..." value={search} onChange={e => setSearch(e.target.value)}
              className={`${inputClass} max-w-sm`}
              title="Substring match across name, manufacturer, year, designers, themes, table authors, aliases, platforms, and room tags. Use a year range like 2001-2020."
            />
            <p className="text-[11px] text-faint mt-1">
              Searches name, manufacturer, year, designers, themes, table authors, aliases, platforms, and room tags. Year range: <code className="px-1 py-px rounded bg-raised text-muted">2001-2020</code>.
            </p>
            {(parsedSearch.minYear !== null || parsedSearch.text !== search.trim()) && (
              <p className="text-[11px] text-neon-cyan mt-1">
                {parsedSearch.minYear !== null && (
                  <span>Year {parsedSearch.minYear}–{parsedSearch.maxYear}</span>
                )}
                {parsedSearch.minYear !== null && parsedSearch.text && <span className="text-faint"> · </span>}
                {parsedSearch.text && (
                  <span>matching "<span className="text-primary">{parsedSearch.text}</span>"</span>
                )}
              </p>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={showPinball} onChange={e => setShowPinball(e.target.checked)} className="accent-neon-amber" />
            Pinball
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={showVideoGame} onChange={e => setShowVideoGame(e.target.checked)} className="accent-neon-cyan" />
            Video Games
          </label>
        </div>
        {(allPlatforms.length > 0 || room) && (
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <span className="text-xs font-display uppercase tracking-wider text-muted">Platforms:</span>
            {allPlatforms.map(p => (
              <button
                key={p}
                onClick={() => togglePlatform(p)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                  platformFilter.has(p)
                    ? 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/60'
                    : 'bg-transparent text-muted border-border hover:border-neon-cyan/40 hover:text-primary'
                }`}
              >
                {getPlatformDisplay(p)}
              </button>
            ))}
            {platformFilter.size > 0 && (
              <button onClick={() => setPlatformFilter(new Set())} className="text-xs text-faint hover:text-primary underline">
                Clear
              </button>
            )}
            {room && !showAddPlatform && (
              <button
                onClick={() => setShowAddPlatform(true)}
                className="text-xs px-1.5 py-0.5 rounded border border-dashed border-border hover:border-neon-cyan/40 text-faint hover:text-neon-cyan transition-colors"
                title="Add platform"
              >
                +
              </button>
            )}
            {showAddPlatform && (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={newPlatformName}
                  onChange={e => setNewPlatformName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addPlatform(); if (e.key === 'Escape') { setShowAddPlatform(false); setNewPlatformName(''); } }}
                  placeholder="e.g. VPXS"
                  className="text-xs px-2 py-0.5 rounded border border-border bg-deep text-primary w-20 focus:border-neon-cyan/60 outline-none"
                  autoFocus
                />
                <button onClick={addPlatform} className="text-xs text-neon-cyan hover:text-neon-cyan/80">Add</button>
                <button onClick={() => { setShowAddPlatform(false); setNewPlatformName(''); }} className="text-xs text-faint hover:text-primary">Cancel</button>
              </div>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {room && (
                  <th className="px-3 py-3 text-left w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={pageRows.length > 0 && pageRows.every(r => r.id && selectedIds.has(r.id))}
                      onChange={() => togglePageSelectAll(pageRows)}
                      className="accent-neon-cyan cursor-pointer"
                    />
                  </th>
                )}
                <th className="px-4 py-3 text-left">
                  <SortHeader label="Game" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left">
                  <SortHeader label="Mode" sortKey="mode" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left">
                  <SortHeader label="Platforms" sortKey="platforms" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </th>
                {room && (
                  <th className="px-4 py-3 text-left">
                    <SortHeader label="Rating" sortKey="rating" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  </th>
                )}
                <th className="px-4 py-3 text-right text-xs font-display font-bold uppercase tracking-wider text-muted"></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={room ? 6 : 4} className="px-4 py-8 text-center text-muted">
                    No games in the catalogue.
                  </td>
                </tr>
              ) : (
                pageRows.map((g) => {
                  const isSelected = !!g.id && selectedIds.has(g.id);
                  return (
                    <tr key={g.id ?? `${g.name}|${g.manufacturer ?? ''}|${g.year ?? ''}`} className={`border-b border-border/50 transition-colors ${isSelected ? 'bg-neon-cyan/5' : 'hover:bg-raised/50'}`}>
                      {room && (
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => g.id && toggleSelected(g.id)}
                            disabled={!g.id}
                            className="accent-neon-cyan cursor-pointer"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <div className="font-medium">{g.name}</div>
                        {(g.manufacturer || g.year) && (
                          <div className="text-xs text-faint mt-0.5">
                            {[g.manufacturer, g.year].filter(Boolean).join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${(g.mode || 'pinball') === 'pinball' ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan'}`}>
                          {(g.mode || 'pinball') === 'pinball' ? 'Pinball' : 'Video Game'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <PlatformChips platforms={g.platforms} roomTags={g.room_tags} />
                      </td>
                      {room && (
                        <td className="px-4 py-3">
                          {(() => {
                            const cr = communityRatings[g.name];
                            const ur = userRatings[g.name] || 0;
                            return (
                              <div className="flex items-center gap-1.5">
                                <StarRating rating={ur} onRate={(r) => handleRate(g.name, r)} />
                                {cr && cr.rating_count > 0 && (
                                  <span className="text-xs text-muted">{cr.avg_rating} ({cr.rating_count})</span>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1 flex-wrap">
                          {room && <NeonButton variant="ghost" onClick={() => setActivateTarget(g.name)} className="text-xs px-2 py-1">Activate</NeonButton>}
                          {room && <NeonButton variant="ghost" onClick={() => { setPinTarget(g.name); setPinOnIScored(true); }} className="text-xs px-2 py-1">Pin</NeonButton>}
                          {room && <NeonButton variant="ghost" onClick={() => setTagTarget(g)} className="text-xs px-2 py-1">Tag</NeonButton>}
                          {room && (
                            <NeonButton
                              variant={g.catalogue_style_id ? 'secondary' : 'ghost'}
                              onClick={() => setStyleTarget(g)}
                              className="text-xs px-2 py-1"
                            >
                              Style
                            </NeonButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {sortedGames.length > 0 && (
          <Pagination
            page={currentPage}
            totalPages={totalPages}
            onPageChange={setPage}
            total={sortedGames.length}
            pageStart={pageStart}
            pageEnd={Math.min(pageStart + ROWS_PER_PAGE, sortedGames.length)}
          />
        )}
      </NeonCard>

      {/* Sticky bulk-action bar — appears whenever ≥1 row is selected. */}
      {room && selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-surface border border-neon-cyan/50 rounded-lg shadow-lg px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-primary">
            {selectedIds.size} selected
          </span>
          <span className="text-faint">·</span>
          <NeonButton variant="ghost" onClick={() => setBulkTagOpen(true)} className="text-xs px-2 py-1">Tag…</NeonButton>
          <NeonButton variant="ghost" onClick={() => setBulkActivateOpen(true)} className="text-xs px-2 py-1">Activate…</NeonButton>
          <NeonButton variant="ghost" onClick={() => setBulkPinOpen(true)} className="text-xs px-2 py-1">Pin</NeonButton>
          <button onClick={clearSelection} className="text-xs text-faint hover:text-primary underline ml-2">Clear</button>
        </div>
      )}

      {/* Per-row Tag editor — chips with × + add input. */}
      {tagTarget && (
        <TagDialog
          game={tagTarget}
          existingTags={[...new Set(games.flatMap(g => g.room_tags ?? []))].sort()}
          onAdd={(tag) => handleAddTagToGame(tagTarget, tag)}
          onRemove={(tag) => handleRemoveTagFromGame(tagTarget, tag)}
          onClose={() => setTagTarget(null)}
        />
      )}

      {/* Bulk-tag prompt — single tag applied to selectedIds. */}
      {bulkTagOpen && (
        <BulkTagDialog
          count={selectedIds.size}
          existingTags={[...new Set(games.flatMap(g => g.room_tags ?? []))].sort()}
          onApply={handleBulkTag}
          onClose={() => setBulkTagOpen(false)}
        />
      )}

      {/* Bulk activate — pick a tournament; sequential per-game activation. */}
      {bulkActivateOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-sm">
            <h2 className="font-display text-lg font-bold mb-2">Bulk Activate</h2>
            <p className="text-muted text-sm mb-4">
              Activate <span className="text-primary font-medium">{selectedIds.size}</span> selected
              game{selectedIds.size !== 1 ? 's' : ''} in which tournament? Games that fail
              tournament platform rules will be skipped.
            </p>
            <div className="space-y-2 mb-4">
              {tournaments.map(t => (
                <NeonButton
                  key={t.id}
                  variant="secondary"
                  className="w-full text-left"
                  onClick={() => handleBulkActivate(t.id)}
                >
                  {t.name}
                </NeonButton>
              ))}
              {tournaments.length === 0 && <p className="text-faint text-sm">No active tournaments.</p>}
            </div>
            <NeonButton variant="ghost" onClick={() => setBulkActivateOpen(false)}>Cancel</NeonButton>
          </div>
        </div>
      )}

      {/* Bulk pin — confirm + iScored toggle. */}
      {bulkPinOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-sm">
            <h2 className="font-display text-lg font-bold mb-2">Bulk Pin</h2>
            <p className="text-muted text-sm mb-4">
              Pin <span className="text-primary font-medium">{selectedIds.size}</span> game{selectedIds.size !== 1 ? 's' : ''} to the scoreboard.
              Games already pinned in this room will be skipped.
            </p>
            <label className="flex items-start gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={pinOnIScored}
                onChange={e => setPinOnIScored(e.target.checked)}
                className="mt-0.5 cursor-pointer accent-neon-cyan"
              />
              <span className="text-sm text-primary">
                Also create on iScored
                <span className="block text-xs text-faint">
                  Skipped automatically if iScored isn't configured.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <NeonButton variant="ghost" onClick={() => setBulkPinOpen(false)}>Cancel</NeonButton>
              <NeonButton onClick={() => handleBulkPin(pinOnIScored)}>Pin {selectedIds.size}</NeonButton>
            </div>
          </div>
        </div>
      )}

      {activateTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-sm">
            <h2 className="font-display text-lg font-bold mb-2">Activate Game</h2>
            <p className="text-muted text-sm mb-4">
              Activate <span className="text-primary font-medium">{activateTarget}</span> for which tournament?
            </p>
            <div className="space-y-2 mb-4">
              {tournaments.map(t => (
                <NeonButton
                  key={t.id}
                  variant="secondary"
                  className="w-full text-left"
                  onClick={() => handleActivate(t.id)}
                  disabled={activatingFor !== null}
                >
                  {activatingFor === t.id ? 'Activating...' : t.name}
                </NeonButton>
              ))}
              {tournaments.length === 0 && <p className="text-faint text-sm">No active tournaments.</p>}
            </div>
            <NeonButton variant="ghost" onClick={() => setActivateTarget(null)} disabled={activatingFor !== null}>
              Cancel
            </NeonButton>
          </div>
        </div>
      )}

      {pinTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-sm">
            <h2 className="font-display text-lg font-bold mb-2">Pin to Scoreboard</h2>
            <p className="text-muted text-sm mb-4">
              Pin <span className="text-primary font-medium">{pinTarget}</span> to the scoreboard as a standalone
              game. It will appear with a "Pinned" chip and stay active until you unpin it. Rankings (max_10 etc.)
              ignore pinned games.
            </p>
            <label className="flex items-start gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={pinOnIScored}
                onChange={e => setPinOnIScored(e.target.checked)}
                disabled={pinSubmitting}
                className="mt-0.5 cursor-pointer accent-neon-cyan"
              />
              <span className="text-sm text-primary">
                Also create on iScored
                <span className="block text-xs text-faint">
                  Uses the room's iScored credentials. Skipped automatically if iScored isn't configured.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <NeonButton variant="ghost" onClick={() => setPinTarget(null)} disabled={pinSubmitting}>
                Cancel
              </NeonButton>
              <NeonButton onClick={handlePin} disabled={pinSubmitting}>
                {pinSubmitting ? 'Pinning...' : 'Pin'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Style Picker for room library games */}
      {styleTarget && room && (
        <StylePicker
          currentStyleId={styleTarget.catalogue_style_id}
          headerDisabled={styleTarget.style_header_disabled === 1}
          showImageTypeSelector
          uploadPath={`/rooms/${room.roomId}/admin/styles/upload`}
          gameName={styleTarget.name}
          onClose={() => setStyleTarget(null)}
          onSelect={async (styleId, headerDisabled, _setAsDefault, imageType) => {
            try {
              if (styleId) {
                if (imageType && imageType !== 'both') {
                  await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.name)}/image`, {
                    styleId, imageType,
                  });
                } else {
                  await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.name)}/style`, {
                    catalogueStyleId: styleId, headerDisabled,
                  });
                }
                toast('Default style set', 'success');
              } else {
                await api.delete(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.name)}/style`);
                toast('Default style cleared', 'success');
              }
              fetchGames();
            } catch (err: any) {
              toast(err.message, 'error');
            }
            setStyleTarget(null);
          }}
        />
      )}
    </div>
  );
}
