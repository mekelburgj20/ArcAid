import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Home, Library } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import LoadFailedNotice from '../components/LoadFailedNotice';
import RatingBadge from '../components/RatingBadge';
import { compareByRating } from '../lib/ratingSort';
import { catalogueImageFor, toCatalogueUrl, type CatalogueImageSource } from '../lib/catalogueImage';
import { getEngineShortLabel } from '../lib/scoreProvenance';
import { engineOptionsFor } from '../lib/engineOptions';
import { useRetryingLoad } from '../hooks/useRetryingLoad';
import ArcaidPage from '../components/parts/ArcaidPage';
import Panel, { PanelGroup } from '../components/parts/Panel';
import Button from '../components/parts/Button';
import { SearchInput } from '../components/parts/Field';
import { ListRows, ListRow } from '../components/parts/ListRow';
import { SkeletonRows } from '../components/parts/Skeleton';
import EmptyState from '../components/parts/EmptyState';

/**
 * C2 - My Tables: the player's table inventory.
 *
 * A player marks which catalogue tables they own, optionally per ENGINE
 * ("where owned"). No engine selected = owned, platform unspecified. The
 * inventory itself is private; other players only ever see a count
 * ("N players own this table") - owner ruling.
 *
 * API (all PLAYER-token raw fetches; never `lib/api.ts`, which carries the
 * admin token and would bounce a player to an operator login on a 401):
 *   GET    /api/me/tables                -> { tables: OwnedTable[] }
 *   PUT    /api/me/tables/:globalGameId  { platforms: string[] } -> { table: OwnedTable }
 *   DELETE /api/me/tables/:globalGameId  -> { ok, removed }
 *   GET    /api/global/games?search=&limit=20 -> { data: [...], nextCursor, hasMore }
 *
 * G22: the page wears the Arcaid look; the owned list loads through
 * `useRetryingLoad` (a failed load retries, never reads as "no tables").
 */

interface OwnedTable {
  global_game_id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  type: string | null;
  image_url: string | null;
  catalogue_platforms: string[];
  /** This player's engines for the game; [] = owned, platform unspecified. */
  platforms: string[];
  created_at: string;
  /** A14.1: per-rater average (one decimal) and distinct raters. Absent on an older server. */
  avg_rating?: number;
  rating_count?: number;
}

interface CatalogueHit extends CatalogueImageSource {
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Middle dot separator, built from its code point to keep this file ASCII-only. */
const MIDDOT = ` ${String.fromCharCode(0xb7)} `;

function mfgYear(m: string | null, y: number | null): string {
  return [m, y].filter(v => v !== null && v !== undefined && v !== '').join(MIDDOT);
}

export default function MyTables() {
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const [rows, setRows] = useState<OwnedTable[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 300);
  const [hitsFor, setHitsFor] = useState<{ q: string; rows: CatalogueHit[] } | null>(null);
  // A14.1: list order.
  const [sortMode, setSortMode] = useState<'name' | 'rating'>('name');

  const authHeaders = (extra?: Record<string, string>): Record<string, string> => ({
    ...(extra ?? {}),
    ...(playerToken ? { Authorization: `Bearer ${playerToken}` } : {}),
  });

  // A load that fails for now tries again by itself; the empty text waits for an answer (G31).
  const { load, phase } = useRetryingLoad(
    () => fetch('/api/me/tables', { headers: { Authorization: `Bearer ${playerToken}` } }),
    async res => {
      const body = await res.json();
      if (!Array.isArray(body?.tables)) throw new Error('shape');
      setRows(body.tables);
    },
    playerToken,
  );
  useEffect(() => { if (playerToken) load(); }, [playerToken, load]);

  useEffect(() => {
    if (debounced.length < 2) return;
    let cancelled = false;
    fetch(`/api/global/games?search=${encodeURIComponent(debounced)}&limit=20`)
      .then(r => (r.ok ? r.json() : null))
      .then(body => {
        if (cancelled) return;
        // The route answers `{ data, nextCursor, hasMore }`; `games` tolerated too.
        const found = Array.isArray(body?.data) ? body.data : Array.isArray(body?.games) ? body.games : [];
        setHitsFor({ q: debounced, rows: found });
      })
      .catch(() => { if (!cancelled) setHitsFor({ q: debounced, rows: [] }); });
    return () => { cancelled = true; };
  }, [debounced]);

  const hits = debounced.length >= 2 && hitsFor?.q === debounced ? hitsFor.rows : null;
  const ownedIdSet = useMemo(() => new Set(rows.map(t => t.global_game_id)), [rows]);
  const sorted = useMemo(
    () => [...rows].sort(
      sortMode === 'rating'
        ? compareByRating
        : (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    ),
    [rows, sortMode],
  );

  const upsertLocal = (table: OwnedTable) => {
    setRows(prev => [...prev.filter(r => r.global_game_id !== table.global_game_id), table]);
  };

  const save = async (globalGameId: string, platforms: string[]) => {
    if (!playerToken) return;
    setBusyId(globalGameId);
    setError(null);
    try {
      const res = await fetch(`/api/me/tables/${encodeURIComponent(globalGameId)}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ platforms }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.table) throw new Error(body?.error || 'save failed');
      upsertLocal(body.table as OwnedTable);
    } catch {
      setError('Could not save that change. Try again.');
    }
    setBusyId(null);
  };

  const remove = async (globalGameId: string) => {
    if (!playerToken) return;
    setBusyId(globalGameId);
    setError(null);
    try {
      const res = await fetch(`/api/me/tables/${encodeURIComponent(globalGameId)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error('remove failed');
      setRows(prev => prev.filter(r => r.global_game_id !== globalGameId));
    } catch {
      setError('Could not remove that table. Try again.');
    }
    setBusyId(null);
  };

  const toggleEngine = (table: OwnedTable, engine: string) => {
    const has = table.platforms.includes(engine);
    const next = has ? table.platforms.filter(p => p !== engine) : [...table.platforms, engine];
    save(table.global_game_id, next);
  };

  if (!discordUser) {
    return (
      <ArcaidPage title="My Tables" bare>
        <div className="text-center px-6">
          <Library size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in to manage your tables.</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__account__', '/account/tables')}
            onGoogleLogin={() => loginWithGoogle('__account__', '/account/tables')}
            className="justify-center"
          />
        </div>
      </ArcaidPage>
    );
  }

  const noAnswerYet = phase !== 'ready' && rows.length === 0;

  return (
    <ArcaidPage
      title="My Tables"
      width="wide"
      actions={
        <>
          <Link to="/account/settings" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
            <ArrowLeft size={16} />
            Account
          </Link>
          <Link to="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
            <Home size={16} />
            Home
          </Link>
        </>
      }
    >
      <PanelGroup
        id="tables-add"
        tone="cyan"
        title="Add a table"
        sub="Mark the tables you own. Your inventory is private; only a count is shown to others."
      >
        <Panel wide title="Search the catalogue">
          <SearchInput
            id="tables-search"
            label="Find a table"
            placeholder="Search the catalogue to add a table"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onClear={() => setQuery('')}
          />
          {hits && (
            hits.length === 0 ? (
              <p className="text-sm text-muted mt-3">No catalogue tables match.</p>
            ) : (
              <div className="mt-3">
                <ListRows label="Catalogue matches" testId="my-tables-search-results">
                  {hits.map(hit => {
                    const owned = ownedIdSet.has(hit.id);
                    const img = catalogueImageFor(hit);
                    return (
                      <ListRow
                        key={hit.id}
                        name={hit.name}
                        tile={img ? <img src={img} alt="" /> : <Library size={18} />}
                        caption={mfgYear(hit.manufacturer, hit.year) || undefined}
                        trailing={owned ? (
                          <span className="text-xs font-medium text-neon-cyan">Owned</span>
                        ) : (
                          <Button size="xs" aria-label={`Add ${hit.name}`} disabled={busyId === hit.id} onClick={() => save(hit.id, [])}>
                            Add
                          </Button>
                        )}
                      />
                    );
                  })}
                </ListRows>
              </div>
            )
          )}
        </Panel>
        {error && <p className="text-xs ink-danger lg:col-span-2" role="alert">{error}</p>}
      </PanelGroup>

      <PanelGroup id="tables-owned" tone="pink" title="Owned">
        <Panel wide title={`Owned (${rows.length})`}>
          {noAnswerYet ? (
            phase === 'retrying'
              ? <LoadFailedNotice what="your tables" onRetry={load} className="py-8" />
              : <SkeletonRows count={4} label="Loading your tables" />
          ) : sorted.length === 0 ? (
            <EmptyState title="No tables yet." tone="pink">Search above to add the ones you own.</EmptyState>
          ) : (
            <>
              <div data-testid="my-tables-sort" className="flex items-center justify-end gap-2 flex-wrap mb-3">
                <span className="text-xs text-muted">Sort</span>
                {([['name', 'Name'], ['rating', 'Top rated']] as const).map(([mode, label]) => (
                  <Button
                    key={mode}
                    size="xs"
                    variant={sortMode === mode ? 'primary' : 'secondary'}
                    aria-pressed={sortMode === mode}
                    onClick={() => setSortMode(mode)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <ListRows label="Owned tables" testId="my-tables-list">
                {sorted.map(table => {
                  const busy = busyId === table.global_game_id;
                  const options = engineOptionsFor(table.catalogue_platforms, table.platforms);
                  const img = table.image_url ? toCatalogueUrl(table.image_url) : null;
                  return (
                    <ListRow
                      key={table.global_game_id}
                      testId={`owned-${table.global_game_id}`}
                      href={`/games/${table.global_game_id}`}
                      name={table.name}
                      tile={img ? <img src={img} alt="" /> : <Library size={18} />}
                      caption={mfgYear(table.manufacturer, table.year) || undefined}
                      trailing={
                        <Button variant="secondary" size="xs" aria-label={`Remove ${table.name}`} disabled={busy} onClick={() => remove(table.global_game_id)}>
                          Remove
                        </Button>
                      }
                      below={
                        <>
                          {(table.rating_count ?? 0) > 0 && (
                            <div className="mb-1.5">
                              <RatingBadge
                                avg={table.avg_rating}
                                count={table.rating_count}
                                to={`/games/${table.global_game_id}#ratings`}
                              />
                            </div>
                          )}
                          <p className="text-xs text-muted mb-1.5">
                            {table.platforms.length === 0 ? 'Owned on: any platform' : 'Owned on:'}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {options.map(engine => {
                              const on = table.platforms.includes(engine);
                              return (
                                <button
                                  key={engine}
                                  type="button"
                                  onClick={() => toggleEngine(table, engine)}
                                  disabled={busy}
                                  aria-pressed={on}
                                  className={`part-focus px-2.5 py-0.5 rounded-full border text-xs transition-colors cursor-pointer disabled:opacity-50 ${
                                    on
                                      ? 'border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan'
                                      : 'border-border text-muted hover:text-primary'
                                  }`}
                                >
                                  {getEngineShortLabel(engine)}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      }
                    />
                  );
                })}
              </ListRows>
            </>
          )}
        </Panel>
      </PanelGroup>
    </ArcaidPage>
  );
}
