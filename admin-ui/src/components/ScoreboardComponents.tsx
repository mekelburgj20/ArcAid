import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, Minus, Camera, Upload } from 'lucide-react';
import QRCode from 'qrcode';
import ScorePhotoModal from './ScorePhotoModal';
import GameInfoPopup from './scoreboard/GameInfoPopup';
import { AnonymousAvatarIcon } from '../assets/icons/ThemedIcons';
// ShowcaseThemeConfig imported via SHOWCASE_THEMES lookup in RankingGroupCard
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../lib/scoreboardThemes';

// --- Shared interfaces ---

export interface RankedEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  score: number;
  avatar_hash?: string | null;
}

export interface GameLeaderboard {
  gameId: string;
  gameName: string;
  displayName?: string | null;
  tournamentName: string;
  tournamentType: string;
  /** v2.4.0: true when this card is a pinned standalone game (no tournament). */
  isPinned?: boolean;
  imageUrl: string | null;
  gameStatus: string;
  catalogueStyleId: string | null;
  logoStyleId: string | null;
  bgStyleId: string | null;
  styleHeaderDisabled: boolean;
  bgHasBg?: number | null;
  logoHasHeader?: number | null;
  catHasBg?: number | null;
  catHasHeader?: number | null;
  externalUrl?: string | null;
  notes?: string | null;
  rankings: RankedEntry[];
  nextMaintenanceAt?: string | null;
  globalGameId?: string | null;
}

export interface RankingGroupData {
  group: {
    id: string;
    name: string;
    description: string;
    rank_method: string;
    best_n: number;
    min_games: number;
  };
  rankings: Array<{
    rank: number;
    iscored_username: string;
    discord_user_id?: string;
    total_points: number;
    games_played: number;
    avatar_hash?: string | null;
  }>;
}

// --- Constants ---

export const TOURNAMENT_COLORS: Record<string, string> = {
  DG:       'border-neon-magenta/50',
  'WG-VPXS': 'border-neon-blue/50',
  'WG-VR':  'border-neon-purple/50',
  MG:       'border-neon-coral/50',
};

export const RANKINGS_TOP_N = 10;

export const TOURNAMENT_BADGE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  DG:       { bg: 'rgba(236,72,153,0.15)', text: '#ec4899', border: 'rgba(236,72,153,0.3)' },
  'WG-VPXS': { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6', border: 'rgba(59,130,246,0.3)' },
  'WG-VR':  { bg: 'rgba(168,85,247,0.15)', text: '#a855f7', border: 'rgba(168,85,247,0.3)' },
  MG:       { bg: 'rgba(251,146,60,0.15)', text: '#fb923c', border: 'rgba(251,146,60,0.3)' },
};

export const METHOD_LABELS: Record<string, { label: string; scoreLabel: string }> = {
  max_10: { label: 'Max 10', scoreLabel: 'Points' },
  average_rank: { label: 'Average Rank', scoreLabel: 'Avg Rank' },
  best_game_papa: { label: 'Best Game (PAPA)', scoreLabel: 'Points' },
  best_game_linear: { label: 'Best Game (Linear)', scoreLabel: 'Points' },
};

// --- Helper functions ---

export function getTournamentBorderColor(type: string): string {
  if (!type) return 'border-border';
  const upper = type.toUpperCase();
  return TOURNAMENT_COLORS[upper] ?? 'border-border';
}

export function getTitleStyleClass(style: string): string {
  switch (style) {
    case 'glow': return 'title-glow';
    case 'retro': return 'title-retro';
    case 'pixel': return 'title-pixel';
    case 'neon-magenta': return 'title-neon-magenta';
    case 'chrome': return 'title-chrome';
    case 'fire': return 'title-fire';
    case 'plasma': return 'title-plasma';
    case 'backglass': return 'title-backglass';
    case 'marquee': return 'title-marquee';
    case 'shadow': return 'title-shadow';
    case 'outlined': return 'title-outlined';
    default: return '';
  }
}

/**
 * Returns an inline fontSize value for scoreboard title sizes.
 * These are deliberately larger than Tailwind defaults for impact on scoreboards.
 */
const TITLE_SIZE_PX: Record<string, string> = {
  xs: '16px',
  sm: '20px',
  base: '28px',
  lg: '36px',
  xl: '44px',
  '2xl': '56px',
  '3xl': '68px',
  '4xl': '80px',
};

export function getTitleSizeStyle(size: string): string {
  return TITLE_SIZE_PX[size] || TITLE_SIZE_PX.sm;
}

/** @deprecated Use getTitleSizeStyle() for inline fontSize instead */
export function getTitleSizeClass(size: string): string {
  // Keep backward compat but map to custom sizes via CSS custom properties
  switch (size) {
    case 'xs': return 'text-[16px]';
    case 'sm': return 'text-[20px]';
    case 'base': return 'text-[28px]';
    case 'lg': return 'text-[36px]';
    case 'xl': return 'text-[44px]';
    case '2xl': return 'text-[56px]';
    case '3xl': return 'text-[68px]';
    case '4xl': return 'text-[80px]';
    default: return 'text-[20px]';
  }
}

// --- Player Avatar Component ---

const AVATAR_COLORS = [
  'bg-neon-magenta', 'bg-neon-cyan', 'bg-neon-green', 'bg-neon-amber',
  'bg-neon-purple', 'bg-neon-coral', 'bg-neon-blue',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

const ANONYMOUS_SENTINELS = new Set(['SYSTEM', 'COMMUNITY', 'ANON', '']);

function isAnonymousDiscordId(discordUserId?: string | null): boolean {
  if (!discordUserId) return true;
  return ANONYMOUS_SENTINELS.has(discordUserId);
}

export function PlayerAvatar({ username, discordUserId, avatarHash, size = 24 }: {
  username: string;
  discordUserId?: string | null;
  avatarHash?: string | null;
  size?: number;
}) {
  const [imgError, setImgError] = useState(false);

  // Sentinel IDs (SYSTEM/COMMUNITY/ANON) never map to a real Discord CDN path.
  const anonymous = isAnonymousDiscordId(discordUserId);
  const hasDiscordAvatar = !anonymous && discordUserId && avatarHash && !imgError;

  if (hasDiscordAvatar) {
    return (
      <img
        src={`https://cdn.discordapp.com/avatars/${discordUserId}/${avatarHash}.png?size=64`}
        alt={username}
        width={size}
        height={size}
        className="rounded-full flex-shrink-0 object-cover"
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    );
  }

  // Sprint 10 / plan §15: anonymous rows get a themed silhouette rather than a
  // colored-letter chip so they read as "not a Discord user" at a glance.
  if (anonymous) {
    return (
      <div
        className="rounded-full flex-shrink-0 flex items-center justify-center text-muted bg-raised border border-border/60"
        style={{ width: size, height: size }}
        aria-label={`${username} (anonymous)`}
        title={`${username} — anonymous`}
      >
        <AnonymousAvatarIcon size={Math.round(size * 0.72)} />
      </div>
    );
  }

  // Colored-letter fallback (real Discord user with no avatar yet).
  const colorIndex = hashString(username) % AVATAR_COLORS.length;
  const bgColor = AVATAR_COLORS[colorIndex];
  const letter = (username[0] || '?').toUpperCase();

  return (
    <div
      className={`rounded-full flex-shrink-0 flex items-center justify-center text-white font-bold ${bgColor}`}
      style={{ width: size, height: size, fontSize: size * 0.45 }}
    >
      {letter}
    </div>
  );
}

// --- Countdown helper ---

export function formatCountdown(targetDate: string): string | null {
  const now = Date.now();
  const target = new Date(targetDate).getTime();
  const diff = target - now;
  if (diff <= 0) return null;

  const totalMinutes = Math.floor(diff / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (totalMinutes > 0) return `< 1h left`;
  return null;
}

// --- QR Code Component ---

export function GameQRCode({ slug, gameId, size = 48 }: { slug: string; gameId: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const url = `${window.location.origin}/${slug}/submit/${gameId}`;
    QRCode.toCanvas(canvasRef.current, url, {
      width: size,
      margin: 1,
      color: { dark: '#ffffff', light: '#00000000' },
    }).catch(() => {});
  }, [slug, gameId, size]);

  return <canvas ref={canvasRef} className="rounded" style={{ width: size, height: size }} />;
}

// --- Components ---

interface ScoreHistoryEntry {
  id: number;
  score: number;
  source: string;
  photo_url: string | null;
  created_at: string;
}

export interface GlobalCardStyles {
  enabled: boolean;
  cssTitle?: string;
  cssScores?: string;
  cssBox?: string;
  bgColor?: string;
}

export function GameCard({ lb, slug, maxScores: maxScoresProp, roomId, onSubmitScore, cardOpacity, scoreColumns = 1, viewerUsername, viewerEntry, qrMode = 'disabled', headerStyle = 'banner', globalStyles, wheelScale = 150, bgFill = 'off', bgSize = 'cover', cardWidth = 288, glassOpacity = 60, gameTitleStyle = 'default', gameTitleEnhance = false, scoreStyle = 'glass' }: {
  lb: GameLeaderboard; slug: string; maxScores: number; roomId?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
  cardOpacity?: number;
  scoreColumns?: number;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
  headerStyle?: string;
  globalStyles?: GlobalCardStyles;
  wheelScale?: number;
  bgFill?: string;
  bgSize?: string;
  cardWidth?: number;
  glassOpacity?: number;
  gameTitleStyle?: string;
  gameTitleEnhance?: boolean;
  scoreStyle?: string;
}) {
  // When 2-column scores are enabled, double the visible scores so both columns fill
  const maxScores = scoreColumns === 2 ? Math.max(maxScoresProp, maxScoresProp * 2) : maxScoresProp;
  const borderColor = getTournamentBorderColor(lb.tournamentType);
  const [scoreCounts, setScoreCounts] = useState<Record<string, number>>({});
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [playerHistory, setPlayerHistory] = useState<ScoreHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [photoModal, setPhotoModal] = useState<{ playerName: string; score: number; photoUrl: string | null } | null>(null);
  const [countdown, setCountdown] = useState<string | null>(
    lb.nextMaintenanceAt ? formatCountdown(lb.nextMaintenanceAt) : null
  );

  // Update countdown every 60 seconds
  useEffect(() => {
    if (!lb.nextMaintenanceAt) { setCountdown(null); return; }
    setCountdown(formatCountdown(lb.nextMaintenanceAt));
    const interval = setInterval(() => {
      setCountdown(formatCountdown(lb.nextMaintenanceAt!));
    }, 60000);
    return () => clearInterval(interval);
  }, [lb.nextMaintenanceAt]);

  // Fetch score counts for this game to know which players have multiple scores
  useEffect(() => {
    if (!roomId || !lb.gameId || lb.rankings.length === 0) return;
    fetch(`/api/rooms/${roomId}/score-counts/${lb.gameId}`)
      .then(r => r.ok ? r.json() : {})
      .then(setScoreCounts)
      .catch(() => {});
  }, [roomId, lb.gameId, lb.rankings.length]);

  const togglePlayer = (username: string) => {
    if (expandedPlayer === username) {
      setExpandedPlayer(null);
      setPlayerHistory([]);
      return;
    }
    if (!roomId) return;
    setExpandedPlayer(username);
    setHistoryLoading(true);
    fetch(`/api/rooms/${roomId}/score-history/${encodeURIComponent(lb.gameName)}/player/${encodeURIComponent(username)}`)
      .then(r => r.ok ? r.json() : [])
      .then(setPlayerHistory)
      .catch(() => setPlayerHistory([]))
      .finally(() => setHistoryLoading(false));
  };

  // Independent logo/bg override the legacy catalogue style — fall through if style lacks the image type
  const effectiveBgId = (lb.bgStyleId && lb.bgHasBg !== 0) ? lb.bgStyleId
    : (lb.catalogueStyleId && lb.catHasBg !== 0) ? lb.catalogueStyleId : null;
  const effectiveLogoId = (lb.logoStyleId && lb.logoHasHeader !== 0) ? lb.logoStyleId
    : (lb.catalogueStyleId && lb.catHasHeader !== 0) ? lb.catalogueStyleId : null;
  const styleBgUrl = effectiveBgId ? `/api/styles/images/backgrounds/${effectiveBgId}.png` : null;
  const styleHeaderUrl = effectiveLogoId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${effectiveLogoId}.png` : null;
  const bgImage = styleBgUrl || lb.imageUrl || null;
  // Use the logo as the primary "icon" image for compact/wheel/sidebar, falling back to bgImage
  const iconImage = styleHeaderUrl || bgImage;
  const isFill = bgFill === 'fill';

  // Background sizing CSS
  const bgSizeStyle = (url: string) => ({
    backgroundImage: `url(${url})`,
    backgroundSize: bgSize === 'tile' ? 'auto' : bgSize,
    backgroundRepeat: bgSize === 'tile' ? 'repeat' : 'no-repeat',
    backgroundPosition: 'top center',
  });

  // Glass-panel helper for fill mode — dynamic opacity
  const glassPanel = `backdrop-blur-sm border border-white/10 rounded-lg`;
  const glassStyle = { backgroundColor: `rgba(0,0,0,${glassOpacity / 100})` };

  const displayText = (lb as GameLeaderboard & { displayName?: string | null }).displayName || lb.gameName;

  // Game title style CSS
  const titleStyleCSS = (() => {
    switch (gameTitleStyle) {
      case 'glow': return { textShadow: '0 0 8px currentColor, 0 0 16px currentColor' };
      case 'shadow': return { textShadow: '0 2px 6px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.9)' };
      case 'outlined': return { textShadow: '-1px -1px 0 rgba(0,0,0,0.8), 1px -1px 0 rgba(0,0,0,0.8), -1px 1px 0 rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.8)' };
      case 'backlit': return {};
      default: return {};
    }
  })();
  const titleEnhanceClass = gameTitleEnhance ? 'bg-black/50 px-2 py-0.5 rounded inline-block' : '';
  const titleBacklitClass = gameTitleStyle === 'backlit' ? 'bg-black/40 px-2 py-0.5 rounded inline-block' : '';

  // Score entry style: glass uses panels, other styles use text effects with no panel
  const useGlassScores = scoreStyle === 'glass';
  const scoreTextCSS = (() => {
    switch (scoreStyle) {
      case 'glow': return { textShadow: '0 0 8px currentColor, 0 0 16px currentColor' };
      case 'shadow': return { textShadow: '0 2px 6px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.9)' };
      case 'outlined': return { textShadow: '-1px -1px 0 rgba(0,0,0,0.8), 1px -1px 0 rgba(0,0,0,0.8), -1px 1px 0 rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.8)' };
      default: return {};
    }
  })();

  return (
    <div
      className={`relative border-2 ${borderColor} rounded-lg ${headerStyle === 'wheel' ? 'overflow-visible' : 'overflow-hidden'} flex flex-col h-full`}
      style={{
        ...(globalStyles?.enabled && globalStyles.cssBox ? { borderColor: globalStyles.cssBox } : {}),
        ...(globalStyles?.enabled && globalStyles.bgColor ? { backgroundColor: globalStyles.bgColor } : {}),
      }}
    >
      {/* Background layer — opacity controlled independently */}
      <div className={`absolute inset-0 ${isFill ? '' : 'bg-surface'}`} style={{
        ...(cardOpacity != null && cardOpacity < 1 ? { opacity: cardOpacity } : {}),
        ...(!isFill && globalStyles?.enabled && globalStyles.bgColor ? { backgroundColor: globalStyles.bgColor } : {}),
      }} />
      {/* Full-bleed background image when bgFill is enabled */}
      {isFill && bgImage && (
        <div className="absolute inset-0" style={bgSizeStyle(bgImage)} />
      )}
      {isFill && <div className="absolute inset-0 bg-black/30" />}
      {/* Header: compact mode with thumbnail */}
      {headerStyle === 'compact' && iconImage ? (
        <div
          className={`flex items-center gap-3 px-4 py-3 border-b ${isFill ? 'border-white/10' : 'border-border/30'} relative ${isFill ? glassPanel + ' m-2 mb-0' : ''} ${onSubmitScore ? 'cursor-pointer hover:bg-raised/50 transition-colors group' : ''}`}
          style={isFill ? glassStyle : undefined}
          onClick={onSubmitScore ? () => onSubmitScore(lb) : undefined}
        >
          <div className="w-12 h-12 flex-shrink-0 rounded overflow-hidden bg-raised">
            <img src={iconImage} alt="" className="w-full h-full object-contain" />
          </div>
          <div className="min-w-0 flex-1">
            {(
              <h3 className={`font-display font-bold leading-tight truncate ${isFill ? 'text-white' : ''} ${titleEnhanceClass} ${titleBacklitClass} flex items-center gap-1`} style={{ fontSize: '0.875rem', ...titleStyleCSS, ...(globalStyles?.enabled && globalStyles.cssTitle ? { color: globalStyles.cssTitle } : {}) }}>
                {displayText}
                <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={13} />
              </h3>
            )}
            {lb.tournamentName && <p className={`text-[11px] uppercase tracking-wider mt-0.5 ${isFill ? 'text-white/60' : 'text-muted'}`}>{lb.tournamentName}</p>}
          </div>
          {lb.gameStatus === 'COMPLETED' && <span title="Completed" className="flex-shrink-0"><Lock size={14} className="text-neon-amber" /></span>}
          {onSubmitScore && (
            <span className="absolute left-3 top-3 hidden"><Upload size={14} className="text-faint group-hover:text-neon-cyan transition-colors" /></span>
          )}
        </div>
      ) : headerStyle === 'wheel' ? (
        <>
          {/* Wheel mode: icon sits on top of card, poking above the border */}
          <div
            className={`relative flex flex-col items-center ${onSubmitScore ? 'cursor-pointer' : ''}`}
            onClick={onSubmitScore ? () => onSubmitScore(lb) : undefined}
          >
            {/* Wheel icon — negative top margin pushes it above the card edge */}
            {iconImage && (
              <div className="flex items-center justify-center z-10" style={{ height: `${wheelScale * 0.07}rem`, marginTop: '-2.5rem' }}>
                <img
                  src={iconImage}
                  alt=""
                  className="h-full max-w-full object-contain drop-shadow-lg"
                />
              </div>
            )}
            {/* Title + tournament below the wheel */}
            <div className="w-full text-center px-4 pb-2 pt-1 relative">
              {(
                <h3
                  className={`font-display font-bold leading-tight truncate ${titleEnhanceClass} ${titleBacklitClass} flex items-center justify-center gap-1`}
                  style={{ fontSize: '0.875rem', ...titleStyleCSS, ...(globalStyles?.enabled && globalStyles.cssTitle ? { color: globalStyles.cssTitle } : {}) }}
                >
                  {displayText}
                  <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={13} />
                </h3>
              )}
              {lb.tournamentName && <p className={`text-[11px] uppercase tracking-wider mt-0.5 ${isFill ? 'text-white/60' : 'text-muted'}`}>{lb.tournamentName}</p>}
              {lb.gameStatus === 'COMPLETED' && <span title="Completed" className="absolute right-3 top-1"><Lock size={14} className="text-neon-amber" /></span>}
              {onSubmitScore && (
                <span className="absolute left-3 top-1"><Upload size={14} className="text-faint group-hover:text-neon-cyan transition-colors" /></span>
              )}
            </div>
          </div>
        </>
      ) : headerStyle === 'sidebar' ? (
        <div
          className={`flex items-center border-b ${isFill ? 'border-white/10' : 'border-border/30'} relative ${isFill ? glassPanel + ' m-2 mb-0' : ''} ${onSubmitScore ? 'cursor-pointer hover:bg-raised/50 transition-colors group' : ''}`}
          style={isFill ? glassStyle : undefined}
          onClick={onSubmitScore ? () => onSubmitScore(lb) : undefined}
        >
          {/* Image panel on the left — square, proportional to title height */}
          {iconImage && (
            <div className="w-16 h-16 flex-shrink-0 bg-raised relative overflow-hidden rounded">
              <img
                src={iconImage}
                alt=""
                className="w-full h-full object-contain"
              />
            </div>
          )}
          {/* Title + tournament on the right */}
          <div className="flex-1 min-w-0 px-4 py-3 flex flex-col justify-center">
            {(
              <h3
                className={`font-display font-bold leading-tight truncate ${titleEnhanceClass} ${titleBacklitClass} flex items-center gap-1`}
                style={{ fontSize: '0.875rem', ...titleStyleCSS, ...(globalStyles?.enabled && globalStyles.cssTitle ? { color: globalStyles.cssTitle } : {}) }}
              >
                {displayText}
                <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={13} />
              </h3>
            )}
            {lb.tournamentName && <p className={`text-[11px] uppercase tracking-wider mt-0.5 ${isFill ? 'text-white/60' : 'text-muted'}`}>{lb.tournamentName}</p>}
          </div>
          {/* Status icons */}
          <div className="flex items-center gap-1.5 pr-3 flex-shrink-0">
            {lb.gameStatus === 'COMPLETED' && <span title="Completed"><Lock size={14} className="text-neon-amber" /></span>}
            {onSubmitScore && <Upload size={14} className="text-faint group-hover:text-neon-cyan transition-colors" />}
          </div>
        </div>
      ) : (
        <>
          {/* Title area — clickable to submit score if handler provided */}
          <div
            className={`px-4 py-3 text-center border-b ${isFill ? 'border-white/10' : 'border-border/30'} relative ${isFill ? glassPanel + ' m-2 mb-0' : ''} ${onSubmitScore ? 'cursor-pointer hover:bg-raised/50 transition-colors group' : ''}`}
            style={isFill ? glassStyle : undefined}
            onClick={onSubmitScore ? () => onSubmitScore(lb) : undefined}
          >
            {(
              <h3 className={`font-display font-bold leading-tight truncate px-5 ${isFill ? 'text-white' : ''} ${titleEnhanceClass} ${titleBacklitClass} flex items-center justify-center gap-1`} style={{ fontSize: '0.875rem', ...titleStyleCSS, ...(globalStyles?.enabled && globalStyles.cssTitle ? { color: globalStyles.cssTitle } : {}) }}>
                {displayText}
                <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={13} />
              </h3>
            )}
            {lb.gameStatus === 'COMPLETED' && <span title="Completed" className="absolute right-3 top-3"><Lock size={14} className="text-neon-amber" /></span>}
            {onSubmitScore && (
              <span className="absolute left-3 top-3"><Upload size={14} className="text-faint group-hover:text-neon-cyan transition-colors" /></span>
            )}
            {lb.tournamentName && <p className={`text-[11px] uppercase tracking-wider mt-0.5 ${isFill ? 'text-white/60' : 'text-muted'}`}>{lb.tournamentName}</p>}
          </div>

          {/* Background image area — only shown in non-fill mode (fill mode uses the full card) */}
          {bgImage && !isFill && (
            <div
              className={`relative h-28 bg-raised ${onSubmitScore ? 'cursor-pointer' : ''}`}
              onClick={onSubmitScore ? () => onSubmitScore(lb) : undefined}
            >
              <div className="absolute inset-0" style={bgSizeStyle(bgImage)} />
              {styleHeaderUrl && (
                <img src={styleHeaderUrl} alt="" className="absolute inset-0 w-full h-full object-contain z-[1]" />
              )}
            </div>
          )}
        </>
      )}

      {/* Scores */}
      <div className={`flex-1 relative ${isFill && useGlassScores ? glassPanel + ' m-2' : isFill ? 'm-2' : ''}`} style={isFill && useGlassScores ? glassStyle : undefined}>
        {lb.rankings.length === 0 ? (
          <div className="py-8 text-center">
            <p className={`text-sm ${isFill ? 'text-white/40' : 'text-faint'}`}>No scores yet</p>
          </div>
        ) : (
          <div>
            {(() => {
              // Build the visible entries list, injecting viewer entry if outside top N
              const lowerViewer = viewerUsername?.toLowerCase();
              let visibleEntries = lb.rankings.slice(0, maxScores);
              let viewerInjected = false;

              if (viewerEntry && lowerViewer) {
                const viewerInVisible = visibleEntries.some(
                  e => e.iscored_username.toLowerCase() === lowerViewer
                );
                if (!viewerInVisible && viewerEntry.rank > maxScores) {
                  // Replace last slot with viewer's entry
                  visibleEntries = [...visibleEntries.slice(0, maxScores - 1), viewerEntry];
                  viewerInjected = true;
                }
              }

              const useTwoColumns = scoreColumns === 2 && visibleEntries.length > 1 && cardWidth >= 288;
              const midpoint = useTwoColumns ? Math.ceil(visibleEntries.length / 2) : visibleEntries.length;
              const col1 = visibleEntries.slice(0, midpoint);
              const col2 = useTwoColumns ? visibleEntries.slice(midpoint) : [];

              const isCompactLayout = headerStyle === 'compact';

              const renderEntry = (entry: RankedEntry, isViewerRow: boolean, showSeparator: boolean) => {
                const hasMultiple = scoreCounts[entry.iscored_username.toLowerCase()] > 1;
                const isExpanded = expandedPlayer === entry.iscored_username;
                const rankColor = entry.rank === 1 ? 'text-neon-amber' :
                  entry.rank === 2 ? 'text-neon-cyan' :
                  entry.rank === 3 ? 'text-neon-green' :
                  isFill ? 'text-white/50' : 'text-faint';
                const scoreColor = entry.rank === 1 ? 'text-neon-amber' : isViewerRow ? 'text-neon-cyan' : isFill ? 'text-white' : 'text-primary';
                const formattedScore = entry.score >= 1_000_000_000_000
                  ? `${(entry.score / 1_000_000_000_000).toFixed(1)}T`
                  : entry.score.toLocaleString();

                return (
                  <div key={`${entry.rank}-${entry.iscored_username}`}>
                    {showSeparator && (
                      <div className="border-t border-dashed border-neon-cyan/30 my-0.5" />
                    )}
                    {isCompactLayout ? (
                      /* Compact: stacked vertical layout — name above score */
                      <div
                        className={`flex flex-col items-center text-center px-2 py-2.5 border-b ${isFill ? 'border-white/10' : 'border-border/20'} last:border-0 ${
                          entry.rank === 1 ? 'bg-neon-amber/8' : ''
                        } ${isViewerRow ? 'bg-neon-cyan/10 border-l-2 border-l-neon-cyan' : ''}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`font-display font-bold ${rankColor}`} style={{ fontSize: '0.8125rem', ...scoreTextCSS }}>
                            {entry.rank}
                          </span>
                          <PlayerAvatar username={entry.iscored_username} discordUserId={entry.discord_user_id} avatarHash={entry.avatar_hash} size={20} />
                          <span className={`truncate max-w-[10rem] ${isViewerRow ? 'text-neon-cyan font-medium' : isFill ? 'text-white' : ''}`} style={{ fontSize: '0.8125rem', ...scoreTextCSS }}>{entry.iscored_username}</span>
                        </div>
                        <span
                          className={`font-display font-bold mt-0.5 ${scoreColor}`}
                          style={{ fontSize: '0.875rem', ...scoreTextCSS, ...(globalStyles?.enabled && globalStyles.cssScores ? { color: globalStyles.cssScores } : {}) }}
                          title={entry.score >= 1_000_000_000_000 ? entry.score.toLocaleString() : undefined}
                        >
                          {formattedScore}
                        </span>
                      </div>
                    ) : (
                      /* Default: horizontal row — name left, score right */
                      <div
                        className={`flex items-center justify-between px-3 py-2 border-b ${isFill ? 'border-white/10' : 'border-border/20'} last:border-0 ${
                          entry.rank === 1 ? 'bg-neon-amber/8' : ''
                        } ${isViewerRow ? 'bg-neon-cyan/10 border-l-2 border-l-neon-cyan' : ''
                        } ${hasMultiple && !useTwoColumns ? 'cursor-pointer hover:bg-raised/50 transition-colors' : ''}`}
                        onClick={hasMultiple && !useTwoColumns ? () => togglePlayer(entry.iscored_username) : undefined}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`font-display font-bold w-6 text-center flex-shrink-0 ${rankColor}`} style={{ fontSize: '0.8125rem', ...scoreTextCSS }}>
                            {entry.rank}
                          </span>
                          <PlayerAvatar username={entry.iscored_username} discordUserId={entry.discord_user_id} avatarHash={entry.avatar_hash} size={20} />
                          <span className={`truncate max-w-[55%] ${isViewerRow ? 'text-neon-cyan font-medium' : isFill ? 'text-white' : ''}`} style={{ fontSize: '0.8125rem', ...scoreTextCSS }}>{entry.iscored_username}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`font-display font-bold flex-shrink-0 ${scoreColor}`}
                            style={{ fontSize: '0.8125rem', ...scoreTextCSS, ...(globalStyles?.enabled && globalStyles.cssScores ? { color: globalStyles.cssScores } : {}) }}
                            title={entry.score >= 1_000_000_000_000 ? entry.score.toLocaleString() : undefined}
                          >
                            {formattedScore}
                          </span>
                          {hasMultiple && !useTwoColumns && (
                            isExpanded
                              ? <Minus size={12} className="text-neon-cyan flex-shrink-0" />
                              : <Plus size={12} className="text-faint flex-shrink-0" />
                          )}
                        </div>
                      </div>
                    )}
                    {isExpanded && !useTwoColumns && (
                      <div className="bg-deep/50 border-b border-border/20 px-4 py-2">
                        {historyLoading ? (
                          <p className="text-faint text-xs py-1">Loading...</p>
                        ) : playerHistory.length > 0 ? (
                          <div className="space-y-1">
                            {playerHistory.map(h => (
                              <div key={h.id} className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-muted">{h.score.toLocaleString()}</span>
                                  {h.photo_url && (
                                    <button
                                      className="text-neon-cyan hover:text-neon-cyan/80 transition-colors cursor-pointer"
                                      onClick={(e) => { e.stopPropagation(); setPhotoModal({ playerName: expandedPlayer || '', score: h.score, photoUrl: h.photo_url }); }}
                                      title="View score photo"
                                    >
                                      <Camera size={12} />
                                    </button>
                                  )}
                                </div>
                                <span className="text-faint">{new Date(h.created_at).toLocaleDateString()}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-faint text-xs py-1">No additional scores recorded.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              };

              const isViewerEntry = (entry: RankedEntry) =>
                !!lowerViewer && entry.iscored_username.toLowerCase() === lowerViewer;

              if (useTwoColumns) {
                return (
                  <>
                    {/* Two-column grid: collapses to 1 on small screens */}
                    <div className="grid grid-cols-1 sm:grid-cols-2">
                      <div className={`sm:border-r ${isFill ? 'sm:border-white/10' : 'sm:border-border/20'}`}>
                        {col1.map((entry, i) => renderEntry(
                          entry,
                          isViewerEntry(entry),
                          viewerInjected && i === col1.length - 1 && isViewerEntry(entry)
                        ))}
                      </div>
                      <div>
                        {col2.map((entry, i) => renderEntry(
                          entry,
                          isViewerEntry(entry),
                          viewerInjected && i === col2.length - 1 && isViewerEntry(entry)
                        ))}
                      </div>
                    </div>
                  </>
                );
              }

              return (
                <>
                  {visibleEntries.map((entry, i) => renderEntry(
                    entry,
                    isViewerEntry(entry),
                    viewerInjected && i === visibleEntries.length - 1
                  ))}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Viewer's best score */}
      {viewerEntry && (
        <div className={`${isFill && useGlassScores ? glassPanel + ' mx-2 px-3 py-1.5' : isFill ? 'mx-2 px-3 py-1.5' : 'border-t border-border/20 pt-2 mt-2 px-4 pb-3'} relative`} style={isFill && useGlassScores ? glassStyle : undefined}>
          <p className="text-xs text-neon-cyan/70" style={scoreTextCSS}>
            Your best: {viewerEntry.score.toLocaleString()} (Rank #{viewerEntry.rank})
          </p>
        </div>
      )}

      {/* Footer: link inside glass panel, QR code outside */}
      <div className={`relative flex items-center ${isFill ? 'mx-2 mb-2 mt-1 gap-2' : 'border-t border-border/50'}`}>
        <div className={`${isFill && useGlassScores ? glassPanel + ' px-3 py-2 flex-1' : isFill ? 'px-3 py-2 flex-1' : 'px-4 py-2.5 flex-1'} flex items-center gap-2`} style={isFill && useGlassScores ? glassStyle : undefined}>
          <Link
            to={`/${slug}/games/${encodeURIComponent(lb.gameName)}`}
            className="text-xs text-neon-cyan hover:text-neon-cyan/80 no-underline transition-colors"
            style={scoreTextCSS}
          >
            Full Leaderboard &rarr;
          </Link>
          {countdown && (
            <span className={`text-[11px] ${isFill ? 'text-white/50' : 'text-muted'} ml-auto`} style={scoreTextCSS} title="Time until next rotation">
              {countdown}
            </span>
          )}
        </div>
        {qrMode !== 'disabled' && (
          <div className={`flex-shrink-0 ${isFill ? '' : 'pr-3 py-2'}`}>
            <GameQRCode slug={slug} gameId={lb.gameId} size={40} />
          </div>
        )}
      </div>

      {/* Score photo modal */}
      {photoModal && (
        <ScorePhotoModal
          playerName={photoModal.playerName}
          score={photoModal.score}
          photoUrl={photoModal.photoUrl}
          onClose={() => setPhotoModal(null)}
        />
      )}
    </div>
  );
}

export function RankingGroupCard({ group, rankings, cardOpacity, scoreboardStyle, showcaseThemeName, qrTopPad = 0 }: {
  group: RankingGroupData['group'];
  rankings: RankingGroupData['rankings'];
  cardOpacity?: number;
  scoreboardStyle?: string;
  showcaseThemeName?: string;
  qrTopPad?: number; // extra top margin to align with game cards that have QR above them
}) {
  const methodInfo = METHOD_LABELS[group.rank_method] || { label: group.rank_method, scoreLabel: 'Score' };
  const showcaseTheme = scoreboardStyle === 'showcase'
    ? SHOWCASE_THEMES[showcaseThemeName || DEFAULT_SHOWCASE_THEME] ?? SHOWCASE_THEMES[DEFAULT_SHOWCASE_THEME]
    : undefined;

  const rankColor = (rank: number) =>
    rank === 1 ? 'text-neon-amber' : rank === 2 ? 'text-neon-cyan' : rank === 3 ? 'text-neon-green' : 'text-faint';

  const scoreDisplay = (entry: RankingGroupData['rankings'][0]) =>
    group.rank_method === 'average_rank' ? entry.total_points.toFixed(2) : entry.total_points.toLocaleString();

  const rankingRows = (borderStyle: string) => (
    rankings.length === 0 ? (
      <div className="py-8 text-center relative">
        <p className="text-faint text-sm">No ranked players yet</p>
      </div>
    ) : (
      <div className="relative">
        {rankings.slice(0, RANKINGS_TOP_N).map((entry) => (
          <div
            key={entry.iscored_username}
            className={`flex items-center gap-2.5 px-3 py-2 ${entry.rank === 1 ? 'bg-neon-amber/8' : ''}`}
            style={{ borderBottom: borderStyle }}
          >
            <span className={`font-display font-bold text-sm w-5 text-left flex-shrink-0 tabular-nums ${rankColor(entry.rank)}`}>
              {entry.rank}
            </span>
            <PlayerAvatar username={entry.iscored_username} discordUserId={entry.discord_user_id} avatarHash={entry.avatar_hash} size={24} />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-secondary truncate">{entry.iscored_username}</div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-bold tabular-nums ${entry.rank === 1 ? 'text-neon-amber' : 'text-primary'}`}>
                  {scoreDisplay(entry)}
                </span>
                <span className="text-xs text-faint">Games: {entry.games_played}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  );

  // ── Showcase style ──
  if (scoreboardStyle === 'showcase' && showcaseTheme) {
    const border = showcaseTheme.cardBorder.replace(/1px solid /, '');
    return (
      <div style={{ position: 'relative', paddingTop: 42, marginTop: qrTopPad, maxWidth: '100%' }}>
        <link rel="stylesheet" href={showcaseTheme.googleFontsUrl} />
        <div style={{
          width: 380,
          maxWidth: '100%',
          position: 'relative',
          overflow: 'hidden',
          borderRadius: showcaseTheme.cardBorderRadius,
          border: showcaseTheme.cardBorder,
          background: showcaseTheme.cardBg,
          boxShadow: showcaseTheme.cardShadow,
          backdropFilter: showcaseTheme.backdropFilter,
          fontFamily: showcaseTheme.fontFamily,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}>
          {cardOpacity != null && cardOpacity < 1 && (
            <div className="absolute inset-0" style={{ background: `${border}22`, opacity: cardOpacity }} />
          )}
          <div className="px-5 pt-5 pb-3 text-center relative" style={{ borderBottom: `1px solid ${border}33` }}>
            <h2 style={{
              fontSize: 18,
              fontWeight: 700,
              color: showcaseTheme.titleColor,
              textShadow: showcaseTheme.titleTextShadow,
              lineHeight: 1.2,
              marginBottom: 4,
              fontFamily: showcaseTheme.fontFamily,
            }}>
              OVERALL RANKINGS
            </h2>
            <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-muted)' }}>
              {group.name}
            </p>
          </div>
          <div className="flex-1">{rankingRows(`1px solid ${border}22`)}</div>
          <div className="px-3 py-2 text-center relative" style={{ borderTop: `1px solid ${border}33`, fontSize: 10, color: 'var(--color-faint)' }}>
            {rankings.length} player{rankings.length !== 1 ? 's' : ''} &middot; {methodInfo.label}
          </div>
        </div>
      </div>
    );
  }

  // ── Minimal style ──
  if (scoreboardStyle === 'minimal') {
    return (
      <div style={{ position: 'relative', marginTop: qrTopPad || undefined, maxWidth: '100%' }}>
        <div style={{
          width: 380,
          maxWidth: '100%',
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '0.5rem',
          border: '1px solid rgba(var(--border-rgb, 128,128,128), 0.4)',
          background: 'var(--color-surface, #1a1a2e)',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}>
          {cardOpacity != null && cardOpacity < 1 && (
            <div className="absolute inset-0 bg-raised" style={{ opacity: cardOpacity }} />
          )}
          <div className="px-5 pt-4 pb-3 relative" style={{ borderBottom: '1px solid rgba(var(--border-rgb, 128,128,128), 0.1)' }}>
            <h3 className="font-display font-bold leading-tight text-primary" style={{ fontSize: '1rem' }}>OVERALL RANKINGS</h3>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-[11px] uppercase tracking-wider text-muted">{group.name}</span>
            </div>
          </div>
          <div className="flex-1">{rankingRows('1px solid rgba(var(--border-rgb, 128,128,128), 0.1)')}</div>
          <div className="px-3 py-2 text-center text-[10px] text-faint relative" style={{ borderTop: '1px solid rgba(var(--border-rgb, 128,128,128), 0.1)' }}>
            {rankings.length} player{rankings.length !== 1 ? 's' : ''} &middot; {methodInfo.label}
          </div>
        </div>
      </div>
    );
  }

  // ── Banner style (default) ──
  return (
    <div style={{ position: 'relative', width: 280, display: 'flex', flexDirection: 'column', height: '100%', marginTop: qrTopPad || undefined }}>
      <div className="relative border-2 border-border rounded-lg overflow-hidden flex flex-col flex-1">
        <div className="absolute inset-0 bg-surface" />
        <div className="px-4 py-3 text-center border-b border-border/30 relative">
          <h3 className="font-display font-bold leading-tight" style={{ fontSize: '0.875rem' }}>OVERALL RANKINGS</h3>
          <p className="text-[11px] uppercase tracking-wider mt-0.5 text-muted">{group.name}</p>
        </div>
        <div className="flex-1 relative">{rankingRows('1px solid rgba(var(--border-rgb, 128,128,128), 0.1)')}</div>
        <div className="border-t border-border/30 px-3 py-2 text-center text-[10px] text-faint relative">
          {rankings.length} player{rankings.length !== 1 ? 's' : ''} &middot; {methodInfo.label}
        </div>
      </div>
    </div>
  );
}

interface RankingsProps {
  rankingGroups: RankingGroupData[];
  cardOpacity?: number;
  scoreboardStyle?: string;
  showcaseThemeName?: string;
  sticky?: boolean;
}

export function RankingsColumn({ rankingGroups, cardOpacity, scoreboardStyle, showcaseThemeName, sticky }: RankingsProps) {
  // Match Showcase card paddingTop so Rankings aligns with card frames, not identifier images
  const topPad = scoreboardStyle === 'showcase' ? 42 : 0;
  // Match width to the current card style
  const colWidth = scoreboardStyle === 'showcase' || scoreboardStyle === 'minimal' ? 380
    : scoreboardStyle === 'banner' ? 280 : 320;
  return (
    <div className={`w-full flex-shrink-0 ${sticky ? 'lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto' : ''}`} style={{ ...(topPad ? { paddingTop: topPad } : {}), maxWidth: colWidth }}>
      <div className="flex flex-col gap-5">
        {rankingGroups.map(({ group, rankings }) => (
          <RankingGroupCard key={group.id} group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={scoreboardStyle} showcaseThemeName={showcaseThemeName} />
        ))}
      </div>
    </div>
  );
}

export function RankingsRow({ rankingGroups, cardOpacity, scoreboardStyle, showcaseThemeName }: RankingsProps) {
  const cardW = scoreboardStyle === 'showcase' || scoreboardStyle === 'minimal' ? 380
    : scoreboardStyle === 'banner' ? 280 : 320;
  return (
    <div className="mb-6">
      <div className="flex gap-5 overflow-x-auto pb-2">
        {rankingGroups.map(({ group, rankings }) => (
          <div key={group.id} className="flex-shrink-0" style={{ width: cardW }}>
            <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={scoreboardStyle} showcaseThemeName={showcaseThemeName} />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Layout helpers ---

export const cardWidthMap: Record<string, number> = { small: 240, medium: 288, large: 360 };
