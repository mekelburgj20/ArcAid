import { useEffect, useState } from 'react';
import { Lock, Trash2, Pencil, StickyNote, ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { getSocket } from '../lib/websocket';
import TournamentBadge from '../components/TournamentBadge';
import LoadingState from '../components/LoadingState';
import ConfirmModal from '../components/ConfirmModal';
import StylePicker from '../components/StylePicker';
import NeonButton from '../components/NeonButton';
import CardRouter from '../components/scoreboard/CardRouter';
import { deriveScoreboardConfig, getCardWidth } from '../lib/scoreboardConfig';
import {
  RankingGroupCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
  getTournamentBorderColor,
} from '../components/ScoreboardComponents';
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
  const [displayNameTarget, setDisplayNameTarget] = useState<GameLeaderboard | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GameLeaderboard | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notesTarget, setNotesTarget] = useState<GameLeaderboard | null>(null);
  const [notesInput, setNotesInput] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [manageScoresTarget, setManageScoresTarget] = useState<GameLeaderboard | null>(null);

  const loadData = () => {
    api.get<GameLeaderboard[]>(`/rooms/${room.roomId}/leaderboard`)
      .then(setLeaderboards)
      .catch(() => setLeaderboards([]));
  };

  const loadRankings = () => {
    api.get<RankingGroupData[]>(`/rooms/${room.roomId}/rankings`)
      .then(setRankingGroups)
      .catch(() => setRankingGroups([]))
      .finally(() => setLoading(false));
  };

  const loadConfig = () => {
    api.get<Record<string, string>>(`/rooms/${room.roomId}/scoreboard-config`)
      .then(setConfig)
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

    return () => {
      socket.emit('leave:room', room.roomId);
      socket.off('connect', onConnect);
      // Handler refs — score:new/leaderboard:updated are room-scoped (S4) and
      // the socket is a shared singleton; a bare off() would also remove the
      // public Scoreboard's / Kiosk's listeners for the same event.
      socket.off('leaderboard:updated', onUpdate);
      socket.off('score:new', onUpdate);
    };
  }, [room.roomId]);

  if (loading) return <LoadingState message="Loading leaderboards..." />;

  // Config-driven values (matching public scoreboard)
  const maxScores = parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5;
  const hideEmpty = config.SCOREBOARD_HIDE_EMPTY === 'true';
  const titleHidden = config.SCOREBOARD_TITLE_HIDDEN === 'true';
  const titleText = config.SCOREBOARD_TITLE || room.roomName || 'High Scores';
  const titleStyle = config.SCOREBOARD_TITLE_STYLE || 'default';
  const titleSize = config.SCOREBOARD_TITLE_SIZE || 'sm';
  const zoom = parseInt(config.SCOREBOARD_ZOOM || '100', 10) || 100;
  const bgUrl = config.SCOREBOARD_BG_URL || '';
  const bgMode = config.SCOREBOARD_BG_MODE || 'cover';
  const logoUrl = config.LOGO_URL || '';
  const logoPosition = config.LOGO_POSITION || 'left';
  const logoMaxHeight = parseInt(config.LOGO_MAX_HEIGHT || '64', 10) || 64;
  const rankingsPosition = config.SCOREBOARD_RANKINGS_POSITION || 'left';

  // New style/theme config (matching public scoreboard)
  const newConfig = deriveScoreboardConfig(config, room.roomName);
  const useNewCards = !!config.SCOREBOARD_STYLE;
  const layout = useNewCards ? newConfig.layout : (config.SCOREBOARD_LAYOUT || 'scroll');
  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : 288;
  const gameColumns = config.SCOREBOARD_GAME_COLUMNS || 'auto';

  // When sticky is off (default), rankings render inline with game cards (matching public scoreboard)
  const inlineRankings = useNewCards && !newConfig.rankingsSticky && rankingGroups.length > 0;

  const visibleLeaderboards = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;

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

      {/* Scoreboard Preview — matches public layout */}
      <div
        className="rounded-lg border border-border/50 px-4 sm:px-6 py-6"
        style={{
          ...(zoom !== 100 ? { zoom: `${zoom}%` } : {}),
          ...(bgUrl ? {
            backgroundImage: `url(${bgUrl})`,
            backgroundSize: bgMode === 'repeat' ? 'auto' : bgMode,
            backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center',
          } : {}),
        }}
      >
        {/* Header */}
        {!titleHidden && (
          <div className="text-center mb-8">
            <div className={`inline-flex items-center gap-4 ${
              logoPosition === 'above' || logoPosition === 'below' ? 'flex-col' : 'flex-row'
            }`}>
              {logoUrl && (logoPosition === 'left' || logoPosition === 'above') && (
                <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain" />
              )}
              <p className={`font-display text-muted ${getTitleSizeClass(titleSize)} uppercase tracking-widest ${getTitleStyleClass(titleStyle)}`}>
                {titleText}
              </p>
              {logoUrl && (logoPosition === 'right' || logoPosition === 'below') && (
                <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain" />
              )}
            </div>
          </div>
        )}
        {titleHidden && logoUrl && (
          <div className="text-center mb-8">
            <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain mx-auto" />
          </div>
        )}

        {/* Rankings: top position (only when sticky/separate) */}
        {!inlineRankings && rankingsPosition === 'top' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
        )}

        {/* Main content area */}
        <div className={`flex ${!inlineRankings && (rankingsPosition === 'left' || rankingsPosition === 'right') ? 'flex-col lg:flex-row' : 'flex-col'} gap-6 items-start`}>

          {/* Rankings: left position (only when sticky/separate) */}
          {!inlineRankings && rankingsPosition === 'left' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
          )}

          {/* Game leaderboards */}
          {visibleLeaderboards.length === 0 ? (
            <div className="flex-1 text-center py-16">
              <p className="text-muted font-display">No active games with scores yet.</p>
            </div>
          ) : layout === 'grid' ? (
            <div className="flex-1 min-w-0 w-full">
              <div
                className={`grid ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${!useNewCards && gameColumns === '2' ? 'grid-cols-1 md:grid-cols-2' : ''}`}
                style={{
                  ...(useNewCards ? { gap: newConfig.cardSpacing } : {}),
                  ...(useNewCards || gameColumns !== '2' ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.7)}px, 100%), 1fr))` } : {}),
                }}
              >
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="grid">
                    <AdminCardWrapper lb={lb} onStyleClick={handleStyleClick} onEditDisplayName={handleEditDisplayName} onDeleteGame={setDeleteTarget} onEditNotes={handleEditNotes} onManageScores={setManageScoresTarget}>
                      {useNewCards ? (
                        <CardRouter
                          lb={lb} slug={room.roomSlug || ''}
                          style={newConfig.style} theme={newConfig.theme}
                          maxScores={newConfig.maxScores} minScores={newConfig.minScores}
                          showTimer={newConfig.showTimer}
                          cardBgFill={newConfig.cardBgFill}
                          titleFontSize={newConfig.titleFontSize || undefined}
                        />
                      ) : (
                        <AdminGameCard lb={lb} roomId={room.roomId} maxScores={maxScores} onScoreDeleted={() => { loadData(); loadRankings(); }} onStyleClick={handleStyleClick} onEditDisplayName={handleEditDisplayName} onDeleteGame={setDeleteTarget} onEditNotes={handleEditNotes} />
                      )}
                    </AdminCardWrapper>
                  </div>
                ))}
                {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                  <div key={`rank-${group.id}`} style={{ overflow: 'visible', minWidth: 0 }}>
                    <RankingGroupCard group={group} rankings={rankings} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 w-full overflow-x-auto">
              <div className={`flex pb-2 ${useNewCards ? '' : 'gap-3 sm:gap-5'}`} style={useNewCards ? { gap: newConfig.cardSpacing } : undefined}>
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, 75vw)` }}>
                    <AdminCardWrapper lb={lb} onStyleClick={handleStyleClick} onEditDisplayName={handleEditDisplayName} onDeleteGame={setDeleteTarget} onEditNotes={handleEditNotes} onManageScores={setManageScoresTarget}>
                      {useNewCards ? (
                        <CardRouter
                          lb={lb} slug={room.roomSlug || ''}
                          style={newConfig.style} theme={newConfig.theme}
                          maxScores={newConfig.maxScores} minScores={newConfig.minScores}
                          showTimer={newConfig.showTimer}
                          cardBgFill={newConfig.cardBgFill}
                          titleFontSize={newConfig.titleFontSize || undefined}
                        />
                      ) : (
                        <AdminGameCard lb={lb} roomId={room.roomId} maxScores={maxScores} onScoreDeleted={() => { loadData(); loadRankings(); }} onStyleClick={handleStyleClick} onEditDisplayName={handleEditDisplayName} onDeleteGame={setDeleteTarget} onEditNotes={handleEditNotes} />
                      )}
                    </AdminCardWrapper>
                  </div>
                ))}
                {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                  <div key={`rank-${group.id}`} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, 75vw)` }}>
                    <RankingGroupCard group={group} rankings={rankings} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rankings: right position (only when sticky/separate) */}
          {!inlineRankings && rankingsPosition === 'right' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
          )}
        </div>

        {/* Rankings: bottom position (only when sticky/separate) */}
        {!inlineRankings && rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
        )}
      </div>

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
          onClose={() => setStyleTarget(null)}
          onSelect={async (styleId, headerDisabled, setAsDefault, imageType) => {
            try {
              if (styleId) {
                // Use new image endpoint for logo/background, legacy for 'both'
                if (imageType && imageType !== 'both') {
                  await api.put(`/rooms/${room.roomId}/admin/games/${styleTarget.gameId}/image`, {
                    styleId, imageType,
                  });
                } else {
                  await api.put(`/rooms/${room.roomId}/admin/games/${styleTarget.gameId}/style`, {
                    catalogueStyleId: styleId, headerDisabled,
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
                        styleId, imageType,
                      });
                    } else {
                      await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.gameName)}/style`, {
                        catalogueStyleId: styleId, headerDisabled,
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
    </div>
  );
}

function AdminCardWrapper({ lb, children, onStyleClick, onEditDisplayName, onDeleteGame, onEditNotes, onManageScores }: {
  lb: GameLeaderboard;
  children: React.ReactNode;
  onStyleClick: (lb: GameLeaderboard) => void;
  onEditDisplayName: (lb: GameLeaderboard) => void;
  onDeleteGame: (lb: GameLeaderboard) => void;
  onEditNotes: (lb: GameLeaderboard) => void;
  onManageScores: (lb: GameLeaderboard) => void;
}) {
  return (
    <div className="relative group">
      {children}
      {/* Admin overlay — visible on hover; also always-visible on touch/focus devices
          (s20) so the toolbar isn't hover-only-inaccessible. */}
      <div className="absolute top-0 left-0 right-0 z-20 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
        <div className="flex flex-wrap items-center justify-center gap-1 p-1.5 bg-black/70 backdrop-blur-sm rounded-t-lg">
          <NeonButton variant="ghost" onClick={() => onEditDisplayName(lb)} className="text-[10px] px-1.5 py-0.5">
            <Pencil size={11} /> Name
          </NeonButton>
          <NeonButton variant={lb.notes ? 'secondary' : 'ghost'} onClick={() => onEditNotes(lb)} className="text-[10px] px-1.5 py-0.5">
            <StickyNote size={11} /> Notes
          </NeonButton>
          <NeonButton variant={lb.catalogueStyleId ? 'secondary' : 'ghost'} onClick={() => onStyleClick(lb)} className="text-[10px] px-1.5 py-0.5">
            Style
          </NeonButton>
          <NeonButton variant="ghost" onClick={() => onManageScores(lb)} className="text-[10px] px-1.5 py-0.5" title="Manage submitted scores">
            Scores
          </NeonButton>
          <NeonButton variant="ghost" onClick={() => onDeleteGame(lb)} className="text-[10px] px-1.5 py-0.5 text-red-400/60 hover:text-red-400">
            <Trash2 size={11} />
          </NeonButton>
        </div>
      </div>
    </div>
  );
}

function AdminGameCard({ lb, roomId, maxScores, onStyleClick, onScoreDeleted, onEditDisplayName, onDeleteGame, onEditNotes }: {
  lb: GameLeaderboard;
  roomId: string;
  maxScores: number;
  onStyleClick: (lb: GameLeaderboard) => void;
  onScoreDeleted: () => void;
  onEditDisplayName: (lb: GameLeaderboard) => void;
  onDeleteGame: (lb: GameLeaderboard) => void;
  onEditNotes: (lb: GameLeaderboard) => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // s20: confirm-before-delete, replacing native confirm().
  const [pendingDelete, setPendingDelete] = useState<Submission | null>(null);

  const requestDeleteSubmission = (sub: Submission) => setPendingDelete(sub);

  const deleteSubmission = async (sub: Submission) => {
    setDeleting(sub.id);
    try {
      await api.delete(`/rooms/${roomId}/admin/games/${lb.gameId}/submissions/${encodeURIComponent(sub.id)}`);
      toast(`Score deleted: ${sub.iscored_username} (${sub.score.toLocaleString()})`, 'success');
      setSubmissions(prev => prev.filter(s => s.id !== sub.id));
      onScoreDeleted();
    } catch (err: any) {
      toast(err.message || 'Failed to delete score', 'error');
    } finally {
      setDeleting(null);
    }
  };
  const borderColor = getTournamentBorderColor(lb.tournamentType);

  const toggleExpand = async (username: string) => {
    if (expanded === username) {
      setExpanded(null);
      return;
    }
    if (submissions.length === 0) {
      setLoadingSubs(true);
      try {
        const subs = await api.get<Submission[]>(`/rooms/${roomId}/leaderboard/${lb.gameId}/submissions`);
        setSubmissions(subs);
      } catch {
        setSubmissions([]);
      } finally {
        setLoadingSubs(false);
      }
    }
    setExpanded(username);
  };

  const getPlayerSubmissions = (username: string): Submission[] =>
    submissions
      .filter(s => s.iscored_username.toLowerCase() === username.toLowerCase())
      .sort((a, b) => b.score - a.score);

  const effectiveBgId = (lb.bgStyleId && lb.bgHasBg !== 0) ? lb.bgStyleId
    : (lb.catalogueStyleId && lb.catHasBg !== 0) ? lb.catalogueStyleId : null;
  const effectiveLogoId = (lb.logoStyleId && lb.logoHasHeader !== 0) ? lb.logoStyleId
    : (lb.catalogueStyleId && lb.catHasHeader !== 0) ? lb.catalogueStyleId : null;
  const styleBgUrl = effectiveBgId ? `/api/styles/images/backgrounds/${effectiveBgId}.png` : null;
  const styleHeaderUrl = effectiveLogoId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${effectiveLogoId}.png` : null;
  const bgImage = styleBgUrl || null;

  return (
    <div className={`bg-surface border-2 ${borderColor} rounded-lg overflow-hidden flex flex-col`}>
      {/* Title area */}
      <div className="px-3 py-2.5 text-center border-b border-border/30">
        <h3 className="font-display font-bold text-sm leading-tight truncate flex items-center justify-center gap-1.5">
          {lb.displayName || lb.gameName}
          {lb.displayName && <span className="text-faint font-normal text-[10px]">({lb.gameName})</span>}
          {lb.gameStatus === 'COMPLETED' && <span title="Completed"><Lock size={14} className="text-faint flex-shrink-0" /></span>}
        </h3>
        <div className="flex items-center justify-center gap-2 mt-0.5">
          <TournamentBadge type={lb.tournamentType || lb.tournamentName} />
          <p className="text-[11px] text-muted uppercase tracking-wider">{lb.tournamentName}</p>
        </div>
        <div className="flex items-center justify-center gap-1 mt-1.5">
          <NeonButton
            variant="ghost"
            onClick={() => onEditDisplayName(lb)}
            className="text-[10px] px-1.5 py-0.5"
            title="Edit display name"
          >
            <Pencil size={11} /> Name
          </NeonButton>
          <NeonButton
            variant={lb.notes ? 'secondary' : 'ghost'}
            onClick={() => onEditNotes(lb)}
            className="text-[10px] px-1.5 py-0.5"
            title="Edit notes"
          >
            <StickyNote size={11} /> Notes
          </NeonButton>
          <NeonButton
            variant={lb.catalogueStyleId ? 'secondary' : 'ghost'}
            onClick={() => onStyleClick(lb)}
            className="text-[10px] px-1.5 py-0.5"
          >
            Style
          </NeonButton>
          <NeonButton
            variant="ghost"
            onClick={() => onDeleteGame(lb)}
            className="text-[10px] px-1.5 py-0.5 text-red-400/60 hover:text-red-400"
            title="Remove game"
          >
            <Trash2 size={11} />
          </NeonButton>
        </div>
      </div>

      {/* Background image area */}
      {bgImage && (
        <div className="relative h-28 bg-raised">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${bgImage})`,
              backgroundSize: 'cover',
              backgroundPosition: 'top center',
            }}
          />
          {styleHeaderUrl && (
            <img src={styleHeaderUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-contain z-[1]" />
          )}
        </div>
      )}

      {/* Scores */}
      <div className="flex-1 text-sm">
        {lb.rankings.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-faint text-xs">No scores yet</p>
          </div>
        ) : (
          <>
            {/* Header row */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
              <span>Player</span>
              <span>Score</span>
            </div>
            {lb.rankings.slice(0, maxScores).map((entry) => {
              const isExpanded = expanded === entry.iscored_username;
              const playerSubs = isExpanded ? getPlayerSubmissions(entry.iscored_username) : [];

              return (
                <div key={entry.discord_user_id}>
                  <div
                    className={`flex items-center justify-between px-3 py-2 border-b border-border/20 last:border-0 cursor-pointer hover:bg-raised/30 transition-colors ${
                      entry.rank === 1 ? 'bg-neon-amber/8' : ''
                    }`}
                    onClick={() => toggleExpand(entry.iscored_username)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(entry.iscored_username);
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-display font-bold text-xs w-5 text-center flex-shrink-0 ${
                        entry.rank === 1 ? 'text-neon-amber' :
                        entry.rank === 2 ? 'text-neon-cyan' :
                        entry.rank === 3 ? 'text-neon-green' :
                        'text-faint'
                      }`}>
                        {entry.rank}
                      </span>
                      <span className="text-xs truncate">{entry.display_name || entry.iscored_username}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={`font-display font-bold text-xs ${
                        entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                      }`}>
                        {entry.score.toLocaleString()}
                      </span>
                      <span className={`text-faint text-[10px] transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="bg-raised/20 border-b border-border/20 px-3 py-1">
                      {loadingSubs ? (
                        <p className="text-faint text-[10px] py-1">Loading...</p>
                      ) : playerSubs.length === 0 ? (
                        <p className="text-faint text-[10px] py-1">No submissions</p>
                      ) : (
                        playerSubs.map((sub, i) => (
                          <div key={sub.id} className="flex items-center justify-between py-0.5 text-[11px] group">
                            <span className="text-faint">{i === 0 ? 'Best' : new Date(sub.timestamp).toLocaleDateString()}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-muted font-display">{sub.score.toLocaleString()}</span>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); requestDeleteSubmission(sub); }}
                                disabled={deleting === sub.id}
                                className="p-4 -m-2 opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-red-400/60 hover:text-red-400 transition-all cursor-pointer disabled:opacity-30"
                                title="Delete this score"
                                aria-label="Delete this score"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
      {pendingDelete && (
        <ConfirmModal
          title="Delete score"
          message={`Delete score ${pendingDelete.score.toLocaleString()} by ${pendingDelete.iscored_username}? Scores at or below this value that still exist on iScored will not re-import.`}
          confirmLabel="Delete"
          onConfirm={() => {
            const sub = pendingDelete;
            setPendingDelete(null);
            deleteSubmission(sub);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
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
                    <span className="text-sm truncate">{sub.iscored_username}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-display font-bold text-sm">{sub.score.toLocaleString()}</span>
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
                    <span className="text-sm truncate">{s.username}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-display font-bold text-sm">{s.suppressedScore.toLocaleString()}</span>
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
    </div>
  );
}
