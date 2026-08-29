import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import NeonCard from './NeonCard';
import {
  Trophy, Shuffle, Timer, Play, Bookmark, BookmarkX, Lock,
  Trash2, Broom, TimerReset, ScrollText, RefreshCw,
} from 'lucide-react';

/**
 * Rotation log (v2.146.0) — the room-admin-visible answer to "who or what
 * picked what, and what triggered it".
 *
 * Prompted by the 2026-08-27 WG-VR / WG-VPXS over-activation, where that
 * question could only be answered by grepping prod logs. Each row is one
 * rotation DECISION recorded at the moment it happened, newest first,
 * filterable by tournament.
 */

interface RotationEvent {
  id: number;
  tournament_id: string | null;
  tournament_name: string | null;
  event_type: string;
  actor: string;
  source: string | null;
  queue_owner: string | null;
  game_id: string | null;
  game_name: string | null;
  /** Per-type extras, shaped by the writer — read through `txt`/`num` below. */
  details: Record<string, unknown>;
  created_at: string;
}

/** `details` is untyped JSON by design; read a field as text with a fallback. */
function txt(v: unknown, fallback = ''): string {
  return v === null || v === undefined || v === '' ? fallback : String(v);
}

/** Same, for a numeric field rendered with thousands separators. */
function num(v: unknown, fallback = ''): string {
  return typeof v === 'number' ? v.toLocaleString() : txt(v, fallback);
}

interface RotationLogPage {
  events: RotationEvent[];
  nextCursor: string | null;
}

const PAGE_SIZE = 50;

const TYPE_META: Record<string, { label: string; color: string; Icon: typeof Trophy }> = {
  winner_resolved:      { label: 'Winner',      color: 'text-neon-amber',  Icon: Trophy },
  disposition_applied:  { label: 'Hand-off',    color: 'text-neon-purple', Icon: Shuffle },
  pick_window_granted:  { label: 'Pick window', color: 'text-neon-cyan',   Icon: Timer },
  pick_window_cleared:  { label: 'Window cleared', color: 'text-muted',    Icon: TimerReset },
  game_activated:       { label: 'Activated',   color: 'text-neon-green',  Icon: Play },
  placeholder_created:  { label: 'Slot held',   color: 'text-neon-cyan',   Icon: Bookmark },
  placeholder_deleted:  { label: 'Slot removed', color: 'text-neon-amber', Icon: BookmarkX },
  game_deactivated:     { label: 'Closed',      color: 'text-muted',       Icon: Lock },
  game_deleted:         { label: 'Deleted',     color: 'text-red-400',     Icon: Trash2 },
  cleanup_action:       { label: 'Cleanup',     color: 'text-muted',       Icon: Broom },
  timeout_pivot:        { label: 'Timed out',   color: 'text-neon-amber',  Icon: TimerReset },
};

/** How each activation source reads in a sentence. */
const SOURCE_PHRASE: Record<string, string> = {
  winner_queue: "from the winner's queue",
  runner_up_queue: "from the runner-up's queue",
  third_place_queue: "from third place's queue",
  fill_loop: 'to fill an extra slot',
  timeout_auto: 'by auto-pick after the pick window expired',
  auto_pick: 'by auto-pick',
  admin_manual: 'by an admin',
  web_pick: 'by a web pick',
  discord_pick: 'by a Discord pick',
  admin_on_behalf: 'by an admin on a player’s behalf',
  unknown: 'from an unrecorded source',
};

const PLACEHOLDER_REASON: Record<string, string> = {
  orphan_sweep: 'its won game was gone (orphan sweep)',
  capacity_guard: 'the tournament was already full',
  repurposed: 'the pick was made and fulfilled it',
  admin_removed: 'an admin removed it',
  autopick_disabled: 'auto-pick is off and nobody picked',
  no_eligible_games: 'no eligible game was left to auto-pick',
};

/**
 * Strip the `player:` / `admin:` / `system:` prefix for display. The prefix is
 * what makes the stored value unambiguous; the reader wants the identity.
 */
function actorLabel(actor: string): string {
  if (actor.startsWith('system:')) {
    const which = actor.slice('system:'.length);
    return which === 'timeout' ? 'the pick timer'
      : which === 'event-scheduler' ? 'the event clock'
      : 'the rotation';
  }
  const sep = actor.indexOf(':');
  return sep < 0 ? actor : actor.slice(sep + 1);
}

/**
 * One plain sentence per event. Never ellipsized — long game titles wrap
 * (owner rule); the row is a flex column, not a truncated single line.
 */
function describe(e: RotationEvent): string {
  const d = e.details || {};
  const game = e.game_name || 'a game';
  switch (e.event_type) {
    case 'winner_resolved':
      return d.resolved
        ? `${txt(d.winnerName, 'Someone')} won ${txt(d.fromGame, game)}`
          + `${d.score != null ? ` with ${num(d.score)}` : ''}.`
        : `No scores were on the board for ${txt(d.fromGame, game)} — no winner.`;
    case 'disposition_applied':
      return d.disposition === 'nominate'
        ? `${actorLabel(e.actor)} handed their pick to ${txt(d.movedTo, 'someone else')}.`
        : d.disposition === 'forfeit'
          ? `${actorLabel(e.actor)} forfeited the pick.`
          : `${actorLabel(e.actor)} rolled the dice — Arcaid picks.`;
    case 'pick_window_granted':
      return `${txt(d.pickerLabel, txt(d.picker, 'A player'))} got a `
        + `${d.pickerType === 'RUNNER_UP' ? 'runner-up' : 'winner'} pick window`
        + `${d.windowMin ? ` of ${txt(d.windowMin)} min` : ''}`
        + `${d.deadline ? `, closing ${fmtTime(txt(d.deadline))}` : ''}.`;
    case 'pick_window_cleared':
      return `An admin cancelled the ${txt(d.pickerType).toLowerCase() || 'pick'} window on ${game}`
        + `${d.picker ? ` (was ${txt(d.picker)})` : ''}.`;
    case 'game_activated':
      return `Activated ${game} ${SOURCE_PHRASE[e.source || 'unknown'] || SOURCE_PHRASE.unknown}`
        + `${e.queue_owner ? ` — ${e.queue_owner}'s queue` : ''}`
        + `${d.replacedGame ? `, replacing ${txt(d.replacedGame)}` : ''}.`;
    case 'placeholder_created':
      return `Reserved a slot for ${txt(d.picker, 'the picker')} (${txt(d.pickerType, 'WINNER')})`
        + ` after ${txt(d.wonGameName, 'their win')}.`;
    case 'placeholder_deleted':
      return `Removed a reserved pick slot — `
        + `${PLACEHOLDER_REASON[txt(d.reason)] || txt(d.reason, 'reason not recorded')}.`;
    case 'game_deactivated':
      return `${game} closed${d.trigger === 'admin' ? ' by an admin' : ' at end of round'}`
        + `${d.iscoredStatus ? ` (iScored: ${txt(d.iscoredStatus)})` : ''}.`;
    case 'game_deleted':
      return `${game} deleted${d.previousStatus ? ` (was ${txt(d.previousStatus)})` : ''}`
        + `${d.scoresRetained ? ', scores kept' : ''}.`;
    case 'cleanup_action':
      return `Cleanup (${txt(d.mode, 'unknown mode')}) archived ${txt(d.archived, '0')}`
        + ` of ${txt(d.considered, '0')} completed game(s).`;
    case 'timeout_pivot':
      return `${txt(d.expiredPicker, 'The picker')}'s ${txt(d.expiredPickerType).toLowerCase() || 'pick'}`
        + ` window expired — the cascade moved on.`;
    default:
      return JSON.stringify(d);
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function RotationLogPanel({ roomId, tournaments }: {
  roomId: string;
  tournaments: { id: string; name: string }[];
}) {
  const [events, setEvents] = useState<RotationEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Refresh — the effect is the only place that fetches page 1. */
  const [reloadToken, setReloadToken] = useState(0);

  const url = useCallback((before?: string | null) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (tournamentId) params.set('tournamentId', tournamentId);
    if (before) params.set('before', before);
    return `/rooms/${roomId}/admin/rotation-log?${params.toString()}`;
  }, [roomId, tournamentId]);

  // The spinner is turned ON by whatever triggered the reload (mount default,
  // the filter's onChange, the Refresh button) rather than synchronously
  // inside the effect, so the effect only ever sets state from a callback.
  useEffect(() => {
    let cancelled = false;
    api.get<RotationLogPage>(url())
      .then(page => {
        if (cancelled) return;
        setError(null);
        // Defensive: an unexpected body shape renders as "nothing yet" rather
        // than throwing inside the Game States page this panel is a guest on.
        setEvents(Array.isArray(page?.events) ? page.events : []);
        setCursor(page?.nextCursor ?? null);
      })
      .catch(() => { if (!cancelled) setError('Failed to load the rotation log'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url, reloadToken]);

  const reload = () => {
    setLoading(true);
    setReloadToken(t => t + 1);
  };

  const loadMore = () => {
    if (!cursor) return;
    setLoadingMore(true);
    api.get<RotationLogPage>(url(cursor))
      .then(page => {
        setEvents(prev => [...prev, ...(Array.isArray(page?.events) ? page.events : [])]);
        setCursor(page?.nextCursor ?? null);
      })
      .catch(() => setError('Failed to load more'))
      .finally(() => setLoadingMore(false));
  };

  return (
    <NeonCard className="mb-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <ScrollText size={16} className="text-neon-purple" />
          <h2 className="font-display text-sm font-bold text-primary uppercase tracking-wider">Rotation log</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={tournamentId}
            onChange={e => { setLoading(true); setTournamentId(e.target.value); }}
            aria-label="Filter rotation log by tournament"
            className="text-xs px-2 py-1.5 rounded border border-border bg-raised text-primary cursor-pointer"
          >
            <option value="">All tournaments</option>
            {tournaments.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={reload}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors cursor-pointer"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      <p className="text-xs text-faint mb-3">
        Every rotation decision, newest first — who or what picked what, and what triggered it.
      </p>

      {error && (
        <div className="mb-3 px-3 py-2 rounded text-sm bg-red-500/10 text-red-400 border border-red-500/30">{error}</div>
      )}

      {loading ? (
        <p className="text-muted text-sm py-6 text-center">Loading rotation log…</p>
      ) : events.length === 0 ? (
        <p className="text-muted text-sm py-6 text-center">
          No rotation decisions recorded yet. Entries appear as tournaments rotate.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {events.map(e => {
            const meta = TYPE_META[e.event_type] || { label: e.event_type, color: 'text-muted', Icon: ScrollText };
            const Icon = meta.Icon;
            return (
              <li
                key={e.id}
                className="flex items-start gap-2.5 py-1.5 px-2 rounded border border-border/20 hover:bg-raised/50 transition-colors"
              >
                <Icon size={14} className={`${meta.color} mt-0.5 shrink-0`} />
                <div className="min-w-0 flex-1">
                  {/* break-words, never truncate — a long table title wraps. */}
                  <div className="text-sm text-primary break-words">{describe(e)}</div>
                  <div className="text-[11px] text-faint flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                    <span className={meta.color}>{meta.label}</span>
                    <span>{fmtTime(e.created_at)}</span>
                    <span>by {actorLabel(e.actor)}</span>
                    {e.tournament_name && <span>· {e.tournament_name}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {cursor && !loading && (
        <div className="flex justify-center mt-3">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="text-xs px-4 py-1.5 rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </NeonCard>
  );
}
