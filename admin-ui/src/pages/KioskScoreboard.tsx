import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';
import {
  GameCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
  cardWidthMap,
} from '../components/ScoreboardComponents';

export default function KioskScoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [roomName, setRoomName] = useState('');

  // Resolve room and fetch scoreboard config
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((portal: { id: string; name: string }) => {
        setRoomName(portal.name);
        return fetch(`/api/rooms/${portal.id}/scoreboard-config`);
      })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => setConfig(cfg || {}))
      .catch(() => {});
  }, [slug]);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/leaderboard');
      if (res.ok) setLeaderboards(await res.json());
    } catch { /* ignore */ }
    try {
      const res = await fetch('/api/rankings');
      if (res.ok) setRankingGroups(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Initial load + auto-refresh
  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const refreshSeconds = parseInt(config.KIOSK_REFRESH_SECONDS || '60', 10);
    if (refreshSeconds > 0) {
      const interval = setInterval(loadData, refreshSeconds * 1000);
      return () => clearInterval(interval);
    }
  }, [loadData, config.KIOSK_REFRESH_SECONDS]);

  // Config-driven values
  const maxScores = parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5;
  const hideEmpty = config.SCOREBOARD_HIDE_EMPTY === 'true';
  const titleHidden = config.SCOREBOARD_TITLE_HIDDEN === 'true';
  const titleText = config.SCOREBOARD_TITLE || roomName || 'High Scores';
  const titleStyle = config.SCOREBOARD_TITLE_STYLE || 'default';
  const titleSize = config.SCOREBOARD_TITLE_SIZE || 'sm';
  const zoom = parseInt(config.SCOREBOARD_ZOOM || '100', 10) || 100;
  const bgUrl = config.SCOREBOARD_BG_URL || '';
  const bgMode = config.SCOREBOARD_BG_MODE || 'cover';
  const logoUrl = config.LOGO_URL || '';
  const logoPosition = config.LOGO_POSITION || 'left';
  const logoMaxHeight = parseInt(config.LOGO_MAX_HEIGHT || '64', 10) || 64;
  const layout = config.SCOREBOARD_LAYOUT || 'scroll';
  const cardsPerRow = parseInt(config.SCOREBOARD_CARDS_PER_ROW || '4', 10) || 4;
  const cardSize = config.SCOREBOARD_CARD_SIZE || 'medium';
  const rankingsPosition = config.SCOREBOARD_RANKINGS_POSITION || 'left';

  const visibleLeaderboards = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;
  const cardWidth = cardWidthMap[cardSize] || 288;

  return (
    <div className="min-h-screen bg-deep text-primary relative">
      <div
        className="px-4 sm:px-6 py-6"
        style={{
          ...(zoom !== 100 ? { zoom: `${zoom}%` } : {}),
          ...(bgUrl ? {
            backgroundImage: `url(${bgUrl})`,
            backgroundSize: bgMode === 'repeat' ? 'auto' : bgMode,
            backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center',
            minHeight: '100vh',
          } : {}),
        }}
      >
        {/* Title */}
        {!titleHidden && (
          <div className="text-center mb-8">
            <div className={`inline-flex items-center gap-4 ${
              logoPosition === 'above' || logoPosition === 'below' ? 'flex-col' : 'flex-row'
            }`}>
              {logoUrl && (logoPosition === 'left' || logoPosition === 'above') && (
                <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain" />
              )}
              <p className={`font-display text-muted ${getTitleSizeClass(titleSize)} uppercase tracking-widest ${getTitleStyleClass(titleStyle)}`}>
                {titleText}
              </p>
              {logoUrl && (logoPosition === 'right' || logoPosition === 'below') && (
                <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain" />
              )}
            </div>
          </div>
        )}
        {titleHidden && logoUrl && (
          <div className="text-center mb-8">
            <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain mx-auto" />
          </div>
        )}

        {/* Rankings: top position */}
        {rankingsPosition === 'top' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} />
        )}

        {/* Main content area */}
        <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row' : 'flex-col'} gap-6 items-start`}>

          {/* Rankings: left position */}
          {rankingsPosition === 'left' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} />
          )}

          {/* Game leaderboards */}
          {visibleLeaderboards.length === 0 ? (
            <div className="flex-1 text-center py-24">
              <p className="text-muted font-display">Waiting for active games...</p>
            </div>
          ) : layout === 'grid' ? (
            <div className="flex-1 min-w-0">
              <div className="grid gap-5" style={{ gridTemplateColumns: `repeat(${cardsPerRow}, minmax(0, 1fr))` }}>
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId}>
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 overflow-x-auto">
              <div className="flex gap-5 pb-2">
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} style={{ width: `${cardWidth}px` }} className="flex-shrink-0">
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rankings: right position */}
          {rankingsPosition === 'right' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} />
          )}
        </div>

        {/* Rankings: bottom position */}
        {rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} />
        )}
      </div>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
