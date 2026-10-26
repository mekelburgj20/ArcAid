import { useEffect, useState } from 'react';

/**
 * Invite-only notice (v2.179.0, W39, ADR 0033 §6) for a logged-in player on a
 * tournament's page. Renders nothing for an open (Room members) tournament or
 * for a player already on the roster. Otherwise it says so — their scores go to
 * the Global Scoreboard — and offers "Request to join" when the host takes
 * requests.
 */
interface MyEntry {
  mode: 'members' | 'invited';
  onRoster: boolean;
  request: 'pending' | 'denied' | null;
  canRequest: boolean;
}

export default function EntryNotice({ roomId, tournamentId, playerToken, toast }: {
  roomId: string;
  tournamentId: string;
  playerToken: string | null;
  toast: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [mine, setMine] = useState<{ tournamentId: string; entry: MyEntry } | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!playerToken) return;
    let cancelled = false;
    fetch(`/api/rooms/${roomId}/tournaments/${tournamentId}/entry/me`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then((entry: MyEntry | null) => { if (!cancelled && entry) setMine({ tournamentId, entry }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [roomId, tournamentId, playerToken]);

  const entry = mine && mine.tournamentId === tournamentId ? mine.entry : null;
  if (!playerToken || !entry || entry.mode !== 'invited' || entry.onRoster) return null;

  const ask = async () => {
    setAsking(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/tournaments/${tournamentId}/entry/request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast(body.error || 'Could not send your request', 'error'); return; }
      setMine({ tournamentId, entry: { ...entry, request: 'pending', onRoster: body.status === 'on_roster' } });
      toast(body.status === 'on_roster' ? "You're already on the roster" : 'Request sent to the host', 'success');
    } catch {
      toast('Could not send your request', 'error');
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="mb-4 rounded border border-neon-amber/40 bg-neon-amber/5 px-4 py-3 text-sm" data-testid="entry-notice">
      <p className="text-primary">Invite-only — you're not on this tournament's roster, so your scores go to your Global Scoreboard.</p>
      {entry.request === 'pending' ? (
        <p className="text-muted text-xs mt-1">Your request to join is waiting for the host.</p>
      ) : entry.canRequest ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={ask}
            disabled={asking}
            className="px-3 py-1.5 rounded border border-neon-amber text-neon-amber text-xs font-display uppercase tracking-wider hover:bg-neon-amber/10 disabled:opacity-50"
            data-testid="request-entry"
          >
            {asking ? 'Sending…' : 'Request to join'}
          </button>
          {entry.request === 'denied' && <span className="text-muted text-xs">Your last request was declined; you can ask again.</span>}
        </div>
      ) : (
        <p className="text-muted text-xs mt-1">Ask the host for an invite.</p>
      )}
    </div>
  );
}
