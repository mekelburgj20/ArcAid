import { useEffect, useState } from 'react';
import { Lock, Trash2, Pencil, StickyNote } from 'lucide-react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { getSocket } from '../lib/websocket';
import TournamentBadge from '../components/TournamentBadge';
import LoadingState from '../components/LoadingState';
import StylePicker from '../components/StylePicker';
import NeonButton from '../components/NeonButton';
import CardRouter from '../components/scoreboard/CardRouter';
import { deriveScoreboardConfig, getCardWidth } from '../lib/scoreboardConfig';
import {
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
    socket.on('leaderboard:updated', () => { loadData(); loadRankings(); });
    socket.on('score:new', () => { loadData(); loadRankings(); });

    return () => {
      socket.off('leaderboard:updated');
      socket.off('score:new');
    };
  }, []);

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
      <h1 className="font-display text-2xl font-bold mb-6">Leaderboards</h1>

      {/* Scoreboard Preview — matches public layout */}
      <div
        className="rounded-lg overflow-hidden border border-border/50 px-4 sm:px-6 py-6"
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

        {/* Rankings: top position */}
        {rankingsPosition === 'top' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} />
        )}

        {/* Main content area */}
        <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row' : 'flex-col'} gap-6 items-start`}>

          {/* Rankings: left position */}
          {rankingsPosition === 'left' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} />
          )}

          {/* Game leaderboards */}
          {visibleLeaderboards.length === 0 ? (
            <div className="flex-1 text-center py-16">
              <p className="text-muted font-display">No active games with scores yet.</p>
            </div>
          ) : layout === 'grid' ? (
            <div className="flex-1 min-w-0">
              <div
                className={`grid ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${!useNewCards && gameColumns === '2' ? 'grid-cols-1 md:grid-cols-2' : ''}`}
                style={{
                  ...(useNewCards ? { gap: newConfig.cardSpacing } : {}),
                  ...(useNewCards || gameColumns !== '2' ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.7)}px, 100%), 1fr))` } : {}),
                }}
              >
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="grid">
                    <AdminCardWrapper lb={lb} onStyleClick={handleStyleClick} onEditDisplayName={handleEditDisplayName} onDeleteGame={setDeleteTarget} onEditNotes={handleEditNotes}>
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
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 overflow-x-auto">
              <div className={`flex pb-2 ${useNewCards ? '' : 'gap-3 sm:gap-5'}`} style={useNewCards ? { gap: newConfig.cardSpacing } : undefined}>
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, 75vw)` }}>
                    <AdminCardWrapper lb={lb} onStyleClick={handleStyleClick} onEditDisplayName={handleEditDisplayName} onDeleteGame={setDeleteTarget} onEditNotes={handleEditNotes}>
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
              </div>
            </div>
          )}

          {/* Rankings: right position */}
          {rankingsPosition === 'right' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} />
          )}
        </div>

        {/* Rankings: bottom position */}
        {rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} />
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

function AdminCardWrapper({ lb, children, onStyleClick, onEditDisplayName, onDeleteGame, onEditNotes }: {
  lb: GameLeaderboard;
  children: React.ReactNode;
  onStyleClick: (lb: GameLeaderboard) => void;
  onEditDisplayName: (lb: GameLeaderboard) => void;
  onDeleteGame: (lb: GameLeaderboard) => void;
  onEditNotes: (lb: GameLeaderboard) => void;
}) {
  return (
    <div className="relative group">
      {children}
      {/* Admin overlay — visible on hover */}
      <div className="absolute top-0 left-0 right-0 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="flex items-center justify-center gap-1 p-1.5 bg-black/70 backdrop-blur-sm rounded-t-lg">
          <NeonButton variant="ghost" onClick={() => onEditDisplayName(lb)} className="text-[10px] px-1.5 py-0.5">
            <Pencil size={11} /> Name
          </NeonButton>
          <NeonButton variant={lb.notes ? 'secondary' : 'ghost'} onClick={() => onEditNotes(lb)} className="text-[10px] px-1.5 py-0.5">
            <StickyNote size={11} /> Notes
          </NeonButton>
          <NeonButton variant={lb.catalogueStyleId ? 'secondary' : 'ghost'} onClick={() => onStyleClick(lb)} className="text-[10px] px-1.5 py-0.5">
            Style
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

  const deleteSubmission = async (sub: Submission) => {
    if (!confirm(`Delete score ${sub.score.toLocaleString()} by ${sub.iscored_username}?`)) return;
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
            <img src={styleHeaderUrl} alt="" className="absolute inset-0 w-full h-full object-contain z-[1]" />
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
                      <span className="text-xs truncate">{entry.iscored_username}</span>
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
                                onClick={(e) => { e.stopPropagation(); deleteSubmission(sub); }}
                                disabled={deleting === sub.id}
                                className="opacity-0 group-hover:opacity-100 text-red-400/60 hover:text-red-400 transition-all cursor-pointer disabled:opacity-30"
                                title="Delete this score"
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
    </div>
  );
}
