import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import ScoreCardGrid from './ScoreCardGrid';
import GameQuickView from './GameQuickView';
import SubmissionSheet from './SubmissionSheet';
import type { GameLeaderboard } from './ScoreboardComponents';
import { catalogueImageFor } from '../lib/catalogueImage';
import {
  GLOBAL_SEE_FULL_LABEL,
  GLOBAL_SEARCH_PLACEHOLDER,
  globalEmpty,
  globalSearchEmpty,
} from '../lib/scoresCopy';

/**
 * Bounded convenience lens onto the Global Scoreboard (locked decision #3):
 * games WITH global scores only, reusing GET /api/global/scoreboard with
 * hasScores=1. Full cross-room browsing / filtering stays on the standalone
 * /scoreboard page — this view only links out to it.
 */

interface GlobalTopScore {
  iscored_username: string;
  display_name?: string | null;
  score: number;
  avatar_hash: string | null;
  /** v2.74.0 (S24.1): full avatar URL (Google-linked users). */
  avatar_url?: string | null;
  discord_user_id: string;
}

interface GlobalTopGame {
  global_game_id: string;
  name: string;
  display_name: string | null;
  image_url: string | null;
  local_image_path: string | null;
  wheel_image_path: string | null;
  top_scores: GlobalTopScore[];
}

interface GlobalScoresViewProps {
  roomId: string;
  slug: string;
  config: Record<string, string>;
  roomName: string;
  viewerUsername?: string;
  /** Owner-asked header compression (2026-08-08) — see RoomScoresView's copy
   *  of this doc comment; same mechanism. */
  tabSwitcher?: ReactNode;
}

const PAGE_SIZE = 30;

// v2.50.0 (A2): the local image-path resolution that used to be copied here
// now lives in lib/catalogueImage.ts, shared with GlobalScoreboard.tsx and
// GlobalGameDetail.tsx.
const imageFor = catalogueImageFor;

/** Map a Global Scoreboard row onto the shared GameLeaderboard shape so
 *  ScoreCardGrid renders it identically to Tournaments / Room Scores cards. */
function globalRowToLeaderboard(g: GlobalTopGame): GameLeaderboard {
  return {
    gameId: g.global_game_id,
    gameName: g.name,
    displayName: g.display_name,
    tournamentName: '',
    tournamentType: 'global',
    imageUrl: imageFor(g),
    gameStatus: 'GLOBAL',
    catalogueStyleId: null,
    logoStyleId: null,
    bgStyleId: null,
    styleHeaderDisabled: false,
    bgHasBg: null,
    logoHasHeader: null,
    catHasBg: null,
    catHasHeader: null,
    externalUrl: null,
    notes: null,
    rankings: (g.top_scores || []).map((s, i) => ({
      rank: i + 1,
      discord_user_id: s.discord_user_id || '',
      iscored_username: s.iscored_username,
      display_name: s.display_name ?? null,
      score: s.score,
      avatar_hash: s.avatar_hash ?? null,
      avatar_url: s.avatar_url ?? null,
    })),
    globalGameId: g.global_game_id,
  };
}

export default function GlobalScoresView({ roomId, slug, config, roomName, viewerUsername, tabSwitcher }: GlobalScoresViewProps) {
  const [rows, setRows] = useState<GlobalTopGame[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [submissionTarget, setSubmissionTarget] = useState<{ gameName: string; globalGameId: string } | null>(null);
  const [quickViewLb, setQuickViewLb] = useState<GameLeaderboard | null>(null);

  // Debounce search
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const fetchPage = useCallback(async (offset: number): Promise<{ data: GlobalTopGame[]; total: number; hasMore: boolean }> => {
    const params = new URLSearchParams({
      scope: 'global',
      hasScores: '1',
      sort: 'most_scores',
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (search) params.set('search', search);
    const res = await fetch(`/api/global/scoreboard?${params}`);
    if (!res.ok) return { data: [], total: 0, hasMore: false };
    const payload = await res.json();
    return {
      data: Array.isArray(payload.data) ? payload.data : [],
      total: Number(payload.total) || 0,
      hasMore: Boolean(payload.hasMore),
    };
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, total: t, hasMore: hm } = await fetchPage(0);
      if (cancelled) return;
      setRows(data);
      setTotal(t);
      setHasMore(hm);
    })().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchPage]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const { data, total: t, hasMore: hm } = await fetchPage(rows.length);
    setRows(prev => [...prev, ...data]);
    setTotal(t);
    setHasMore(hm);
    setLoadingMore(false);
  };

  const cards = rows.map(globalRowToLeaderboard);

  const emptyState = (
    <div className="text-center py-16">
      {search ? (
        <>
          <p className="text-muted text-sm">{globalSearchEmpty(search)}</p>
          <button onClick={() => setSearchInput('')} className="mt-2 text-xs text-neon-cyan hover:text-neon-cyan/80 cursor-pointer">
            Clear search
          </button>
        </>
      ) : (
        <>
          <p className="text-primary font-display text-sm mb-1">{globalEmpty().title}</p>
          <p className="text-muted text-sm">{globalEmpty().body}</p>
        </>
      )}
      <Link to="/scoreboard" className="inline-block mt-3 text-xs text-neon-cyan hover:text-neon-cyan/80 no-underline">
        Open the Global Scoreboard →
      </Link>
    </div>
  );

  return (
    <div className="px-4 sm:px-6 pb-6">
      {/* One control row (owner-asked header compression, 2026-08-08): search
          left; running total + the cross-link (locked decision #3 — bounded
          lens, full browsing lives on /scoreboard) + the shared tab chips on
          the right. The old full-width banner row is gone — same link,
          folded onto this row. flex-wrap throughout so narrow viewports
          stack instead of scrolling horizontally. */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder={GLOBAL_SEARCH_PLACEHOLDER}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full pl-10 pr-3 py-2 rounded-lg border border-border/50 bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan/40 text-sm"
            aria-label={GLOBAL_SEARCH_PLACEHOLDER}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          {!loading && total > 0 && (
            <span className="text-[11px] text-faint whitespace-nowrap">
              Showing {rows.length.toLocaleString()} of {total.toLocaleString()} games with global scores
            </span>
          )}
          <Link to="/scoreboard" className="text-xs text-neon-cyan hover:text-neon-cyan/80 no-underline whitespace-nowrap">
            {GLOBAL_SEE_FULL_LABEL}
          </Link>
          {tabSwitcher}
        </div>
      </div>

      <ScoreCardGrid
        cards={cards}
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
        linkFor={lb => `/games/${lb.globalGameId}?from=${encodeURIComponent(slug || '')}&tab=global`}
        onSubmit={lb => setSubmissionTarget({ gameName: lb.gameName, globalGameId: lb.globalGameId! })}
        onTitleClick={lb => setQuickViewLb(lb)}
      />

      {quickViewLb && (
        <GameQuickView lb={quickViewLb} slug={slug} fromTab="global" onClose={() => setQuickViewLb(null)} />
      )}

      {/* Locked decision #5 — submitting from a Global card keeps the freeplay path. */}
      {submissionTarget && roomId && (
        <SubmissionSheet
          target={{ kind: 'freeplay', roomId, gameName: submissionTarget.gameName, globalGameId: submissionTarget.globalGameId }}
          roomSlug={slug}
          discordEnabled={config.DISCORD_ENABLED !== 'false'}
          onClose={() => setSubmissionTarget(null)}
          onSubmitted={() => {
            setSubmissionTarget(null);
            fetchPage(0).then(({ data, total: t, hasMore: hm }) => { setRows(data); setTotal(t); setHasMore(hm); });
          }}
        />
      )}
    </div>
  );
}
