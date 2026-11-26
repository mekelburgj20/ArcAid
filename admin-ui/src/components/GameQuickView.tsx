import { useEffect, useMemo, useState } from 'react';
import { Crown, Trash2, Pencil, Plus, Minus, Camera } from 'lucide-react';
import { Dialog } from './parts/Dialog';
import { ButtonLink } from './parts/Button';
import type { RankedEntry } from './ScoreboardComponents';
import { PlayerAvatar, playerName } from './ScoreboardComponents';
import { getLegacyPlatformLabel } from '../lib/scoreProvenance';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { decodeViewerClaims } from '../lib/viewerClaims';
import { canDeleteRow, deleteConfirmText, deleteScoreHistory, rowHistoryId } from '../lib/scoreDelete';
import { canCorrectRow, correctScoreHistory } from '../lib/scoreCorrect';
import CorrectScoreModal from './CorrectScoreModal';
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
 *
 * G23c (v2.271.0): the Arcaid dialog (`parts/Dialog`), a bottom sheet on a
 * phone. The tournament is the label, the table the title (and the dialog's
 * name), the maker, year and platforms the line under it; the table art is a
 * banner at the top of the body. The delete confirm, the score correction and
 * the photo open INSIDE this dialog's children, so base-ui nests them: Escape,
 * a press outside and the × close the top one only.
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
  /**
   * v2.150.1 — needed by the score-correction gate: the SUBMITTER may only
   * correct their own row while the card is unlocked (`'ACTIVE'`). Absent
   * means "no round to close", which leaves correction admin-only here.
   * Callers pass a whole `GameLeaderboard`, which already carries it.
   */
  gameStatus?: string;
  /**
   * 2026-10-25 — the board's tournament is Sanctioned or has Limited attempts:
   * no self-correction (admins still can). Rides on the same `GameLeaderboard`.
   */
  selfCorrectionLocked?: boolean;
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

  // v2.108.0 (F4) — delete plumbing. All of it is inert without `roomId`:
  // `canDeleteRow` returns false for an undefined room, and `useScoreExpand`
  // no-ops without a room id, so the popup renders exactly as before.
  const { playerToken } = useViewerAuth();
  const claims = useMemo(() => decodeViewerClaims(playerToken), [playerToken]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(() => new Set());
  const [pendingDelete, setPendingDelete] =
    useState<{ historyId: number; score: number; source?: string | null } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingCorrect, setPendingCorrect] =
    useState<{ historyId: number; score: number; label: string } | null>(null);
  // v2.109.0 (score-gesture-photos) — clicking a row's body (main ranked row
  // or any expanded nested history row) opens that score's photo evidence,
  // but ONLY when the row actually has a photo (no dead click). Reuses the
  // SAME lightbox `ScoreboardComponents.tsx`'s legacy GameCard already uses
  // for its own inline history expand — see ScorePhotoModal.tsx.
  const [photoModal, setPhotoModal] = useState<{ playerName: string; score: number; photoUrl: string; historyId: number | null } | null>(null);
  const {
    expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple, removeHistoryEntry,
  } = useScoreExpand(roomId, lb.gameId ?? '', lb.gameName, (lb.rankings ?? []).length);

  /**
   * v2.150.1 — score correction from the quick view. This popup is where the
   * owner actually looks at a score (it opens straight off a scoreboard card),
   * and it was the one surface with a delete and no correction; v2.149.1 and
   * v2.150.0 both missed it.
   *
   * Refetching is the owning page's job (`onScoreDeleted`, which is really
   * "the score list changed"): the corrected value may or may not still be the
   * player's best, so the rank order cannot be patched here by hand.
   */
  const runCorrect = async (historyId: number, newScore: number) => {
    if (!roomId) return;
    setDeleteError(null);
    const result = await correctScoreHistory(roomId, historyId, newScore, playerToken);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    onScoreDeleted?.();
    onClose();
  };

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
    <Dialog
      open
      onOpenChange={next => { if (!next) onClose(); }}
      tone="cyan"
      size="md"
      sheet
      label={lb.tournamentName || 'Table'}
      title={lb.gameName}
      description={subtitleParts.join(' · ') || undefined}
      footer={(
        <>
          <ButtonLink to={fullInfoHref} variant="secondary" onClick={onClose}>View full info</ButtonLink>
          {globalHref && <ButtonLink to={globalHref} onClick={onClose}>Global Scoreboard</ButtonLink>}
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        {/* The table art, as a banner (no text on it). The canvas-dark wash is the old header's. */}
        {lb.imageUrl && (
          <div
            className="h-28 rounded"
            aria-hidden="true"
            style={{
              backgroundImage: `linear-gradient(180deg, color-mix(in srgb, var(--arc-canvas) 45%, transparent), color-mix(in srgb, var(--arc-canvas) 85%, transparent)), url(${lb.imageUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'top center',
            }}
          />
        )}

        {/* Body: one headline stat in presentational mode, else the top-10. */}
        {highlightStat !== undefined ? (
          highlightStat.value != null && (
            <div>
              <p className="text-xs uppercase tracking-wider text-faint">{highlightStat.label}</p>
              <div className="flex items-baseline gap-2 mt-1.5">
                <Crown size={14} className="text-neon-amber flex-shrink-0 self-center" aria-hidden="true" />
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
        <div>
          {topScores.length === 0 ? (
            <p className="text-sm text-faint text-center py-6">No scores yet</p>
          ) : (
            topScores.map((entry) => {
              // v2.108.0 (F4) — per-row delete + nested history. Both are
              // gated on `roomId`; without one, `canDelete` is false and
              // `canExpand` is false, and this renders as it always did.
              const historyId = rowHistoryId(entry);
              const canDelete = canDeleteRow(entry, claims, roomId);
              const canCorrect = canCorrectRow(entry, claims, roomId, lb.gameStatus, lb.selfCorrectionLocked);
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
                  <span className="flex-1 text-sm text-muted truncate">
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
                  {/* Correction first, and always visible for the same reason
                      the delete is: on a mistyped score it is the action you
                      actually want, and it must not be the harder one to
                      reach. */}
                  {canCorrect && historyId != null && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingCorrect({ historyId, score: entry.score, label: playerName(entry) });
                      }}
                      className="p-1 -m-0.5 text-muted/70 hover:text-neon-cyan transition-colors cursor-pointer flex-shrink-0"
                      aria-label={`Correct this score (${entry.score.toLocaleString()})`}
                      title="Correct this score"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {canDelete && historyId != null && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setPendingDelete({ historyId, score: entry.score, source: entry.source }); }}
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
                      <p className="text-xs text-faint py-1">Loading…</p>
                    ) : playerHistory.length > 0 ? (
                      <div className="space-y-1">
                        {playerHistory.map(h => {
                          const canDeleteNested = canDeleteRow(h, claims, roomId);
                          const canCorrectNested = canCorrectRow(h, claims, roomId, lb.gameStatus, lb.selfCorrectionLocked);
                          const hPhotoUrl = h.photo_url ?? null;
                          return (
                            <div
                              key={h.id}
                              className={`flex items-center gap-2 text-xs ${hPhotoUrl ? 'cursor-pointer' : ''}`}
                              onClick={hPhotoUrl ? () => setPhotoModal({ playerName: playerName(entry), score: h.score, photoUrl: hPhotoUrl, historyId: h.id }) : undefined}
                            >
                              <span className="text-muted tabular-nums">{h.score.toLocaleString()}</span>
                              {hPhotoUrl && (
                                <Camera size={11} className="text-faint flex-shrink-0" aria-hidden />
                              )}
                              <span className="text-faint flex-1">{parseServerDate(h.created_at)?.toLocaleDateString() ?? ''}</span>
                              {canCorrectNested && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setPendingCorrect({ historyId: h.id, score: h.score, label: playerName(entry) });
                                  }}
                                  className="p-1 -m-0.5 text-muted/70 hover:text-neon-cyan transition-colors cursor-pointer"
                                  aria-label={`Correct this score (${h.score.toLocaleString()})`}
                                  title="Correct this score"
                                >
                                  <Pencil size={12} />
                                </button>
                              )}
                              {canDeleteNested && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setPendingDelete({ historyId: h.id, score: h.score, source: h.source }); }}
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
                      <p className="text-xs text-faint py-1">No additional scores.</p>
                    )}
                  </div>
                )}
              </div>
              );
            })
          )}
          {deleteError && (
            <p role="alert" className="text-xs ink-danger pt-2">{deleteError}</p>
          )}
        </div>
        )}
      </div>

      {/* The pop-ups this one opens are rendered INSIDE its children, so base-ui
          nests them: Escape, a press outside and the × close the top one only. */}
      {pendingCorrect && (
        <CorrectScoreModal
          playerLabel={pendingCorrect.label}
          currentScore={pendingCorrect.score}
          onCancel={() => setPendingCorrect(null)}
          onConfirm={async (newScore) => {
            const target = pendingCorrect;
            setPendingCorrect(null);
            await runCorrect(target.historyId, newScore);
          }}
        />
      )}

      {/* v2.108.0 (F4) — same confirm component the GameDetail delete uses. */}
      {pendingDelete && (
        <ConfirmModal
          title="Delete score"
          message={deleteConfirmText(`Delete this score (${pendingDelete.score.toLocaleString()})?`, pendingDelete)}
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
    </Dialog>
  );
}
