import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Gamepad2, Trophy } from 'lucide-react';
import { ButtonLink } from '../parts/Button';
import { ListRow, ListRows } from '../parts/ListRow';
import { Skeleton, SkeletonRows } from '../parts/Skeleton';
import EmptyState from '../parts/EmptyState';
import LoadFailedNotice from '../LoadFailedNotice';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { catalogueImageFor } from '../../lib/catalogueImage';
import { formatCompactNumber, formatScore, parseServerDate, relativeTimeFrom, scoreTitle } from '../../lib/format';
import { roomInitials } from '../../lib/landingRooms';

/**
 * G35c - the landing page's Global Scoreboard panel: one kit panel (the
 * owner's lead panel, replacing the old "View All Scores" pill) with the
 * trophy, a LIVE lamp naming when the newest score came in, the way in to the
 * Global Scoreboard, the three most-played tables and their leaders, and the
 * floating score cards along its bottom.
 *
 * Two reads, each on its own `useRetryingLoad`, so one failing shows
 * `LoadFailedNotice` in its own place while the other renders: the newest
 * scores (`/api/global/recent-scores`, the cards and the lamp) and the boards
 * by popularity (`/api/global/scoreboard?sort=popular`, the hot tables).
 */

interface RecentScore {
    id: string;
    score: number;
    iscored_username: string;
    /** The player's chosen global name (`display_name` below is the GAME's). */
    player_display_name: string | null;
    submitted_at: string;
    discord_user_id: string;
    global_game_id: string;
    game_name: string;
    display_name: string | null;
    local_image_path: string | null;
    wheel_image_path: string | null;
    image_url: string | null;
    avatar_hash: string | null;
    avatar_url: string | null;
}

interface HotTable {
    global_game_id: string;
    name: string;
    display_name: string | null;
    image_url: string | null;
    local_image_path: string | null;
    wheel_image_path: string | null;
    score_count: number;
    category?: string | null;
    top_scores: Array<{ iscored_username: string; display_name?: string | null; score: number }>;
}

/**
 * Seconds of travel per card. Today's row moved at 304 px (a 286 px card and
 * its 18 px gap) per 5.2 s; the cards are now 380 px with a 20 px gap, so the
 * same speed is 6.9 s per card.
 */
const SECONDS_PER_CARD = 6.9;

/** The first three boards with a score, one per table (a table can have a board per category). */
function pickHotTables(boards: HotTable[]): HotTable[] {
    const seen = new Set<string>();
    const out: HotTable[] = [];
    for (const b of boards) {
        if (!b.top_scores?.length || seen.has(b.global_game_id)) continue;
        seen.add(b.global_game_id);
        out.push(b);
        if (out.length === 3) break;
    }
    return out;
}

/** The table's page, on the board this row was read from (as the Global Scoreboard's own cards link). */
function tableHref(b: HotTable): string {
    return b.category ? `/games/${b.global_game_id}?category=${encodeURIComponent(b.category)}` : `/games/${b.global_game_id}`;
}

function HotTables({ tables }: { tables: HotTable[] }) {
    return (
        <ListRows label="Hot tables" testId="landing-hot-tables">
            {tables.map(b => {
                const name = b.display_name || b.name;
                const art = catalogueImageFor(b);
                const top = b.top_scores[0]!;
                return (
                    <ListRow
                        key={b.global_game_id}
                        href={tableHref(b)}
                        name={name}
                        tile={art ? <img src={art} alt="" /> : roomInitials(name)}
                        caption={`${b.score_count.toLocaleString()} score${b.score_count === 1 ? '' : 's'}`}
                        trailing={(
                            <span className="lp-hot__lead">
                                <span className="lp-hot__who">{playerName(top)}</span>
                                <span className="lp-score" title={scoreTitle(top.score)}>{formatScore(top.score)}</span>
                            </span>
                        )}
                    />
                );
            })}
        </ListRows>
    );
}

function TickerCard({ score, copy = false }: { score: RecentScore; copy?: boolean }) {
    const [broken, setBroken] = useState(false);
    const art = catalogueImageFor(score);
    const game = score.display_name || score.game_name;
    const player = playerName({ iscored_username: score.iscored_username || '?', display_name: score.player_display_name });
    const ago = relativeTimeFrom(score.submitted_at);
    return (
        <Link
            to={score.global_game_id ? `/games/${score.global_game_id}` : '/scoreboard'}
            className="lp-tk__card"
            // The second copy only closes the loop: hidden from screen readers and the Tab order.
            aria-hidden={copy || undefined}
            tabIndex={copy ? -1 : undefined}
            data-copy={copy || undefined}
            data-testid={copy ? undefined : 'landing-ticker-card'}
            aria-label={copy ? undefined : `${game}: ${player}, ${formatScore(score.score)}, ${ago}`}
        >
            <span className="lp-tk__art">
                {art && !broken
                    ? <img src={art} alt="" onError={() => setBroken(true)} />
                    : <Gamepad2 aria-hidden="true" className="lp-tk__noart" />}
                <span className="lp-tk__score">{formatCompactNumber(score.score)}</span>
            </span>
            <span className="lp-tk__body">
                <span className="lp-tk__game">{game}</span>
                <span className="lp-tk__meta">
                    <PlayerAvatar
                        username={player}
                        discordUserId={score.discord_user_id}
                        avatarHash={score.avatar_hash}
                        avatarUrl={score.avatar_url}
                        size={26}
                    />
                    <span className="lp-tk__player">{player}</span>
                    <span className="lp-tk__ago">{ago}</span>
                </span>
            </span>
        </Link>
    );
}

/**
 * The floating score cards: the list twice in one row that slides by half
 * its width and starts again. It moves only for people who have not asked for
 * less motion and stops while pointed at or focused; with reduced motion the
 * second copy is not shown and the row scrolls by hand (`index.css`).
 */
function ScoreCards({ scores }: { scores: RecentScore[] }) {
    return (
        <div className="lp-tk__view" data-testid="landing-ticker">
            <div className="lp-tk__track" style={{ ['--lp-tk-dur' as string]: `${Math.round(scores.length * SECONDS_PER_CARD)}s` }}>
                {scores.map(s => <TickerCard key={s.id} score={s} />)}
                {scores.map(s => <TickerCard key={`${s.id}-copy`} score={s} copy />)}
            </div>
        </div>
    );
}

function ScoreCardsSkeleton() {
    return (
        <div className="lp-tk__view" role="status" aria-busy="true">
            <span className="sr-only">Loading the latest scores</span>
            <div className="lp-tk__track" aria-hidden="true">
                {[0, 1, 2, 3].map(i => (
                    <span key={i} className="lp-tk__card lp-tk__card--skel">
                        <span className="lp-tk__art"><Skeleton width="100%" height="100%" /></span>
                        <span className="lp-tk__body">
                            <Skeleton width="70%" height={16} />
                            <Skeleton width="50%" height={12} />
                        </span>
                    </span>
                ))}
            </div>
        </div>
    );
}

export default function GlobalPanel() {
    const [recent, setRecent] = useState<RecentScore[]>([]);
    const { load: loadRecent, phase: recentPhase } = useRetryingLoad(
        () => fetch('/api/global/recent-scores?limit=20'),
        async res => {
            const json: unknown = await res.json();
            if (!Array.isArray(json)) throw new Error('shape');
            setRecent(json as RecentScore[]);
        },
        'recent-scores',
    );
    const [hot, setHot] = useState<HotTable[]>([]);
    const { load: loadHot, phase: hotPhase } = useRetryingLoad(
        () => fetch('/api/global/scoreboard?sort=popular&limit=8'),
        async res => {
            const json = await res.json() as { data?: unknown };
            if (!json || !Array.isArray(json.data)) throw new Error('shape');
            setHot(pickHotTables(json.data as HotTable[]));
        },
        'hot-tables',
    );
    useEffect(() => {
        loadRecent();
        loadHot();
    }, [loadRecent, loadHot]);

    // The lamp: when the newest of the recent scores came in.
    const latest = useMemo(() => {
        let newest: string | null = null;
        let newestAt = -Infinity;
        for (const s of recent) {
            const at = parseServerDate(s.submitted_at)?.getTime();
            if (at != null && at > newestAt) {
                newestAt = at;
                newest = s.submitted_at;
            }
        }
        return newest ? relativeTimeFrom(newest) : null;
    }, [recent]);

    return (
        <section className="aw-panel lp-gs" aria-labelledby="lp-gs-title" data-testid="landing-global">
            <div className="lp-gs__top">
                <div className="lp-gs__intro">
                    <span className="lp-gs__tile" aria-hidden="true"><Trophy /></span>
                    <div className="lp-gs__head">
                        <h2 id="lp-gs-title" className="lp-gs__title">Global Scoreboard</h2>
                        <div className="lp-gs__sub">
                            <p className="lp-gs__line">High scores from every Arcaid room</p>
                            {latest && <span className="lp-lamp" data-testid="landing-latest">Live · Latest score {latest}</span>}
                        </div>
                    </div>
                    <div className="lp-gs__act">
                        <ButtonLink to="/scoreboard" className="min-h-11">
                            Open the Global Scoreboard
                            <ArrowRight aria-hidden="true" size={16} />
                        </ButtonLink>
                    </div>
                </div>
                <div className="lp-gs__hot">
                    <p className="aw-label">Hot tables</p>
                    {hotPhase === 'loading' ? (
                        <SkeletonRows count={3} label="Loading the hot tables" />
                    ) : hotPhase === 'retrying' ? (
                        <LoadFailedNotice what="the hot tables" onRetry={loadHot} testId="hot-tables-failed" className="py-6" />
                    ) : hot.length === 0 ? (
                        <EmptyState title="No scores yet.">The tables played most across every room show here.</EmptyState>
                    ) : (
                        <HotTables tables={hot} />
                    )}
                </div>
            </div>
            {!(recentPhase === 'ready' && recent.length === 0) && (
                <div className="lp-tk">
                    <div className="lp-tk__head">
                        <p className="aw-label">Latest scores</p>
                        <span className="lp-tk__hint">Tap a score to open its table</span>
                    </div>
                    {recentPhase === 'loading' ? (
                        <ScoreCardsSkeleton />
                    ) : recentPhase === 'retrying' ? (
                        <LoadFailedNotice what="the latest scores" onRetry={loadRecent} testId="latest-scores-failed" className="py-6" />
                    ) : (
                        <ScoreCards scores={recent} />
                    )}
                </div>
            )}
        </section>
    );
}
