import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * C2 - "N players own this table" plus the viewer's own "I own this" toggle.
 *
 * Ownership is public as a COUNT only - never listed by name (owner ruling).
 * Reads `GET /api/global/games/:id/owners` (Bearer when logged in, so `mine`
 * comes back); the toggle PUTs `{ platforms: [] }` (owned, any platform) or
 * DELETEs `/api/me/tables/:id`. Per-engine detail is edited on My Tables.
 *
 * Raw fetch with the PLAYER token on purpose - `lib/api.ts` carries the admin
 * token and would bounce a player to an operator login on a 401.
 */
interface OwnersResponse {
  count: number;
  mine: { owned: boolean; platforms: string[] } | null;
}

interface TableOwnersLineProps {
  globalGameId: string;
  playerToken: string | null;
}

export default function TableOwnersLine({ globalGameId, playerToken }: TableOwnersLineProps) {
  const [owners, setOwners] = useState<OwnersResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped after a toggle to re-read the count + `mine` from the server.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const headers: Record<string, string> = {};
    if (playerToken) headers['Authorization'] = `Bearer ${playerToken}`;
    fetch(`/api/global/games/${encodeURIComponent(globalGameId)}/owners`, { headers })
      .then(res => (res.ok ? res.json() : null))
      .then(body => {
        if (!cancelled && body && typeof body.count === 'number') setOwners(body as OwnersResponse);
      })
      .catch(() => { /* the line is optional - stay hidden */ });
    return () => { cancelled = true; };
  }, [globalGameId, playerToken, reloadKey]);

  const owned = !!owners?.mine?.owned;

  const toggle = async () => {
    if (!playerToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = `/api/me/tables/${encodeURIComponent(globalGameId)}`;
      const res = owned
        ? await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${playerToken}` } })
        : await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
            body: JSON.stringify({ platforms: [] }),
          });
      if (!res.ok) throw new Error('save failed');
      setReloadKey(k => k + 1);
    } catch {
      setError('Could not update your tables.');
    }
    setBusy(false);
  };

  if (!owners) return null;
  const { count } = owners;
  if (count === 0 && !playerToken) return null;

  return (
    <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap mb-3 text-xs" data-testid="table-owners">
      <span className="text-muted">
        {count > 0
          ? `${count} player${count === 1 ? '' : 's'} own${count === 1 ? 's' : ''} this table`
          : 'Be the first to add it to your tables'}
      </span>
      {playerToken && (
        <>
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            aria-pressed={owned}
            className={`px-2.5 py-1 rounded border text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default ${
              owned
                ? 'border-neon-green/50 bg-neon-green/10 text-neon-green'
                : 'border-border text-muted hover:text-primary hover:border-neon-cyan/40'
            }`}
          >
            {owned ? 'Owned' : 'I own this'}
          </button>
          <Link to="/account/tables" className="text-neon-cyan hover:underline">
            Set platforms
          </Link>
        </>
      )}
      {error && <span className="text-neon-red">{error}</span>}
    </div>
  );
}
