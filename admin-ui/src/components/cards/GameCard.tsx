import type { ReactNode } from 'react';
import CardRouter from '../scoreboard/CardRouter';
import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import type { ScoreboardStyle } from '../../lib/scoreboardThemes';
import { Plus } from 'lucide-react';

/**
 * Surfaces that render a GameCard. Used for:
 *   • Telling the card whether navigation + submit should be active.
 *   • Picking the right default link path.
 * See tmp/scores-nav-reorg-plan-v1.md §10 for the contract.
 */
export type GameCardContext =
    | 'tournament'
    | 'all-games'
    | 'global'
    | 'picks'
    | 'search'
    | 'profile';

export interface GameCardSlots {
    /** Rendered inside the card wrapper, above the card (e.g. room badge). */
    topLeft?: ReactNode;
    topRight?: ReactNode;
    /** Rendered inside the card wrapper, below the card (e.g. "Your best" footer). */
    bottom?: ReactNode;
}

export interface GameCardProps {
    /** Game leaderboard data (identical shape CardRouter already consumes). */
    game: GameLeaderboard;
    /** The surface hosting the card. */
    context: GameCardContext;
    /** Slug of the room the card belongs to. Required for scoreboard/room links. */
    slug: string;
    roomId?: string;
    /** Invoked when the user clicks the submit affordance. */
    onSubmit?: (game: GameLeaderboard) => void;
    /**
     * Optional override for the navigation target. Defaults to the shared
     * detail route — /games/:globalGameId (if linked) or /:slug/games/:name.
     */
    onNavigate?: (game: GameLeaderboard) => void;
    /** Custom slot nodes (top badges, bottom footers). */
    slots?: GameCardSlots;

    // --- Styling pass-through (mirrors CardRouter) ---
    style: ScoreboardStyle;
    theme?: string;
    maxScores: number;
    minScores?: number;
    showTimer?: boolean;
    viewerUsername?: string;
    viewerEntry?: RankedEntry | null;
    qrMode?: string;
    qrSize?: number;
    qrPosition?: string;
    cardBgFill?: boolean;
    titleFontSize?: number;
    gameTitleStyle?: string;

    /** Max width of the card column (defaults to whatever CardRouter decides). */
    maxWidth?: number;
    className?: string;
}

function defaultLinkTarget(game: GameLeaderboard, slug: string): string {
    // v2.2.6: always link to the room-scoped Game Detail so clicks show the
    // same scores that appeared on the card (including anon/guest submissions).
    // Pre-v2.2.6 we routed to the Global Game Detail when a globalGameId was
    // present — but Global correctly hides anon submissions via the fan-out
    // gate, so users saw scores vanish when they clicked through. Global is
    // still reachable via `/scoreboard` → game tile.
    return `/${slug}/games/${encodeURIComponent(game.gameName)}`;
}

/**
 * Shared card wrapper.
 *
 * v2.2.8 — removed the inset-0 Link overlay that used to cover the whole
 * card. The overlay was intercepting clicks on expand (+) icons and inline
 * score rows, and no amount of pointer-events / z-index juggling in the
 * child cards was reliable across layouts. Now:
 *   • Each card style (BannerCard / MinimalCard / ShowcaseCard) wraps its
 *     own title in a Link via the `titleLinkTo` prop plumbed through
 *     CardRouter. Click the title → navigate.
 *   • Submit button is an always-visible top-right affordance, as before.
 *   • Score rows with onClick handlers just work — no competing overlay.
 *   • Slot badges / footers render normally.
 */
export default function GameCard({
    game,
    context,
    slug,
    roomId,
    onSubmit,
    onNavigate,
    slots,
    style,
    theme,
    maxScores,
    minScores,
    showTimer,
    viewerUsername,
    viewerEntry,
    qrMode,
    qrSize,
    qrPosition,
    cardBgFill,
    titleFontSize,
    gameTitleStyle,
    maxWidth,
    className,
}: GameCardProps) {
    const titleLinkTo = defaultLinkTarget(game, slug);

    const handleSubmit = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onSubmit?.(game);
    };

    const handleTitleNav = onNavigate
        ? (e: React.MouseEvent) => {
              e.preventDefault();
              onNavigate(game);
          }
        : undefined;

    return (
        <div
            data-context={context}
            className={`relative group/card justify-self-center w-full ${className ?? ''}`}
            style={maxWidth ? { maxWidth: `${maxWidth}px` } : undefined}
        >
            {/* Optional slot nodes (badges etc). */}
            {slots?.topLeft && (
                <div className="absolute top-1 left-1 z-20">
                    {slots.topLeft}
                </div>
            )}
            {slots?.topRight && (
                <div className="absolute top-1 right-1 z-20">
                    {slots.topRight}
                </div>
            )}

            {/* Submit affordance — always visible per §10.
                Sprint 13: outer 44×44 button is the tap target (iOS HIG min);
                inner 36×36 span carries the visible chrome. */}
            {onSubmit && (
                <button
                    type="button"
                    onClick={handleSubmit}
                    className="absolute top-0 right-0 z-20 w-11 h-11 inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-full group/submit focus:outline-none"
                    aria-label={`Submit score for ${game.displayName || game.gameName}`}
                    title="Submit score"
                >
                    <span className="w-9 h-9 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan group-hover/submit:bg-neon-cyan/20 group-focus/submit:bg-neon-cyan/20 flex items-center justify-center transition-colors backdrop-blur-sm">
                        <Plus size={18} />
                    </span>
                </button>
            )}

            <CardRouter
                lb={game}
                slug={slug}
                roomId={roomId}
                style={style}
                theme={theme}
                maxScores={maxScores}
                minScores={minScores}
                showTimer={showTimer}
                viewerUsername={viewerUsername}
                viewerEntry={viewerEntry}
                qrMode={qrMode}
                qrSize={qrSize}
                qrPosition={qrPosition}
                cardBgFill={cardBgFill}
                titleFontSize={titleFontSize}
                gameTitleStyle={gameTitleStyle}
                onSubmitScore={onSubmit}
                titleLinkTo={titleLinkTo}
                titleLinkOnClick={handleTitleNav}
            />

            {slots?.bottom && (
                <div className="relative z-20 mt-2">{slots.bottom}</div>
            )}
        </div>
    );
}
