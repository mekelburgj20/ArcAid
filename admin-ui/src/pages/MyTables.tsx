import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Home, Library, Plus, Search, Trash2 } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import { catalogueImageFor, toCatalogueUrl, type CatalogueImageSource } from '../lib/catalogueImage';
import { getEngineShortLabel } from '../lib/scoreProvenance';
import { engineOptionsFor } from '../lib/engineOptions';

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

function Thumb({ src, name }: { src: string | null; name: string }) {
  if (!src) {
    return (
      <div className="w-12 h-12 rounded bg-raised border border-border flex items-center justify-center flex-shrink-0" aria-hidden="true">
        <Library size={18} className="text-faint" />
      </div>
    );
  }
  return <img src={src} alt={name} className="w-12 h-12 rounded object-cover border border-border flex-shrink-0" />;
}

/** Middle dot separator, built from its code point to keep this file ASCII-only. */
const MIDDOT = ` ${String.fromCharCode(0xb7)} `;

function mfgYear(m: string | null, y: number | null): string {
  return [m, y].filter(v => v !== null && v !== undefined && v !== '').join(MIDDOT);
}

export default function MyTables() {
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const [tablesFor, setTablesFor] = useState<{ token: string; rows: OwnedTable[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 300);
  const [hitsFor, setHitsFor] = useState<{ q: string; rows: CatalogueHit[] } | null>(null);

  const tables = useMemo(
    () => (playerToken && tablesFor?.token === playerToken ? tablesFor.rows : null),
    [playerToken, tablesFor],
  );

  const authHeaders = useCallback(
    (extra?: Record<string, string>): Record<string, string> => ({
      ...(extra ?? {}),
      ...(playerToken ? { Authorization: `Bearer ${playerToken}` } : {}),
    }),
    [playerToken],
  );

  useEffect(() => {
    if (!playerToken) return;
    let cancelled = false;
    fetch('/api/me/tables', { headers: { Authorization: `Bearer ${playerToken}` } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then(body => {
        if (cancelled) return;
        setTablesFor({ token: playerToken, rows: Array.isArray(body?.tables) ? body.tables : [] });
        setLoadFailed(false);
      })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [playerToken]);

  useEffect(() => {
    if (debounced.length < 2) return;
    let cancelled = false;
    fetch(`/api/global/games?search=${encodeURIComponent(debounced)}&limit=20`)
      .then(r => (r.ok ? r.json() : null))
      .then(body => {
        if (cancelled) return;
        // The route answers `{ data, nextCursor, hasMore }`; `games` tolerated too.
        const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.games) ? body.games : [];
        setHitsFor({ q: debounced, rows });
      })
      .catch(() => { if (!cancelled) setHitsFor({ q: debounced, rows: [] }); });
    return () => { cancelled = true; };
  }, [debounced]);

  const hits = debounced.length >= 2 && hitsFor?.q === debounced ? hitsFor.rows : null;
  const ownedIdSet = useMemo(() => new Set((tables ?? []).map(t => t.global_game_id)), [tables]);
  const sorted = useMemo(
    () => [...(tables ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [tables],
  );

  const upsertLocal = (table: OwnedTable) => {
    if (!playerToken) return;
    setTablesFor(prev => {
      const rows = prev && prev.token === playerToken ? prev.rows : [];
      const next = rows.filter(r => r.global_game_id !== table.global_game_id);
      next.push(table);
      return { token: playerToken, rows: next };
    });
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
      setTablesFor(prev => (prev ? { ...prev, rows: prev.rows.filter(r => r.global_game_id !== globalGameId) } : prev));
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
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <div className="text-center px-6">
          <Library size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in to manage your tables.</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__account__', '/account/tables')}
            onGoogleLogin={() => loginWithGoogle('__account__', '/account/tables')}
            className="justify-center"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary">
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div
          className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <Link to="/account/settings" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
            <ArrowLeft size={16} />
            Account
          </Link>
          <Link to="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
            <Home size={16} />
            Home
          </Link>
        </div>
      </nav>

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-6">
        <h1 className="text-xl font-semibold mb-1">My Tables</h1>
        <p className="text-sm text-muted mb-6">
          Mark the tables you own. Your inventory is private; only a count is shown to others.
        </p>

        {/* Search the catalogue to add a table. */}
        <section className="mb-8">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search the catalogue to add a table"
              aria-label="Search the catalogue"
              className="w-full bg-surface border border-border rounded-lg pl-9 pr-4 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
            />
          </div>
          {hits && (
            <ul className="mt-2 bg-surface border border-border rounded-lg overflow-hidden" data-testid="my-tables-search-results">
              {hits.length === 0 && <li className="px-4 py-3 text-sm text-muted">No catalogue tables match.</li>}
              {hits.map(hit => {
                const owned = ownedIdSet.has(hit.id);
                return (
                  <li key={hit.id} className="flex items-center gap-3 px-3 py-2 border-b border-border/30 last:border-0">
                    <Thumb src={catalogueImageFor(hit)} name={hit.name} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium break-words leading-tight">{hit.name}</p>
                      {mfgYear(hit.manufacturer, hit.year) && (
                        <p className="text-[11px] text-muted break-words">{mfgYear(hit.manufacturer, hit.year)}</p>
                      )}
                    </div>
                    {owned ? (
                      <span className="text-xs font-medium text-neon-green flex-shrink-0">Owned</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => save(hit.id, [])}
                        disabled={busyId === hit.id}
                        aria-label={`Add ${hit.name}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-xs font-medium hover:bg-neon-cyan/20 disabled:opacity-50 cursor-pointer flex-shrink-0"
                      >
                        <Plus size={12} />
                        Add
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {error && <p className="text-xs text-neon-red mb-3" role="alert">{error}</p>}

        <section>
          <h2 className="text-sm font-medium mb-2">
            Owned{tables ? ` (${tables.length})` : ''}
          </h2>
          {tables === null ? (
            <p className="text-sm text-muted">{loadFailed ? 'Could not load your tables.' : 'Loading...'}</p>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted">No tables yet. Search above to add the ones you own.</p>
          ) : (
            <ul className="space-y-3" data-testid="my-tables-list">
              {sorted.map(table => {
                const busy = busyId === table.global_game_id;
                const options = engineOptionsFor(table.catalogue_platforms, table.platforms);
                const img = table.image_url ? toCatalogueUrl(table.image_url) : null;
                return (
                  <li key={table.global_game_id} className="bg-surface border border-border rounded-lg p-3" data-testid={`owned-${table.global_game_id}`}>
                    <div className="flex items-start gap-3">
                      <Thumb src={img} name={table.name} />
                      <div className="flex-1 min-w-0">
                        <Link
                          to={`/games/${table.global_game_id}`}
                          className="text-sm font-medium break-words leading-tight text-primary hover:text-neon-cyan no-underline"
                        >
                          {table.name}
                        </Link>
                        {mfgYear(table.manufacturer, table.year) && (
                          <p className="text-[11px] text-muted break-words">{mfgYear(table.manufacturer, table.year)}</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(table.global_game_id)}
                        disabled={busy}
                        aria-label={`Remove ${table.name}`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-xs text-muted hover:text-neon-red hover:border-neon-red/40 disabled:opacity-50 cursor-pointer bg-transparent flex-shrink-0"
                      >
                        <Trash2 size={12} />
                        Remove
                      </button>
                    </div>
                    <div className="mt-2.5">
                      <p className="text-[11px] text-faint mb-1.5">
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
                              className={`px-2 py-0.5 rounded-full border text-[11px] transition-colors cursor-pointer disabled:opacity-50 ${
                                on
                                  ? 'bg-neon-cyan/15 border-neon-cyan/60 text-neon-cyan'
                                  : 'border-border text-muted hover:text-primary'
                              }`}
                            >
                              {getEngineShortLabel(engine)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
