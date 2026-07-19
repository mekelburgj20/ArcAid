import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { formatCountdown, TOURNAMENT_BADGE_COLORS, GameQRCode, getTitleStyleClass } from '../ScoreboardComponents';
import type { ShowcaseThemeConfig } from '../../lib/scoreboardThemes';
import ShowcasePodium from './ShowcasePodium';
import ScoreList from './ScoreList';
import GameInfoPopup from './GameInfoPopup';
import { useScoreExpand } from './useScoreExpand';
import { CircuitBoardBackground, GlowNodes, ScanlineOverlay, PodiumBackground } from './neonCircuitAssets';
import { qrBottomMetrics } from '../../lib/scoreboardConfig';

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
  qrSize?: number;
  qrPosition?: string;
  qrOverlapPx?: number;
  cardBgFill?: boolean;
  titleFontSize?: number;
  gameTitleStyle?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
  /** v2.2.8 — title-click nav target. */
  titleLinkTo?: string;
  titleLinkOnClick?: (e: React.MouseEvent) => void;
}

function resolveImages(lb: GameLeaderboard) {
  const effectiveBgId = (lb.bgStyleId && lb.bgHasBg !== 0) ? lb.bgStyleId
    : (lb.catalogueStyleId && lb.catHasBg !== 0) ? lb.catalogueStyleId : null;
  const effectiveLogoId = (lb.logoStyleId && lb.logoHasHeader !== 0) ? lb.logoStyleId
    : (lb.catalogueStyleId && lb.catHasHeader !== 0) ? lb.catalogueStyleId : null;
  // v2.0.3: fall back to catalogue image when no style_id is set. Previously
  // cards with no style mapping rendered blank; now they show the default
  // catalogue art, which admins can override via the style editor.
  const styleBgUrl = effectiveBgId ? `/api/styles/images/backgrounds/${effectiveBgId}.png` : null;
  const bgImage = styleBgUrl || lb.imageUrl || null;
  const styleHeaderUrl = effectiveLogoId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${effectiveLogoId}.png` : null;
  return { bgImage, styleHeaderUrl };
}

export default function ShowcaseCard({
  lb,
  slug,
  roomId,
  theme,
  maxScores,
  minScores = 20,
  showTimer = true,
  cardBgFill = false,
  titleFontSize,
  gameTitleStyle = 'default',
  qrMode = 'disabled',
  qrSize = 30,
  qrPosition = 'top-right',
  qrOverlapPx = 10,
  onSubmitScore: _onSubmitScore,  // v2.2.8: unused (title is a Link); kept for CardRouter spread compat
  titleLinkTo,
  titleLinkOnClick,
}: ShowcaseCardProps) {
  const { bgImage, styleHeaderUrl } = resolveImages(lb);
  const displayName = lb.displayName || lb.gameName;
  const { expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple } = useScoreExpand(roomId, lb.gameId, lb.gameName, lb.rankings.length);

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

  // Bottom-center QR needs extra bottom margin so next card isn't overlapped
  const qrMetrics = qrBottomMetrics(qrSize, qrMode !== 'disabled', qrPosition, qrOverlapPx);

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
            decoding="async"
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
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Card background fill — v2.0.3: accepts catalogue image fallback too. */}
        {cardBgFill && bgImage && (
          <>
            <div style={{
              position: 'absolute', inset: 0, zIndex: 0,
              backgroundImage: `url(${bgImage})`,
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
        <div style={{ position: 'relative', zIndex: 4, display: 'flex', flexDirection: 'column', flex: 1, ...(cardBgFill ? { textShadow: '0 1px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.7)' } : {}) }}>
          {/* Title area. v2.2.8: title is a Link to Room Game Detail. */}
          <div
            style={{
              textAlign: 'center',
              padding: hasFloatImage ? '90px 24px 4px' : '20px 24px 4px',
              position: 'relative',
            }}
          >
            {titleLinkTo ? (
              <Link
                to={titleLinkTo}
                onClick={titleLinkOnClick}
                className={getTitleStyleClass(gameTitleStyle)}
                style={{
                  fontSize: titleFontSize || 18,
                  fontWeight: 700 as const,
                  ...(gameTitleStyle === 'default' ? { color: theme.titleColor, textShadow: theme.titleTextShadow } : {}),
                  lineHeight: 1.2,
                  marginBottom: 6,
                  fontFamily: theme.fontFamily,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  gap: 4,
                  overflowWrap: 'break-word',
                  wordBreak: 'break-word',
                  textAlign: 'center',
                  textDecoration: 'none',
                }}
              >
                {displayName}
                <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={14} />
              </Link>
            ) : (
              <h2 className={getTitleStyleClass(gameTitleStyle)} style={{
                fontSize: titleFontSize || 18,
                fontWeight: 700 as const,
                ...(gameTitleStyle === 'default' ? { color: theme.titleColor, textShadow: theme.titleTextShadow } : {}),
                lineHeight: 1.2,
                marginBottom: 6,
                fontFamily: theme.fontFamily,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                gap: 4,
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
                textAlign: 'center',
              }}>
                {displayName}
                <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} size={14} />
              </h2>
            )}

            {/* Meta: badge + timer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              {(() => {
                // v2.4.0: pinned games get a "Pinned" chip in place of the
                // tournament badge. Rendering preserves theme colors.
                if (lb.isPinned) {
                  return (
                    <span style={{
                      padding: '4px 12px',
                      borderRadius: theme.badgeBorder ? 4 : 6,
                      background: cardBgFill ? 'rgba(0,0,0,0.6)' : theme.badgeBg,
                      border: theme.badgeBorder || 'none',
                      color: theme.badgeColor,
                      fontSize: 10,
                      letterSpacing: 2,
                      textTransform: 'uppercase' as const,
                      fontWeight: 600,
                      textShadow: cardBgFill ? '0 1px 4px rgba(0,0,0,0.8)' : undefined,
                    }}>Pinned</span>
                  );
                }
                const tBadge = lb.tournamentType ? TOURNAMENT_BADGE_COLORS[lb.tournamentType.toUpperCase()] : null;
                const label =
                  lb.tournamentType === 'DG' ? 'Daily Grind' :
                  lb.tournamentType === 'WG-VPXS' ? 'Weekly Grind' :
                  lb.tournamentType === 'WG-VR' ? 'VR Weekly' :
                  lb.tournamentType === 'MG' ? 'Monthly Grind' :
                  lb.tournamentName;
                // v2.0.1: hide the tournament badge when label is empty (catalogue
                // / community rows have no tournament context to surface).
                if (!label) return null;
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
                {label}
              </span>
                );
              })()}
              {lb.gameStatus === 'COMPLETED' && (
                <Lock size={12} style={{ color: theme.badgeColor, flexShrink: 0 }} />
              )}
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

          {/* Podium (top 3) — always rendered, blank slots when no entries */}
          {isChipPodium ? (
            <div style={{ position: 'relative' }}>
              <PodiumBackground />
              <ShowcasePodium entries={podiumEntries} theme={theme} slug={slug} hasMultiple={hasMultiple} expandedPlayer={expandedPlayer} playerHistory={playerHistory} historyLoading={historyLoading} onTogglePlayer={togglePlayer} />
            </div>
          ) : (
            <ShowcasePodium entries={podiumEntries} theme={theme} hasMultiple={hasMultiple} expandedPlayer={expandedPlayer} playerHistory={playerHistory} historyLoading={historyLoading} onTogglePlayer={togglePlayer} />
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
            slug={slug}
            fontFamily={theme.fontFamily}
            monoFontFamily={theme.monoFontFamily}
            zebraStripe={theme.rowZebraStripe}
            hoverBorder={theme.rowHoverBorder}
            rankColor={theme.rankColor}
            nameColor={theme.nameColor}
            scoreColor={theme.scoreColor}
            hasMultiple={hasMultiple}
            expandedPlayer={expandedPlayer}
            playerHistory={playerHistory}
            historyLoading={historyLoading}
            onTogglePlayer={togglePlayer}
          />

          {/* Spacer pushes footer to card bottom */}
          <div style={{ flex: 1 }} />

          {/* Footer */}
          <div style={{
            borderTop: `1px solid ${cardBgFill ? 'rgba(255,255,255,0.15)' : theme.footerBorder}`,
            padding: `10px 24px ${10 + qrMetrics.footerExtra}px 24px`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            ...(cardBgFill ? { background: 'rgba(0,0,0,0.3)' } : {}),
          }}>
            <a
              href={`/${slug}/games/${encodeURIComponent(lb.gameName)}`}
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

      {/* QR code — outside the card shell, above or below */}
      {qrMode !== 'disabled' && (
        qrPosition === 'bottom-center' ? (
          <div style={{ position: 'absolute', bottom: -qrMetrics.overhang, left: '50%', transform: 'translateX(-50%)', zIndex: 15 }}>
            <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
          </div>
        ) : qrPosition === 'bottom-right' ? (
          // v2.13.12 — negative marginTop pulls QR up by `peek` px, overlapping
          // the card's bottom edge by `qrOverlapPx` (default 10).
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -qrMetrics.peek, position: 'relative', zIndex: 15 }}>
            <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
          </div>
        ) : (
          <div style={{ position: 'absolute', top: Math.max(0, floatPadTop - qrSize - 6), right: 0, zIndex: 5 }}>
            <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
          </div>
        )
      )}
    </div>
  );
}
