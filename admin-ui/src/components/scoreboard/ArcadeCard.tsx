import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, Minus, BadgeCheck, ChevronRight } from 'lucide-react';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, formatCountdown, GameQRCode, getTitleStyleClass, playerName } from '../ScoreboardComponents';
import PlayerNameLink from '../PlayerNameLink';
import FitRowName from './FitRowName';
import GameInfoPopup from './GameInfoPopup';
import ArcadePodium from './ArcadePodium';
import { arcadeNeonKey } from './arcadeNeon';
import { useScoreExpand } from './useScoreExpand';
import { qrEdgeMetrics, DEFAULT_QR_OFFSET_PX } from '../../lib/scoreboardConfig';
import { formatScore } from '../../lib/format';
import { resolveRowClick, opensQuickView, QUICK_VIEW_HINT } from '../../lib/scoreGesture';

/**
 * ArcadeCard — the Global Scoreboard's card language, on room-card behaviour.
 *
 * Phase 1 of the style-system revamp. Arcade becomes the DEFAULT look for every
 * room, so it is the Global card's shape (art taking the top region with the
 * title set on it, an always-on podium, a contained footer, a category-coloured
 * neon frame) wired to everything a ROOM card has to do and the Global card has
 * never had to: admin style-image resolution, the maintenance countdown,
 * tournament labels, verified badges, inline score-history expand, viewer-row
 * injection, and the QR block.
 *
 * ─── Theme model: HYBRID (Phase 1 design decision 1) ───
 *
 * Base surfaces, borders and text track the room's `--color-*` tokens — a
 * cyberpunk or ocean room still reads as that room, exactly as Banner and
 * Minimal do. Only the SIGNATURE accents are fixed: the per-category neon
 * frame, the gold/silver/bronze podium tints, and the contained footer strip.
 * Those come from the `--sb-*` token family (see `index.css`), which already
 * carries `.theme-light` / `.theme-coffee` polarity overrides, so the card is
 * correct on a pale page without a second implementation.
 *
 * A full opt-out (Showcase's model, where the card ignores the room theme
 * entirely) was rejected: a DEFAULT that ignores the admin's theme choice reads
 * as broken. Re-deriving the neon palette across all 17 themes was rejected as
 * scope explosion.
 *
 * ─── "Category" in a room ───
 *
 * The Global card wears its FIDELITY BAND's neon. A room card has no fidelity
 * band — its equivalent question is "which tournament is this?", which is
 * already a colour system here (`TOURNAMENT_BADGE_COLORS`, and the same
 * daily/weekly/monthly identity the Discord embeds use). So `data-neon` carries
 * the tournament kind (`dg` / `wg` / `wg-vr` / `mg` / `pinned` / `none`) and
 * `index.css` maps each to an `--sb-arcade-neon-*` token. Same mechanism,
 * room semantics.
 *
 * ─── Deliberately NOT ported from GlobalGameCard ───
 *
 * The origin-room tag (a room card is already in one room), the `neighbors` /
 * density planner (a room leaderboard ships full rankings, and `maxScores` is
 * the room's own knob), the pin control, and the footer's score-count semantics
 * — the footer counts PLAYERS SHOWN, like every other room card, not scores.
 * The Submit button is not in the footer either: on a room scoreboard the `+`
 * control lives outside the card (see `ScoreboardSurface`), and a second one
 * would be two buttons for one action. `onSubmitScore` is still used — the
 * podium's empty places call it.
 */

interface ArcadeCardProps {
  lb: GameLeaderboard;
  slug: string;
  roomId?: string;
  maxScores: number;
  minScores?: number;
  showTimer?: boolean;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
  qrSize?: number;
  qrPosition?: 'top-center' | 'bottom-center';
  /** Signed distance from the anchored edge; negative overlaps into the card. */
  qrOffsetPx?: number;
  cardBgFill?: boolean;
  titleFontSize?: number;
  gameTitleStyle?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
  titleLinkTo?: string;
  titleLinkOnClick?: (e: React.MouseEvent) => void;
  /** v2.109.0 (score-gesture-photos) — opens the game quick popup. */
  onOpenQuickView?: () => void;
}

/**
 * Admin style-image resolution — the same chain BannerCard and ShowcaseCard
 * use, `lb.imageUrl` fallback included. Kept as a local copy for the same
 * reason the siblings keep theirs: it is three lines of per-card policy, and
 * the two existing copies are already byte-identical to each other.
 */
function resolveImages(lb: GameLeaderboard) {
  const effectiveBgId = (lb.bgStyleId && lb.bgHasBg !== 0) ? lb.bgStyleId
    : (lb.catalogueStyleId && lb.catHasBg !== 0) ? lb.catalogueStyleId : null;
  const effectiveLogoId = (lb.logoStyleId && lb.logoHasHeader !== 0) ? lb.logoStyleId
    : (lb.catalogueStyleId && lb.catHasHeader !== 0) ? lb.catalogueStyleId : null;
  const styleBgUrl = effectiveBgId ? `/api/styles/images/backgrounds/${effectiveBgId}.png` : null;
  const styleHeaderUrl = effectiveLogoId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${effectiveLogoId}.png` : null;
  const bgImage = styleBgUrl || lb.imageUrl || null;
  return { bgImage, styleHeaderUrl };
}

/** The chip that names the board — the room analogue of the fidelity chip. */
function tournamentLabel(lb: GameLeaderboard): string | null {
  if (lb.isPinned) return 'Pinned';
  switch ((lb.tournamentType || '').toUpperCase()) {
    case 'DG': return 'Daily Grind';
    case 'WG-VPXS': return 'Weekly Grind';
    case 'WG-VR': return 'VR Weekly';
    case 'MG': return 'Monthly Grind';
    default: return lb.tournamentName || null;
  }
}

/** A rank-4-and-below row. Podium rows live in `ArcadePodium` (the swap seam). */
function ArcadeRow({ entry, slug, isViewer, canExpand, isExpanded, onToggle, onOpenQuickView }: {
  entry: RankedEntry;
  slug: string;
  isViewer: boolean;
  canExpand: boolean;
  isExpanded: boolean;
  onToggle?: () => void;
  /** v2.109.0 (score-gesture-photos) — opens the quick popup. */
  onOpenQuickView?: () => void;
}) {
  const abbreviated = formatScore(entry.score);
  const onRowClick = resolveRowClick(canExpand, isExpanded, () => onToggle?.(), onOpenQuickView);
  const showHint = opensQuickView(canExpand, isExpanded, !!onOpenQuickView);
  return (
    <div
      className={`flex items-center gap-2 rounded-[6px] border px-2 py-[6px] ${onRowClick ? 'cursor-pointer' : ''}`}
      style={{
        background: isViewer ? 'var(--sb-row-you-bg)' : 'transparent',
        borderColor: isViewer ? 'var(--sb-row-you-border)' : 'transparent',
      }}
      onClick={onRowClick}
      title={showHint ? QUICK_VIEW_HINT : undefined}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">
        <span className="font-mono text-[13px] font-bold tabular-nums text-muted">#{entry.rank}</span>
      </span>
      <PlayerAvatar
        username={playerName(entry)}
        discordUserId={entry.discord_user_id}
        avatarHash={entry.avatar_hash}
        avatarUrl={entry.avatar_url}
        size={26}
      />
      <FitRowName origin="left" className={`min-w-0 flex-1 sb-row-name text-[16px] ${isViewer ? 'font-bold' : 'font-medium'}`}>
        <PlayerNameLink
          slug={slug}
          entry={entry}
          onClick={e => e.stopPropagation()}
          className="text-primary no-underline transition-colors hover:text-neon-cyan"
        />
      </FitRowName>
      {entry.verified && (
        <span className="inline-flex shrink-0 items-center text-neon-green" title="Verified by an admin" aria-label="Verified score">
          <BadgeCheck size={13} />
        </span>
      )}
      <span
        className={`shrink-0 sb-row-score font-mono text-[16px] font-bold tabular-nums ${isViewer ? 'text-neon-cyan' : 'text-primary'}`}
        title={abbreviated.endsWith('T') ? entry.score.toLocaleString() : undefined}
      >
        {abbreviated}
      </span>
      {canExpand && isExpanded ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
          className="shrink-0 p-1 -m-1 text-neon-cyan cursor-pointer"
          aria-label="Hide score history"
          title="Hide score history"
        >
          <Minus size={12} />
        </button>
      ) : canExpand ? (
        <Plus size={12} className="shrink-0 text-faint" />
      ) : showHint ? (
        <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />
      ) : null}
    </div>
  );
}

export default function ArcadeCard({
  lb,
  slug,
  roomId,
  maxScores,
  minScores = 20,
  showTimer = true,
  viewerUsername,
  viewerEntry,
  qrMode = 'disabled',
  qrSize = 30,
  qrPosition = 'top-center',
  qrOffsetPx = DEFAULT_QR_OFFSET_PX,
  cardBgFill = false,
  titleFontSize,
  gameTitleStyle = 'default',
  onSubmitScore,
  titleLinkTo,
  titleLinkOnClick,
  onOpenQuickView,
}: ArcadeCardProps) {
  const { bgImage, styleHeaderUrl } = resolveImages(lb);
  const displayName = lb.displayName || lb.gameName;
  const { expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple } =
    useScoreExpand(roomId, lb.gameId, lb.gameName, lb.rankings.length);

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

  // Viewer-row injection — identical rule to Banner/Minimal: when the signed-in
  // viewer ranks below the visible window, the last visible slot is given up to
  // their row so they can always find themselves.
  let visibleEntries = lb.rankings.slice(0, maxScores);
  if (viewerEntry && viewerUsername) {
    const lowerViewer = viewerUsername.toLowerCase();
    const viewerInVisible = visibleEntries.some(
      e => e.iscored_username.toLowerCase() === lowerViewer
    );
    if (!viewerInVisible && viewerEntry.rank > maxScores) {
      visibleEntries = [...visibleEntries.slice(0, maxScores - 1), viewerEntry];
    }
  }
  const podiumEntries = visibleEntries.filter(e => e.rank <= 3);
  const belowPodium = visibleEntries.filter(e => e.rank > 3);

  // The podium is three rows tall whatever happens, so the room's `minScores`
  // only has to reserve space for the tail.
  const tailMinHeight = Math.max(0, minScores - 3) * 34;

  const label = tournamentLabel(lb);
  const neonKey = arcadeNeonKey(lb);
  const showQr = qrMode !== 'disabled';
  const qrMetrics = qrEdgeMetrics(qrSize, showQr, qrPosition, qrOffsetPx);
  const lowerViewer = viewerUsername?.toLowerCase();

  const title = (
    <>
      <span
        className={`font-display font-bold leading-[1.08] [text-wrap:balance] ${getTitleStyleClass(gameTitleStyle)}`}
        style={{
          fontSize: titleFontSize ? `${titleFontSize}px` : 22,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          ...(gameTitleStyle === 'default'
            ? { color: 'var(--sb-art-title)', textShadow: 'var(--sb-art-title-shadow)' }
            : {}),
        }}
      >
        {displayName}
      </span>
      <GameInfoPopup externalUrl={lb.externalUrl} notes={lb.notes} roomId={roomId} gameName={lb.gameName} globalGameId={lb.globalGameId} size={13} />
    </>
  );

  return (
    // S21 — `scoreboard-card-slot` is what the <=640px rules key off to force
    // width:100%; the fixed 380px lives on this element, so the class has to be
    // here (see BannerCard for the full rationale).
    <div className="scoreboard-card-slot" style={{ position: 'relative', width: 380, maxWidth: '100%', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* QR — top edge, horizontally centred. In flow (not absolute) so the
          slot reserves the space itself: a box of `qrSize` with a marginBottom
          of `qrOffsetPx` leaves exactly `qrSize + qrOffsetPx` above the card.
          A negative offset therefore pulls the QR down over the card's top
          edge; a positive one opens a gap. */}
      {showQr && qrPosition === 'top-center' && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: qrOffsetPx, position: 'relative', zIndex: 15 }}>
          <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
        </div>
      )}

      {/* The card. `arc-card` carries the neon frame + bloom (index.css); the
          surface, radius and text colours are ordinary theme tokens, which is
          the hybrid model in one line. It deliberately does NOT clip — the
          frame's fringe rings sit outside it. */}
      <div
        data-testid="arcade-card"
        data-neon={neonKey}
        className="arc-card relative flex flex-1 flex-col rounded-[10px] bg-surface"
        style={{ minHeight: 'var(--sb-card-min-h)' }}
      >
        {/* Card background fill — the room's "immersive" toggle. Arcade already
            shows the art at the top, so here the setting extends that same
            image behind the WHOLE card under a heavy scrim, which is what the
            toggle promises and what Banner/Minimal do with it. `inset-px`
            keeps the fill inside the 2px neon frame; the card doesn't clip, so
            an `inset-0` layer would paint over the frame's inner edge. */}
        {cardBgFill && bgImage && (
          <>
            <div
              className="absolute inset-px z-0 rounded-[8px]"
              style={{ backgroundImage: `url(${bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              aria-hidden="true"
            />
            <div className="absolute inset-px z-0 rounded-[8px] bg-black/60" aria-hidden="true" />
          </>
        )}

        {/* 1. Art — the top REGION, and the surface the title is set on.
               `m-3` is the whole geometry rule: one 12px gutter on all four
               sides, and the podium below adds no top padding of its own. */}
        <div
          data-testid="arcade-art"
          className="relative z-[1] m-3 h-[176px] shrink-0 overflow-hidden rounded-[6px] bg-raised"
        >
          {bgImage ? (
            <img
              src={bgImage}
              alt=""
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-deep text-[12px] text-muted">
              No image
            </div>
          )}
          {/* The room's identifier art (admin style header), when set. It sits
              in the LOWER half so the title's scrim band stays clear of it —
              Banner hides its title when an identifier exists, but Arcade sets
              the title on the art rather than above it, so both can coexist. */}
          {styleHeaderUrl && (
            <img
              src={styleHeaderUrl}
              alt=""
              decoding="async"
              className="absolute inset-x-0 bottom-1 z-[1] mx-auto max-h-[72px] w-auto max-w-[70%] object-contain"
            />
          )}
          {/* Heavy gradient over the top ~72%, fading to nothing — the answer
              to setting 22px type over an arbitrary backglass. Polarity-
              flipping token: the light theme gets a white veil under dark ink
              rather than an island of white-on-black. */}
          <div
            className="absolute inset-x-0 top-0 h-[72%]"
            style={{ background: 'var(--sb-art-scrim-top)' }}
            aria-hidden="true"
          />

          {/* Header, over the art — a centered STACK: tournament chip (+lock)
              on top, game title beneath it (owner field revision 2026-08-13:
              the side-by-side row squeezed the title into a scrunched left
              column next to the chip). Centering also clears the page-level
              submit "+" overlay in the top-right corner. `pointer-events-none`
              with each interactive child opting back in, so the gaps don't
              become dead strips. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] flex flex-col items-center gap-1.5 p-2">
            {(label || lb.gameStatus === 'COMPLETED') && (
              <div className="pointer-events-auto flex items-center justify-center gap-1.5">
                {label && (
                  <span
                    data-testid="arcade-chip"
                    className="sb-fs-10 rounded-[4px] border px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.5px]"
                    style={{
                      background: 'var(--sb-pill-bg)',
                      borderColor: 'var(--arc-neon)',
                      color: 'var(--arc-neon)',
                    }}
                  >
                    {label}
                  </span>
                )}
                {lb.gameStatus === 'COMPLETED' && (
                  <Lock size={15} strokeWidth={2.5} className="shrink-0 text-neon-amber" aria-label="Locked" />
                )}
              </div>
            )}

            {titleLinkTo ? (
              <Link
                to={titleLinkTo}
                onClick={titleLinkOnClick}
                data-tour="game-card-title"
                className="pointer-events-auto flex w-full min-w-0 items-start justify-center gap-1 text-center no-underline"
              >
                {title}
              </Link>
            ) : (
              <h3 className="pointer-events-auto m-0 flex w-full min-w-0 items-start justify-center gap-1 text-center">
                {title}
              </h3>
            )}
          </div>

          {/* The countdown rides the bottom-left of the art, out of the
              title's way and off the podium's first row. */}
          {showTimer && countdown && (
            <span
              className="sb-fs-10 absolute bottom-1 left-2 z-[2] font-mono text-[10px]"
              style={{ color: 'var(--sb-art-meta-strong)', textShadow: 'var(--sb-art-title-shadow)' }}
            >
              {countdown}
            </span>
          )}
        </div>

        {/* 2. Podium (always three places) + the tail. No top padding: the
               art's own bottom margin is the gutter. */}
        <div className="relative z-[1] flex-1 px-3 pb-3">
          <ArcadePodium
            entries={podiumEntries}
            slug={slug}
            viewerUsername={viewerUsername}
            onClaim={onSubmitScore ? () => onSubmitScore(lb) : undefined}
            hasMultiple={hasMultiple}
            expandedPlayer={expandedPlayer}
            playerHistory={playerHistory}
            historyLoading={historyLoading}
            onTogglePlayer={togglePlayer}
            onOpenQuickView={onOpenQuickView}
          />
          <div className="mt-1.5 space-y-1.5" style={{ minHeight: tailMinHeight }}>
            {belowPodium.map(entry => {
              const canExpand = hasMultiple(entry.iscored_username);
              const isExpanded = expandedPlayer === entry.iscored_username;
              return (
                <div key={`${entry.rank}-${entry.iscored_username}`}>
                  <ArcadeRow
                    entry={entry}
                    slug={slug}
                    isViewer={!!lowerViewer && entry.iscored_username.toLowerCase() === lowerViewer}
                    canExpand={canExpand}
                    isExpanded={isExpanded}
                    onToggle={() => togglePlayer(entry.iscored_username)}
                    onOpenQuickView={onOpenQuickView}
                  />
                  {isExpanded && (
                    <div className="mx-2 mt-0.5 mb-1 rounded bg-deep/50 px-2 py-1">
                      {historyLoading ? (
                        <p className="py-0.5 text-[11px] text-faint">Loading…</p>
                      ) : playerHistory.length > 0 ? (
                        <div className="space-y-0.5">
                          {playerHistory.map(h => (
                            <div
                              key={h.id}
                              className={`flex items-center justify-between text-[11px] ${onOpenQuickView ? 'cursor-pointer' : ''}`}
                              onClick={onOpenQuickView}
                            >
                              <span className="text-muted">{h.score.toLocaleString()}</span>
                              <span className="text-faint">{new Date(h.created_at).toLocaleDateString()}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="py-0.5 text-[11px] text-faint">No additional scores.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 3. Footer — a CONTAINED strip. A hairline rule with the card's own
               background put the footer in undifferentiated space directly
               above the next card on a stacked phone layout; a filled band with
               its own top border makes it visibly part of THIS card.
               `rounded-b-[8px]` is the card's 10px radius less its 2px frame:
               the card doesn't clip, so the one child with a fill of its own
               has to round its own bottom corners. */}
        <div
          className="relative z-[2] mt-auto flex items-start justify-between gap-2 rounded-b-[8px] border-t px-3"
          style={{
            background: 'var(--sb-card-footer-bg)',
            borderTopColor: 'var(--sb-card-footer-border)',
            paddingTop: 10,
            paddingBottom: 10 + qrMetrics.footerExtra,
          }}
        >
          <a
            href={`/${slug}/games/${encodeURIComponent(lb.gameName)}`}
            className="sb-fs-12 text-[12px] font-medium text-neon-cyan no-underline transition-colors hover:brightness-110"
          >
            Full Leaderboard &rarr;
          </a>
          <span className="sb-fs-11 text-[11px] text-muted">
            {lb.rankings.length} player{lb.rankings.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* QR — bottom edge, horizontally centred. Mirrors the top placement:
          marginTop of `qrOffsetPx` means a negative offset overlaps the card's
          bottom edge and a positive one pushes the QR away from it. */}
      {showQr && qrPosition === 'bottom-center' && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: qrOffsetPx, position: 'relative', zIndex: 15 }}>
          <GameQRCode slug={slug} gameId={lb.gameId} size={qrSize} />
        </div>
      )}
    </div>
  );
}
