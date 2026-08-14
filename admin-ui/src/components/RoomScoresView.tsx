import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import ScoreCardGrid from './ScoreCardGrid';
import GameQuickView from './GameQuickView';
import SubmissionSheet from './SubmissionSheet';
import type { GameLeaderboard, RankedEntry } from './ScoreboardComponents';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { decodeViewerClaims, isRoomAdminFor } from '../lib/viewerClaims';
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
  /** Owner-asked header compression (2026-08-08) — the shared Tournaments/
   *  Room Scores/Global tab chips, rendered by the page (`Scoreboard.tsx`) so
   *  every tab's control row shares one definition. Folded into the right
   *  side of this view's own search/sort/count row instead of sitting above
   *  it in the page's measured title zone. */
  tabSwitcher?: ReactNode;
}

const PAGE_SIZE = 48;

export default function RoomScoresView({ roomId, slug, config, roomName, viewerUsername, tabSwitcher }: RoomScoresViewProps) {
  const [rows, setRows] = useState<RoomScoreCard[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<RoomSort>('recent');

  const [submissionTarget, setSubmissionTarget] = useState<{ gameName: string } | null>(null);
  // v2.13.12-style quick-view modal, owned here (not by ScoreCardGrid — see F1).
  const [quickViewLb, setQuickViewLb] = useState<GameLeaderboard | null>(null);

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
    // never 401s on a bad/absent token (edge case 11). Headers are built
    // inline from the stable playerToken string: usePlayerHeaders() returns a
    // NEW object each render, and having it in this callback's deps refired
    // the first-page effect every render (v2.18.0 infinite-fetch-loop bug —
    // the 429 storm that took the tab down on launch day).
    const headers: Record<string, string> = playerToken ? { Authorization: `Bearer ${playerToken}` } : {};
    const res = await fetch(`/api/rooms/${roomId}/room-scores?${params}`, { headers });
    if (!res.ok) return { data: [], total: 0, hasMore: false };
    const payload = await res.json();
    return {
      data: Array.isArray(payload.data) ? payload.data : [],
      total: Number(payload.total) || 0,
      hasMore: Boolean(payload.hasMore),
    };
  }, [roomId, search, sort, playerToken]);

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

  const claims = useMemo(() => decodeViewerClaims(playerToken), [playerToken]);
  const isRoomAdmin = isRoomAdminFor(claims, roomId);
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
      {/* One control row (owner-asked header compression, 2026-08-08; revised
          for true chip centering per owner feedback). 3-column grid — left
          (search), center (shared tab chips, centered against the FULL row
          width via two equal 1fr side tracks, not just leftover flex space),
          right (sort chips + running total + browse link). Collapses to one
          stacked column below `sm`; the right group keeps its own
          `flex-wrap` so a narrow right track never forces horizontal
          scroll. */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-3 mb-4">
        <div className="relative min-w-0 max-w-sm">
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

        <div className="min-w-0 flex justify-center">
          {tabSwitcher}
        </div>

        <div className="min-w-0 flex flex-wrap items-center gap-3 justify-start sm:justify-end">
          {/* Sort chips (ROOM_SORT_LABELS — server-side sort param). */}
          <div className="flex items-center gap-1.5">
            {(Object.keys(ROOM_SORT_LABELS) as RoomSort[]).map(key => (
              <button
                key={key}
                onClick={() => setSort(key)}
                className={`px-3 py-1 rounded-full text-xs border transition-colors cursor-pointer whitespace-nowrap ${
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

          {/* Running total (F3 pagination fix) + persistent muted browse link (F5 (b)). */}
          <div className="flex items-center gap-3 text-[11px] text-faint whitespace-nowrap">
            {!loading && total > 0 && <span>{total.toLocaleString()} game{total === 1 ? '' : 's'}</span>}
            <Link to={browseHref} className="text-muted hover:text-primary transition-colors no-underline">
              {browseLabel}
            </Link>
          </div>
        </div>
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
        onSubmit={lb => setSubmissionTarget({ gameName: lb.gameName })}
        onTitleClick={lb => setQuickViewLb(lb)}
        // v2.108.0 (F3) — a click on the viewer's OWN row opens the same
        // popup the title opens, where the score can be deleted.
        viewerDiscordId={claims?.discordId}
        onOwnRowClick={lb => setQuickViewLb(lb)}
      />

      {quickViewLb && (
        <GameQuickView
          lb={quickViewLb}
          slug={slug}
          fromTab="room"
          // v2.108.0 (F4) — per-row delete inside the popup. The Global tab
          // deliberately does NOT pass roomId (global rows delete through
          // /api/me/global-scores instead).
          roomId={roomId}
          onScoreDeleted={refetchFirstPage}
          onClose={() => setQuickViewLb(null)}
        />
      )}

      {/* Preserves existing Played-Here submit semantics (kind:'tournament' by
          gameName) — do NOT "fix" to freeplay; see F3.
          `gameStatus` is deliberately NOT threaded through here (owner field
          report 2026-08-11): its only consumer in SubmissionSheet is the
          cooldown caption, which is Tournaments-tab context ("won't count
          toward the active tournament"). On Room Scores every submission is a
          room-leaderboard post by definition — including games that rotated
          out of past tournaments (COMPLETED status) — so the caption was pure
          noise here. Tournaments tab / GameDetail still pass gameStatus and
          keep the caption; don't change those. */}
      {submissionTarget && roomId && (
        <SubmissionSheet
          target={{
            kind: 'tournament',
            roomId,
            gameName: submissionTarget.gameName,
            requirePhoto: config.REQUIRE_SCORE_PHOTO === 'true',
          }}
          roomSlug={slug}
          discordEnabled={config.DISCORD_ENABLED !== 'false'}
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
