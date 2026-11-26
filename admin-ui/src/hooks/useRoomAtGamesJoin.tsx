import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useToast } from '../components/Toast';
import { Dialog } from '../components/parts/Dialog';
import Button from '../components/parts/Button';
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
    <Dialog
      open
      onOpenChange={o => { if (!o) setActive(null); }}
      tone="cyan"
      label="AtGames"
      title="Join on AtGames"
      description={(
        <span className="break-words">
          {active.tournamentName}
          {active.code && <> · or join on the cabinet with code <span className="font-mono font-bold text-neon-cyan">{active.code}</span></>}
        </span>
      )}
      footer={playerToken ? undefined : (
        <>
          <Button variant="secondary" onClick={() => setActive(null)}>Cancel</Button>
          <Button onClick={() => { setActive(null); onLogin(); }}>Log in</Button>
        </>
      )}
    >
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
        <p className="text-sm text-primary">Log in to Arcaid first, then join.</p>
      )}
    </Dialog>
  ) : null;

  return { value, reload, dialog };
}
