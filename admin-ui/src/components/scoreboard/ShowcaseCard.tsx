import { useEffect, useState } from 'react';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { formatCountdown } from '../ScoreboardComponents';
import type { ShowcaseThemeConfig } from '../../lib/scoreboardThemes';
import ShowcasePodium from './ShowcasePodium';
import ScoreList from './ScoreList';
import { CircuitBoardBackground, GlowNodes, ScanlineOverlay, PodiumBackground } from './neonCircuitAssets';

interface ShowcaseCardProps {
  lb: GameLeaderboard;
  slug: string;
  roomId?: string;
  theme: ShowcaseThemeConfig;
  maxScores: number;
  showTimer?: boolean;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
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
  showTimer = true,
}: ShowcaseCardProps) {
  const { styleHeaderUrl } = resolveImages(lb);
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

  // Image float top padding — gives space for floating identifier image
  const hasFloatImage = !!styleHeaderUrl;
  const floatPadTop = hasFloatImage ? 42 : 0;

  return (
    <div style={{ position: 'relative', paddingTop: floatPadTop }}>
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
        position: 'relative',
        overflow: 'hidden',
        borderRadius: theme.cardBorderRadius,
        border: theme.cardBorder,
        background: theme.cardBg,
        boxShadow: theme.cardShadow,
        backdropFilter: theme.backdropFilter,
        fontFamily: theme.fontFamily,
      }}>
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
        <div style={{ position: 'relative', zIndex: 4 }}>
          {/* Title area */}
          <div style={{
            textAlign: 'center',
            padding: hasFloatImage ? '90px 24px 4px' : '20px 24px 4px',
          }}>
            <h2 style={{
              fontSize: 18,
              fontWeight: 700 as const,
              color: theme.titleColor,
              textShadow: theme.titleTextShadow,
              lineHeight: 1.2,
              marginBottom: 6,
              fontFamily: theme.fontFamily,
            }}>
              {displayName}
            </h2>

            {/* Meta: badge + timer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <span style={{
                padding: '3px 10px',
                borderRadius: theme.badgeBorder ? 4 : 6,
                background: theme.badgeBg,
                border: theme.badgeBorder || 'none',
                color: theme.badgeColor,
                fontSize: 8,
                letterSpacing: 3,
                textTransform: 'uppercase' as const,
                fontWeight: 500,
              }}>
                {lb.tournamentType === 'DG' ? 'Daily Grind' :
                 lb.tournamentType === 'WG-VPXS' ? 'Weekly Grind' :
                 lb.tournamentType === 'WG-VR' ? 'VR Weekly' :
                 lb.tournamentType === 'MG' ? 'Monthly Grind' :
                 lb.tournamentName}
              </span>
              {showTimer && countdown && (
                <span style={{
                  fontSize: 9,
                  color: theme.timerColor,
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
            borderTop: `1px solid ${theme.footerBorder}`,
            padding: '10px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <a
              href={`/${slug}`}
              style={{
                fontSize: 12,
                color: theme.linkColor,
                fontWeight: 500,
                textDecoration: 'none',
                letterSpacing: theme.linkLetterSpacing ? parseFloat(theme.linkLetterSpacing) : undefined,
                textTransform: 'uppercase' as const,
              }}
            >
              Full Leaderboard &rarr;
            </a>
            <span style={{ fontSize: 11, color: theme.metaColor }}>
              {lb.rankings.length} player{lb.rankings.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
