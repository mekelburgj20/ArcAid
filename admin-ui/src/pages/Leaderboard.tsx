import { useEffect, useRef, useState } from 'react';
import { Lock, Trash2, Pencil, StickyNote, ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { getPortal } from '../lib/portal';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { getSocket } from '../lib/websocket';
import LoadingState from '../components/LoadingState';
import ConfirmModal from '../components/ConfirmModal';
import StylePicker from '../components/StylePicker';
import NeonButton from '../components/NeonButton';
import GameQuickView from '../components/GameQuickView';
import ScoreboardSurface from '../components/scoreboard/ScoreboardSurface';
import { tournamentCardTitleLink, tournamentCardTitleClick } from '../components/scoreboard/tournamentCardTitle';
import { ADMIN_CARD_CHROME_Z_INDEX } from '../components/scoreboard/cardStacking';
import { getTournamentBorderColor } from '../components/ScoreboardComponents';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';

interface Submission {
  id: string;
  iscored_username: string;
  score: number;
  timestamp: string;
  photo_url: string | null;
}

/** A deleted-score tombstone (deleted_score_suppressions, migration 096). While
 *  it exists, the ScoreSyncPoller refuses to re-import a same-or-lower iScored
 *  score for this game. Removing it lets the next poll cycle re-import. */
interface Suppression {
  gameId: string;
  /** lowercased iScored username (composite-PK component). */
  username: string;
  suppressedScore: number;
  deletedAt: string;
  deletedBy: string | null;
}

export default function Leaderboard() {
  const room = useRoom();
  const { toast } = useToast();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [styleTarget, setStyleTarget] = useState<GameLeaderboard | null>(null);
  const [libraryHasDefault, setLibraryHasDefault] = useState(false);
  /** v2.9x (ranking-card backgrounds) — Style picker target for a ranking
   *  GROUP card, kept separate from `styleTarget` (games): ranking groups
   *  have no default-in-library concept and no header/logo, just one
   *  background slot. */
  const [rankingStyleTarget, setRankingStyleTarget] = useState<RankingGroupData['group'] | null>(null);
  const [displayNameTarget, setDisplayNameTarget] = useState<GameLeaderboard | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GameLeaderboard | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notesTarget, setNotesTarget] = useState<GameLeaderboard | null>(null);
  const [notesInput, setNotesInput] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [manageScoresTarget, setManageScoresTarget] = useState<GameLeaderboard | null>(null);
  /** Card-title quick-view popup — the same page-chrome instance the public
   *  Scoreboard owns. Card titles are `<Link>`s on the public page, so they
   *  must be here too, and a title click must do the same thing. */
  const [quickViewLb, setQuickViewLb] = useState<GameLeaderboard | null>(null);
  /**
   * The ROOM's public theme, which is what the public scoreboard renders under.
   * `/:slug/admin/*` runs on the admin's own personal theme (ThemeProvider
   * treats admin routes separately), so without this the mirror would be right
   * in every respect except its colours. See `.sb-theme-scope` in index.css.
   * `getPortal` is the shared slug cache RoomAdminLayout already primed, so
   * this resolves off the cache rather than issuing a second request.
   */
  const [roomTheme, setRoomTheme] = useState<string | null>(null);

  // Unmount guard for the three loaders — they're fired from the mount effect
  // AND from socket handlers, so an in-flight response can land after unmount
  // (late-setState flake class; the roomTheme effect below already guards the
  // same way with a local flag). A ref because the loaders are shared across
  // both call contexts.
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  const loadData = () => {
    api.get<GameLeaderboard[]>(`/rooms/${room.roomId}/leaderboard`)
      .then(d => { if (!unmountedRef.current) setLeaderboards(d); })
      .catch(() => { if (!unmountedRef.current) setLeaderboards([]); });
  };

  const loadRankings = () => {
    api.get<RankingGroupData[]>(`/rooms/${room.roomId}/rankings`)
      .then(d => { if (!unmountedRef.current) setRankingGroups(d); })
      .catch(() => { if (!unmountedRef.current) setRankingGroups([]); })
      .finally(() => { if (!unmountedRef.current) setLoading(false); });
  };

  const loadConfig = () => {
    api.get<Record<string, string>>(`/rooms/${room.roomId}/scoreboard-config`)
      .then(c => { if (!unmountedRef.current) setConfig(c); })
      .catch(() => {});
  };

  useEffect(() => {
    loadData();
    loadRankings();
    loadConfig();

    const socket = getSocket();
    socket.emit('join:room', room.roomId);
    // Re-join on every (re)connect — room membership doesn't survive a reconnect.
    const onConnect = () => socket.emit('join:room', room.roomId);
    socket.on('connect', onConnect);
    const onUpdate = () => { loadData(); loadRankings(); };
    socket.on('leaderboard:updated', onUpdate);
    socket.on('score:new', onUpdate);
    // v2.86.0 — the public Scoreboard has always refetched on rotation; admin
    // did not, so after a maintenance rotation this page showed the previous
    // slot's game until something else happened to refresh it.
    const onRotated = () => { loadData(); };
    socket.on('game:rotated', onRotated);

    return () => {
      socket.emit('leave:room', room.roomId);
      socket.off('connect', onConnect);
      // Handler refs — score:new/leaderboard:updated are room-scoped (S4) and
      // the socket is a shared singleton; a bare off() would also remove the
      // public Scoreboard's / Kiosk's listeners for the same event.
      socket.off('leaderboard:updated', onUpdate);
      socket.off('score:new', onUpdate);
      socket.off('game:rotated', onRotated);
    };
  }, [room.roomId]);

  useEffect(() => {
    if (!room.roomSlug) return;
    let cancelled = false;
    getPortal(room.roomSlug)
      .then(p => { if (!cancelled) setRoomTheme(p.public_theme || p.ui_theme || 'dark'); })
      .catch(() => { if (!cancelled) setRoomTheme('dark'); });
    return () => { cancelled = true; };
  }, [room.roomSlug]);

  if (loading) return <LoadingState message="Loading leaderboards..." />;

  // v2.86.0 — every config-driven value used to be re-derived here by hand and
  // had drifted from `deriveCardProps`/`deriveScoreboardConfig` (it ignored
  // SCOREBOARD_LOGO_ENABLED, SCOREBOARD_BG_OPACITY, card opacity, the
  // bg 'fill-entire' mapping, and more). ScoreboardSurface owns all of it now,
  // so this page derives nothing about rendering — it just hands over config.

  const handleStyleClick = async (target: GameLeaderboard) => {
    try {
      const libStyle = await api.get<{ catalogueStyleId: string | null }>(`/rooms/${room.roomId}/game_library/${encodeURIComponent(target.gameName)}/style`);
      setLibraryHasDefault(!!libStyle.catalogueStyleId);
    } catch { setLibraryHasDefault(false); }
    setStyleTarget(target);
  };
  const handleEditDisplayName = (target: GameLeaderboard) => {
    setDisplayNameInput(target.displayName || '');
    setDisplayNameTarget(target);
  };
  const handleEditNotes = (target: GameLeaderboard) => {
    setNotesInput(target.notes || '');
    setNotesTarget(target);
  };

  // `sb-theme-scope` restates the default (dark) tokens so the surface is dark
  // even when the admin's own theme is not; the room's theme class, when it
  // has one, then overrides from there. See index.css.
  const roomThemeClass = `sb-theme-scope${roomTheme && roomTheme !== 'dark' ? ` theme-${roomTheme}` : ''}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold">Leaderboards</h1>
        <a
          href={`/${room.roomSlug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted hover:text-neon-cyan transition-colors no-underline"
        >
          <ExternalLink size={14} />
          <span>View Public Leaderboard</span>
        </a>
      </div>

      {/* The scoreboard, rendered by the SAME component the public page uses.
          Everything below the room theme wrapper is public code — no admin
          fork of card rendering, layout, sizing or config handling exists any
          more. The only admin addition is renderUnderCard.

          What is deliberately NOT passed:
            - viewerUsername / viewerEntry: an admin previews what a fresh
              anonymous visitor sees, so no row is highlighted as "yours".
            - onSubmitScore: submitting is a player affordance, not part of
              the design being previewed. The per-slot "+" button it gates is
              absolutely positioned, so its absence shifts nothing. */}
      <ScoreboardSurface
        embedded
        themeClass={roomThemeClass}
        config={config}
        roomName={room.roomName}
        roomId={room.roomId}
        slug={room.roomSlug || ''}
        leaderboards={leaderboards}
        rankingGroups={rankingGroups}
        titleLinkTo={tournamentCardTitleLink(room.roomSlug || '')}
        titleLinkOnClick={tournamentCardTitleClick(setQuickViewLb)}
        renderUnderCard={lb => (
          <AdminControlsStrip
            lb={lb}
            onStyleClick={handleStyleClick}
            onEditDisplayName={handleEditDisplayName}
            onDeleteGame={setDeleteTarget}
            onEditNotes={handleEditNotes}
            onManageScores={setManageScoresTarget}
          />
        )}
        renderUnderRankingCard={group => (
          <RankingAdminControlsStrip group={group} onStyleClick={setRankingStyleTarget} />
        )}
      />

      {/* Card-title quick-view — mirrors the public Scoreboard exactly, so a
          title click previews the game here the way it does for a player. */}
      {quickViewLb && (
        <GameQuickView
          lb={quickViewLb}
          slug={room.roomSlug || ''}
          fromTab="tournaments"
          onClose={() => setQuickViewLb(null)}
        />
      )}

      {/* Display Name Edit Modal */}
      {displayNameTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setDisplayNameTarget(null)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="font-display text-lg font-bold mb-1">Edit Display Name</h2>
            <p className="text-xs text-muted mb-4">Game: {displayNameTarget.gameName}</p>
            <div className="mb-4">
              <label className="text-xs text-muted block mb-1">Display Name (leave empty to use game name)</label>
              <input
                type="text"
                value={displayNameInput}
                onChange={e => setDisplayNameInput(e.target.value)}
                placeholder={displayNameTarget.gameName}
                className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setDisplayNameTarget(null)} disabled={displayNameSaving}>Cancel</NeonButton>
              <NeonButton disabled={displayNameSaving} onClick={async () => {
                setDisplayNameSaving(true);
                try {
                  await api.patch(`/rooms/${room.roomId}/admin/games/${displayNameTarget.gameId}/display-name`, {
                    displayName: displayNameInput.trim() || null,
                  });
                  toast(displayNameInput.trim() ? 'Display name updated' : 'Display name cleared', 'success');
                  loadData();
                  setDisplayNameTarget(null);
                } catch (err: any) {
                  toast(err.message, 'error');
                } finally {
                  setDisplayNameSaving(false);
                }
              }}>
                {displayNameSaving ? 'Saving...' : 'Save'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Delete Game Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="font-display text-lg font-bold mb-1 text-red-400">Remove Game</h2>
            <p className="text-sm text-muted mb-2">
              Are you sure you want to remove <strong className="text-primary">{deleteTarget.displayName || deleteTarget.gameName}</strong> from the leaderboard?
            </p>
            <p className="text-xs text-muted mb-4">
              This will delete the game entry and remove it from iScored. Player scores and history will be retained.
            </p>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</NeonButton>
              <NeonButton variant="danger" disabled={deleting} onClick={async () => {
                setDeleting(true);
                try {
                  await api.delete(`/rooms/${room.roomId}/admin/games/${deleteTarget.gameId}`);
                  toast(`Removed: ${deleteTarget.displayName || deleteTarget.gameName}`, 'success');
                  loadData();
                  loadRankings();
                  setDeleteTarget(null);
                } catch (err: any) {
                  toast(err.message || 'Failed to remove game', 'error');
                } finally {
                  setDeleting(false);
                }
              }}>
                {deleting ? 'Removing...' : 'Remove Game'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Notes Edit Modal */}
      {notesTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setNotesTarget(null)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="font-display text-lg font-bold mb-1">Edit Game Notes</h2>
            <p className="text-xs text-muted mb-4">Game: {notesTarget.displayName || notesTarget.gameName}</p>
            <div className="mb-4">
              <label className="text-xs text-muted block mb-1">Notes (shown to players via info icon)</label>
              <textarea
                value={notesInput}
                onChange={e => setNotesInput(e.target.value)}
                placeholder="e.g., VPW v1.2, Use cabinet mode..."
                className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50 min-h-[80px] resize-y"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setNotesTarget(null)} disabled={notesSaving}>Cancel</NeonButton>
              <NeonButton disabled={notesSaving} onClick={async () => {
                setNotesSaving(true);
                try {
                  await api.patch(`/rooms/${room.roomId}/admin/games/${notesTarget.gameId}/notes`, {
                    notes: notesInput.trim() || null,
                  });
                  toast(notesInput.trim() ? 'Notes updated' : 'Notes cleared', 'success');
                  loadData();
                  setNotesTarget(null);
                } catch (err: any) {
                  toast(err.message, 'error');
                } finally {
                  setNotesSaving(false);
                }
              }}>
                {notesSaving ? 'Saving...' : 'Save'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {/* Manage Scores modal — admin per-player delete on the new card style.
          Mirrors the inline trash UI legacy AdminGameCard had on hover. */}
      {manageScoresTarget && (
        <ManageScoresModal
          lb={manageScoresTarget}
          roomId={room.roomId}
          onClose={() => setManageScoresTarget(null)}
          onDeleted={() => { loadData(); loadRankings(); }}
        />
      )}

      {/* Style Picker for leaderboard games */}
      {styleTarget && (
        <StylePicker
          currentStyleId={styleTarget.catalogueStyleId}
          headerDisabled={styleTarget.styleHeaderDisabled}
          showDefaultOption
          showImageTypeSelector
          uploadPath={`/rooms/${room.roomId}/admin/styles/upload`}
          gameName={styleTarget.gameName}
          libraryHasDefault={libraryHasDefault}
          showFraming
          bgZoom={styleTarget.bgZoom}
          bgPosX={styleTarget.bgPosX}
          bgPosY={styleTarget.bgPosY}
          fallbackBgUrl={styleTarget.imageUrl}
          onClose={() => setStyleTarget(null)}
          onSelect={async (styleId, headerDisabled, setAsDefault, imageType, framing) => {
            try {
              if (styleId) {
                // Use new image endpoint for logo/background, legacy for 'both'
                if (imageType && imageType !== 'both') {
                  await api.put(`/rooms/${room.roomId}/admin/games/${styleTarget.gameId}/image`, {
                    styleId, imageType, ...framing,
                  });
                } else {
                  await api.put(`/rooms/${room.roomId}/admin/games/${styleTarget.gameId}/style`, {
                    catalogueStyleId: styleId, headerDisabled, ...framing,
                  });
                }
                toast('Style applied', 'success');
              } else {
                await api.delete(`/rooms/${room.roomId}/admin/games/${styleTarget.gameId}/style`);
                toast('Style removed', 'success');
              }
              if (setAsDefault) {
                try {
                  if (styleId) {
                    if (imageType && imageType !== 'both') {
                      await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.gameName)}/image`, {
                        styleId, imageType, ...framing,
                      });
                    } else {
                      await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.gameName)}/style`, {
                        catalogueStyleId: styleId, headerDisabled, ...framing,
                      });
                    }
                    toast('Default style updated in library', 'success');
                  } else {
                    await api.delete(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.gameName)}/style`);
                    toast('Default style cleared in library', 'success');
                  }
                } catch {
                  toast('Failed to update library default', 'error');
                }
              }
              loadData();
            } catch (err: any) {
              toast(err.message, 'error');
            }
            setStyleTarget(null);
          }}
        />
      )}

      {/* Style Picker for ranking-group cards (v2.9x). No showDefaultOption
          (ranking groups have no library-default concept) and no
          showImageTypeSelector (no header/logo — just the one background
          slot), so onSelect's imageType/setAsDefault args are always
          undefined here. */}
      {rankingStyleTarget && (
        <StylePicker
          currentStyleId={rankingStyleTarget.bg_style_id ?? null}
          onClose={() => setRankingStyleTarget(null)}
          onSelect={async (styleId) => {
            const target = rankingStyleTarget;
            try {
              if (styleId) {
                await api.put(`/rooms/${room.roomId}/ranking-groups/${target.id}/style`, { styleId });
                toast('Background applied', 'success');
              } else {
                await api.delete(`/rooms/${room.roomId}/ranking-groups/${target.id}/style`);
                toast('Background removed', 'success');
              }
              loadRankings();
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Failed to update background', 'error');
            }
            setRankingStyleTarget(null);
          }}
        />
      )}
    </div>
  );
}

/** The per-card admin controls, as a contained band UNDER the card rather than
 *  a layer on top of it.
 *
 *  Until v2.85.0 this was an absolutely-positioned cluster pinned to the card's
 *  TOP edge — i.e. directly over the game title. It was hover-revealed on
 *  desktop, but `[@media(hover:none)]` forced it permanently visible on touch,
 *  so on a phone the title of every game was simply unreadable. Moving the
 *  controls below the card removes the conflict outright, which is also why
 *  there is no hover/focus gating left: the strip obscures nothing, so it is
 *  always visible on every device and every button is in the tab order.
 *
 *  Styling follows GlobalGameCard's footer idiom (a filled band with its own
 *  border in the card's tournament colour, so it reads as part of THIS card and
 *  not as a floating row above the next one).
 *
 *  It attaches FLUSH — a fully-rounded bar sitting 4px under the card — rather
 *  than tucking under the card's bottom corners with a negative margin. v2.85.0
 *  had both variants, because a tuck has to know the card's corner radius and
 *  only the legacy in-file admin card had a knowable one (`rounded-lg`, 8px).
 *  v2.86.0 deleted that card in favour of the public `GameCard`, so every card
 *  this strip attaches to now comes from the public rendering path, where radii
 *  vary by style and theme (8px on banner/minimal, 16-20px on the showcase
 *  themes). Flush is correct at ANY radius, and the strip still reads as part
 *  of the card above it via the matching tournament-coloured border.
 *
 *  v2.85.1 — the strip also has to out-rank the card's bottom-anchored QR
 *  overlay, which hangs down across exactly this band and was covering (and
 *  swallowing the clicks for) the Name/Style buttons. Hence the explicit
 *  `ADMIN_CARD_CHROME_Z_INDEX`; see `cardStacking.ts` for the stacking-context
 *  analysis. The QR stays visible behind the strip, which is what the owner
 *  asked for — an admin needs to SEE the QR, not scan it. */
function AdminControlsStrip({ lb, onStyleClick, onEditDisplayName, onDeleteGame, onEditNotes, onManageScores }: {
  lb: GameLeaderboard;
  onStyleClick: (lb: GameLeaderboard) => void;
  onEditDisplayName: (lb: GameLeaderboard) => void;
  onDeleteGame: (lb: GameLeaderboard) => void;
  onEditNotes: (lb: GameLeaderboard) => void;
  onManageScores: (lb: GameLeaderboard) => void;
}) {
  const borderColor = getTournamentBorderColor(lb.tournamentType);
  // The z-index is inline rather than a Tailwind class so it can be read back
  // and compared numerically against the card's QR overlay at runtime — see
  // `cardStacking.ts` and the stacking test in LeaderboardAdminControls.
  return (
    <div
      data-testid="admin-card-controls"
      style={{ zIndex: ADMIN_CARD_CHROME_Z_INDEX }}
      className={`relative flex-shrink-0 min-w-0 flex flex-wrap items-center justify-center gap-1 border-2 ${borderColor} bg-raised px-2 mt-1 py-1.5 rounded-lg`}
    >
      <NeonButton variant="ghost" onClick={() => onEditDisplayName(lb)} className="text-[10px] px-1.5 py-0.5" title="Edit display name">
        <Pencil size={11} /> Name
      </NeonButton>
      <NeonButton variant={lb.notes ? 'secondary' : 'ghost'} onClick={() => onEditNotes(lb)} className="text-[10px] px-1.5 py-0.5" title="Edit notes">
        <StickyNote size={11} /> Notes
      </NeonButton>
      <NeonButton variant={lb.catalogueStyleId ? 'secondary' : 'ghost'} onClick={() => onStyleClick(lb)} className="text-[10px] px-1.5 py-0.5" title="Change card style">
        Style
      </NeonButton>
      <NeonButton variant="ghost" onClick={() => onManageScores(lb)} className="text-[10px] px-1.5 py-0.5" title="Manage submitted scores">
        Scores
      </NeonButton>
      <NeonButton variant="ghost" onClick={() => onDeleteGame(lb)} className="text-[10px] px-1.5 py-0.5 text-red-400/60 hover:text-red-400" title="Remove game" aria-label="Remove game">
        <Trash2 size={11} />
      </NeonButton>
    </div>
  );
}

/** v2.9x (ranking-card backgrounds) — the ranking-GROUP-card counterpart of
 *  `AdminControlsStrip` above. A ranking card carries none of the
 *  game-specific affordances (no display name, notes, per-score management,
 *  or delete-from-here — groups are managed on the Rankings admin page), so
 *  this is deliberately a single-button strip: just the Style control that
 *  opens the same `StylePicker` used for game backgrounds. Same flush,
 *  always-visible, z-stacked band as the game strip — see the doc comment
 *  on `AdminControlsStrip` for the layout/QR rationale, unchanged here. */
function RankingAdminControlsStrip({ group, onStyleClick }: {
  group: RankingGroupData['group'];
  onStyleClick: (group: RankingGroupData['group']) => void;
}) {
  return (
    <div
      data-testid="ranking-admin-card-controls"
      style={{ zIndex: ADMIN_CARD_CHROME_Z_INDEX }}
      className="relative flex-shrink-0 min-w-0 flex flex-wrap items-center justify-center gap-1 border-2 border-border bg-raised px-2 mt-1 py-1.5 rounded-lg"
    >
      <NeonButton variant={group.bg_style_id ? 'secondary' : 'ghost'} onClick={() => onStyleClick(group)} className="text-[10px] px-1.5 py-0.5" title="Change card background">
        Style
      </NeonButton>
    </div>
  );
}

/** Modal listing all submissions on a game with admin-delete buttons. Used
 *  by the new card path (Banner/Showcase/Minimal) which doesn't have inline
 *  per-row admin chrome. Calls the existing admin "wipe player from game"
 *  endpoint, which now (post-fix) also cascades to score_history so the
 *  deletion sticks across the leaderboard recompute. */
function ManageScoresModal({ lb, roomId, onClose, onDeleted }: {
  lb: GameLeaderboard;
  roomId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [suppressions, setSuppressions] = useState<Suppression[] | null>(null);
  const [removingSuppression, setRemovingSuppression] = useState<string | null>(null);
  // s20: confirm-before-delete for both destructive actions in this modal,
  // replacing native confirm().
  const [pendingConfirm, setPendingConfirm] = useState<
    { kind: 'delete'; sub: Submission } | { kind: 'suppression'; s: Suppression } | null
  >(null);

  const load = () => {
    setSubmissions(null);
    api.get<Submission[]>(`/rooms/${roomId}/leaderboard/${lb.gameId}/submissions`)
      .then(rows => {
        rows.sort((a, b) => b.score - a.score);
        setSubmissions(rows);
      })
      .catch(() => setSubmissions([]));
    setSuppressions(null);
    api.get<{ suppressions: Suppression[] }>(`/rooms/${roomId}/admin/games/${lb.gameId}/suppressions`)
      .then(r => setSuppressions(r.suppressions))
      .catch(() => setSuppressions([]));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lb.gameId]);

  const handleDelete = async (sub: Submission) => {
    setDeletingId(sub.id);
    try {
      await api.delete(`/rooms/${roomId}/admin/games/${lb.gameId}/submissions/${encodeURIComponent(sub.id)}`);
      toast(`Deleted: ${sub.iscored_username} (${sub.score.toLocaleString()})`, 'success');
      setSubmissions(prev => prev ? prev.filter(s => s.id !== sub.id) : prev);
      onDeleted();
    } catch (err: any) {
      toast(err.message || 'Failed to delete score', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const handleRemoveSuppression = async (s: Suppression) => {
    setRemovingSuppression(s.username);
    try {
      await api.delete(`/rooms/${roomId}/admin/games/${lb.gameId}/suppressions/${encodeURIComponent(s.username)}`);
      toast(`Suppression removed: ${s.username} (${s.suppressedScore.toLocaleString()})`, 'success');
      load();
    } catch (err: any) {
      toast(err.message || 'Failed to remove suppression', 'error');
    } finally {
      setRemovingSuppression(null);
    }
  };

  return (
    // m2 fix: the two ConfirmModals below are rendered as SIBLINGS of this
    // backdrop div (not descendants), so a click on a ConfirmModal's own
    // backdrop no longer bubbles up into this div's onClick={onClose} and
    // closes the whole Manage Scores panel underneath it.
    <>
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border/50">
          <h2 className="font-display text-lg font-bold mb-0.5">Manage Scores</h2>
          <p className="text-xs text-muted">{lb.displayName || lb.gameName} · {lb.tournamentName}</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {submissions === null ? (
            <p className="text-faint text-sm text-center py-8">Loading...</p>
          ) : submissions.length === 0 ? (
            <p className="text-muted text-sm text-center py-8">No submissions yet.</p>
          ) : (
            <div className="divide-y divide-border/30">
              {submissions.map((sub, i) => (
                <div key={sub.id} className="flex items-center justify-between px-5 py-2.5 group hover:bg-raised/30 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`font-display font-bold text-xs w-6 text-center flex-shrink-0 ${
                      i === 0 ? 'text-neon-amber' : i === 1 ? 'text-neon-cyan' : i === 2 ? 'text-neon-green' : 'text-faint'
                    }`}>{i + 1}</span>
                    <span className="text-sm truncate min-w-0">{sub.iscored_username}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-display font-bold text-sm flex-shrink-0 whitespace-nowrap tabular-nums">{sub.score.toLocaleString()}</span>
                    <span className="text-faint text-[10px] w-20 text-right">{new Date(sub.timestamp).toLocaleDateString()}</span>
                    <button
                      type="button"
                      onClick={() => setPendingConfirm({ kind: 'delete', sub })}
                      disabled={deletingId === sub.id}
                      className="p-4 -m-2 text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-30"
                      title="Delete score (wipes player from this game)"
                      aria-label="Delete score (wipes player from this game)"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="px-5 pt-4 pb-1 border-t border-border/50 mt-2">
            <h3 className="font-display text-sm font-bold mb-0.5">Suppressed scores</h3>
            <p className="text-[11px] text-faint">Deleted scores that iScored will not re-import until removed.</p>
          </div>
          {suppressions === null ? (
            <p className="text-faint text-sm text-center py-6">Loading...</p>
          ) : suppressions.length === 0 ? (
            <p className="text-muted text-sm text-center py-6">No suppressed scores</p>
          ) : (
            <div className="divide-y divide-border/30">
              {suppressions.map(s => (
                <div key={`${s.gameId}-${s.username}`} className="flex items-center justify-between px-5 py-2.5 group hover:bg-raised/30 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <Lock size={12} className="text-faint flex-shrink-0" />
                    <span className="text-sm truncate min-w-0">{s.username}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-display font-bold text-sm flex-shrink-0 whitespace-nowrap tabular-nums">{s.suppressedScore.toLocaleString()}</span>
                    <span className="text-faint text-[10px] w-28 text-right truncate" title={s.deletedBy ? `Deleted by ${s.deletedBy}` : 'Deleted'}>
                      {new Date(s.deletedAt).toLocaleDateString()}{s.deletedBy ? ` · ${s.deletedBy}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingConfirm({ kind: 'suppression', s })}
                      disabled={removingSuppression === s.username}
                      className="p-4 -m-2 text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-30"
                      title="Remove suppression (allows iScored re-import)"
                      aria-label="Remove suppression (allows iScored re-import)"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border/50 flex justify-end">
          <NeonButton variant="ghost" onClick={onClose}>Close</NeonButton>
        </div>
      </div>
    </div>
    {pendingConfirm?.kind === 'delete' && (
      <ConfirmModal
        title="Delete score"
        message={`Delete ${pendingConfirm.sub.iscored_username}'s score (${pendingConfirm.sub.score.toLocaleString()})? This wipes the row from the leaderboard and removes their score history for this game. Scores at or below this value that still exist on iScored will not re-import.`}
        confirmLabel="Delete"
        onConfirm={() => {
          const sub = pendingConfirm.sub;
          setPendingConfirm(null);
          handleDelete(sub);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    )}
    {pendingConfirm?.kind === 'suppression' && (
      <ConfirmModal
        title="Remove suppression"
        message={`Remove the suppression for ${pendingConfirm.s.username} (${pendingConfirm.s.suppressedScore.toLocaleString()})? Their iScored score for this game will re-import on the next sync cycle.`}
        confirmLabel="Remove"
        onConfirm={() => {
          const s = pendingConfirm.s;
          setPendingConfirm(null);
          handleRemoveSuppression(s);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    )}
    </>
  );
}
