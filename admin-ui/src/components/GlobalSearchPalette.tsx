import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Medal, Loader2 } from 'lucide-react';
import { catalogueImageFor } from '../lib/catalogueImage';
import { playerName } from './ScoreboardComponents';
import { formatScore } from '../lib/format';

/**
 * v2.51.0 (A3) — the ⌘K / Ctrl+K command palette on /scoreboard.
 *
 * Purpose, in one line: the shortest path from "I just played X" to "my score
 * is posted". Everything here optimises for that — the primary action on every
 * row is Submit, not "open the game page".
 *
 * This component OWNS the page's search field rather than rendering a second
 * one. Two inputs would mean juggling focus and reconciling two values; one
 * input that gains a focused treatment when the palette opens is both simpler
 * and what the design shows.
 *
 * Notes on the deliberate implementation choices:
 *   • The 300ms debounce is NOT re-implemented here. The page already debounces
 *     `searchInput` → `search`; that value arrives as `debouncedQuery`, so a
 *     burst of keystrokes produces exactly one palette request.
 *   • Selection tracking adjusts the list's `scrollTop` directly. `scrollIntoView`
 *     is banned: it scrolls the nearest scrollable ancestor too, which yanks the
 *     whole page while the user is typing.
 *   • Every colour is a token (`--sb-*`, `--color-*`). Global pages are
 *     light-capable since A1, so a literal rgba() here would be a light-mode bug.
 */

export interface PaletteScore {
    iscored_username: string;
    display_name?: string | null;
    score: number;
}

export interface PaletteGame {
    global_game_id: string;
    name: string;
    display_name: string | null;
    manufacturer: string | null;
    year: number | null;
    image_url: string | null;
    local_image_path: string | null;
    wheel_image_path: string | null;
    score_count: number;
    top_scores?: PaletteScore[];
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Live input text (owned by the page so the grid behind filters too). */
    value: string;
    onValueChange: (next: string) => void;
    /** The page's already-debounced query. Do not debounce it again. */
    debouncedQuery: string;
    /** Active room scope — the palette respects the page's filters. */
    scope: string;
    /** Active fidelity-category chip (`all` | a `CARD_CATEGORY_ORDER` id). */
    category: string;
    /** Drives the logged-out footer hint; submission gating lives on the page. */
    loggedIn: boolean;
    onSubmitGame: (game: PaletteGame) => void;
}

/** A palette shows a handful of rows; the grid behind is the "full results". */
const PALETTE_LIMIT = 10;

export default function GlobalSearchPalette({
    open,
    onOpenChange,
    value,
    onValueChange,
    debouncedQuery,
    scope,
    category,
    loggedIn,
    onSubmitGame,
}: Props) {
    const navigate = useNavigate();
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
    const measureRef = useRef<HTMLSpanElement>(null);
    const caretRef = useRef<HTMLSpanElement>(null);

    const [results, setResults] = useState<PaletteGame[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState(0);
    const [caretPos, setCaretPos] = useState(0);

    const listId = useId();
    const optionId = (i: number) => `${listId}-opt-${i}`;

    // ── Trigger ────────────────────────────────────────────────────────────
    // ⌘K / Ctrl+K from anywhere on the page. Focus already inside some *other*
    // text field means the user is typing, not navigating — leave them alone.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'k' && e.key !== 'K') return;
            if (!e.metaKey && !e.ctrlKey) return;
            const target = e.target as HTMLElement | null;
            if (target && target !== inputRef.current) {
                const tag = target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
            }
            e.preventDefault();
            onOpenChange(true);
            const el = inputRef.current;
            if (el) {
                el.focus();
                el.select();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onOpenChange]);

    // ── Data ───────────────────────────────────────────────────────────────
    const requestUrl = useCallback((query: string): string => {
        const params = new URLSearchParams({
            sort: 'popular',
            scope,
            limit: String(PALETTE_LIMIT),
            offset: '0',
            search: query,
            // v2.59.0 (P4) — the grid lists per-category CARDS; the palette
            // lists GAMES. `groupBy=game` collapses the rows server-side, so a
            // game with three category boards is one result, its `score_count`
            // is the game's real total, and the `total` in the footer counts
            // games rather than boards. Deduping client-side instead would
            // have made both of those numbers lie.
            groupBy: 'game',
        });
        // A game still qualifies through the active chip: with a category set,
        // the endpoint keeps only games that have at least one score in it.
        if (category !== 'all') params.set('category', category);
        return `/api/global/scoreboard?${params.toString()}`;
    }, [scope, category]);

    const query = debouncedQuery.trim();
    // "Has something to search for". Stale rows are gated out at render time
    // rather than reset in an effect — one less state round-trip, and no flash
    // of the previous query's results when the field is cleared.
    const active = open && query.length > 0;

    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        setLoading(true);
        fetch(requestUrl(query), { signal: controller.signal })
            .then(r => (r.ok ? r.json() : { data: [], total: 0 }))
            .then(payload => {
                setResults(payload.data || []);
                setTotal(payload.total || 0);
                setSelected(0);
            })
            .catch(() => { /* aborted or offline — keep the previous rows */ })
            .finally(() => setLoading(false));
        return () => controller.abort();
    }, [active, query, requestUrl]);

    // ── Selection tracking (scrollTop, never scrollIntoView) ────────────────
    useEffect(() => {
        const list = listRef.current;
        const row = rowRefs.current[selected];
        if (!list || !row) return;
        const top = row.offsetTop;
        const bottom = top + row.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }, [selected, results]);

    // ── Fake caret ─────────────────────────────────────────────────────────
    // The native caret can't be 2px-cyan-with-a-guardable-blink, so the input's
    // own caret is transparent and a styled bar is positioned at the measured
    // width of the text preceding the cursor (so mid-string edits track too).
    // The offset is written straight onto the node — it's a measurement, and
    // routing it through state would re-render the whole palette per keystroke.
    useLayoutEffect(() => {
        if (!open || !caretRef.current) return;
        caretRef.current.style.left = `${measureRef.current?.offsetWidth ?? 0}px`;
    }, [open, value, caretPos]);

    const syncCaret = () => setCaretPos(inputRef.current?.selectionStart ?? value.length);

    // ── Actions ────────────────────────────────────────────────────────────
    const close = useCallback(() => {
        onOpenChange(false);
        // Esc leaves focus on the field (a11y): the palette is a dropdown, not
        // a modal, and dumping focus on <body> would strand keyboard users.
        // Safe to call unconditionally — the field never re-opens on focus,
        // only on click / typing / ⌘K.
        inputRef.current?.focus();
    }, [onOpenChange]);

    // Esc works even when focus has moved into the dropdown (e.g. a row's
    // Submit button), and an outside click dismisses without stealing focus.
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        };
        const onPointerDown = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) onOpenChange(false);
        };
        window.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onPointerDown);
        };
    }, [open, close, onOpenChange]);

    const openDetails = useCallback((game: PaletteGame) => {
        onOpenChange(false);
        navigate(`/games/${game.global_game_id}`);
    }, [navigate, onOpenChange]);

    const submit = useCallback((game: PaletteGame) => {
        onOpenChange(false);
        onSubmitGame(game);
    }, [onOpenChange, onSubmitGame]);

    /** Rows actually on screen — empty until the debounced query is non-empty. */
    const rows = active ? results : [];

    const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // Escape is handled by the window-level listener above (it must also
        // work when focus sits on a row button), so it is deliberately absent.
        if (!open) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (rows.length === 0) return;
            e.preventDefault();
            // Wrap at both ends — a 3-row palette should never dead-end.
            setSelected(prev => {
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                return (prev + delta + rows.length) % rows.length;
            });
            return;
        }
        if (e.key === 'Enter') {
            const game = rows[selected];
            if (!game) {
                // Nothing to act on — the grid behind already holds the full
                // result set, so ↵ just gets out of the way.
                close();
                return;
            }
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) openDetails(game);
            else submit(game);
        }
    };

    const showDropdown = open;
    const remaining = active ? Math.max(total - rows.length, 0) : 0;

    return (
        <div className="relative flex-1" ref={containerRef}>
            <Search
                className={`pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 ${open ? 'text-neon-cyan' : 'text-muted'}`}
            />
            <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label="Search games"
                aria-expanded={showDropdown}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={showDropdown && rows.length > 0 ? optionId(selected) : undefined}
                placeholder="Search games..."
                value={value}
                onChange={e => {
                    onValueChange(e.target.value);
                    if (!open) onOpenChange(true);
                    syncCaret();
                }}
                onClick={() => { if (!open) onOpenChange(true); syncCaret(); }}
                onFocus={syncCaret}
                onKeyUp={syncCaret}
                onSelect={syncCaret}
                onKeyDown={onInputKeyDown}
                className={`w-full rounded-lg border py-2 pl-10 text-primary placeholder:text-muted focus:outline-none ${
                    open
                        ? 'border-neon-cyan pr-24 font-mono text-[14px] caret-transparent'
                        : 'border-border bg-surface pr-3'
                }`}
                style={open ? { background: 'var(--sb-palette-field-bg)', boxShadow: 'var(--sb-palette-glow)' } : undefined}
            />

            {/* Caret overlay — `left-10` matches the input's pl-10 text origin. */}
            {open && (
                <div className="pointer-events-none absolute inset-y-0 left-10 right-24 overflow-hidden" aria-hidden="true">
                    <span
                        ref={measureRef}
                        className="invisible absolute left-0 top-1/2 -translate-y-1/2 whitespace-pre font-mono text-[14px]"
                    >
                        {value.slice(0, caretPos)}
                    </span>
                    <span
                        ref={caretRef}
                        className="gsp-caret absolute left-0 top-1/2 h-[18px] w-[2px] -translate-y-1/2 bg-neon-cyan"
                    />
                </div>
            )}

            {open && (
                <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
                    {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-neon-cyan" aria-label="Searching" />}
                    <span className="text-[11px] text-muted">esc to close</span>
                </div>
            )}

            {showDropdown && (
                <div
                    className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-lg border border-border bg-surface"
                    style={{ boxShadow: 'var(--sb-palette-shadow)' }}
                >
                    {/* Header strip */}
                    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-[10px] tracking-[1px]">
                        <span className="text-faint">
                            {active
                                ? `GAMES — ${total.toLocaleString()} ${total === 1 ? 'MATCH' : 'MATCHES'}`
                                : 'GAMES'}
                        </span>
                        {/* The design handoff put "Press ↵ for full results" here while its
                            own footer said "↵ submit score" — ↵ can't do both, and the
                            contract makes ↵ submit. The footer carries the full key hints,
                            so this slot just names the selected-row action instead of
                            contradicting it. */}
                        <span className="text-faint">↑↓ to browse</span>
                    </div>

                    {/* Rows */}
                    <div
                        id={listId}
                        ref={listRef}
                        role="listbox"
                        aria-label="Game search results"
                        className="relative max-h-[min(320px,45vh)] overflow-y-auto scrollbar-thin"
                    >
                        {!active ? (
                            <div className="px-4 py-4 text-[12px] text-muted">
                                Start typing to search the catalogue — try a title, a manufacturer, or a year.
                            </div>
                        ) : rows.length === 0 ? (
                            <div className="px-4 py-4 text-[12px] text-muted">
                                {loading ? 'Searching…' : `No games match "${query}".`}
                            </div>
                        ) : (
                            rows.map((game, i) => (
                                <PaletteRow
                                    key={game.global_game_id}
                                    ref={el => { rowRefs.current[i] = el; }}
                                    id={optionId(i)}
                                    game={game}
                                    selected={i === selected}
                                    onHover={() => setSelected(i)}
                                    onSubmit={() => submit(game)}
                                    onOpenDetails={() => openDetails(game)}
                                />
                            ))
                        )}
                    </div>

                    {/* Footer strip */}
                    <div
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[10px] text-muted"
                        style={{ background: 'var(--sb-palette-strip-bg)' }}
                    >
                        <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd> navigate</span>
                        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> submit score</span>
                        <span className="hidden items-center gap-1.5 sm:flex"><Kbd>⌘↵</Kbd> open details</span>
                        <span className="ml-auto flex items-center gap-3">
                            {/* Provider-agnostic: Google is a full IdP here, so
                                the palette never says "Discord". */}
                            {!loggedIn && <span className="text-neon-cyan">Log in to submit a score</span>}
                            {remaining > 0 && (
                                <span>
                                    {`${remaining.toLocaleString()} more ${remaining === 1 ? 'game' : 'games'} matched "${query}"`}
                                </span>
                            )}
                        </span>
                    </div>
                </div>
            )}

            {/* Scoped caret animation. The blink is decorative, so it is nulled
                under prefers-reduced-motion (same convention as TourOverlay). */}
            <style>{`
                @keyframes gsp-caret-blink { 50% { opacity: 0; } }
                .gsp-caret { animation: gsp-caret-blink 1s step-end infinite; }
                @media (prefers-reduced-motion: reduce) {
                    .gsp-caret { animation: none !important; }
                }
            `}</style>
        </div>
    );
}

function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <kbd
            className="rounded-[3px] border px-[5px] py-px font-mono text-[9px] text-primary"
            style={{ background: 'var(--sb-kbd-bg)', borderColor: 'var(--sb-kbd-border)' }}
        >
            {children}
        </kbd>
    );
}

interface RowProps {
    id: string;
    game: PaletteGame;
    selected: boolean;
    onHover: () => void;
    onSubmit: () => void;
    onOpenDetails: () => void;
}

const PaletteRow = function PaletteRow({
    ref, id, game, selected, onHover, onSubmit, onOpenDetails,
}: RowProps & { ref?: (el: HTMLDivElement | null) => void }) {
    const img = catalogueImageFor(game);
    const title = game.display_name || game.name;
    const champion = game.top_scores?.[0];

    return (
        <div
            ref={ref}
            id={id}
            role="option"
            aria-selected={selected}
            aria-label={title}
            onMouseEnter={onHover}
            onClick={onOpenDetails}
            className="flex cursor-pointer items-center gap-3.5 border-b border-border/30 px-4 py-2.5 last:border-b-0"
            style={selected ? { background: 'var(--sb-palette-row-sel)' } : undefined}
        >
            {img ? (
                <img
                    src={img}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-[42px] w-[42px] shrink-0 rounded-[5px] object-cover"
                />
            ) : (
                <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[5px] bg-deep text-[8px] text-muted">
                    No art
                </div>
            )}

            <div className="min-w-0 flex-1">
                <div className="truncate font-display text-[14px] font-bold text-primary">{title}</div>
                <div className="truncate text-[10px] text-muted">
                    {game.manufacturer || 'Unknown'}
                    {game.year ? ` · ${game.year}` : ''}
                    {` · ${game.score_count.toLocaleString()} ${game.score_count === 1 ? 'score' : 'scores'}`}
                </div>
            </div>

            {champion && (
                <div className="hidden shrink-0 text-right sm:block">
                    <div className="flex items-center justify-end gap-1 text-[9px] text-muted">
                        <Medal className="h-[9px] w-[9px] text-neon-amber" aria-hidden="true" />
                        <span className="max-w-[90px] truncate">{playerName(champion)}</span>
                    </div>
                    <div className="font-mono text-[12px] font-bold text-neon-amber">
                        {formatScore(champion.score)}
                    </div>
                </div>
            )}

            <button
                type="button"
                onClick={e => { e.stopPropagation(); onSubmit(); }}
                className={`shrink-0 rounded-[4px] px-3.5 py-1.5 text-[11px] font-bold transition ${
                    selected
                        ? 'bg-neon-cyan text-deep hover:brightness-110'
                        : 'border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10'
                }`}
            >
                {selected ? '↵ Submit' : 'Submit'}
            </button>
        </div>
    );
};
