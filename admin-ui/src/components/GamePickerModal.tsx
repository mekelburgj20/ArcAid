import { useState, useEffect, useContext, useRef } from 'react';
import { Search, X } from 'lucide-react';
import NeonButton from './NeonButton';
import { api } from '../lib/api';
import { RoomContext } from '../contexts/RoomContext';
import type { ImageApplyType } from './StylePicker';
import { compareByRank } from '../lib/searchRank';

interface LeaderboardGame {
  gameId: string;
  gameName: string;
  tournamentName: string;
  gameStatus: string;
}

interface LibraryGame {
  gameName: string;
}

interface GamePickerModalProps {
  styleName: string;
  styleId: string;
  onClose: () => void;
  onApplied: () => void;
}

export default function GamePickerModal({ styleName, styleId, onClose, onApplied }: GamePickerModalProps) {
  const roomCtx = useContext(RoomContext);
  const roomId = roomCtx?.roomId;
  const [leaderboardGames, setLeaderboardGames] = useState<LeaderboardGame[]>([]);
  const [libraryGames, setLibraryGames] = useState<LibraryGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selectedGame, setSelectedGame] = useState<LeaderboardGame | LibraryGame | null>(null);
  const [imageType, setImageType] = useState<ImageApplyType>('both');
  const [applyToActive, setApplyToActive] = useState(true);
  const [makeDefault, setMakeDefault] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  const isLeaderboardGame = (g: LeaderboardGame | LibraryGame): g is LeaderboardGame => 'gameId' in g;
  const getGameName = (g: LeaderboardGame | LibraryGame) => isLeaderboardGame(g) ? g.gameName : g.gameName;

  useEffect(() => {
    if (!roomId) return;
    setLoading(true);
    api.get<{ leaderboardGames: LeaderboardGame[]; libraryGames: LibraryGame[] }>(
      `/rooms/${roomId}/admin/games-for-picker`
    ).then(data => {
      setLeaderboardGames(data.leaderboardGames);
      setLibraryGames(data.libraryGames);
    }).catch(() => {
      setError('Failed to load games');
    }).finally(() => setLoading(false));
  }, [roomId]);

  const filterLower = filter.toLowerCase();
  const trimmedFilter = filter.trim();
  const filteredLB = leaderboardGames.filter(g => g.gameName.toLowerCase().includes(filterLower));
  const filteredLib = libraryGames.filter(g => g.gameName.toLowerCase().includes(filterLower));
  // Search-relevance work package (2026-08-13): nearest-exact-match first.
  if (trimmedFilter) {
    filteredLB.sort(compareByRank(trimmedFilter, g => g.gameName));
    filteredLib.sort(compareByRank(trimmedFilter, g => g.gameName));
  }

  const handleApply = async () => {
    if (!selectedGame || !roomId) return;
    setApplying(true);
    try {
      if (isLeaderboardGame(selectedGame)) {
        if (applyToActive) {
          if (imageType === 'both') {
            await api.put(`/rooms/${roomId}/admin/games/${selectedGame.gameId}/style`, {
              catalogueStyleId: styleId, headerDisabled: false,
            });
          } else {
            await api.put(`/rooms/${roomId}/admin/games/${selectedGame.gameId}/image`, {
              styleId, imageType,
            });
          }
        }
        if (makeDefault) {
          if (imageType === 'both') {
            await api.put(`/rooms/${roomId}/game_library/${encodeURIComponent(selectedGame.gameName)}/style`, {
              catalogueStyleId: styleId, headerDisabled: false,
            });
          } else {
            await api.put(`/rooms/${roomId}/game_library/${encodeURIComponent(selectedGame.gameName)}/image`, {
              styleId, imageType,
            });
          }
        }
      } else {
        // Library-only game — set as default
        if (imageType === 'both') {
          await api.put(`/rooms/${roomId}/game_library/${encodeURIComponent(selectedGame.gameName)}/style`, {
            catalogueStyleId: styleId, headerDisabled: false,
          });
        } else {
          await api.put(`/rooms/${roomId}/game_library/${encodeURIComponent(selectedGame.gameName)}/image`, {
            styleId, imageType,
          });
        }
      }
      onApplied();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to apply style');
    } finally {
      setApplying(false);
    }
  };

  const backdropMouseDown = useRef(false);
  const handleBackdropMouseDown = (e: React.MouseEvent) => { backdropMouseDown.current = e.target === e.currentTarget; };
  const handleBackdropClick = (e: React.MouseEvent) => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); };

  if (!roomId) {
    return (
      <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onMouseDown={handleBackdropMouseDown} onClick={handleBackdropClick}>
        <div className="bg-surface border border-border rounded-lg p-6 max-w-sm" onClick={e => e.stopPropagation()}>
          <p className="text-muted text-sm">Apply to Game is only available from a room admin context.</p>
          <NeonButton variant="ghost" onClick={onClose} className="mt-4">Close</NeonButton>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onMouseDown={handleBackdropMouseDown} onClick={handleBackdropClick}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-md max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="font-display text-sm font-bold text-primary">Apply to Game</h3>
            <p className="text-xs text-muted truncate mt-0.5">{styleName}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {/* Image type selector */}
        <div className="px-4 pt-3 shrink-0">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm text-muted">Apply as:</span>
            <div className="inline-flex rounded border border-border overflow-hidden">
              {(['both', 'background', 'logo'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setImageType(t)}
                  className={`px-3 py-1 text-xs border-0 cursor-pointer transition-colors ${
                    imageType === t ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-surface text-muted hover:text-primary'
                  }`}
                >
                  {t === 'both' ? 'Both' : t === 'background' ? 'Background' : 'Identifier'}
                </button>
              ))}
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-3">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter games..."
              className="w-full pl-10 pr-4 py-2 bg-raised border border-border rounded text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
            />
          </div>
        </div>

        {/* Game list */}
        <div className="flex-1 overflow-y-auto px-4 pb-2">
          {loading ? (
            <div className="text-center text-muted py-8">Loading games...</div>
          ) : error ? (
            <div className="text-center text-neon-magenta py-8 text-sm">{error}</div>
          ) : (
            <>
              {/* Leaderboard games */}
              {filteredLB.length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] text-faint uppercase tracking-wider mb-1.5">Current Games</p>
                  {filteredLB.map(g => {
                    const isSelected = selectedGame && isLeaderboardGame(selectedGame) && selectedGame.gameId === g.gameId;
                    return (
                      <div
                        key={g.gameId}
                        onClick={() => { setSelectedGame(g); setApplyToActive(true); setMakeDefault(true); }}
                        className={`flex items-center justify-between px-3 py-2 rounded cursor-pointer transition-colors mb-0.5 ${
                          isSelected ? 'bg-neon-cyan/10 border border-neon-cyan/30' : 'hover:bg-raised border border-transparent'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-primary truncate">{g.gameName}</div>
                          <div className="text-[11px] text-faint">{g.tournamentName}</div>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          g.gameStatus === 'ACTIVE' ? 'bg-neon-green/10 text-neon-green' : 'bg-neon-amber/10 text-neon-amber'
                        }`}>
                          {g.gameStatus === 'ACTIVE' ? 'Active' : 'Locked'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Library games */}
              {filteredLib.length > 0 && (
                <div>
                  <p className="text-[10px] text-faint uppercase tracking-wider mb-1.5">Library Games</p>
                  {filteredLib.map(g => {
                    const isSelected = selectedGame && !isLeaderboardGame(selectedGame) && getGameName(selectedGame) === g.gameName;
                    return (
                      <div
                        key={g.gameName}
                        onClick={() => { setSelectedGame(g); setMakeDefault(true); }}
                        className={`flex items-center px-3 py-2 rounded cursor-pointer transition-colors mb-0.5 ${
                          isSelected ? 'bg-neon-cyan/10 border border-neon-cyan/30' : 'hover:bg-raised border border-transparent'
                        }`}
                      >
                        <div className="text-sm text-primary truncate">{g.gameName}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {filteredLB.length === 0 && filteredLib.length === 0 && (
                <div className="text-center text-muted py-8 text-sm">No games found.</div>
              )}
            </>
          )}
        </div>

        {/* Options + Apply */}
        {selectedGame && (
          <div className="border-t border-border p-4 shrink-0">
            {isLeaderboardGame(selectedGame) ? (
              <div className="space-y-2 mb-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={applyToActive} onChange={e => setApplyToActive(e.target.checked)} className="accent-neon-cyan" />
                  <span className="text-sm text-muted">Apply to active game</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} className="accent-neon-cyan" />
                  <span className="text-sm text-muted">Set as default for future games</span>
                </label>
              </div>
            ) : (
              <p className="text-sm text-muted mb-3">
                This will set the default {imageType === 'logo' ? 'logo' : imageType === 'background' ? 'background' : 'style'} for future games of <strong className="text-primary">{getGameName(selectedGame)}</strong>.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <NeonButton variant="ghost" onClick={onClose}>Cancel</NeonButton>
              <NeonButton
                onClick={handleApply}
                disabled={applying || (isLeaderboardGame(selectedGame) && !applyToActive && !makeDefault)}
              >
                {applying ? 'Applying...' : 'Apply'}
              </NeonButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
