import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useToast } from '../components/Toast';
import { AtGamesAlreadyJoined, AtGamesJoinForm } from '../components/AtGamesJoinPanel';
import type { AtGamesJoinable, AtGamesJoinedVia, CardAtGamesJoinValue } from '../components/scoreboard/cardAtGamesJoinContext';

/**
 * v2.234.0 (A36) — the public Scoreboard's ONE read of the room's AtGames
 * joinable round cards, plus the join dialog. Returns the value for
 * `CardAtGamesJoinContext`, `reload` (called alongside the page's board loads,
 * so a round going live picks up its button) and the dialog element.
 *
 * Shown to guests too: tapping it asks them to log in first.
 *
 * v2.237.0 (A40) — "Joined" is the server's per-player answer (`joinedVia` on
 * each row), no longer this browser's localStorage, so a join on another
 * device, in the AtGames app (via "I've joined") or one Arcaid saw in a pulled
 * score all show. Arcaid still cannot read AtGames' member list.
 */
export function useRoomAtGamesJoin(roomId: string | null | undefined, playerToken: string | null | undefined, onLogin: () => void): {
  value: CardAtGamesJoinValue | null;
  reload: () => Promise<void>;
  dialog: ReactNode;
} {
  const { toast } = useToast();
  const [games, setGames] = useState<AtGamesJoinable[]>([]);
  const [active, setActive] = useState<AtGamesJoinable | null>(null);

  const reload = useCallback(async () => {
    if (!roomId) { setGames([]); return; }
    try {
      const res = await fetch(`/api/rooms/${roomId}/atgames/joinable`, {
        headers: playerToken ? { Authorization: `Bearer ${playerToken}` } : {},
      });
      if (!res.ok) { setGames([]); return; }
      const body = await res.json() as { games?: unknown };
      setGames(Array.isArray(body.games) ? body.games as AtGamesJoinable[] : []);
    } catch {
      setGames([]);
    }
  }, [roomId, playerToken]);

  // Every round card of that event flips at once; the server already stored it.
  const markJoined = useCallback((tournamentId: string, via: AtGamesJoinedVia) => {
    setGames(prev => prev.map(g => (g.tournamentId === tournamentId ? { ...g, joinedVia: via } : g)));
  }, []);

  const value = useMemo<CardAtGamesJoinValue | null>(() => (
    games.length === 0 ? null : {
      byGameId: Object.fromEntries(games.map(g => [g.gameId, g])),
      joined: new Set(games.filter(g => g.joinedVia).map(g => g.tournamentId)),
      open: (item) => setActive(item),
    }
  ), [games]);

  const dialog = active && roomId ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
      onClick={() => setActive(null)}
    >
      <div
        role="dialog" aria-modal="true" aria-label={`Join ${active.tournamentName} on AtGames`}
        className="w-full max-w-sm rounded border border-border bg-surface p-5 shadow-xl shadow-black/40"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-primary mb-1">Join on AtGames</h2>
        <p className="text-xs text-muted mb-4 break-words">
          {active.tournamentName}
          {active.code && <> · or join on the cabinet with code <span className="font-mono font-bold text-neon-cyan">{active.code}</span></>}
        </p>
        {playerToken ? (
          <div className="grid gap-4">
            <AtGamesJoinForm
              roomId={roomId} eventId={active.tournamentId} playerToken={playerToken}
              onJoined={(msg, via) => { markJoined(active.tournamentId, via); setActive(null); toast(msg, 'success'); }}
              onCancel={() => setActive(null)}
            />
            <div className="pt-3 border-t border-border/40">
              <AtGamesAlreadyJoined
                roomId={roomId} eventId={active.tournamentId} playerToken={playerToken}
                onMarked={via => { markJoined(active.tournamentId, via); setActive(null); toast('Marked as joined on AtGames.', 'success'); }}
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm text-primary">Log in to Arcaid first, then join.</p>
            <div className="flex gap-2">
              <button
                type="button" onClick={() => { setActive(null); onLogin(); }}
                className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors"
              >Log in</button>
              <button
                type="button" onClick={() => setActive(null)}
                className="px-4 py-2 rounded border border-border bg-raised text-primary text-sm"
              >Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  ) : null;

  return { value, reload, dialog };
}
