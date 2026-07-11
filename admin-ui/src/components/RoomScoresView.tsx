import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import ScoreCardGrid from './ScoreCardGrid';
import GameQuickView from './GameQuickView';
import SubmissionSheet from './SubmissionSheet';
import type { GameLeaderboard, RankedEntry } from './ScoreboardComponents';
import { usePlayerHeaders, useViewerAuth } from '../contexts/ViewerAuthContext';
import {
  ROOM_SCORES_SEARCH_PLACEHOLDER,
  ROOM_SORT_LABELS,
  roomScoresEmpty,
  roomScoresSearchEmpty,
  browseLink,
} from '../lib/scoresCopy';

type RoomSort = keyof typeof ROOM_SORT_LABELS;

/** Room Scores row shape — every score ever set in this room, best-per-player-
 *  per-game across sources (locked decision #2), served by GET
 *  /:roomId/room-scores. Extends the shared GameLeaderboard so cards render
 *  through the same ScoreCardGrid as Tournaments / Global. */
interface RoomScoreCard extends GameLeaderboard {
  globalGameId: string | null;
  lastPlayed: string;
  playerCount: number;
  totalScores: number;
  viewerEntry?: RankedEntry | null;
}

interface RoomScoresViewProps {
  roomId: string;
  slug: string;
  config: Record<string, string>;
  roomName: string;
  viewerUsername?: string;
}

const PAGE_SIZE = 48;

/** Decode a player JWT and pull the role + gameRoomIds claims — used only to
 *  pick the role-aware browse link (room admin → library, else → catalogue).
 *  Mirrors GameDetail.tsx's decodeViewerClaims (not shared — that helper isn't
 *  exported). Returns null on missing/invalid token. */
function decodeViewerClaims(token: string | null): { role: string; gameRoomIds: string[] } | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      role: (payload.role as string) || 'player',
      gameRoomIds: Array.isArray(payload.gameRoomIds) ? payload.gameRoomIds : [],
    };
  } catch {
    return null;
  }
}

export default function RoomScoresView({ roomId, slug, config, roomName, viewerUsername }: RoomScoresViewProps) {
  const [rows, setRows] = useState<RoomScoreCard[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<RoomSort>('recent');

  const [submissionTarget, setSubmissionTarget] = useState<{ gameName: string; gameStatus?: string } | null>(null);
  // v2.13.12-style quick-view modal, owned here (not by ScoreCardGrid — see F1).
  const [quickViewLb, setQuickViewLb] = useState<GameLeaderboard | null>(null);

  const playerHeaders = usePlayerHeaders();
  const { playerToken } = useViewerAuth();

  // Debounce search
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const fetchPage = useCallback(async (pageOffset: number): Promise<{ data: RoomScoreCard[]; total: number; hasMore: boolean }> => {
    if (!roomId) return { data: [], total: 0, hasMore: false };
    const params = new URLSearchParams({ sort, limit: String(PAGE_SIZE), offset: String(pageOffset) });
    if (search) params.set('search', search);
    // Optional Bearer — server best-effort resolves viewerEntry per card and
    // never 401s on a bad/absent token (edge case 11).
    const res = await fetch(`/api/rooms/${roomId}/room-scores?${params}`, { headers: playerHeaders });
    if (!res.ok) return { data: [], total: 0, hasMore: false };
    const payload = await res.json();
    return {
      data: Array.isArray(payload.data) ? payload.data : [],
      total: Number(payload.total) || 0,
      hasMore: Boolean(payload.hasMore),
    };
  }, [roomId, search, sort, playerHeaders]);

  // First page — replaces rows on room/search change.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    setLoading(true);
    setOffset(0);
    (async () => {
      const { data, total: t, hasMore: hm } = await fetchPage(0);
      if (cancelled) return;
      setRows(data);
      setTotal(t);
      setHasMore(hm);
    })().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [roomId, fetchPage]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextOffset = offset + PAGE_SIZE;
    const { data, total: t, hasMore: hm } = await fetchPage(nextOffset);
    setRows(prev => [...prev, ...data]);
    setTotal(t);
    setHasMore(hm);
    setOffset(nextOffset);
    setLoadingMore(false);
  };

  const refetchFirstPage = () => {
    setOffset(0);
    fetchPage(0).then(({ data, total: t, hasMore: hm }) => { setRows(data); setTotal(t); setHasMore(hm); });
  };

  const claims = decodeViewerClaims(playerToken);
  const isRoomAdmin = !!claims && (claims.role === 'super_admin' || (claims.role === 'room_admin' && claims.gameRoomIds.includes(roomId)));
  const { href: browseHref, label: browseLabel } = browseLink({ isRoomAdmin, slug });

  const empty = roomScoresEmpty({ roomName });
  const emptyState = (
    <div className="text-center py-16">
      {search ? (
        <>
          <p className="text-muted text-sm">{roomScoresSearchEmpty(search)}</p>
          <button onClick={() => setSearchInput('')} className="mt-2 text-xs text-neon-cyan hover:text-neon-cyan/80 cursor-pointer">
            Clear search
          </button>
        </>
      ) : (
        <>
          <p className="text-primary font-display text-sm mb-1">{empty.title}</p>
          <p className="text-muted text-sm">{empty.body}</p>
        </>
      )}
      <Link to={browseHref} className="inline-block mt-3 text-xs text-neon-cyan hover:text-neon-cyan/80 no-underline">
        {browseLabel}
      </Link>
    </div>
  );

  return (
    <div className="px-4 sm:px-6 pb-6">
      <div className="max-w-md mx-auto mb-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder={ROOM_SCORES_SEARCH_PLACEHOLDER}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full pl-10 pr-3 py-2 rounded-lg border border-border/50 bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan/40 text-sm"
            aria-label={ROOM_SCORES_SEARCH_PLACEHOLDER}
          />
        </div>
      </div>

      {/* Sort chips (ROOM_SORT_LABELS — server-side sort param). */}
      <div className="max-w-md mx-auto mb-2 flex items-center justify-center gap-1.5">
        {(Object.keys(ROOM_SORT_LABELS) as RoomSort[]).map(key => (
          <button
            key={key}
            onClick={() => setSort(key)}
            className={`px-3 py-1 rounded-full text-xs border transition-colors cursor-pointer ${
              sort === key
                ? 'border-neon-cyan/60 text-neon-cyan bg-neon-cyan/10'
                : 'border-border/50 text-muted hover:text-primary'
            }`}
            aria-pressed={sort === key}
          >
            {ROOM_SORT_LABELS[key]}
          </button>
        ))}
      </div>

      {/* Small persistent muted browse link (F5 (b)) + running total (F3 pagination fix). */}
      <div className="max-w-md mx-auto mb-4 flex items-center justify-center gap-3 text-[11px] text-faint">
        {!loading && total > 0 && <span>{total.toLocaleString()} game{total === 1 ? '' : 's'}</span>}
        <Link to={browseHref} className="text-muted hover:text-primary transition-colors no-underline">
          {browseLabel}
        </Link>
      </div>

      <ScoreCardGrid
        cards={rows}
        slug={slug}
        roomId={roomId}
        config={config}
        roomName={roomName}
        viewerUsername={viewerUsername}
        loading={loading}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        emptyState={emptyState}
        linkFor={lb => `/${slug}/games/${encodeURIComponent(lb.gameName)}?tab=room`}
        onSubmit={lb => setSubmissionTarget({ gameName: lb.gameName, gameStatus: lb.gameStatus })}
        onTitleClick={lb => setQuickViewLb(lb)}
      />

      {quickViewLb && (
        <GameQuickView lb={quickViewLb} slug={slug} fromTab="room" onClose={() => setQuickViewLb(null)} />
      )}

      {/* Preserves existing Played-Here submit semantics (kind:'tournament' by
          gameName) — do NOT "fix" to freeplay; see F3. */}
      {submissionTarget && roomId && (
        <SubmissionSheet
          target={{
            kind: 'tournament',
            roomId,
            gameName: submissionTarget.gameName,
            gameStatus: submissionTarget.gameStatus,
            requirePhoto: config.REQUIRE_SCORE_PHOTO === 'true',
          }}
          roomSlug={slug}
          requireLogin={config.REQUIRE_DISCORD_LOGIN === 'true'}
          onClose={() => setSubmissionTarget(null)}
          onSubmitted={() => {
            setSubmissionTarget(null);
            refetchFirstPage();
          }}
        />
      )}
    </div>
  );
}
