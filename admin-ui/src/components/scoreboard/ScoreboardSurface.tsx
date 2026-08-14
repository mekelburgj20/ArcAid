import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import type { GameLeaderboard, RankingGroupData, RankedEntry } from '../ScoreboardComponents';
import {
  GameCard,
  RankingGroupCard,
  RankingsColumn,
  RankingsRow,
  RankingsTicker,
  getTitleStyleClass,
  getTitleSizeClass,
} from '../ScoreboardComponents';
import CardRouter from './CardRouter';
import HorizontalScrollNav from '../HorizontalScrollNav';
import { deriveCardProps, deriveScoreboardConfig, getCardWidth, qrBottomMetrics } from '../../lib/scoreboardConfig';

export interface LeaderboardWithViewer extends GameLeaderboard {
  viewerEntry?: RankedEntry | null;
}

/**
 * v2.10x — mobile viewport gate for QR codes (owner design call, 2026-08-12
 * mobile-polish batch): a QR exists to be scanned BY a phone FROM a
 * desktop/TV — on the phone itself it's pointless, so QR never renders at
 * the mobile breakpoint (<=640px) regardless of the room's QR toggle. This
 * is the single chokepoint: every QR-driving value below (`qrEnabled`, the
 * legacy `qrMode==='all'` pass-through, and the layout metrics derived from
 * them — `cardMarginBottom`, `hasQrTop`/`rankQrTopPad`) already funnels
 * through here, and each card's own `showQr`-derived spacing (footer
 * padding, overhang reservation) collapses to zero automatically once the
 * card receives `qrMode='disabled'` — no BannerCard/ShowcaseCard/
 * MinimalCard/GameCard edit needed. Kiosk (TV-width) and desktop are
 * unaffected — the media query only matches narrow viewports.
 *
 * Defaults to `false` (not mobile) when `matchMedia` is unavailable (jsdom
 * ships none) — mirrors the guard pattern already used by ThemeProvider /
 * PinnedCarousel / GameInfoPopup, so existing tests that render this surface
 * without a matchMedia stub keep seeing pre-change QR behavior.
 */
function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 640px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = () => setIsMobile(mq.matches);
    handler();
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }, []);
  return isMobile;
}

/**
 * v2.86.0 — THE scoreboard surface.
 *
 * Extracted verbatim from `pages/Scoreboard.tsx` so the room-admin
 * `pages/Leaderboard.tsx` renders the SAME pixels the public page does. Before
 * this, admin carried a drifted hand copy: its own re-implementation of
 * `deriveCardProps`, its own in-file `AdminGameCard` (a card players never
 * saw), no vertical layout, no banner-forces-scroll rule, no QR, no
 * `gameTitleStyle`, no `roomId` (so no score expand, no GameInfoPopup links),
 * no mobile scale/vertical handling, and no `HorizontalScrollNav`. Forty
 * documented divergences.
 *
 * The contract: EVERY derivation lives in here (`deriveScoreboardConfig`,
 * `deriveCardProps`, `getCardWidth`, `qrBottomMetrics`), so a consumer cannot
 * diverge by computing its own. Consumers supply data and slots only.
 *
 * The public page owns everything AROUND the surface (data fetching, sockets,
 * viewer prefs, tab strip, search box, toasts, submission sheet, modals) and
 * injects the page-specific bits through the `overlays` / `headerExtras` /
 * `aboveCards` / `contentOverride` slots — which sit at exactly the DOM
 * positions that code used to occupy inline.
 *
 * The admin page supplies the same three payloads, NO viewer props (an admin
 * mirrors a fresh anonymous viewer = room defaults) and NO `onSubmitScore`
 * (a functional affordance, not design), plus `renderUnderCard` for its
 * controls strip.
 */
export interface ScoreboardSurfaceProps {
  /** Raw scoreboard-config map from `GET /rooms/:roomId/scoreboard-config`
   *  (public page merges the viewer's personal prefs over it first). */
  config: Record<string, string>;
  roomName?: string;
  /** Enables score-expand + GameInfoPopup links inside the cards. */
  roomId?: string;
  slug: string;
  leaderboards: LeaderboardWithViewer[];
  rankingGroups: RankingGroupData[];

  /** Highlights the viewer's own row. Omitted on admin. */
  viewerUsername?: string;
  /** When omitted, the per-slot `+` submit button does not render. It is
   *  absolutely positioned, so its absence shifts nothing. */
  onSubmitScore?: (lb: GameLeaderboard) => void;
  /** Per-card title link target. Both pages pass `tournamentCardTitleLink`
   *  from `./tournamentCardTitle` — do not hand-roll a second one. */
  titleLinkTo?: (lb: GameLeaderboard) => string;
  /** Per-card title click handler (opens the page's quick-view modal). Both
   *  pages pass `tournamentCardTitleClick` from `./tournamentCardTitle`. */
  titleLinkOnClick?: (lb: GameLeaderboard) => (e: React.MouseEvent) => void;
  /** Admin controls strip. Rendered inside each card slot, directly under the
   *  card, in EVERY layout branch. */
  renderUnderCard?: (lb: GameLeaderboard) => ReactNode;
  /** v2.9x (ranking-card backgrounds) — same idea as `renderUnderCard`, but
   *  for ranking-group cards (a structurally separate render path — see
   *  RankingGroupCard/RankingsRow/RankingsColumn). Rendered under every
   *  ranking card in EVERY layout branch, inline or sticky. */
  renderUnderRankingCard?: (group: RankingGroupData['group']) => ReactNode;

  /** Free-text game-name filter (public search box). */
  searchFilter?: string;

  /** Fixed-position page overlays (score flash, toast). Rendered inside the
   *  root, before the `<style>` block — where the public page had them. */
  overlays?: ReactNode;
  /** Rendered inside the MEASURED header zone, below the title/logo. The bg
   *  image layer starts below this whole zone unless bg mode is fill-entire.
   *  (public: the tab strip + tab subtitle). */
  headerExtras?: ReactNode;
  /** Rendered between the header zone and the card region (public: search). */
  aboveCards?: ReactNode;
  /** Replaces the entire card region (public: the Room/Global score tabs). */
  contentOverride?: ReactNode;

  /** Extra bottom padding on the scroll container (public: lobby ticker). */
  scrollPaddingBottom?: number;
  /** Room public-theme class (e.g. `theme-light`) scoping the surface to the
   *  room's colours instead of the ambient page theme. See `Leaderboard.tsx`. */
  themeClass?: string;
  /**
   * Renders the surface as a block inside an already-scrolling page (the admin
   * Leaderboard sits in `<main>`), rather than as a full-height page that owns
   * its own vertical scroller. Card rendering and every layout branch are
   * identical either way — this only swaps the outer height/scroll chrome.
   */
  embedded?: boolean;

  /**
   * Kiosk-surface migration additions (KioskScoreboard.tsx). Three narrow,
   * deliberately optional overrides — all default to the existing public/admin
   * behaviour untouched — for the handful of things the kiosk display needs
   * that genuinely differ from the public page, rather than forking the
   * surface. See KioskScoreboard.tsx for the call site and rationale.
   */
  /** Overrides the page-zoom percentage (default: `SCOREBOARD_ZOOM`, i.e. the
   *  same `zoom` the public page/admin use). Kiosk zooms by `KIOSK_ZOOM`
   *  (falling back to `SCOREBOARD_ZOOM`) instead — a distance-tuning control
   *  the public page has no use for. */
  zoomPercent?: number;
  /** When true, `SCOREBOARD_QR_MODE === 'kiosk-only'` is ALSO treated as
   *  "QR enabled" (normally only `'all'` is) for the new-cards (Style+Theme)
   *  render path. `'kiosk-only'` exists specifically so a room can show the
   *  submit QR on the TV display without also putting it on the public page a
   *  player may already be viewing on their phone — the public page and admin
   *  preview must keep treating it as disabled, hence opt-in. */
  qrKioskOnlyEnabled?: boolean;
  /** When true, uses the kiosk's historical header spacing (mb-8 instead of
   *  mb-4 under the title/logo, and skips the overflow-hidden/max-w-full
   *  refinement on the title-hidden+logo-only variant) instead of the
   *  public-page default. Preserves kiosk's existing pixel layout, which
   *  predates and diverged slightly from the public page's header zone. */
  kioskHeaderSpacing?: boolean;
}

export default function ScoreboardSurface({
  config,
  roomName,
  roomId,
  slug,
  leaderboards,
  rankingGroups,
  viewerUsername,
  onSubmitScore,
  titleLinkTo,
  titleLinkOnClick,
  renderUnderCard,
  renderUnderRankingCard,
  searchFilter,
  overlays,
  headerExtras,
  aboveCards,
  contentOverride,
  scrollPaddingBottom,
  themeClass,
  embedded = false,
  zoomPercent,
  qrKioskOnlyEnabled = false,
  kioskHeaderSpacing = false,
}: ScoreboardSurfaceProps) {
  // New style/theme config
  const newConfig = deriveScoreboardConfig(config, roomName);
  const useNewCards = !!config.SCOREBOARD_STYLE; // explicit style = new system

  // Legacy config (used when SCOREBOARD_STYLE not set)
  const legacyProps = deriveCardProps(config, roomName);
  const {
    maxScores, hideEmpty, titleHidden, titleText, titleStyle, titleSize,
    zoom, bgUrl, bgMode, logoUrl, logoPosition, logoMaxHeight,
    layout: legacyLayout, cardWidth: legacyCardWidth, rankingsPosition,
    cardOpacity, bgOpacity, scoreColumns, qrMode,
    headerStyle, bgFill, bgSize, wheelScale, gameColumns, globalStyles,
    glassOpacity, gameTitleStyle, gameTitleEnhance, scoreStyle,
  } = legacyProps;
  const layout = useNewCards ? newConfig.layout : legacyLayout;

  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyCardWidth;
  const isBanner = useNewCards && newConfig.style === 'banner';

  // Effective layout: Banner always horizontal scroll; others respect setting
  // Mobile always forces vertical via CSS
  const effectiveLayout = isBanner ? 'scroll' : layout;

  const trimmedSearch = (searchFilter || '').trim().toLowerCase();
  const visibleLeaderboards = leaderboards
    .filter(lb => !hideEmpty || lb.rankings.length > 0)
    .filter(lb => !trimmedSearch || (lb.displayName || lb.gameName).toLowerCase().includes(trimmedSearch));

  // v2.9x — "ticker" is a full-width marquee strip, not a per-group card, so
  // it never participates in the inline-with-game-cards grid/sticky-column
  // layouts the other four rankingsStyle values use. `tickerMode` short-
  // circuits every position branch below in favor of the two ticker-only
  // render sites (top/bottom of the card region).
  const tickerMode = useNewCards && newConfig.rankingsStyle === 'ticker' && rankingGroups.length > 0;
  // A marquee strip can't be a sidebar column — left/right degrade to bottom
  // ("degrade sensibly" per the design spec). top/bottom pass through as-is;
  // any other value (including the 'left' default) also degrades to bottom.
  // Ticker has exactly ONE position (top of the scoreboard, above the room
  // header) — the rankings position setting is ignored for this treatment.

  // When sticky is off (default), rankings render inline with game cards
  const inlineRankings = useNewCards && !newConfig.rankingsSticky && rankingGroups.length > 0 && !tickerMode;
  // Mobile QR gate (see useIsMobileViewport doc comment above) — ANDed into
  // every QR-enabled check below so a mobile phone never renders one, no
  // matter the room's QR toggle.
  const isMobileViewport = useIsMobileViewport();
  // QR codes above game cards add extra height — rankings card needs matching top margin
  const qrEnabled = !isMobileViewport && (newConfig.qrMode === 'all' || (qrKioskOnlyEnabled && newConfig.qrMode === 'kiosk-only'));
  const hasQrTop = useNewCards && qrEnabled && newConfig.qrPosition === 'top-right';
  const rankQrTopPad = hasQrTop ? newConfig.qrSize + 4 : 0;
  // v2.13.3: bottom-center QR overhangs below the card. The reservation must
  // live on the LAYOUT ITEM (flex/grid wrapper), not the card's inner div —
  // marginBottom on a height:100% child escapes its parent's border-box, so
  // the QR's overhang area was rendered outside the scrollable region and
  // unreachable even at max scroll. Moving the margin up one level makes flex
  // line cross-size and grid track sizing include the QR space.
  const cardMarginBottom = useNewCards
    ? qrBottomMetrics(newConfig.qrSize, !isMobileViewport && newConfig.qrMode !== 'disabled', newConfig.qrPosition, newConfig.qrOverlapPx).overhang
    : 0;

  // Measure header height so bg image can start below it
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The pinned rankings ticker sits ABOVE the header zone, outside its
  // measured box — measured separately and added to the bg offset so the
  // image still starts below the header's visual bottom.
  const tickerRef = useRef<HTMLDivElement>(null);
  const [tickerHeight, setTickerHeight] = useState(0);
  useEffect(() => {
    const el = tickerRef.current;
    if (!el) { setTickerHeight(0); return; }
    const ro = new ResizeObserver(() => setTickerHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tickerMode]);

  const bgBehindTitle = useNewCards ? newConfig.bgBehindTitle : false;
  const effectiveBgSize = bgMode === 'fill-entire' ? 'cover' : bgMode === 'repeat' ? 'auto' : bgMode;

  /** One card, rendered exactly as the public page renders it. */
  const renderCard = (lb: LeaderboardWithViewer) => (
    useNewCards ? (
      <CardRouter
        lb={lb} slug={slug} roomId={roomId}
        style={newConfig.style} theme={newConfig.theme}
        podiumVariant={newConfig.podiumVariant}
        maxScores={newConfig.maxScores} minScores={newConfig.minScores}
        showTimer={newConfig.showTimer}
        cardBgFill={newConfig.cardBgFill}
        titleFontSize={newConfig.titleFontSize || undefined}
        viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry}
        qrMode={qrEnabled ? 'all' : 'disabled'}
        qrSize={newConfig.qrSize} qrPosition={newConfig.qrPosition} qrOverlapPx={newConfig.qrOverlapPx}
        gameTitleStyle={newConfig.gameTitleStyle}
        onSubmitScore={onSubmitScore}
        titleLinkTo={titleLinkTo?.(lb)} titleLinkOnClick={titleLinkOnClick?.(lb)}
      />
    ) : (
      <GameCard lb={lb} slug={slug} maxScores={maxScores} roomId={roomId} onSubmitScore={onSubmitScore} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={!isMobileViewport && qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
    )
  );

  /**
   * Card + (optional) under-card slot.
   *
   * With no `renderUnderCard` the card is returned bare, so the public page's
   * DOM is byte-for-byte what it was before the extraction. With one, the pair
   * goes into a `flex-col h-full min-w-0` column — the card sits DIRECTLY in
   * it on purpose. An intermediate `flex-1` box absorbs the row-height stretch
   * CSS Grid applies to every card in a row, which leaves a short card's strip
   * floating below its own content. Sitting directly in the column, each path
   * lands right: CardRouter cards carry an inline `height: 100%` so they
   * resolve against `h-full` then shrink by exactly the strip's height; the
   * legacy card has no height so it stays content-sized with the strip under
   * it and leftover stretch falling below, where it's invisible. `min-w-0`
   * defeats the flex/grid automatic minimum size, without which a long
   * (nowrap) title widens the card past its grid track.
   */
  const renderSlotContent = (lb: LeaderboardWithViewer) => (
    renderUnderCard ? (
      <div className="flex flex-col h-full min-w-0">
        {renderCard(lb)}
        {renderUnderCard(lb)}
      </div>
    ) : renderCard(lb)
  );

  /** Same idea as `renderSlotContent`, for the inline-rankings render sites
   *  (grid/vertical/horizontal). RankingsRow/RankingsColumn (the
   *  top/left/right/bottom, non-inline positions) take `renderUnderCard`
   *  directly as a prop instead — see the call sites below. */
  const renderRankingSlot = (group: RankingGroupData['group'], rankings: RankingGroupData['rankings']) => {
    const card = <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} rankingsStyle={newConfig.rankingsStyle} qrTopPad={rankQrTopPad} />;
    return renderUnderRankingCard ? (
      <div className="flex flex-col h-full min-w-0">
        {card}
        {renderUnderRankingCard(group)}
      </div>
    ) : card;
  };

  /** The `+` submit affordance. Absolutely positioned in every branch, so
   *  omitting it (admin) cannot shift anything around it. */
  const submitButton = (lb: LeaderboardWithViewer, variant: 'corner' | 'inset') => (
    onSubmitScore ? (
      variant === 'corner' ? (
        <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSubmitScore(lb); }} aria-label={`Submit score for ${lb.displayName || lb.gameName}`} title="Submit score" className="absolute top-0 right-0 z-20 w-11 h-11 inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-full group/submit focus:outline-none">
          <span className="w-9 h-9 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan group-hover/submit:bg-neon-cyan/20 group-focus/submit:bg-neon-cyan/20 flex items-center justify-center transition-colors backdrop-blur-sm">
            <Plus size={16} />
          </span>
        </button>
      ) : (
        <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSubmitScore(lb); }} aria-label={`Submit score for ${lb.displayName || lb.gameName}`} title="Submit score" className="absolute top-2 right-2 z-20 w-9 h-9 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/20 focus:bg-neon-cyan/20 flex items-center justify-center transition-colors cursor-pointer backdrop-blur-sm">
          <Plus size={16} />
        </button>
      )
    ) : null
  );

  const rootClass = embedded
    // Embedded: the host page already scrolls. `overflow-x-hidden` stands in
    // for the scroll container's own, so the full-bleed `-mx-4 sm:-mx-6`
    // horizontal card rail stays contained. `bg-deep` reproduces the public
    // page's body background, which matters when `themeClass` re-scopes the
    // palette to a different theme than the surrounding page.
    ? `relative overflow-x-hidden bg-deep ${newConfig.mobileVertical ? 'scoreboard-mobile-vertical' : ''} ${themeClass || ''}`
    : `h-full flex flex-col overflow-hidden relative ${newConfig.mobileVertical ? 'scoreboard-mobile-vertical' : ''} ${themeClass || ''}`;

  return (
    <div className={rootClass.trimEnd()}>
      {/* Background image layer with opacity control — offset below header unless fill-entire */}
      {bgUrl && (
        <div
          className="absolute pointer-events-none"
          style={{
            top: bgBehindTitle ? 0 : headerHeight + tickerHeight,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage: `url(${bgUrl})`,
            backgroundSize: effectiveBgSize,
            backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center top',
            opacity: bgOpacity,
          }}
        />
      )}

      {overlays}

      <style>{`
        @keyframes slideDown {
          from { opacity: 0; transform: translate(-50%, -100%); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
        .animate-slideDown {
          animation: slideDown 0.3s ease-out forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          .animate-slideDown {
            animation: none;
          }
        }
        /* v2.13.14 — scrollbar hidden; HorizontalScrollNav provides edge-hover
           arrow controls instead. overscroll-behavior-x kept so horizontal
           overscroll doesn't trigger browser swipe-back navigation. */
        .scoreboard-hscroll-layout {
          scrollbar-width: none;
          overscroll-behavior-x: contain;
        }
        .scoreboard-hscroll-layout::-webkit-scrollbar { display: none; }
        .scoreboard-hscroll-nobar {
          scrollbar-width: none;
        }
        .scoreboard-hscroll-nobar::-webkit-scrollbar { display: none; }
        /* Mobile: scale + vertical mode */
        @media (max-width: 640px) {
          .scoreboard-mobile-scale { zoom: var(--mobile-scale, 1); }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout {
            overflow-x: hidden !important;
          }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout > div {
            flex-direction: column !important;
            align-items: center !important;
          }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout > div > div {
            flex-shrink: 1 !important;
            max-width: 100% !important;
          }
          .scoreboard-mobile-vertical .scoreboard-grid-layout {
            grid-template-columns: 1fr !important;
            justify-items: center;
          }
          .scoreboard-mobile-vertical .scoreboard-grid-layout > div {
            max-width: 100%;
          }
          /* S21 — true mobile card layout: cards render at full width (no
             fixed-px cap) at natural type scale. Applies to the layout
             wrapper AND the card component's own inner width (BannerCard/
             ShowcaseCard/MinimalCard/RankingGroupCard all set an explicit
             px width on an inner element that a wrapper-only override can't
             reach). */
          .scoreboard-mobile-vertical .scoreboard-card-slot {
            width: 100% !important;
            max-width: 100% !important;
          }
          /* S21 — SCOREBOARD_ZOOM (legacy TV zoom) must not apply on phones;
             mirrors the mobile-scale mechanism above. */
          .scoreboard-page-zoom {
            zoom: 100% !important;
          }
          /* S21 — mobile type floors. Viewport-only (not gated behind
             .scoreboard-mobile-vertical — readability at natural scale
             applies regardless of the vertical-stacking toggle). Class name
             encodes the ORIGINAL desktop px size; see ScoreList.tsx,
             BannerCard.tsx, ShowcaseCard.tsx for call sites. */
          .sb-fs-9  { font-size: 11px !important; }
          .sb-fs-10 { font-size: 11px !important; }
          .sb-fs-11 { font-size: 12px !important; }
          .sb-fs-12 { font-size: 13px !important; }
          .sb-fs-13 { font-size: 14px !important; }
          /* Mobile polish batch (2026-08-12) — score-row username + score,
             specifically (not the generic sb-fs-* floors above, which also
             cover badges/timers/footer meta the owner did not ask to
             change). One pair of mobile-only sizes shared by all four card
             families (BannerCard's pill row, ShowcaseCard's ScoreList rows,
             MinimalCard's row, legacy GameCard's compact+default rows) —
             deliberately NOT scaled from each card's own (differing)
             desktop base the way sb-fs-* is; the ask was "bigger than
             today, on every family," not "preserve each family's relative
             ratio." Desktop sizing is untouched (no rule outside this
             media query). Overflow handling is NOT here anymore: every
             sb-row-name call site now renders through <FitRowName>, which
             scales an overlong name down to fit ONE line (owner revision
             2026-08-13 — wrapping made row heights uneven; ellipsis is
             banned by doctrine). Names that fit are untouched.

             v2.104.1: the .sb-row-name/.sb-row-score font rules MOVED to
             index.css — this style block only mounts with ScoreboardSurface
             (the Tournaments tab), but the same card components render on
             the Room Scores + Global tabs OUTSIDE the surface (owner field
             report: "my score font size looks the same" — they were on Room
             Scores). Global stylesheet = every surface, one definition. */
        }
      `}</style>

      {/* Scrollable content — zoom applied here so it doesn't break the flex height chain */}
      <div
        className={embedded
          ? 'scoreboard-page-zoom'
          : 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden scoreboard-page-zoom'}
        style={{
          ...((zoomPercent ?? zoom) !== 100 ? { zoom: `${zoomPercent ?? zoom}%` } : {}),
          // S14: reserve room for the fixed-bottom lobby ticker so it doesn't
          // cover the last row of cards.
          paddingBottom: scrollPaddingBottom,
        }}
      >
      {/* Rankings ticker — owner placement (2026-08-10, rev 2): edge-to-edge
          strip PINNED at the top of the scroll container (sticky, like the
          nav bar) — always visible while scrolling. Direct child of the
          scroller (sticky can't escape a parent's bounds, so it can't live
          inside the header zone); its height is measured separately and
          added to the bg-image offset. The rankings POSITION setting does
          not apply to the ticker treatment. z-30 clears the card-layer
          stack (QR 15 / admin strip 20, see cardStacking.ts). */}
      {tickerMode && (
        <div ref={tickerRef} className="sticky top-0 z-30">
          <RankingsTicker rankingGroups={rankingGroups} slug={slug} />
        </div>
      )}

      {/* Header zone — bg image starts below this unless fill-entire mode */}
      <div
        ref={headerRef}
        className="px-4 sm:px-6 pt-6 relative z-[1]"
      >
      {!titleHidden && (
        <div className={`text-center ${kioskHeaderSpacing ? 'mb-8' : 'mb-4'} overflow-hidden`}>
          <div className={`inline-flex items-center gap-4 max-w-full ${
            logoPosition === 'above' || logoPosition === 'below' ? 'flex-col' : 'flex-row'
          }`}>
            {logoUrl && (logoPosition === 'left' || logoPosition === 'above') && (
              <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain flex-shrink-0" />
            )}
            <p className={`font-display text-muted ${getTitleSizeClass(titleSize)} uppercase tracking-widest ${getTitleStyleClass(titleStyle)} min-w-0`}>
              {titleText}
            </p>
            {logoUrl && (logoPosition === 'right' || logoPosition === 'below') && (
              <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain flex-shrink-0" />
            )}
          </div>
        </div>
      )}
      {titleHidden && logoUrl && (
        kioskHeaderSpacing ? (
          <div className="text-center mb-8">
            <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain mx-auto" />
          </div>
        ) : (
          <div className="text-center mb-4 overflow-hidden">
            <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain mx-auto max-w-full" />
          </div>
        )
      )}

      {headerExtras}

      </div>

      {contentOverride ?? (
      <>
      {aboveCards}

      {/* Game cards */}
      <div className="px-4 sm:px-6 pb-6 scoreboard-mobile-scale" style={{ '--mobile-scale': newConfig.mobileScale } as React.CSSProperties}>

      {/* Rankings: top position (only when sticky/separate) */}
      {!tickerMode && !inlineRankings && rankingsPosition === 'top' && rankingGroups.length > 0 && (
        <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} renderUnderCard={renderUnderRankingCard} />
      )}

      {/* Main content area */}
      <div className={`flex ${!tickerMode && (rankingsPosition === 'left' || rankingsPosition === 'right') ? 'flex-col lg:flex-row gap-6 items-stretch lg:items-start' : 'flex-col gap-6'}`}>

        {/* Rankings: left position (only when sticky/separate) */}
        {!tickerMode && !inlineRankings && rankingsPosition === 'left' && rankingGroups.length > 0 && (
          <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} sticky={useNewCards && newConfig.rankingsSticky} renderUnderCard={renderUnderRankingCard} />
        )}

        {/* Game leaderboards */}
        {visibleLeaderboards.length === 0 ? (
          <div className="flex-1 text-center py-24">
            <p className="text-muted font-display">
              {trimmedSearch
                ? `No active games match "${(searchFilter || '').trim()}".`
                : 'Waiting for active games...'}
            </p>
          </div>
        ) : effectiveLayout === 'grid' ? (
          /* Grid layout — responsive rows, mobile forces single column via CSS */
          <div className="flex-1 min-w-0">
            <div
              className={`scoreboard-grid-layout grid ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${!useNewCards && gameColumns === '2' ? 'grid-cols-1 md:grid-cols-2' : ''}`}
              style={{
                ...(useNewCards ? { gap: newConfig.cardSpacing } : {}),
                ...(useNewCards || gameColumns !== '2' ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.7)}px, 100%), 1fr))` } : {}),
              }}
            >
              {visibleLeaderboards.map(lb => (
                <div key={lb.gameId} className="relative group/card scoreboard-card-slot" style={{ ...(!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}), overflow: 'visible', minWidth: 0, marginBottom: cardMarginBottom || undefined }}>
                  {/* v2.2.8: overlay Link removed — title is a Link inside CardRouter instead. */}
                  {submitButton(lb, 'corner')}
                  {renderSlotContent(lb)}
                </div>
              ))}
              {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                <div key={`rank-${group.id}`} className="scoreboard-card-slot" style={{ overflow: 'visible', minWidth: 0, marginBottom: cardMarginBottom || undefined }}>
                  {renderRankingSlot(group, rankings)}
                </div>
              ))}
            </div>
          </div>
        ) : effectiveLayout === 'vertical' ? (
          /* Vertical scroll — single column centered */
          <div className="flex-1 min-w-0">
            <div className="flex flex-col items-center" style={{ gap: useNewCards ? newConfig.cardSpacing : 20 }}>
              {visibleLeaderboards.map(lb => (
                <div key={lb.gameId} className="relative group/card scoreboard-card-slot" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%', marginBottom: cardMarginBottom || undefined }}>
                  {/* v2.2.8: overlay Link removed — title is a Link inside CardRouter instead. */}
                  {submitButton(lb, 'corner')}
                  {renderSlotContent(lb)}
                </div>
              ))}
              {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                <div key={`rank-${group.id}`} className="scoreboard-card-slot" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%', marginBottom: cardMarginBottom || undefined }}>
                  {renderRankingSlot(group, rankings)}
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Horizontal scroll (default for Banner, also available for others) */
          <div className="flex-1 min-w-0">
            <HorizontalScrollNav className="-mx-4 sm:-mx-6 scoreboard-hscroll-layout">
              <div className={`flex pb-2 px-4 sm:px-6 ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${isBanner ? 'scoreboard-banner-scroll' : ''}`} style={useNewCards ? { gap: newConfig.cardSpacing } : undefined}>
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="flex-shrink-0 relative group/card scoreboard-card-slot" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, ...(!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}), marginBottom: cardMarginBottom || undefined }}>
                    {/* v2.2.8: overlay Link removed — title is a Link inside CardRouter instead. */}
                    {submitButton(lb, 'inset')}
                    {renderSlotContent(lb)}
                  </div>
                ))}
                {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                  <div key={`rank-${group.id}`} className="flex-shrink-0 scoreboard-card-slot" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, marginBottom: cardMarginBottom || undefined }}>
                    {renderRankingSlot(group, rankings)}
                  </div>
                ))}
              </div>
            </HorizontalScrollNav>
          </div>
        )}

        {/* Rankings: right position (only when sticky/separate) */}
        {!tickerMode && !inlineRankings && rankingsPosition === 'right' && rankingGroups.length > 0 && (
          <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} sticky={useNewCards && newConfig.rankingsSticky} renderUnderCard={renderUnderRankingCard} />
        )}
      </div>

      {/* Rankings: bottom position (only when sticky/separate) */}
      {!tickerMode && !inlineRankings && rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
        <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} renderUnderCard={renderUnderRankingCard} />
      )}

      </div>{/* end game cards */}
      </>
      )}
      </div>{/* end scrollable */}
    </div>
  );
}
