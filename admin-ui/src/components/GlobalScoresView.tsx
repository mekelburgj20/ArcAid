import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import ScoreCardGrid from './ScoreCardGrid';
import GameQuickView from './GameQuickView';
import SubmissionSheet from './SubmissionSheet';
import type { GameLeaderboard } from './ScoreboardComponents';
import { requiresAnyLogin, requiresDiscordOnly } from '../lib/loginPolicy';
import {
  GLOBAL_BANNER_TEXT,
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
}

const PAGE_SIZE = 30;

// Mirrors the local image-path resolution duplicated in GamesTabView.tsx /
// GlobalScoreboard.tsx — no shared export exists for this today.
function toCatalogueUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function imageFor(g: GlobalTopGame): string | null {
  if (g.local_image_path) return toCatalogueUrl(g.local_image_path);
  if (g.wheel_image_path) return toCatalogueUrl(g.wheel_image_path);
  if (g.image_url) return g.image_url;
  return null;
}

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
    })),
    globalGameId: g.global_game_id,
  };
}

export default function GlobalScoresView({ roomId, slug, config, roomName, viewerUsername }: GlobalScoresViewProps) {
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
      {/* Cross-link banner (locked decision #3 — bounded lens, full browsing lives on /scoreboard) */}
      <div className="max-w-3xl mx-auto mb-4 flex items-center justify-between gap-3 flex-wrap px-4 py-2.5 rounded-lg border border-border/50 bg-surface/60">
        <span className="text-xs text-muted">{GLOBAL_BANNER_TEXT}</span>
        <Link to="/scoreboard" className="text-xs text-neon-cyan hover:text-neon-cyan/80 no-underline flex-shrink-0">
          {GLOBAL_SEE_FULL_LABEL}
        </Link>
      </div>

      <div className="max-w-md mx-auto mb-2">
        <div className="relative">
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
      </div>

      {!loading && total > 0 && (
        <p className="text-center text-[11px] text-faint mb-4">
          Showing {rows.length.toLocaleString()} of {total.toLocaleString()} games with global scores
        </p>
      )}

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
          requireLogin={requiresAnyLogin(config.REQUIRE_DISCORD_LOGIN)}
          discordOnly={requiresDiscordOnly(config.REQUIRE_DISCORD_LOGIN)}
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
