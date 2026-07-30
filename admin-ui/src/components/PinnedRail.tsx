import { Link } from 'react-router-dom';
import { Pin, Plus, TrendingUp, TrendingDown } from 'lucide-react';
import { PlayerAvatar, playerName } from './ScoreboardComponents';
import { formatScore } from '../lib/format';
import { catalogueImageFor } from '../lib/catalogueImage';

/**
 * v2.52.0 (A4) — the "My Pins" rail on /scoreboard.
 *
 * Sits between the title block and the search field, logged-in only, and
 * renders NOTHING when the viewer has no pins (an empty amber panel offering
 * an add-tile is noise on a page whose primary job is browsing).
 *
 * Pins are unlimited, so the chip row scrolls horizontally rather than
 * wrapping — a wrapping rail would push the whole grid below the fold for
 * anyone with a real pin list.
 *
 * Deliberately NOT here: the header's "Alerts: …/Manage" block from the design
 * handoff. Rank-change alerting is A5; a control that advertises alerts nothing
 * yet sends would be a lie in the UI.
 *
 * Every colour is a token (`--sb-*`, `--color-*`) — global pages are
 * light-capable since A1.
 */

export interface PinnedGameChip {
    global_game_id: string;
    name: string;
    display_name: string | null;
    manufacturer: string | null;
    year: number | null;
    image_url: string | null;
    local_image_path: string | null;
    wheel_image_path: string | null;
    score_count: number;
    top_score: number | null;
    top_player: {
        iscored_username: string;
        display_name: string | null;
        discord_user_id: string;
        avatar_hash: string | null;
        score: number;
    } | null;
    my_rank: number | null;
    my_score: number | null;
    /** Negative = improved, positive = dropped, 0/null = no badge. */
    rank_delta: number | null;
    pinned_at: string;
}

interface Props {
    pins: PinnedGameChip[];
    /** Opens SubmissionSheet for that game (the chip's `+` button). */
    onSubmit: (pin: PinnedGameChip) => void;
    /** Trailing dashed tile — reuses the page's ⌘K palette open state. */
    onAdd: () => void;
}

/**
 * Rank movement badge. Rendered only when the delta is a non-zero number:
 * `0` (held station) and `null` (no prior reading — e.g. a fresh pin) both
 * mean "nothing worth drawing attention to".
 */
function DeltaBadge({ delta }: { delta: number }) {
    const improved = delta < 0;
    const Icon = improved ? TrendingUp : TrendingDown;
    const label = improved
        ? `Up ${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'place' : 'places'} since you pinned it`
        : `Down ${delta} ${delta === 1 ? 'place' : 'places'} since you pinned it`;
    return (
        <span
            className={`inline-flex items-center gap-0.5 rounded-[3px] px-1.5 py-px font-mono text-[9px] font-bold ${
                improved ? 'text-neon-green' : 'text-neon-coral'
            }`}
            style={{ background: 'var(--sb-art-btn-bg)' }}
            title={label}
        >
            <Icon className="h-2.5 w-2.5" aria-hidden="true" />
            {Math.abs(delta)}
            <span className="sr-only">{label}</span>
        </span>
    );
}

function PinChip({ pin, onSubmit }: { pin: PinnedGameChip; onSubmit: () => void }) {
    const img = catalogueImageFor(pin);
    const title = pin.display_name || pin.name;
    const champ = pin.top_player;

    return (
        <div className="relative w-[220px] shrink-0 overflow-hidden rounded-[10px] border border-border bg-surface">
            <Link
                to={`/games/${pin.global_game_id}`}
                className="relative block h-16 no-underline"
                title={title}
            >
                {img ? (
                    <img src={img} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                    <div className="absolute inset-0 bg-deep" />
                )}
                <div className="absolute inset-0" style={{ background: 'var(--sb-art-scrim)' }} />
                <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
                    {pin.rank_delta != null && pin.rank_delta !== 0 && <DeltaBadge delta={pin.rank_delta} />}
                    <span
                        className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[3px]"
                        style={{ background: 'var(--sb-art-btn-bg)' }}
                    >
                        <Pin className="h-2.5 w-2.5 text-neon-amber" aria-hidden="true" />
                    </span>
                </div>
                <h3
                    className="absolute inset-x-2.5 bottom-1 truncate font-display text-[12px] font-bold"
                    style={{ color: 'var(--sb-art-title)', textShadow: 'var(--sb-title-shadow)' }}
                >
                    {title}
                </h3>
            </Link>

            <div className="flex items-center gap-2 px-2.5 py-[7px]">
                {champ ? (
                    <>
                        <PlayerAvatar
                            username={playerName(champ)}
                            discordUserId={champ.discord_user_id}
                            avatarHash={champ.avatar_hash}
                            size={20}
                        />
                        <span className="shrink-0 text-[9px] font-semibold text-muted">#1</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-bold text-neon-amber">
                            {formatScore(champ.score)}
                        </span>
                    </>
                ) : (
                    <span className="min-w-0 flex-1 truncate text-[10px] text-muted">No scores yet</span>
                )}
                <button
                    type="button"
                    onClick={onSubmit}
                    className="shrink-0 rounded bg-neon-cyan px-2 py-[3px] text-[10px] font-bold text-deep transition hover:brightness-110"
                    title={`Submit a score for ${title}`}
                    aria-label={`Submit a score for ${title}`}
                >
                    +
                </button>
            </div>
        </div>
    );
}

export default function PinnedRail({ pins, onSubmit, onAdd }: Props) {
    // Zero pins → render nothing at all, not an empty shell.
    if (pins.length === 0) return null;

    return (
        <section
            aria-label="My pinned games"
            className="mb-5 rounded-[10px] border p-3.5"
            style={{ background: 'var(--sb-rail-bg)', borderColor: 'var(--sb-rail-border)' }}
        >
            <div className="mb-2.5 flex items-center gap-2">
                <Pin className="h-3.5 w-3.5 text-neon-amber" aria-hidden="true" />
                <h2 className="font-display text-[14px] font-bold tracking-[0.5px]">MY PINS</h2>
                <span className="text-[10px] text-muted">
                    — {pins.length} {pins.length === 1 ? 'game' : 'games'} watched
                </span>
            </div>

            <div className="flex gap-2.5 overflow-x-auto scrollbar-thin pb-1">
                {pins.map(pin => (
                    <PinChip key={pin.global_game_id} pin={pin} onSubmit={() => onSubmit(pin)} />
                ))}
                <button
                    type="button"
                    onClick={onAdd}
                    className="flex w-20 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-border text-faint transition-colors hover:border-neon-cyan hover:text-neon-cyan"
                    title="Find a game to pin"
                    aria-label="Find a game to pin"
                >
                    <Plus className="h-[22px] w-[22px]" aria-hidden="true" />
                </button>
            </div>
        </section>
    );
}
