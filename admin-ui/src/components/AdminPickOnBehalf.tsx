import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Trash2, UserCheck, X } from 'lucide-react';
import NeonCard from './NeonCard';
import NeonButton from './NeonButton';
import ConfirmModal from './ConfirmModal';
import MemberAdminPicker, { type PickableMember } from './MemberAdminPicker';
import { PlayerAvatar } from './ScoreboardComponents';
import { useToast } from './Toast';
import { api } from '../lib/api';
import { compareByRank } from '../lib/searchRank';

/**
 * Admin pick controls on behalf of a player (v2.121.0).
 *
 * Owner ask (2026-08-20): "admins should be able to override the winner pick
 * and do a table pick manually — 'I won't be around to pick but I want
 * Medieval Madness if I win', admins can make that selection for him."
 *
 * Two panels over one selected (tournament, player) pair:
 *   1. **Queue a game** — the on-behalf twin of the player's own Picks-page
 *      queue flow. POSTs to the admin queue endpoint, which runs the SAME
 *      eligibility pipeline (`PickQueueService`) the player path runs, so the
 *      server is the authority on cooldown/rules/cap; the cooldown labels
 *      here are advisory only.
 *   2. **If they win next…** — the disposition-on-behalf controls. The
 *      endpoints (`PUT/DELETE .../admin/tournaments/:id/pick-disposition`)
 *      and the `/nominate-picker set|clear` slash subcommands have existed
 *      since the next-win-disposition arc; until now they had NO web UI at
 *      all, so an admin relaying "give my pick to Dave" had to use Discord.
 */

export interface AdminPickTournament {
  id: string;
  name: string;
}

interface AvailabilityGame {
  name: string;
  available: boolean;
  daysUntilAvailable: number;
}

interface QueuedRow {
  id: string;
  name: string;
  queue_order: number | null;
  tournament_id: string;
}

type Disposition = 'nominate' | 'forfeit' | 'auto';

interface DispositionState {
  disposition: Disposition;
  nomineeDiscordId: string | null;
}

interface Props {
  roomId: string;
  tournaments: AdminPickTournament[];
}

/** A room member id that Discord can actually DM / mention. */
const isDiscordSnowflake = (id: string) => /^\d{5,25}$/.test(id);

export default function AdminPickOnBehalf({ roomId, tournaments }: Props) {
  const { toast } = useToast();

  const [tournamentId, setTournamentId] = useState<string>('');
  const [members, setMembers] = useState<PickableMember[]>([]);
  const [player, setPlayer] = useState<PickableMember | null>(null);

  const [games, setGames] = useState<AvailabilityGame[]>([]);
  const [gameQuery, setGameQuery] = useState('');
  const [queue, setQueue] = useState<QueuedRow[]>([]);
  const [queueing, setQueueing] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<QueuedRow | null>(null);

  const [disposition, setDisposition] = useState<DispositionState | null>(null);
  const [dispositionBusy, setDispositionBusy] = useState(false);
  const [showNomineePicker, setShowNomineePicker] = useState(false);

  useEffect(() => {
    if (tournaments.length > 0 && !tournamentId) setTournamentId(tournaments[0]!.id);
  }, [tournaments, tournamentId]);

  useEffect(() => {
    api.get<PickableMember[]>(`/rooms/${roomId}/admin/members`)
      .then(rows => setMembers(rows.map(m => ({
        userId: String(m.userId),
        displayName: m.displayName ?? null,
        avatarHash: m.avatarHash ?? null,
        avatarUrl: m.avatarUrl ?? null,
      }))))
      .catch(() => setMembers([]));
  }, [roomId]);

  // The tournament's pick list — same payload the public Picks page reads, so
  // an admin sees exactly the games the player would see.
  useEffect(() => {
    if (!tournamentId) { setGames([]); return; }
    api.get<{ games: AvailabilityGame[] }>(`/rooms/${roomId}/game-availability/${tournamentId}`)
      .then(data => setGames(data.games ?? []))
      .catch(() => setGames([]));
  }, [roomId, tournamentId]);

  const refreshQueue = useCallback(() => {
    if (!tournamentId || !player) { setQueue([]); return; }
    api.get<{ queue: QueuedRow[] }>(`/rooms/${roomId}/admin/tournaments/${tournamentId}/queue/${encodeURIComponent(player.userId)}`)
      .then(data => setQueue(data.queue ?? []))
      .catch(() => setQueue([]));
  }, [roomId, tournamentId, player]);

  useEffect(() => { refreshQueue(); }, [refreshQueue]);

  const refreshDisposition = useCallback(() => {
    if (!tournamentId || !player) { setDisposition(null); return; }
    api.get<{ disposition: DispositionState | null }>(
      `/rooms/${roomId}/admin/tournaments/${tournamentId}/pick-disposition/${encodeURIComponent(player.userId)}`,
    )
      .then(data => setDisposition(data.disposition ?? null))
      // A read failure must not block the WRITE controls below — start from
      // "no disposition" and let the admin set one.
      .catch(() => setDisposition(null));
  }, [roomId, tournamentId, player]);

  useEffect(() => { refreshDisposition(); }, [refreshDisposition]);

  const filteredGames = useMemo(() => {
    const q = gameQuery.trim().toLowerCase();
    const queued = new Set(queue.map(g => g.name.toLowerCase()));
    const list = games.filter(g => !queued.has(g.name.toLowerCase()) && (!q || g.name.toLowerCase().includes(q)));
    if (q) list.sort(compareByRank(q, g => g.name));
    return list.slice(0, 12);
  }, [games, gameQuery, queue]);

  const nomineeCandidates = useMemo(
    () => members.filter(m => isDiscordSnowflake(m.userId) && m.userId !== player?.userId),
    [members, player],
  );

  const playerLabel = player ? (player.displayName || player.userId) : '';

  const handleQueue = async (gameName: string) => {
    if (!player || !tournamentId) return;
    setQueueing(gameName);
    try {
      const res = await api.post<{ game: { name: string }; tournament: { name: string }; queue: QueuedRow[] }>(
        `/rooms/${roomId}/admin/tournaments/${tournamentId}/queue`,
        { forUserId: player.userId, gameName },
      );
      setQueue(res.queue ?? []);
      setGameQuery('');
      toast(`Queued ${res.game.name} for ${playerLabel} in ${res.tournament.name}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to queue that game', 'error');
    } finally {
      setQueueing(null);
    }
  };

  const handleRemove = async (row: QueuedRow) => {
    setRemoveTarget(null);
    try {
      const res = await api.delete<{ queue?: QueuedRow[] }>(
        `/rooms/${roomId}/admin/tournaments/${tournamentId}/queue/${row.id}`,
      );
      setQueue(res.queue ?? []);
      toast(`Removed ${row.name} from ${playerLabel}'s queue`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to remove that game', 'error');
      refreshQueue();
    }
  };

  const saveDisposition = async (next: Disposition, nomineeDiscordId?: string) => {
    if (!player || !tournamentId) return;
    setDispositionBusy(true);
    try {
      const res = await api.put<{ disposition: DispositionState }>(
        `/rooms/${roomId}/admin/tournaments/${tournamentId}/pick-disposition`,
        { forUserId: player.userId, disposition: next, ...(nomineeDiscordId ? { nomineeDiscordId } : {}) },
      );
      setDisposition(res.disposition);
      setShowNomineePicker(false);
      toast('Saved.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save', 'error');
    } finally {
      setDispositionBusy(false);
    }
  };

  const clearDisposition = async () => {
    if (!player || !tournamentId) return;
    setDispositionBusy(true);
    try {
      await api.delete(`/rooms/${roomId}/admin/tournaments/${tournamentId}/pick-disposition/${encodeURIComponent(player.userId)}`);
      setDisposition(null);
      setShowNomineePicker(false);
      toast('Back to using their own queue.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to clear', 'error');
    } finally {
      setDispositionBusy(false);
    }
  };

  if (tournaments.length === 0) return null;

  return (
    <NeonCard className="mb-4" title="Pick on behalf of a player">
      <p className="text-xs text-muted mb-4">
        For the player who says "I won't be around to pick, but I want Medieval Madness if I win."
        Queued games only activate if that player wins a round — nothing starts immediately.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <label className="flex-1 min-w-0">
          <span className="text-xs text-faint block mb-1">Tournament</span>
          <select
            value={tournamentId}
            onChange={e => setTournamentId(e.target.value)}
            aria-label="Tournament"
            className="w-full min-h-[44px] bg-raised border border-border rounded px-3 text-sm text-primary focus:outline-none focus:border-neon-cyan cursor-pointer"
          >
            {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      </div>

      {!player ? (
        <MemberAdminPicker
          members={members}
          excludeIds={new Set()}
          onSelect={setPlayer}
          label="Choose a player"
          emptyMembersText="No room members yet — nobody to pick for."
          allExcludedText="No room members yet — nobody to pick for."
        />
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4 p-2 rounded border border-neon-cyan/30 bg-neon-cyan/5">
            <PlayerAvatar
              username={playerLabel}
              discordUserId={player.userId}
              avatarHash={player.avatarHash}
              avatarUrl={player.avatarUrl}
              size={28}
            />
            <span className="text-sm text-primary truncate flex-1" data-testid="on-behalf-player">{playerLabel}</span>
            <button
              type="button"
              onClick={() => { setPlayer(null); setGameQuery(''); }}
              aria-label="Choose a different player"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted hover:text-primary cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          {/* --- Queue a game --- */}
          <div className="mb-6">
            <h4 className="font-display text-xs uppercase tracking-wider text-neon-cyan mb-2">Queue a game</h4>
            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
              <input
                type="text"
                value={gameQuery}
                onChange={e => setGameQuery(e.target.value)}
                placeholder="Search the pick list…"
                aria-label="Search games"
                className="w-full min-h-[44px] pl-8 pr-3 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
              />
            </div>
            <div className="max-h-56 overflow-y-auto border border-border rounded divide-y divide-border/40" data-testid="on-behalf-game-list">
              {filteredGames.length === 0 ? (
                <p className="text-faint text-xs px-3 py-2">
                  {games.length === 0 ? 'No games in this tournament’s pick list.' : 'No games match that search.'}
                </p>
              ) : filteredGames.map(g => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => handleQueue(g.name)}
                  disabled={queueing !== null}
                  className="w-full min-h-[44px] flex items-center gap-3 px-3 py-2 text-left hover:bg-border/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <span className="text-sm text-primary truncate flex-1">{g.name}</span>
                  {!g.available && (
                    <span className="text-[10px] text-neon-amber flex-shrink-0">
                      cooldown {g.daysUntilAvailable}d
                    </span>
                  )}
                  {queueing === g.name && <span className="text-xs text-faint flex-shrink-0">Queueing…</span>}
                </button>
              ))}
            </div>
          </div>

          {/* --- Their current queue --- */}
          <div className="mb-6">
            <h4 className="font-display text-xs uppercase tracking-wider text-neon-cyan mb-2">
              {playerLabel}&rsquo;s queue ({queue.length}/5)
            </h4>
            {queue.length === 0 ? (
              <p className="text-faint text-xs">Nothing queued for this tournament.</p>
            ) : (
              <ul className="space-y-1" data-testid="on-behalf-queue">
                {queue.map((row, i) => (
                  <li key={row.id} className="flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-raised">
                    <span className="text-xs text-faint w-5 flex-shrink-0">{i + 1}.</span>
                    <span className="text-sm text-primary truncate flex-1">{row.name}</span>
                    <button
                      type="button"
                      onClick={() => setRemoveTarget(row)}
                      aria-label={`Remove ${row.name} from the queue`}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --- Disposition on behalf --- */}
          <div>
            <h4 className="font-display text-xs uppercase tracking-wider text-neon-cyan mb-2">If they win next…</h4>
            <p className="text-xs text-muted mb-2">
              {disposition === null
                ? 'Currently: use their own queue (the default).'
                : disposition.disposition === 'nominate'
                  ? `Currently: their pick goes to ${members.find(m => m.userId === disposition.nomineeDiscordId)?.displayName ?? disposition.nomineeDiscordId}.`
                  : disposition.disposition === 'forfeit'
                    ? 'Currently: their pick is forfeited to the runner-up.'
                    : 'Currently: Arcaid rolls the dice and picks for them.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <NeonButton
                variant="secondary"
                disabled={dispositionBusy}
                onClick={() => setShowNomineePicker(v => !v)}
                className="min-h-[44px]"
              >
                <UserCheck size={14} className="inline mr-1.5" />
                Give their pick to…
              </NeonButton>
              <NeonButton variant="secondary" disabled={dispositionBusy} onClick={() => saveDisposition('forfeit')} className="min-h-[44px]">
                Forfeit to runner-up
              </NeonButton>
              <NeonButton variant="secondary" disabled={dispositionBusy} onClick={() => saveDisposition('auto')} className="min-h-[44px]">
                Roll the dice
              </NeonButton>
              {disposition !== null && (
                <NeonButton variant="ghost" disabled={dispositionBusy} onClick={clearDisposition} className="min-h-[44px]">
                  Back to their queue
                </NeonButton>
              )}
            </div>

            {showNomineePicker && (
              <div className="mt-3">
                <MemberAdminPicker
                  members={nomineeCandidates}
                  excludeIds={new Set()}
                  onSelect={m => saveDisposition('nominate', m.userId)}
                  label="Hand their pick to"
                  emptyMembersText="No other Discord members in this room yet."
                  allExcludedText="No other Discord members in this room yet."
                />
              </div>
            )}
          </div>
        </>
      )}

      {removeTarget && (
        <ConfirmModal
          title="Remove from queue"
          message={`Remove "${removeTarget.name}" from ${playerLabel}'s queue for this tournament?`}
          confirmLabel="Remove"
          onConfirm={() => handleRemove(removeTarget)}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </NeonCard>
  );
}
