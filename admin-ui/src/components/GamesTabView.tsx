import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, Plus } from 'lucide-react';
import CardRouter from './scoreboard/CardRouter';
import { GameCard } from './ScoreboardComponents';
import type { GameLeaderboard } from './ScoreboardComponents';
import { deriveScoreboardConfig, deriveCardProps, getCardWidth } from '../lib/scoreboardConfig';
import SubmissionSheet from './SubmissionSheet';
import RoomTag from './RoomTag';

export interface CatalogueGame {
  id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  type: string;
  local_image_path: string | null;
  wheel_image_path: string | null;
  image_url: string | null;
  platforms: string;
}

interface CommunityLeaderboardGame extends GameLeaderboard {
  globalGameId: string | null;
  lastPlayed: string;
  playerCount: number;
  totalScores: number;
}

interface GamesTabViewProps {
  roomId: string;
  slug: string;
  config: Record<string, string>;
  roomName: string;
  viewerUsername?: string;
}

const CATALOGUE_PAGE_SIZE = 48;

function toCatalogueUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function catalogueImage(g: CatalogueGame): string | null {
  if (g.local_image_path) return toCatalogueUrl(g.local_image_path);
  if (g.wheel_image_path) return toCatalogueUrl(g.wheel_image_path);
  if (g.image_url) return g.image_url;
  return null;
}

/** Map a CatalogueGame (global catalogue row) onto the GameLeaderboard shape so CardRouter/GameCard can render it uniformly. */
function catalogueToLeaderboard(g: CatalogueGame): GameLeaderboard {
  return {
    gameId: g.id,
    gameName: g.name,
    displayName: g.display_name || null,
    tournamentName: '', // v2.0.1 — no user-facing "Catalogue" label; cards hide when empty.
    tournamentType: 'community',
    imageUrl: catalogueImage(g),
    gameStatus: 'CATALOGUE',
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
    rankings: [],
    globalGameId: g.id,
  };
}

export default function GamesTabView({ roomId, slug, config, roomName, viewerUsername }: GamesTabViewProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const playedHere = searchParams.get('played-here') === '1';

  const [playedGames, setPlayedGames] = useState<CommunityLeaderboardGame[]>([]);
  const [catalogueGames, setCatalogueGames] = useState<CatalogueGame[]>([]);
  const [hasMoreCatalogue, setHasMoreCatalogue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [submissionTarget, setSubmissionTarget] = useState<
    | { kind: 'tournament'; gameName: string; gameStatus?: string }
    | { kind: 'freeplay'; gameName: string; globalGameId: string }
    | null
  >(null);

  const useNewCards = !!config.SCOREBOARD_STYLE;
  const newConfig = deriveScoreboardConfig(config, roomName);
  const legacyProps = deriveCardProps(config, roomName);
  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyProps.cardWidth;
  const cardGap = useNewCards ? newConfig.cardSpacing : 20;
  const requirePhoto = legacyProps.requirePhoto;

  // Debounce search
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const setFilter = (next: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('played-here', '1');
    else params.delete('played-here');
    setSearchParams(params, { replace: true });
  };

  // Fetch "played here" games (rich leaderboard shape with style resolution)
  const fetchPlayedHere = useCallback(async () => {
    if (!roomId) return;
    const params = new URLSearchParams({ sort: 'recent', limit: '100' });
    if (search) params.set('search', search);
    const res = await fetch(`/api/rooms/${roomId}/community-leaderboards?${params}`);
    if (!res.ok) { setPlayedGames([]); return; }
    setPlayedGames(await res.json());
  }, [roomId, search]);

  // Fetch all catalogue (paginated)
  const fetchCatalogue = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams({ status: 'approved', limit: String(CATALOGUE_PAGE_SIZE) });
    if (search) params.set('search', search);
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/global/games?${params}`);
    if (!res.ok) return { data: [] as CatalogueGame[], hasMore: false };
    const payload = await res.json();
    return { data: (payload.data || []) as CatalogueGame[], hasMore: Boolean(payload.hasMore) };
  }, [search]);

  // Load on filter / search change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      if (playedHere) {
        await fetchPlayedHere();
      } else {
        const { data, hasMore } = await fetchCatalogue();
        if (cancelled) return;
        setCatalogueGames(data);
        setHasMoreCatalogue(hasMore);
      }
    })().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playedHere, fetchPlayedHere, fetchCatalogue]);

  const loadMoreCatalogue = async () => {
    if (loadingMore || !hasMoreCatalogue || catalogueGames.length === 0) return;
    setLoadingMore(true);
    const last = catalogueGames[catalogueGames.length - 1];
    const { data, hasMore } = await fetchCatalogue(last.id);
    setCatalogueGames(prev => [...prev, ...data]);
    setHasMoreCatalogue(hasMore);
    setLoadingMore(false);
  };

  // Unified list of cards to render
  const cards = useMemo<GameLeaderboard[]>(() => {
    if (playedHere) return playedGames;
    return catalogueGames.map(catalogueToLeaderboard);
  }, [playedHere, playedGames, catalogueGames]);

  // Submit handler — SubmissionSheet handles the anonymous-flow state machine
  // (plan §15), including the Discord collision prompt for unauthenticated users.
  const handleSubmit = (lb: GameLeaderboard) => {
    if (lb.gameStatus === 'CATALOGUE') {
      const cg = catalogueGames.find(c => c.id === lb.gameId);
      if (!cg) return;
      setSubmissionTarget({ kind: 'freeplay', gameName: cg.name, globalGameId: cg.id });
    } else {
      setSubmissionTarget({ kind: 'tournament', gameName: lb.gameName, gameStatus: lb.gameStatus });
    }
  };

  const emptyCopy = playedHere
    ? (search ? `No games found for "${search}" played at this room.` : 'No games played at this room yet.')
    : (search ? `No catalogue games found for "${search}".` : 'No catalogue games available.');

  return (
    <div className="px-4 sm:px-6 pb-6">
      {/* Controls: filter toggle */}
      <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
        <div className="flex gap-1" role="tablist" aria-label="Games filter">
          <button
            role="tab"
            aria-selected={!playedHere}
            onClick={() => setFilter(false)}
            className={`px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer ${
              !playedHere
                ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
                : 'border-border/50 text-muted hover:text-primary'
            }`}
          >
            All Games
          </button>
          <button
            role="tab"
            aria-selected={playedHere}
            onClick={() => setFilter(true)}
            className={`px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
              playedHere
                ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
                : 'border-border/50 text-muted hover:text-primary'
            }`}
          >
            <span>Played at</span>
            <RoomTag shortTag={slug} size={16} />
          </button>
        </div>
      </div>

      {/* Search — always rendered to keep layout stable */}
      <div className="max-w-md mx-auto mb-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search games..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full pl-10 pr-3 py-2 rounded-lg border border-border/50 bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan/40 text-sm"
            aria-label="Search games"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      ) : cards.length === 0 ? (
        <div className="text-center py-16 text-muted text-sm">
          {emptyCopy}
        </div>
      ) : (
        <>
          <div
            className="grid"
            style={{
              gap: cardGap,
              gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.85)}px, 100%), 1fr))`,
              justifyContent: 'center',
            }}
          >
            {cards.map(lb => {
              // v2.2.6: always link to the room-scoped Game Detail. Global was
              // preferred when globalGameId existed, but Global hides anon
              // scores via the fan-out gate so clicks made scores "disappear".
              const linkTo = `/${slug}/games/${encodeURIComponent(lb.gameName)}`;

              return (
                <div
                  key={`${lb.gameStatus}-${lb.gameId}`}
                  className="relative group/card justify-self-center w-full"
                  style={{ maxWidth: `${cardWidth}px` }}
                >
                  <Link
                    to={linkTo}
                    className="absolute inset-0 z-10"
                    aria-label={lb.displayName || lb.gameName}
                  />
                  {useNewCards ? (
                    <CardRouter
                      lb={lb}
                      slug={slug}
                      roomId={roomId}
                      style={newConfig.style}
                      theme={newConfig.theme}
                      maxScores={newConfig.maxScores}
                      minScores={newConfig.minScores}
                      showTimer={false}
                      cardBgFill={newConfig.cardBgFill}
                      titleFontSize={newConfig.titleFontSize || undefined}
                      viewerUsername={viewerUsername}
                      qrMode="disabled"
                      gameTitleStyle={newConfig.gameTitleStyle}
                    />
                  ) : (
                    <GameCard
                      lb={lb}
                      slug={slug}
                      maxScores={legacyProps.maxScores}
                      roomId={roomId}
                      cardOpacity={legacyProps.cardOpacity}
                      scoreColumns={legacyProps.scoreColumns}
                      viewerUsername={viewerUsername}
                      headerStyle={legacyProps.headerStyle}
                      globalStyles={legacyProps.globalStyles}
                      wheelScale={legacyProps.wheelScale}
                      bgFill={legacyProps.bgFill}
                      bgSize={legacyProps.bgSize}
                      cardWidth={legacyProps.cardWidth}
                      glassOpacity={legacyProps.glassOpacity}
                      gameTitleStyle={legacyProps.gameTitleStyle}
                      gameTitleEnhance={legacyProps.gameTitleEnhance}
                      scoreStyle={legacyProps.scoreStyle}
                    />
                  )}

                  <button
                    className="absolute top-2 right-2 z-20 w-8 h-8 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/20 flex items-center justify-center opacity-0 group-hover/card:opacity-100 focus:opacity-100 transition-opacity cursor-pointer backdrop-blur-sm"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleSubmit(lb); }}
                    aria-label={`Submit score for ${lb.displayName || lb.gameName}`}
                    title="Submit score"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              );
            })}
          </div>
          {!playedHere && hasMoreCatalogue && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={loadMoreCatalogue}
                disabled={loadingMore}
                className="px-5 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50 cursor-pointer"
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Sprint 10 — SubmissionSheet handles both tournament (room) and freeplay
          (catalogue) submissions plus the anonymous collision flow.
          v2.0.1 — requireLogin short-circuits the form when the room gates submissions. */}
      {submissionTarget && roomId && (
        <SubmissionSheet
          target={
            submissionTarget.kind === 'tournament'
              ? { kind: 'tournament', roomId, gameName: submissionTarget.gameName, gameStatus: submissionTarget.gameStatus, requirePhoto }
              : { kind: 'freeplay', roomId, gameName: submissionTarget.gameName, globalGameId: submissionTarget.globalGameId }
          }
          roomSlug={slug}
          requireLogin={config.REQUIRE_DISCORD_LOGIN === 'true'}
          onClose={() => setSubmissionTarget(null)}
          onSubmitted={() => {
            if (submissionTarget.kind === 'tournament') fetchPlayedHere();
            setSubmissionTarget(null);
          }}
        />
      )}
    </div>
  );
}
