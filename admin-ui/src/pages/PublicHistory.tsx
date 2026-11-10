import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { tournamentResultsPath } from '../lib/tournamentLinks';
import { RESULTS_PAGE } from '../lib/pageLayout';
import { TOURNAMENT_TYPE_COLORS } from '../components/TournamentTypeBadge';
import RunFeed from '../components/results/RunFeed';
import { useRoom } from '../contexts/RoomContext';

/**
 * `/:slug/history` — every finished run in the room.
 *
 * v2.241.0 (B26, owner 2026-11-10): a week at a time, one card per run with
 * its table art, winner and final standings open (`components/results/RunFeed`,
 * shared with the tournament page's Runs view). v2.238.0 (B24): filters by
 * tournament and by tag, kept in the URL (`?tournament=&type=&week=`).
 */

interface TournamentOption {
  id: string;
  name: string;
  type?: string | null;
  is_active?: number | boolean;
}

export default function PublicHistory() {
  const { roomId, roomSlug } = useRoom();
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [params, setParams] = useSearchParams();
  const tournamentFilter = params.get('tournament') ?? '';
  const typeFilter = params.get('type') ?? '';

  /** A filter change starts again at the latest week. */
  const setFilter = (key: 'tournament' | 'type', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('week');
    next.delete('run');
    setParams(next);
  };

  // The room's tournaments, for the tournament filter (and its tags for the
  // type filter). Optional: without them the page still lists everything.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    fetch(`/api/rooms/${roomId}/tournaments`)
      .then(r => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled || !Array.isArray(rows)) return;
        setTournaments((rows as TournamentOption[])
          .filter(t => t && typeof t.id === 'string' && typeof t.name === 'string')
          .sort((a, b) => (Number(!!b.is_active) - Number(!!a.is_active)) || a.name.localeCompare(b.name)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [roomId]);

  // The room's own tags (B24: the old static list named four tags many rooms
  // don't use and none they invented). The static list is the fallback while
  // the tournaments haven't loaded.
  const tournamentTypes = useMemo(() => {
    const own = [...new Set(tournaments.map(t => (t.type || '').trim()).filter(Boolean))].sort();
    return own.length > 0 ? own : Object.keys(TOURNAMENT_TYPE_COLORS);
  }, [tournaments]);
  const selectClass = 'bg-raised border border-border rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-neon-cyan/60 w-full sm:w-auto';

  return (
    <div className={`${RESULTS_PAGE} pt-6 pb-8`}>
      <div className="pb-4 flex flex-col gap-3 sm:flex-row sm:items-center justify-between">
        <h2 className="font-display text-2xl sm:text-3xl font-bold">History</h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {tournaments.length > 0 && (
            <select
              aria-label="Tournament"
              value={tournamentFilter}
              onChange={e => setFilter('tournament', e.target.value)}
              className={`${selectClass} sm:max-w-[16rem]`}
            >
              <option value="">All tournaments</option>
              {tournaments.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          <select
            aria-label="Type"
            value={typeFilter}
            onChange={e => setFilter('type', e.target.value)}
            className={selectClass}
          >
            <option value="">All Types</option>
            {tournamentTypes.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </div>
      </div>
      {tournamentFilter && roomSlug && (
        <div className="pb-4">
          <Link
            to={tournamentResultsPath(roomSlug, tournamentFilter)}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-neon-cyan no-underline transition-colors"
          >
            Open the tournament page
            <ChevronRight size={12} aria-hidden="true" />
          </Link>
        </div>
      )}

      {roomId && (
        <RunFeed
          key={`${tournamentFilter}|${typeFilter}`}
          roomId={roomId}
          slug={roomSlug}
          tournamentId={tournamentFilter || undefined}
          type={typeFilter || undefined}
          showTournament
          emptyText="No completed games found."
        />
      )}
    </div>
  );
}
