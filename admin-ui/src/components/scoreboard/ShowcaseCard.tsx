import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { formatCountdown, TOURNAMENT_BADGE_COLORS } from '../ScoreboardComponents';
import type { ShowcaseThemeConfig } from '../../lib/scoreboardThemes';
import ShowcasePodium from './ShowcasePodium';
import ScoreList from './ScoreList';
import GameInfoPopup from './GameInfoPopup';
import { CircuitBoardBackground, GlowNodes, ScanlineOverlay, PodiumBackground } from './neonCircuitAssets';

interface ShowcaseCardProps {
  lb: GameLeaderboard;
  slug: string;
  roomId?: string;
  theme: ShowcaseThemeConfig;
  maxScores: number;
  minScores?: number;
  showTimer?: boolean;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
  cardBgFill?: boolean;
  titleFontSize?: number;
  onSubmitScore?: (lb: GameLeaderboard) => void;
}

function resolveImages(lb: GameLeaderboard) {
  const effectiveBgId = (lb.bgStyleId && lb.bgHasBg !== 0) ? lb.bgStyleId
    : (lb.catalogueStyleId && lb.catHasBg !== 0) ? lb.catalogueStyleId : null;
  const effectiveLogoId = (lb.logoStyleId && lb.logoHasHeader !== 0) ? lb.logoStyleId
    : (lb.catalogueStyleId && lb.catHasHeader !== 0) ? lb.catalogueStyleId : null;
  const styleBgUrl = effectiveBgId ? `/api/styles/images/backgrounds/${effectiveBgId}.png` : null;
  const styleHeaderUrl = effectiveLogoId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${effectiveLogoId}.png` : null;
  return { styleBgUrl, styleHeaderUrl };
}

export default function ShowcaseCard({
  lb,
  slug,
  theme,
  maxScores,
  minScores = 20,
  showTimer = true,
  cardBgFill = false,
  titleFontSize,
  onSubmitScore,
}: ShowcaseCardProps) {
  const { styleBgUrl, styleHeaderUrl } = resolveImages(lb);
  const displayName = lb.displayName || lb.gameName;

  const [countdown, setCountdown] = useState<string | null>(
    lb.nextMaintenanceAt ? formatCountdown(lb.nextMaintenanceAt) : null
  );

  useEffect(() => {
    if (!lb.nextMaintenanceAt) { setCountdown(null); return; }
    setCountdown(formatCountdown(lb.nextMaintenanceAt));
    const interval = setInterval(() => {
      setCountdown(formatCountdown(lb.nextMaintenanceAt!));
    }, 60000);
    return () => clearInterval(interval);
  }, [lb.nextMaintenanceAt]);

  const podiumEntries = lb.rankings.slice(0, 3);
  const listEntries = lb.rankings.slice(3, maxScores);
  const isChipPodium = theme.podiumVariant === 'chip';

  // Minimum height: podium (~180px) + remaining score rows (~32px each)
  const minListRows = Math.max(0, minScores - 3);
  const contentMinHeight = 180 + minListRows * 32;

  // Uniform top padding — all Showcase cards reserve space for identifier images
  // so card frames align even when some cards have identifiers and others don't
  const hasFloatImage = !!styleHeaderUrl;
  const floatPadTop = 42;

  return (
    <div style={{ position: 'relative', paddingTop: floatPadTop, maxWidth: '100%' }}>
      {/* Google Fonts */}
      <link rel="stylesheet" href={theme.googleFontsUrl} />

      {/* Floating identifier image */}
      {hasFloatImage && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
          filter: 'drop-shadow(0 6px 20px rgba(0,0,0,0.7))',
        }}>
          <img
            src={styleHeaderUrl!}
            alt=""
            style={{ display: 'block', objectFit: 'contain', maxWidth: 180, maxHeight: 130 }}
          />
        </div>
      )}

      {/* Card shell */}
      <div style={{
        width: 380,
        maxWidth: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: theme.cardBorderRadius,
        border: theme.cardBorder,
        background: theme.cardBg,
        boxShadow: theme.cardShadow,
        backdropFilter: theme.backdropFilter,
        fontFamily: theme.fontFamily,
        minHeight: contentMinHeight,
      }}>
        {/* Card background fill */}
        {cardBgFill && styleBgUrl && (
          <>
            <div style={{
              position: 'absolute', inset: 0, zIndex: 0,
              backgroundImage: `url(${styleBgUrl})`,
              backgroundSize: 'cover', backgroundPosition: 'center',
            }} />
            <div style={{ position: 'absolute', inset: 0, zIndex: 0, background: 'rgba(0,0,0,0.55)' }} />
          </>
        )}
        {/* Background decoration (circuit board for neon-circuit) */}
        {theme.BackgroundDecoration ? <theme.BackgroundDecoration /> : null}
        {isChipPodium && <CircuitBoardBackground />}

        {/* Scanline overlay */}
        {theme.hasScanlines && <ScanlineOverlay />}

        {/* Glow nodes */}
        {theme.GlowNodes ? <theme.GlowNodes /> : null}
        {isChipPodium && <GlowNodes />}

        {/* Accent bar */}
        {theme.accentBar && (
          <div style={{
            height: 2,
            position: 'relative',
            zIndex: 3,
            background: theme.accentBar,
            boxShadow: theme.accentBarShadow,
          }} />
        )}

        {/* Content area */}
        <div style={{ position: 'relative', zIndex: 4, ...(cardBgFill ? { textShadow: '0 1px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.7)' } : {}) }}>
          {/* Title area */}
          <div
            style={{
              textAlign: 'center',
              padding: hasFloatImage ? '90px 24px 4px' : '20px 24px 4px',
              position: 'relative',
              ...(onSubmitScore ? { cursor: 'pointer' } : {}),
            }}
            onClick={onSubmitScore ? () => onSubmitScore(lb) : undefined}
          >
            {lb.gameStatus === 'COMPLETED' && (
              <span title="Completed" style={{ position: 'absolute', right: 16, top: hasFloatImage ? 94 : 20 }}>
                <Lock size={14} style={{ color: theme.badgeColor }} />
              </span>
            )}
            <h2 style={{
              fontSize: titleFontSize || 18,
              fontWeight: 700 as const,
              color: theme.titleColor,
              textShadow: theme.titleTextShadow,
              lineHeight: 1.2,
              marginBottom: 6,
              fontFamily: theme.fontFamily,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
            }}>
              {displayName}
              <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={14} />
            </h2>

            {/* Meta: badge + timer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              {(() => {
                const tBadge = lb.tournamentType ? TOURNAMENT_BADGE_COLORS[lb.tournamentType.toUpperCase()] : null;
                return (
              <span style={{
                padding: '4px 12px',
                borderRadius: tBadge ? 4 : (theme.badgeBorder ? 4 : 6),
                background: cardBgFill
                  ? (tBadge ? tBadge.bg.replace('0.15', '0.5') : 'rgba(0,0,0,0.6)')
                  : (tBadge?.bg ?? theme.badgeBg),
                border: tBadge ? `1px solid ${tBadge.border}` : (theme.badgeBorder || 'none'),
                color: tBadge?.text ?? theme.badgeColor,
                fontSize: 10,
                letterSpacing: 2,
                textTransform: 'uppercase' as const,
                fontWeight: 600,
                textShadow: cardBgFill ? '0 1px 4px rgba(0,0,0,0.8)' : undefined,
              }}>
                {lb.tournamentType === 'DG' ? 'Daily Grind' :
                 lb.tournamentType === 'WG-VPXS' ? 'Weekly Grind' :
                 lb.tournamentType === 'WG-VR' ? 'VR Weekly' :
                 lb.tournamentType === 'MG' ? 'Monthly Grind' :
                 lb.tournamentName}
              </span>
                );
              })()}
              {showTimer && countdown && (
                <span style={{
                  fontSize: 9,
                  color: cardBgFill ? 'rgba(255,255,255,0.7)' : theme.timerColor,
                  fontFamily: theme.monoFontFamily,
                  letterSpacing: 1,
                }}>
                  {countdown}
                </span>
              )}
            </div>
          </div>

          {/* Divider */}
          <div style={{
            height: 1,
            margin: '14px 20px',
            background: theme.dividerBg,
          }} />

          {/* Podium (top 3) */}
          {podiumEntries.length > 0 && (
            isChipPodium ? (
              <div style={{ position: 'relative', height: 280, margin: '0 20px' }}>
                <PodiumBackground />
                <ShowcasePodium entries={podiumEntries} theme={theme} />
              </div>
            ) : (
              <ShowcasePodium entries={podiumEntries} theme={theme} />
            )
          )}

          {/* Divider before list */}
          {listEntries.length > 0 && (
            <div style={{
              height: 1,
              margin: '14px 20px',
              background: theme.dividerBg,
            }} />
          )}

          {/* Score list (ranks 4+) */}
          <ScoreList
            entries={listEntries}
            fontFamily={theme.fontFamily}
            monoFontFamily={theme.monoFontFamily}
            zebraStripe={theme.rowZebraStripe}
            hoverBorder={theme.rowHoverBorder}
            rankColor={theme.rankColor}
            nameColor={theme.nameColor}
            scoreColor={theme.scoreColor}
            avatarBg={theme.avatarBg}
            avatarBorder={theme.avatarBorder}
            avatarColor={theme.avatarColor}
          />

          {/* Footer */}
          <div style={{
            borderTop: `1px solid ${cardBgFill ? 'rgba(255,255,255,0.15)' : theme.footerBorder}`,
            padding: '10px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            ...(cardBgFill ? { background: 'rgba(0,0,0,0.3)' } : {}),
          }}>
            <a
              href={`/${slug}`}
              style={{
                fontSize: 12,
                color: cardBgFill ? 'rgba(255,255,255,0.7)' : theme.linkColor,
                fontWeight: 500,
                textDecoration: 'none',
                letterSpacing: theme.linkLetterSpacing ? parseFloat(theme.linkLetterSpacing) : undefined,
                textTransform: 'uppercase' as const,
              }}
            >
              Full Leaderboard &rarr;
            </a>
            <span style={{ fontSize: 11, color: cardBgFill ? 'rgba(255,255,255,0.5)' : theme.metaColor }}>
              {lb.rankings.length} player{lb.rankings.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
