import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Search, X, Trophy } from 'lucide-react';
import { formatScore } from '../lib/format';
import { useRoom } from '../contexts/RoomContext';
import { compareByRank } from '../lib/searchRank';

/**
 * WP2 — S14 social loops: head-to-head player comparison.
 *
 * Reads ?a=<identifier>&b=<identifier> (iscored_username or discord_user_id,
 * same resolution rule as /stats/enhanced/player/:identifier). When a side is
 * missing, shows a searchable picker sourced from the room's player list
 * (same endpoint PublicStats.tsx uses for its Players tab).
 */

interface PlayerOption {
  discord_user_id: string;
  iscored_username: string | null;
  display_name?: string | null;
}

interface CompareSide {
  identifier: string;
  displayName: string;
  discordUserId: string | null;
}

interface SharedGame {
  game_name: string;
  a_best: number;
  b_best: number;
  leader: 'a' | 'b' | 'tie';
  gap: number;
}

interface CompareResult {
  a: CompareSide;
  b: CompareSide;
  sharedGames: SharedGame[];
  /** Counts of games only one side has scored on (numbers, not arrays). */
  aOnlyGames: number;
  bOnlyGames: number;
  totals: { aWins: number; bWins: number; ties: number };
}

function playerLabel(p: PlayerOption): string {
  return p.display_name || p.iscored_username || `User ${p.discord_user_id.slice(-4)}`;
}

function playerIdentifier(p: PlayerOption): string {
  return p.iscored_username || p.discord_user_id;
}

export default function ComparePlayers() {
  const { slug } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const aParam = params.get('a') || '';
  const bParam = params.get('b') || '';

  const { roomId } = useRoom();
  const [players, setPlayers] = useState<PlayerOption[]>([]);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchA, setSearchA] = useState('');
  const [searchB, setSearchB] = useState('');

  // Fetch player list for the picker.
  useEffect(() => {
    if (!roomId) return;
    fetch(`/api/rooms/${roomId}/stats/enhanced/players`)
      .then(r => (r.ok ? r.json() : []))
      .then(list => setPlayers(list || []))
      .catch(() => {});
  }, [roomId]);

  // Fetch the comparison once both identifiers are set.
  useEffect(() => {
    if (!roomId || !aParam || !bParam) { setResult(null); return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/rooms/${roomId}/stats/compare?a=${encodeURIComponent(aParam)}&b=${encodeURIComponent(bParam)}`)
      .then(r => {
        if (!r.ok) throw new Error('compare-failed');
        return r.json();
      })
      .then(data => { if (!cancelled) setResult(data); })
      .catch(() => { if (!cancelled) setError('Could not load this comparison.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [roomId, aParam, bParam]);

  const setSide = (side: 'a' | 'b', identifier: string) => {
    const next = new URLSearchParams(params);
    next.set(side, identifier);
    setParams(next, { replace: true });
  };

  const clearSide = (side: 'a' | 'b') => {
    const next = new URLSearchParams(params);
    next.delete(side);
    setParams(next, { replace: true });
  };

  const filteredA = useMemo(() => {
    const q = searchA.trim().toLowerCase();
    const opts = q ? players.filter(p => playerLabel(p).toLowerCase().includes(q)) : players;
    // Search-relevance work package (2026-08-13): nearest-exact-match first.
    if (q) opts.sort(compareByRank(searchA.trim(), playerLabel));
    return opts.slice(0, 20);
  }, [players, searchA]);

  const filteredB = useMemo(() => {
    const q = searchB.trim().toLowerCase();
    const opts = q ? players.filter(p => playerLabel(p).toLowerCase().includes(q)) : players;
    if (q) opts.sort(compareByRank(searchB.trim(), playerLabel));
    return opts.slice(0, 20);
  }, [players, searchB]);

  return (
    <div>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2">
        <Link to={`/${slug}/stats`} className="text-faint hover:text-muted no-underline transition-colors text-xs">
          &larr; Back to Stats
        </Link>
        <h2 className="font-display text-xl font-bold mt-1 flex items-center gap-2">
          <ArrowLeftRight size={20} className="text-neon-cyan" />
          Compare Players
        </h2>
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Picker row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <PlayerSlot
            label="Player A"
            resolvedName={result?.a.displayName}
            picked={!!aParam}
            search={searchA}
            onSearch={setSearchA}
            options={filteredA}
            onPick={p => { setSide('a', playerIdentifier(p)); setSearchA(''); }}
            onClear={() => clearSide('a')}
          />
          <PlayerSlot
            label="Player B"
            resolvedName={result?.b.displayName}
            picked={!!bParam}
            search={searchB}
            onSearch={setSearchB}
            options={filteredB}
            onPick={p => { setSide('b', playerIdentifier(p)); setSearchB(''); }}
            onClear={() => clearSide('b')}
          />
        </div>

        {!aParam || !bParam ? (
          <p className="text-muted text-center py-8 text-sm">Pick two players to compare.</p>
        ) : loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="text-neon-magenta text-center py-8 text-sm">{error}</p>
        ) : result ? (
          <>
            {/* Totals strip */}
            <div className="bg-surface border border-border rounded-lg p-4 mb-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
              <span className="flex items-center gap-1.5">
                <Trophy size={14} className="text-neon-cyan" />
                <span className="text-neon-cyan font-display font-bold truncate max-w-[10rem]">{result.a.displayName}</span>
                <span className="text-primary font-bold">{result.totals.aWins}</span>
              </span>
              <span className="text-faint">Ties {result.totals.ties}</span>
              <span className="flex items-center gap-1.5">
                <span className="text-primary font-bold">{result.totals.bWins}</span>
                <span className="text-neon-magenta font-display font-bold truncate max-w-[10rem]">{result.b.displayName}</span>
                <Trophy size={14} className="text-neon-magenta" />
              </span>
              <span className="text-xs text-faint w-full text-center sm:w-auto">
                {result.a.displayName} only: {result.aOnlyGames} · {result.b.displayName} only: {result.bOnlyGames}
              </span>
            </div>

            {/* Shared games table */}
            {result.sharedGames.length === 0 ? (
              <p className="text-muted text-center py-8 text-sm">No shared games yet.</p>
            ) : (
              <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="hidden sm:grid grid-cols-[1fr_120px_120px_90px] gap-2 px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                  <span>Game</span>
                  <span className="text-right truncate" title={result.a.displayName}>{result.a.displayName}</span>
                  <span className="text-right truncate" title={result.b.displayName}>{result.b.displayName}</span>
                  <span className="text-right">Gap</span>
                </div>
                {result.sharedGames.map((g, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-2 sm:grid-cols-[1fr_120px_120px_90px] gap-2 items-center px-4 py-3 border-b border-border/20 last:border-0"
                  >
                    <span className="text-sm text-primary truncate col-span-2 sm:col-span-1">{g.game_name}</span>
                    <span
                      className={`text-right font-display font-bold text-sm ${g.leader === 'a' ? 'text-neon-cyan' : 'text-muted'}`}
                      title={g.a_best.toLocaleString()}
                    >
                      {formatScore(g.a_best)}
                    </span>
                    <span
                      className={`text-right font-display font-bold text-sm ${g.leader === 'b' ? 'text-neon-magenta' : 'text-muted'}`}
                      title={g.b_best.toLocaleString()}
                    >
                      {formatScore(g.b_best)}
                    </span>
                    <span className="text-right text-xs text-faint">
                      {g.leader === 'tie' ? 'Tie' : formatScore(g.gap)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}

function PlayerSlot({
  label,
  resolvedName,
  picked,
  search,
  onSearch,
  options,
  onPick,
  onClear,
}: {
  label: string;
  resolvedName?: string;
  picked: boolean;
  search: string;
  onSearch: (v: string) => void;
  options: PlayerOption[];
  onPick: (p: PlayerOption) => void;
  onClear: () => void;
}) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <p className="text-[10px] text-faint uppercase tracking-wider mb-2">{label}</p>
      {picked ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-primary truncate">{resolvedName || 'Loading…'}</span>
          <button
            onClick={onClear}
            className="text-muted hover:text-neon-magenta bg-transparent border-0 cursor-pointer p-1 flex-shrink-0"
            title="Change player"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <input
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search players..."
              className="w-full bg-raised border border-border rounded pl-8 pr-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none"
            />
          </div>
          {options.length > 0 && (
            <div className="mt-1 max-h-48 overflow-y-auto bg-raised border border-border rounded divide-y divide-border/20">
              {options.map(p => (
                <button
                  key={p.discord_user_id}
                  onClick={() => onPick(p)}
                  className="w-full text-left px-3 py-1.5 text-sm text-secondary hover:bg-border/20 hover:text-primary cursor-pointer bg-transparent border-0"
                >
                  {playerLabel(p)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
