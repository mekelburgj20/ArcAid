import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import { api } from '../lib/api';
import { useOptionalRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import StarRating from '../components/StarRating';
import ConfirmModal from '../components/ConfirmModal';
import StylePicker from '../components/StylePicker';
import { getPlatformDisplay, normalizePlatformList } from '../lib/platforms';

interface GameRow {
  name: string;
  display_name: string;
  aliases: string;
  style_id: string;
  mode: string;
  css_title: string;
  css_initials: string;
  css_scores: string;
  css_box: string;
  bg_color: string;
  platforms: string;
  catalogue_style_id?: string | null;
  style_header_disabled?: number;
}

const emptyGame: GameRow = {
  name: '', display_name: '', aliases: '', style_id: '', mode: 'pinball', css_title: '', css_initials: '',
  css_scores: '', css_box: '', bg_color: '', platforms: ''
};

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

function parsePlatforms(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

function PlatformChips({ platforms: raw }: { platforms: string }) {
  // v2.5.1: defense-in-depth — even after migration 089 normalizes the data,
  // alias-fold + dedupe at render time so future drift doesn't reintroduce
  // visual duplicates. Render the canonical displayName (e.g. "FX Classic"),
  // not the raw id (`pinball_fx_classic`).
  const list = normalizePlatformList(parsePlatforms(raw));
  if (list.length === 0) return <span className="text-faint text-sm">None</span>;
  return (
    <div className="flex gap-1 flex-wrap">
      {list.map(p => (
        <span key={p} className="text-xs px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30">{getPlatformDisplay(p)}</span>
      ))}
    </div>
  );
}

interface TournamentOption {
  id: string;
  name: string;
}

type SortKey = 'name' | 'mode' | 'platforms' | 'rating' | 'style_id';
type SortDir = 'asc' | 'desc';

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
  const [newGame, setNewGame] = useState<GameRow>({ ...emptyGame });
  const [search, setSearch] = useState('');
  const [showPinball, setShowPinball] = useState(true);
  const [showVideoGame, setShowVideoGame] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<GameRow | null>(null);
  const [editGame, setEditGame] = useState<GameRow>({ ...emptyGame });
  const [editSaving, setEditSaving] = useState(false);
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

  // Selection + delete
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Inline platform add
  const [showAddPlatform, setShowAddPlatform] = useState(false);
  const [newPlatformName, setNewPlatformName] = useState('');

  // v2.5.0: per-room game-library proposal flow.
  // proposalCheck holds the response from POST /game_library/proposals so the
  // UI can render the inline use_global / submit_to_global / room_only choice.
  type GlobalGameLite = { id: string; name: string; manufacturer?: string | null; year?: number | null; type: string; platforms?: string };
  const [proposalCheck, setProposalCheck] = useState<{
    input: { name: string; type: 'pinball' | 'video_game'; platforms: string[] };
    exact: GlobalGameLite | null;
    possible: GlobalGameLite[];
  } | null>(null);
  const [proposalCommitting, setProposalCommitting] = useState(false);

  // v2.5.0: CSV preview/commit flow.
  type PreviewBucket = 'auto_link' | 'auto_submit' | 'needs_review';
  type PreviewRow = {
    index: number;
    input: { name: string; manufacturer?: string | null; year?: number | null; type: 'pinball' | 'video_game'; platforms?: string[] };
    candidates: { exact: GlobalGameLite | null; possible: GlobalGameLite[] };
    bucket: PreviewBucket;
    suggestedDecision: 'use_global' | 'submit_to_global' | null;
  };
  const [csvPreview, setCsvPreview] = useState<{ rows: PreviewRow[]; summary: Record<PreviewBucket, number> & { total: number } } | null>(null);
  // Per-row decisions for needs_review entries; auto_link/auto_submit use suggestedDecision.
  const [csvDecisions, setCsvDecisions] = useState<Record<number, { decision: 'use_global' | 'room_only' | 'submit_to_global'; globalGameId?: string }>>({});
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
    setNewGame(prev => ({ ...prev, name: s.name, mode: s.mode, platforms: plats }));
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
          // Pre-seed decisions for auto-bucketed rows from the server's suggestion.
          const seeded: Record<number, { decision: 'use_global' | 'room_only' | 'submit_to_global'; globalGameId?: string }> = {};
          for (const r of preview.rows) {
            if (r.bucket === 'auto_link' && r.candidates.exact) {
              seeded[r.index] = { decision: 'use_global', globalGameId: r.candidates.exact.id };
            } else if (r.bucket === 'auto_submit') {
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

  // v2.5.0: commit the previewed CSV. Skips rows in `needs_review` that the
  // user hasn't picked a decision for yet.
  const commitCsvPreview = async () => {
    if (!csvPreview) return;
    const ready = csvPreview.rows
      .map(r => {
        const d = csvDecisions[r.index];
        if (!d) return null;
        return { input: r.input, decision: d.decision, ...(d.globalGameId ? { globalGameId: d.globalGameId } : {}) };
      })
      .filter(Boolean) as Array<{ input: PreviewRow['input']; decision: 'use_global' | 'room_only' | 'submit_to_global'; globalGameId?: string }>;
    if (ready.length === 0) {
      toast('Pick a decision for at least one row', 'error');
      return;
    }
    setCsvCommitting(true);
    try {
      const result = await api.post<{ ok: boolean; counts: { linked: number; submitted_pending: number; room_only: number; errors: number }; errors?: Array<{ index: number; error: string }> }>(
        `${prefix}/game_library/import-csv-commit`, { games: ready },
      );
      const { counts } = result;
      const summary = `${counts.linked} linked · ${counts.submitted_pending} pending · ${counts.room_only} room-only` + (counts.errors ? ` · ${counts.errors} failed` : '');
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
    const headers = ['name','aliases','style_id','mode','platforms','css_title','css_initials','css_scores','css_box','bg_color'];
    const csv = headers.join(',') + '\n"Medieval Madness","MM","92025","pinball","AtGames,VPXS","","","","",""';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'arcaid_games_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // v2.5.0: Add Game now runs through the proposals dedup flow. Form data
  // is captured into `newGame`; clicking Save runs /proposals → renders an
  // inline result panel where the user picks one of three commit paths.
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

  // v2.5.0: commit the user's choice from the proposal result panel.
  // `decision` selects which endpoint to call. After success, refresh list +
  // close the Add form.
  const commitProposal = async (decision: 'use_global' | 'room_only' | 'submit_to_global', globalGameId?: string) => {
    if (!proposalCheck || !room) return;
    setProposalCommitting(true);
    try {
      const path =
        decision === 'use_global'
          ? `${prefix}/game_library/use_global`
          : decision === 'room_only'
          ? `${prefix}/game_library/room_only`
          : `${prefix}/game_library/submit_to_global`;
      const body: Record<string, unknown> = decision === 'use_global'
        ? { globalGameId }
        : {
            name: proposalCheck.input.name,
            type: proposalCheck.input.type,
            platforms: proposalCheck.input.platforms,
          };
      await api.post(path, body);
      const successMsg =
        decision === 'use_global'   ? 'Linked to existing catalogue entry'
        : decision === 'room_only'  ? 'Added to this room only (not contributing to global catalogue)'
        :                              'Added to room and submitted to global catalogue for review';
      toast(successMsg, 'success');
      setProposalCheck(null);
      setNewGame({ ...emptyGame });
      setShowAddForm(false);
      fetchGames();
    } catch (err: any) {
      toast(err.message || 'Failed to add game', 'error');
    } finally {
      setProposalCommitting(false);
    }
  };

  const openEdit = (g: GameRow) => {
    setEditTarget(g);
    const plats = parsePlatforms(g.platforms).join(', ');
    setEditGame({ ...g, platforms: plats });
  };

  const handleEditSave = async () => {
    if (!editTarget || !editGame.name.trim()) return;
    setEditSaving(true);
    try {
      await api.put(`${prefix}/game_library/${encodeURIComponent(editTarget.name)}`, editGame);
      toast('Game updated', 'success');
      setEditTarget(null);
      fetchGames();
    } catch {
      toast('Failed to update game', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const res = await api.post<{ deleted: number }>(`${prefix}/game_library/delete`, { names: [...selected] });
      toast(`Deleted ${res.deleted} game${res.deleted !== 1 ? 's' : ''} from library`, 'success');
      setSelected(new Set());
      setShowDeleteConfirm(false);
      fetchGames();
    } catch (err: any) {
      toast(err.message || 'Failed to delete games', 'error');
    } finally {
      setDeleting(false);
    }
  };

  // v2.5.1: alias-fold + dedupe before building the filter pill row, so
  // legacy mixed-case data (`VPX` / `vpx`) and aliases (`FX3` /
  // `pinball_fx_classic`) collapse to one chip per real platform.
  const allPlatforms = normalizePlatformList(games.flatMap(g => parsePlatforms(g.platforms))).sort();

  const togglePlatform = (p: string) => {
    setPlatformFilter(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const filteredGames = games.filter(g => {
    if (!showPinball && (g.mode || 'pinball') === 'pinball') return false;
    if (!showVideoGame && g.mode === 'videogame') return false;
    if (platformFilter.size > 0) {
      // Normalize the game's platforms before comparing — handles mixed-case
      // pre-089 data without forcing the filter to match all variants.
      const gPlats = normalizePlatformList(parsePlatforms(g.platforms));
      if (!gPlats.some(p => platformFilter.has(p))) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      return g.name.toLowerCase().includes(q) || (g.platforms || '').toLowerCase().includes(q);
    }
    return true;
  });

  // Sorted games
  const sortedGames = useMemo(() => {
    const sorted = [...filteredGames];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'mode':
          cmp = (a.mode || 'pinball').localeCompare(b.mode || 'pinball');
          break;
        case 'platforms':
          cmp = (a.platforms || '').localeCompare(b.platforms || '');
          break;
        case 'rating': {
          const ra = communityRatings[a.name]?.avg_rating ?? 0;
          const rb = communityRatings[b.name]?.avg_rating ?? 0;
          cmp = ra - rb;
          break;
        }
        case 'style_id':
          cmp = (a.style_id || '').localeCompare(b.style_id || '');
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filteredGames, sortKey, sortDir, communityRatings]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const toggleSelect = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === sortedGames.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sortedGames.map(g => g.name)));
    }
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
              <input type="text" placeholder="e.g. AtGames, VPXS" value={newGame.platforms} onChange={e => setNewGame({...newGame, platforms: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Style ID</label>
              <input type="text" value={newGame.style_id} onChange={e => setNewGame({...newGame, style_id: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Aliases</label>
              <input type="text" value={newGame.aliases} onChange={e => setNewGame({...newGame, aliases: e.target.value})} className={inputClass} />
            </div>
          </div>
          <details className="mb-4 text-muted text-sm cursor-pointer">
            <summary className="hover:text-primary transition-colors">Advanced CSS Styling</summary>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
              {(['css_title','css_initials','css_scores','css_box','bg_color'] as const).map(field => (
                <div key={field}>
                  <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">{field.replace('css_','CSS ').replace('bg_','BG ')}</label>
                  <input type="text" value={newGame[field]} onChange={e => setNewGame({...newGame, [field]: e.target.value})} className={inputClass} />
                </div>
              ))}
            </div>
          </details>
          <NeonButton onClick={handleAddGame} disabled={saving}>
            {saving ? 'Saving...' : 'Save Game'}
          </NeonButton>
        </NeonCard>
      )}

      {/* v2.5.0: proposal result panel — rendered after Add Game ran a dedup check.
          Three states (exact match / possible matches / no candidate) each surface
          their relevant commit choices. */}
      {proposalCheck && (
        <NeonCard glowColor="cyan" className="mb-4 border-l-2 border-l-neon-cyan" title={
          proposalCheck.exact ? 'Already in the catalogue' :
          proposalCheck.possible.length > 0 ? 'Possible duplicates' :
          'New game — submit to catalogue?'
        }>
          {proposalCheck.exact ? (
            <>
              <p className="text-sm text-muted mb-3">
                We found an existing catalogue entry for{' '}
                <span className="text-primary font-medium">{proposalCheck.input.name}</span>:
              </p>
              <div className="bg-raised/50 px-3 py-2 rounded text-sm mb-3 flex items-center justify-between">
                <div>
                  <span className="text-primary font-medium">{proposalCheck.exact.name}</span>
                  {(proposalCheck.exact.manufacturer || proposalCheck.exact.year) && (
                    <span className="text-faint ml-2">
                      ({[proposalCheck.exact.manufacturer, proposalCheck.exact.year].filter(Boolean).join(', ')})
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <NeonButton onClick={() => commitProposal('use_global', proposalCheck.exact!.id)} disabled={proposalCommitting}>
                  Yes, link this to my room
                </NeonButton>
                <NeonButton variant="ghost" onClick={() => setProposalCheck(null)} disabled={proposalCommitting}>
                  Cancel
                </NeonButton>
              </div>
            </>
          ) : proposalCheck.possible.length > 0 ? (
            <>
              <p className="text-sm text-muted mb-3">
                These existing entries have similar names. Pick one to link, or add{' '}
                <span className="text-primary font-medium">{proposalCheck.input.name}</span> as new.
              </p>
              <div className="space-y-2 mb-3">
                {proposalCheck.possible.map(p => (
                  <div key={p.id} className="bg-raised/50 px-3 py-2 rounded text-sm flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-primary font-medium">{p.name}</span>
                      {(p.manufacturer || p.year) && (
                        <span className="text-faint ml-2">
                          ({[p.manufacturer, p.year].filter(Boolean).join(', ')})
                        </span>
                      )}
                    </div>
                    <NeonButton variant="secondary" className="text-xs px-2 py-1 flex-shrink-0"
                      onClick={() => commitProposal('use_global', p.id)} disabled={proposalCommitting}>
                      Use this one
                    </NeonButton>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 flex-wrap pt-2 border-t border-border/30">
                <span className="text-xs text-faint self-center">None of these match —</span>
                <NeonButton variant="secondary" onClick={() => commitProposal('submit_to_global')} disabled={proposalCommitting}>
                  Submit as new (pending review)
                </NeonButton>
                <NeonButton variant="ghost" onClick={() => commitProposal('room_only')} disabled={proposalCommitting}>
                  Add room-only
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
                Submit it for review (visible to all rooms once approved), or keep it private to this room.
              </p>
              <div className="flex gap-2 flex-wrap">
                <NeonButton onClick={() => commitProposal('submit_to_global')} disabled={proposalCommitting}>
                  Submit to global catalogue
                </NeonButton>
                <NeonButton variant="ghost" onClick={() => commitProposal('room_only')} disabled={proposalCommitting}>
                  Add room-only
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
                      <div className="text-xs text-faint mb-2">Possible matches:</div>
                      <div className="space-y-1 mb-2">
                        {r.candidates.possible.map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setCsvDecisions(prev => ({ ...prev, [r.index]: { decision: 'use_global', globalGameId: p.id } }))}
                            className={`w-full text-left px-2 py-1 rounded border transition-colors text-xs ${
                              decision?.decision === 'use_global' && decision.globalGameId === p.id
                                ? 'bg-neon-cyan/15 border-neon-cyan text-neon-cyan'
                                : 'border-border text-muted hover:text-primary hover:border-border/80'
                            }`}
                          >
                            {p.name}
                            {(p.manufacturer || p.year) && <span className="text-faint ml-2">({[p.manufacturer, p.year].filter(Boolean).join(', ')})</span>}
                          </button>
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
                          onClick={() => setCsvDecisions(prev => ({ ...prev, [r.index]: { decision: 'room_only' } }))}
                          className={`text-xs px-2 py-1 rounded border transition-colors ${
                            decision?.decision === 'room_only'
                              ? 'bg-neon-cyan/15 border-neon-cyan text-neon-cyan'
                              : 'border-border text-muted hover:text-primary hover:border-border/80'
                          }`}
                        >
                          Room-only
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
        <div className="flex flex-wrap items-center gap-3 sm:gap-4 mb-4">
          <input
            type="text" placeholder="Search games..." value={search} onChange={e => setSearch(e.target.value)}
            className={`${inputClass} max-w-sm`}
          />
          <label className="flex items-center gap-1.5 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={showPinball} onChange={e => setShowPinball(e.target.checked)} className="accent-neon-amber" />
            Pinball
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={showVideoGame} onChange={e => setShowVideoGame(e.target.checked)} className="accent-neon-cyan" />
            Video Games
          </label>
          {selected.size > 0 && (
            <NeonButton variant="danger" onClick={() => setShowDeleteConfirm(true)} className="text-xs px-3 py-1">
              Delete Selected ({selected.size})
            </NeonButton>
          )}
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

        {/* Custom table with sorting + checkboxes */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left w-10">
                  <input
                    type="checkbox"
                    checked={sortedGames.length > 0 && selected.size === sortedGames.length}
                    onChange={toggleSelectAll}
                    className="accent-neon-cyan cursor-pointer"
                  />
                </th>
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
                <th className="px-4 py-3 text-left">
                  <SortHeader label="Style ID" sortKey="style_id" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-right text-xs font-display font-bold uppercase tracking-wider text-muted"></th>
              </tr>
            </thead>
            <tbody>
              {sortedGames.length === 0 ? (
                <tr>
                  <td colSpan={room ? 7 : 6} className="px-4 py-8 text-center text-muted">
                    No games in the library.
                  </td>
                </tr>
              ) : (
                sortedGames.map((g) => (
                  <tr key={g.name} className={`border-b border-border/50 transition-colors ${
                    selected.has(g.name) ? 'bg-neon-cyan/5' : 'hover:bg-raised/50'
                  }`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(g.name)}
                        onChange={() => toggleSelect(g.name)}
                        className="accent-neon-cyan cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium">{g.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${(g.mode || 'pinball') === 'pinball' ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan'}`}>
                        {(g.mode || 'pinball') === 'pinball' ? 'Pinball' : 'Video Game'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <PlatformChips platforms={g.platforms} />
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
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted font-mono">{g.style_id || '-'}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {room && <NeonButton variant="ghost" onClick={() => setActivateTarget(g.name)} className="text-xs px-2 py-1">Activate</NeonButton>}
                        {room && <NeonButton variant="ghost" onClick={() => { setPinTarget(g.name); setPinOnIScored(true); }} className="text-xs px-2 py-1">Pin</NeonButton>}
                        {room && (
                          <NeonButton
                            variant={g.catalogue_style_id ? 'secondary' : 'ghost'}
                            onClick={() => setStyleTarget(g)}
                            className="text-xs px-2 py-1"
                          >
                            Style
                          </NeonButton>
                        )}
                        <NeonButton variant="ghost" onClick={() => openEdit(g)} className="text-xs px-2 py-1">Edit</NeonButton>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-faint text-xs mt-3">{filteredGames.length} game{filteredGames.length !== 1 ? 's' : ''}</p>
      </NeonCard>

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

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Games"
          message={`Are you sure you want to delete ${selected.size} game${selected.size !== 1 ? 's' : ''} from the library? Active tournament games will not be affected.`}
          confirmLabel={deleting ? 'Deleting...' : 'Delete'}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {editTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="font-display text-lg font-bold mb-4">Edit Game</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Game Name *</label>
                <input type="text" value={editGame.name} onChange={e => setEditGame({...editGame, name: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Display Name</label>
                <input type="text" placeholder="Leave blank to use game name" value={editGame.display_name} onChange={e => setEditGame({...editGame, display_name: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Mode</label>
                <select value={editGame.mode || 'pinball'} onChange={e => setEditGame({...editGame, mode: e.target.value})} className={selectClass}>
                  <option value="pinball">Pinball</option>
                  <option value="videogame">Video Game</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Platforms</label>
                <input type="text" placeholder="e.g. AtGames, VPXS" value={editGame.platforms} onChange={e => setEditGame({...editGame, platforms: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Style ID</label>
                <input type="text" value={editGame.style_id} onChange={e => setEditGame({...editGame, style_id: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Aliases</label>
                <input type="text" value={editGame.aliases} onChange={e => setEditGame({...editGame, aliases: e.target.value})} className={inputClass} />
              </div>
            </div>
            <details className="mb-4 text-muted text-sm cursor-pointer">
              <summary className="hover:text-primary transition-colors">Advanced CSS Styling</summary>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
                {(['css_title','css_initials','css_scores','css_box','bg_color'] as const).map(field => (
                  <div key={field}>
                    <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">{field.replace('css_','CSS ').replace('bg_','BG ')}</label>
                    <input type="text" value={editGame[field]} onChange={e => setEditGame({...editGame, [field]: e.target.value})} className={inputClass} />
                  </div>
                ))}
              </div>
            </details>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</NeonButton>
              <NeonButton onClick={handleEditSave} disabled={editSaving || !editGame.name.trim()}>
                {editSaving ? 'Saving...' : 'Save Changes'}
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
