import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, Plus, Sparkles } from 'lucide-react';
import CardRouter from './scoreboard/CardRouter';
import { GameCard } from './ScoreboardComponents';
import type { GameLeaderboard } from './ScoreboardComponents';
import { deriveScoreboardConfig, deriveCardProps, getCardWidth } from '../lib/scoreboardConfig';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import ScoreSubmitModal from './ScoreSubmitModal';
import CatalogueBrowse from './CatalogueBrowse';
import FreeplaySubmitModal, { type CatalogueGame } from './FreeplaySubmitModal';
import MysteryAward from './MysteryAward';

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

export default function GamesTabView({ roomId, slug, config, roomName, viewerUsername }: GamesTabViewProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialView = searchParams.get('view') === 'catalogue' ? 'catalogue' : 'room';
  const [subView, setSubView] = useState<'room' | 'catalogue'>(initialView);

  const [games, setGames] = useState<CommunityLeaderboardGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [selectedGame, setSelectedGame] = useState<GameLeaderboard | null>(null);
  const [catalogueSubmitGame, setCatalogueSubmitGame] = useState<CatalogueGame | null>(null);
  const [showMystery, setShowMystery] = useState(false);
  const [roomLogoUrl, setRoomLogoUrl] = useState<string>('');

  const { discordUser, playerToken, loginWithDiscord } = useViewerAuth();

  const useNewCards = !!config.SCOREBOARD_STYLE;
  const newConfig = deriveScoreboardConfig(config, roomName);
  const legacyProps = deriveCardProps(config, roomName);
  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyProps.cardWidth;
  const cardGap = useNewCards ? newConfig.cardSpacing : 20;
  const requirePhoto = legacyProps.requirePhoto;

  // Fetch room logo for Mystery Award backglass
  useEffect(() => {
    if (!slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ slug: string; logo_url: string | null }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (found?.logo_url) setRoomLogoUrl(found.logo_url);
      })
      .catch(() => {});
  }, [slug]);

  // Debounce search
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const fetchGames = useCallback(async () => {
    if (!roomId) return;
    const params = new URLSearchParams({ sort: 'recent', limit: '100' });
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

  const handleSubViewChange = (next: 'room' | 'catalogue') => {
    setSubView(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'catalogue') {
      params.set('view', 'catalogue');
    } else {
      params.delete('view');
    }
    setSearchParams(params, { replace: true });
  };

  const handleCatalogueSubmit = (game: CatalogueGame) => {
    if (!playerToken) {
      loginWithDiscord(slug, `/${slug}?tab=games&view=catalogue`);
      return;
    }
    setCatalogueSubmitGame(game);
  };

  const handleMysteryPick = (gameName: string) => {
    setShowMystery(false);
    const found = games.find(g => g.gameName === gameName);
    if (found) setSelectedGame(found);
  };

  return (
    <div className="px-4 sm:px-6 pb-6">
      {/* Mystery Award + sub-view toggle */}
      <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
        <div className="flex gap-1">
          <button
            onClick={() => handleSubViewChange('room')}
            className={`px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer ${
              subView === 'room'
                ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
                : 'border-border/50 text-muted hover:text-primary'
            }`}
          >
            Room Games
          </button>
          <button
            onClick={() => handleSubViewChange('catalogue')}
            className={`px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer ${
              subView === 'catalogue'
                ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
                : 'border-border/50 text-muted hover:text-primary'
            }`}
          >
            Browse Catalogue
          </button>
        </div>

        {subView === 'room' && games.length > 0 && (
          <button
            onClick={() => setShowMystery(true)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg border border-neon-magenta/40 bg-neon-magenta/10 text-neon-magenta hover:bg-neon-magenta/20 transition-colors cursor-pointer"
            title="Pick a random game"
          >
            <Sparkles size={14} />
            Mystery Award
          </button>
        )}
      </div>

      {subView === 'catalogue' ? (
        <CatalogueBrowse slug={slug} onSubmitGame={handleCatalogueSubmit} />
      ) : (
        <>
          {/* Search */}
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

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
            </div>
          ) : games.length === 0 ? (
            <div className="text-center py-16">
              {search ? (
                <p className="text-muted text-sm">
                  No games found for &ldquo;{search}&rdquo;
                </p>
              ) : (
                <>
                  <p className="text-muted">No games in this room yet.</p>
                  <p className="text-xs text-faint mt-1">
                    Browse the{' '}
                    <button
                      onClick={() => handleSubViewChange('catalogue')}
                      className="text-neon-cyan hover:underline cursor-pointer"
                    >
                      catalogue
                    </button>
                    {' '}to submit the first score.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div
              className="grid"
              style={{
                gap: cardGap,
                gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.85)}px, 100%), 1fr))`,
                justifyContent: 'center',
              }}
            >
              {games.map(game => {
                const linkTo = game.globalGameId
                  ? `/games/${game.globalGameId}?from=${encodeURIComponent(slug)}`
                  : `/${slug}/games/${encodeURIComponent(game.gameName)}`;

                return (
                  <div
                    key={game.gameName}
                    className="relative group/card justify-self-center w-full"
                    style={{ maxWidth: `${cardWidth}px` }}
                  >
                    {/* Navigation: Link overlay to game detail */}
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

                    {/* Quick submit [+] button — above Link overlay */}
                    <button
                      className="absolute top-2 right-2 z-20 w-8 h-8 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/20 flex items-center justify-center opacity-0 group-hover/card:opacity-100 focus:opacity-100 transition-opacity cursor-pointer backdrop-blur-sm"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedGame(game); }}
                      aria-label={`Submit score for ${game.gameName}`}
                      title="Submit score"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Score submit modal (room game) */}
      {selectedGame && roomId && (
        <ScoreSubmitModal
          gameName={selectedGame.gameName}
          roomId={roomId}
          gameStatus={selectedGame.gameStatus}
          requirePhoto={requirePhoto}
          onClose={() => setSelectedGame(null)}
          onSubmitted={() => { setSelectedGame(null); fetchGames(); }}
        />
      )}

      {/* Freeplay submit modal (catalogue game) */}
      {catalogueSubmitGame && playerToken && roomId && (
        <FreeplaySubmitModal
          game={catalogueSubmitGame}
          roomId={roomId}
          playerToken={playerToken}
          discordUsername={discordUser?.username}
          onClose={() => setCatalogueSubmitGame(null)}
          onSubmitted={() => { setCatalogueSubmitGame(null); fetchGames(); }}
        />
      )}

      {/* Mystery Award */}
      {showMystery && games.length > 0 && (
        <MysteryAward
          availableGames={games.map(g => g.gameName)}
          onClose={() => setShowMystery(false)}
          roomName={roomName}
          backglassUrl={roomLogoUrl || undefined}
          onPickGame={handleMysteryPick}
        />
      )}
    </div>
  );
}
