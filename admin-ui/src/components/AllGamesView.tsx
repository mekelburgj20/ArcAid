import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import CardRouter from './scoreboard/CardRouter';
import { GameCard } from './ScoreboardComponents';
import type { GameLeaderboard } from './ScoreboardComponents';
import { deriveScoreboardConfig, deriveCardProps, getCardWidth } from '../lib/scoreboardConfig';

interface CommunityLeaderboardGame extends GameLeaderboard {
  globalGameId: string | null;
  lastPlayed: string;
  playerCount: number;
  totalScores: number;
}

interface AllGamesViewProps {
  roomId: string;
  slug: string;
  config: Record<string, string>;
  roomName: string;
  viewerUsername?: string;
}

export default function AllGamesView({ roomId, slug, config, roomName, viewerUsername }: AllGamesViewProps) {
  const [games, setGames] = useState<CommunityLeaderboardGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const useNewCards = !!config.SCOREBOARD_STYLE;
  const newConfig = deriveScoreboardConfig(config, roomName);
  const legacyProps = deriveCardProps(config, roomName);
  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyProps.cardWidth;
  const cardGap = useNewCards ? newConfig.cardSpacing : 20;

  // Debounced search
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // Fetch games
  const fetchGames = useCallback(async () => {
    const params = new URLSearchParams({ sort: 'recent', limit: '50' });
    if (search) params.set('search', search);
    try {
      const res = await fetch(`/api/rooms/${roomId}/community-leaderboards?${params}`);
      if (!res.ok) return;
      setGames(await res.json());
    } catch { /* ignore */ }
  }, [roomId, search]);

  useEffect(() => {
    setLoading(true);
    fetchGames().finally(() => setLoading(false));
  }, [fetchGames]);

  // Auto-scroll carousel — pauses on hover or when searching
  useEffect(() => {
    if (isHovered || search || games.length <= 1) return;
    const el = scrollRef.current;
    if (!el) return;

    const interval = setInterval(() => {
      const maxScroll = el.scrollWidth - el.clientWidth;
      if (maxScroll <= 0) return;
      const step = cardWidth + cardGap;
      const nextPos = el.scrollLeft + step;
      if (nextPos >= maxScroll) {
        el.scrollTo({ left: 0, behavior: 'smooth' });
      } else {
        el.scrollTo({ left: nextPos, behavior: 'smooth' });
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isHovered, search, games.length, cardWidth, cardGap]);

  const scrollBy = (direction: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * (cardWidth + cardGap), behavior: 'smooth' });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (games.length === 0 && !search) {
    return (
      <div className="text-center py-16">
        <p className="text-muted">No community scores yet.</p>
        <p className="text-xs text-faint mt-1">
          Submit scores via{' '}
          <Link to={`/${slug}/freeplay`} className="text-neon-cyan hover:underline">Freeplay</Link>
          {' '}to see them here.
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 pb-6">
      {/* Search bar */}
      <div className="max-w-md mx-auto mb-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search games..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full pl-10 pr-3 py-2 rounded-lg border border-border/50 bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan/40 text-sm"
          />
        </div>
      </div>

      {games.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          No games found for &ldquo;{search}&rdquo;
        </div>
      ) : (
        <div
          className="relative group/carousel"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Left arrow */}
          <button
            onClick={() => scrollBy(-1)}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-surface/90 border border-border/50 text-muted hover:text-primary hover:border-neon-cyan/40 opacity-0 group-hover/carousel:opacity-100 transition-opacity cursor-pointer backdrop-blur-sm"
            aria-label="Previous"
          >
            <ChevronLeft size={20} />
          </button>

          {/* Carousel container */}
          <div
            ref={scrollRef}
            className="overflow-x-auto allgames-carousel"
          >
            <div
              className="flex pb-2 px-8"
              style={{ gap: cardGap }}
            >
              {games.map(game => {
                const linkTo = game.globalGameId
                  ? `/games/${game.globalGameId}?from=${encodeURIComponent(slug)}`
                  : `/${slug}/games/${encodeURIComponent(game.gameName)}`;

                return (
                  <div
                    key={game.gameName}
                    className="flex-shrink-0 relative group/card"
                    style={{ width: `min(${cardWidth}px, calc(100vw - 3rem))` }}
                  >
                    {/* Clickable overlay — navigates to game detail */}
                    <Link
                      to={linkTo}
                      className="absolute inset-0 z-10"
                      aria-label={game.gameName}
                    />
                    {useNewCards ? (
                      <CardRouter
                        lb={game}
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
                        lb={game}
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
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right arrow */}
          <button
            onClick={() => scrollBy(1)}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-surface/90 border border-border/50 text-muted hover:text-primary hover:border-neon-cyan/40 opacity-0 group-hover/carousel:opacity-100 transition-opacity cursor-pointer backdrop-blur-sm"
            aria-label="Next"
          >
            <ChevronRight size={20} />
          </button>
        </div>
      )}

      <style>{`
        .allgames-carousel {
          scrollbar-width: thin;
          scrollbar-color: var(--color-border) transparent;
          scroll-behavior: smooth;
        }
        .allgames-carousel::-webkit-scrollbar {
          height: 6px;
        }
        .allgames-carousel::-webkit-scrollbar-track {
          background: transparent;
        }
        .allgames-carousel::-webkit-scrollbar-thumb {
          background: var(--color-border);
          border-radius: 3px;
        }
        .allgames-carousel::-webkit-scrollbar-thumb:hover {
          background: var(--color-muted);
        }
      `}</style>
    </div>
  );
}
