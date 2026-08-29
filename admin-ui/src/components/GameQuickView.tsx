import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, ExternalLink, Star, Trash2, Plus, Minus, Camera } from 'lucide-react';
import type { RankedEntry } from './ScoreboardComponents';
import { PlayerAvatar, playerName } from './ScoreboardComponents';
import { getLegacyPlatformLabel } from '../lib/scoreProvenance';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { decodeViewerClaims } from '../lib/viewerClaims';
import { canDeleteRow, deleteScoreHistory, rowHistoryId } from '../lib/scoreDelete';
import { useScoreExpand } from './scoreboard/useScoreExpand';
import { parseServerDate } from '../lib/format';
import ConfirmModal from './ConfirmModal';
import ScorePhotoModal from './ScorePhotoModal';

/**
 * v2.13.12 — lightweight popup preview of a game's top scores + metadata,
 * triggered by clicking a game card title on the public scoreboard. Replaces
 * direct navigation to GameDetail so users can peek without losing tab
 * context. Falls through to the full GameDetail page via "View full info →"
 * or to the game's Global Scoreboard detail page via "Global Scoreboard →".
 *
 * Middle-click / ctrl-click / cmd-click on the card title still navigates
 * directly (the click handler that opens this modal preventDefaults only
 * plain left-click — see Scoreboard.tsx).
 */
interface GlobalGameMeta {
  manufacturer: string | null;
  year: number | null;
  platforms: string[];
}

/**
 * What this popup actually reads off its subject.
 *
 * v2.84.0 — deliberately NOT `GameLeaderboard`. The component only ever
 * touched these five fields, so widening the prop to the structural minimum
 * lets a caller that has no leaderboard at all (the Picks availability list)
 * open the same popup. `GameLeaderboard` still satisfies this interface
 * structurally, so the three original call sites pass exactly what they always
 * did and are unaffected.
 */
export interface QuickViewTarget {
  gameName: string;
  imageUrl?: string | null;
  tournamentName?: string | null;
  globalGameId?: string | null;
  rankings?: RankedEntry[];
  /**
   * v2.108.0 — the tournament game id, when the caller has one. Only used to
   * fetch per-player score counts for the nested-history expand; absent (or a
   * Room Scores synthetic `room_<name>` id) simply means no expand chevrons.
   */
  gameId?: string;
}

/** A single headline figure shown in place of the top-10 list. */
export interface QuickViewStat {
  label: string;
  /** `null` renders no body at all — see the `highlightStat` prop note. */
  value: number | null;
  player?: string | null;
}

interface Props {
  lb: QuickViewTarget;
  slug: string;
  /** Tab the user came from. Threaded into "View full info" and "Global Scoreboard"
   *  links so GameDetail's back link returns to the correct tab. */
  fromTab?: string | null;
  /**
   * Presentational mode (v2.84.0). Passing this AT ALL replaces the top-10
   * score list with one compact stat — for callers that know a single figure
   * about the game but hold no leaderboard.
   *
   * A `null` value renders no body section rather than the list's "No scores
   * yet" copy: that message means "this leaderboard is empty", which would be
   * a claim this caller never made and cannot support.
   */
  highlightStat?: QuickViewStat;
  /**
   * v2.108.0 (F4) — the room these scores belong to. Passing it turns on the
   * per-row delete affordances (own rows for players, any row for admins of
   * this room) and the nested per-player history expand. OMITTING it renders
   * the popup exactly as it did before: the Global tab and the Picks
   * `highlightStat` mode pass nothing and are byte-identical to v2.107.
   */
  roomId?: string;
  /** Fired after a successful delete so the owning page can refetch. */
  onScoreDeleted?: () => void;
  onClose: () => void;
}

export default function GameQuickView({ lb, slug, fromTab, highlightStat, roomId, onScoreDeleted, onClose }: Props) {
  const [meta, setMeta] = useState<GlobalGameMeta | null>(null);
  const backdropMouseDown = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // v2.108.0 (F4) — delete plumbing. All of it is inert without `roomId`:
  // `canDeleteRow` returns false for an undefined room, and `useScoreExpand`
  // no-ops without a room id, so the popup renders exactly as before.
  const { playerToken } = useViewerAuth();
  const claims = useMemo(() => decodeViewerClaims(playerToken), [playerToken]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<{ historyId: number; score: number } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // v2.109.0 (score-gesture-photos) — clicking a row's body (main ranked row
  // or any expanded nested history row) opens that score's photo evidence,
  // but ONLY when the row actually has a photo (no dead click). Reuses the
  // SAME lightbox `ScoreboardComponents.tsx`'s legacy GameCard already uses
  // for its own inline history expand — see ScorePhotoModal.tsx.
  const [photoModal, setPhotoModal] = useState<{ playerName: string; score: number; photoUrl: string; historyId: number | null } | null>(null);
  const {
    expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple, removeHistoryEntry,
  } = useScoreExpand(roomId, lb.gameId ?? '', lb.gameName, (lb.rankings ?? []).length);

  const runDelete = async (historyId: number) => {
    if (!roomId) return;
    setDeleteError(null);
    const result = await deleteScoreHistory(roomId, historyId, playerToken);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    setDeletedIds(prev => new Set(prev).add(historyId));
    removeHistoryEntry(historyId);
    onScoreDeleted?.();
  };

  // s20: initial focus into the dialog + focus-return to the trigger on close.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  // s20: minimal Tab focus loop — keeps focus inside the dialog while open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Pull catalogue metadata for the subtitle. Optional — if there's no
  // globalGameId or the fetch fails, the modal just shows the tournament name.
  useEffect(() => {
    if (!lb.globalGameId) return;
    let cancelled = false;
    fetch(`/api/global/games/${lb.globalGameId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(g => {
        if (!cancelled && g) {
          setMeta({
            manufacturer: g.manufacturer || null,
            year: g.year || null,
            platforms: Array.isArray(g.platforms) ? g.platforms : [],
          });
        }
      })
      .catch(() => { /* swallow */ });
    return () => { cancelled = true; };
  }, [lb.globalGameId]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Compose links so GameDetail's back link returns to the originating tab.
  const tabSuffix = fromTab && fromTab !== 'tournaments'
    ? `?tab=${fromTab === 'all-games' ? 'room' : fromTab}`
    : '';
  const fullInfoHref = `/${slug}/games/${encodeURIComponent(lb.gameName)}${tabSuffix}`;
  const globalHref = lb.globalGameId
    ? `/games/${lb.globalGameId}?from=${encodeURIComponent(slug)}${fromTab ? `&tab=${fromTab}` : ''}`
    : null;

  const topScores = (lb.rankings ?? [])
    .filter(e => {
      const hid = rowHistoryId(e);
      return hid == null || !deletedIds.has(hid);
    })
    .slice(0, 10);

  const subtitleParts: string[] = [];
  if (meta?.manufacturer) subtitleParts.push(meta.manufacturer);
  if (meta?.year) subtitleParts.push(String(meta.year));
  if (meta?.platforms?.length) {
    // v2.58.0 (ADR 0016): engine/device vocabulary + dedupe, so a game on both
    // `vpx` and `vpxs` reads "Visual Pinball X" once, not twice.
    subtitleParts.push(
      [...new Set(meta.platforms.map(p => getLegacyPlatformLabel(p, false)))].join(', '),
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
      // mousedown-on-backdrop + mouseup-on-backdrop required to dismiss; prevents
      // accidental close when text-selection drags off the inner card.
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={lb.gameName ? `${lb.gameName} preview` : 'Game preview'}
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with optional image background */}
        <div
          className="relative px-5 py-5 border-b border-border"
          style={lb.imageUrl ? {
            backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0.45), rgba(0,0,0,0.85)), url(${lb.imageUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'top center',
          } : undefined}
        >
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full p-1.5 backdrop-blur-sm border-0 cursor-pointer transition-colors"
          >
            <X size={16} />
          </button>
          <h2 className={`font-display text-lg font-bold pr-8 leading-tight ${lb.imageUrl ? 'text-white' : 'text-primary'}`}>
            {lb.gameName}
          </h2>
          {subtitleParts.length > 0 && (
            <p className={`text-xs mt-1.5 ${lb.imageUrl ? 'text-white/70' : 'text-muted'}`}>
              {subtitleParts.join(' · ')}
            </p>
          )}
          {lb.tournamentName && (
            <p className={`text-[10px] uppercase tracking-wider mt-1.5 ${lb.imageUrl ? 'text-white/50' : 'text-faint'}`}>
              {lb.tournamentName}
            </p>
          )}
        </div>

        {/* Body: one headline stat in presentational mode, else the top-10. */}
        {highlightStat !== undefined ? (
          highlightStat.value != null && (
            <div className="px-5 py-4">
              <p className="text-[10px] uppercase tracking-wider text-faint">{highlightStat.label}</p>
              <div className="flex items-baseline gap-2 mt-1.5">
                <Star size={14} className="text-neon-amber flex-shrink-0 self-center" />
                <span className="font-display text-xl font-bold text-neon-amber tabular-nums">
                  {highlightStat.value.toLocaleString()}
                </span>
                {highlightStat.player && (
                  <span className="text-sm text-muted truncate min-w-0">{highlightStat.player}</span>
                )}
              </div>
            </div>
          )
        ) : (
        <div className="px-5 py-3">
          {topScores.length === 0 ? (
            <p className="text-sm text-faint text-center py-6">No scores yet</p>
          ) : (
            topScores.map((entry) => {
              // v2.108.0 (F4) — per-row delete + nested history. Both are
              // gated on `roomId`; without one, `canDelete` is false and
              // `canExpand` is false, and this renders as it always did.
              const historyId = rowHistoryId(entry);
              const canDelete = canDeleteRow(entry, claims, roomId);
              const canExpand = !!roomId && hasMultiple(entry.iscored_username);
              const isExpanded = expandedPlayer === entry.iscored_username;
              // v2.109.0 (score-gesture-photos) — the row body opens the
              // photo evidence viewer, but only when this row HAS a photo.
              const rowPhotoUrl = entry.photo_url ?? null;
              return (
              <div key={`${entry.iscored_username}-${entry.rank}`}>
                <div
                  className={`flex items-center gap-3 py-2 border-b border-border/30 last:border-0 ${rowPhotoUrl ? 'cursor-pointer' : ''}`}
                  onClick={rowPhotoUrl ? () => setPhotoModal({ playerName: playerName(entry), score: entry.score, photoUrl: rowPhotoUrl, historyId }) : undefined}
                >
                  <span
                    className={`font-display font-bold text-sm w-5 text-right tabular-nums flex-shrink-0 ${
                      entry.rank === 1 ? 'text-neon-amber'
                        : entry.rank === 2 ? 'text-neon-cyan'
                        : entry.rank === 3 ? 'text-neon-green'
                        : 'text-faint'
                    }`}
                  >
                    {entry.rank}
                  </span>
                  <PlayerAvatar
                    username={playerName(entry)}
                    discordUserId={entry.discord_user_id}
                    avatarHash={entry.avatar_hash}
                    avatarUrl={entry.avatar_url}
                    size={22}
                  />
                  <span className="flex-1 text-sm text-secondary truncate">
                    {playerName(entry)}
                  </span>
                  <span
                    className={`text-sm font-bold tabular-nums flex-shrink-0 ${
                      entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                    }`}
                  >
                    {entry.score.toLocaleString()}
                  </span>
                  {/* v2.109.0 (score-gesture-photos) — the affordance cue: a
                      photo-carrying row gets the glyph, a photo-less row gets
                      neither the glyph nor a clickable body. */}
                  {rowPhotoUrl && (
                    <Camera size={12} className="text-faint flex-shrink-0" aria-hidden />
                  )}
                  {canExpand && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); togglePlayer(entry.iscored_username); }}
                      className="p-1 -m-0.5 text-faint hover:text-neon-cyan transition-colors cursor-pointer flex-shrink-0"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? 'Hide score history' : 'Show score history'}
                      title={isExpanded ? 'Hide score history' : 'Show score history'}
                    >
                      {isExpanded ? <Minus size={13} /> : <Plus size={13} />}
                    </button>
                  )}
                  {/* Always visible, never hover-gated — the owner ask is that
                      removing a score you just posted takes no hunting. */}
                  {canDelete && historyId != null && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setPendingDelete({ historyId, score: entry.score }); }}
                      className="p-1 -m-0.5 text-red-400/70 hover:text-red-400 transition-colors cursor-pointer flex-shrink-0"
                      aria-label={`Delete this score (${entry.score.toLocaleString()})`}
                      title="Delete this score"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>

                {isExpanded && (
                  <div className="ml-8 mr-1 mb-2 rounded bg-deep/50 px-2 py-1.5">
                    {historyLoading ? (
                      <p className="text-[11px] text-faint py-1">Loading…</p>
                    ) : playerHistory.length > 0 ? (
                      <div className="space-y-1">
                        {playerHistory.map(h => {
                          const canDeleteNested = canDeleteRow(h, claims, roomId);
                          const hPhotoUrl = h.photo_url ?? null;
                          return (
                            <div
                              key={h.id}
                              className={`flex items-center gap-2 text-[11px] ${hPhotoUrl ? 'cursor-pointer' : ''}`}
                              onClick={hPhotoUrl ? () => setPhotoModal({ playerName: playerName(entry), score: h.score, photoUrl: hPhotoUrl, historyId: h.id }) : undefined}
                            >
                              <span className="text-muted tabular-nums">{h.score.toLocaleString()}</span>
                              {hPhotoUrl && (
                                <Camera size={11} className="text-faint flex-shrink-0" aria-hidden />
                              )}
                              <span className="text-faint flex-1">{parseServerDate(h.created_at)?.toLocaleDateString() ?? ''}</span>
                              {canDeleteNested && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setPendingDelete({ historyId: h.id, score: h.score }); }}
                                  className="p-1 -m-0.5 text-red-400/70 hover:text-red-400 transition-colors cursor-pointer"
                                  aria-label={`Delete this score (${h.score.toLocaleString()})`}
                                  title="Delete this score"
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[11px] text-faint py-1">No additional scores.</p>
                    )}
                  </div>
                )}
              </div>
              );
            })
          )}
          {deleteError && (
            <p role="alert" className="text-[11px] text-red-400 pt-2">{deleteError}</p>
          )}
        </div>
        )}

        {/* Footer links */}
        <div className="px-5 py-3 border-t border-border flex flex-col gap-2">
          <Link
            to={fullInfoHref}
            onClick={onClose}
            className="inline-flex items-center justify-between gap-1 px-3 py-2 rounded border border-border text-sm text-muted hover:text-primary hover:border-neon-cyan/40 no-underline transition-colors"
          >
            <span>View full info</span>
            <ExternalLink size={14} />
          </Link>
          {globalHref && (
            <Link
              to={globalHref}
              onClick={onClose}
              className="inline-flex items-center justify-between gap-1 px-3 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 no-underline transition-colors"
            >
              <span>Global Scoreboard</span>
              <ExternalLink size={14} />
            </Link>
          )}
        </div>
      </div>

      {/* v2.108.0 (F4) — same confirm component the GameDetail delete uses. */}
      {pendingDelete && (
        <ConfirmModal
          title="Delete score"
          message={`Delete this score (${pendingDelete.score.toLocaleString()})?`}
          confirmLabel="Delete"
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            runDelete(target.historyId);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* v2.109.0 (score-gesture-photos) — reuses the SAME lightbox the
          legacy GameCard's inline history expand already opens. */}
      {photoModal && (
        <ScorePhotoModal
          playerName={photoModal.playerName}
          score={photoModal.score}
          photoUrl={photoModal.photoUrl}
          sharePath={photoModal.historyId != null
            ? `/${slug}/games/${encodeURIComponent(lb.gameName)}?score=${photoModal.historyId}`
            : undefined}
          onClose={() => setPhotoModal(null)}
        />
      )}
    </div>
  );
}
