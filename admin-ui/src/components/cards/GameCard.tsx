import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
    if (game.globalGameId) {
        return `/games/${game.globalGameId}?from=${encodeURIComponent(slug)}`;
    }
    return `/${slug}/games/${encodeURIComponent(game.gameName)}`;
}

/**
 * Shared card wrapper (Sprint 3, plan §10).
 *
 * Wraps CardRouter with:
 *   • Link overlay covering the card (title + image always navigate).
 *   • Always-visible submit affordance (top-right icon button).
 *   • Optional slot nodes for context-specific chrome (room badge, etc).
 *
 * Submit + slot children sit above the Link overlay via z-index, so clicks
 * on them do not trigger navigation. `e.preventDefault()` is still called as
 * a belt-and-suspenders for environments where the Link swallows the event.
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
    const linkTo = defaultLinkTarget(game, slug);

    const handleSubmit = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onSubmit?.(game);
    };

    const handleNavClick = onNavigate
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
            {/* Navigation overlay — always wired, regardless of context. */}
            <Link
                to={linkTo}
                onClick={handleNavClick}
                className="absolute inset-0 z-10"
                aria-label={game.displayName || game.gameName}
            />

            {/* Optional slot nodes (badges etc) — rendered above the Link overlay. */}
            {slots?.topLeft && (
                <div className="absolute top-1 left-1 z-20 pointer-events-auto">
                    {slots.topLeft}
                </div>
            )}
            {slots?.topRight && (
                <div className="absolute top-1 right-1 z-20 pointer-events-auto">
                    {slots.topRight}
                </div>
            )}

            {/* Submit affordance — always visible per §10.
                Sprint 13: outer 44×44 button is the tap target (iOS HIG min); inner 36×36
                span carries the visible chrome. group-hover/submit drives hover state on
                the inner span so mobile taps land anywhere in the 44×44 box. */}
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
            />

            {slots?.bottom && (
                <div className="relative z-20 mt-2">{slots.bottom}</div>
            )}
        </div>
    );
}
