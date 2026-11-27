import { useEffect, useState } from 'react';
import Dialog from '../parts/Dialog';
import { SkeletonRows } from '../parts/Skeleton';
import LoadFailedNotice from '../LoadFailedNotice';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import { useRetryingLoad } from '../../hooks/useRetryingLoad';
import { formatScore } from '../../lib/format';
import { formatRecapDay, formatRecapScore } from '../../lib/recapFormat';
import { roomFetch } from '../../lib/roomFetch';
import type { RecapPlayerDetail, RecapPlayerRow } from '../../lib/runRecapTypes';

const GAME_ROWS_SHOWN = 50;

function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? 'a' : 'p'}`;
}

/** One player's run: bar strip of their Witness games (by index, not time), games, sessions, hours. */
export default function PlayerRunDetail({ roomId, gameId, player, open, onClose, maxAttempts = null }: {
  roomId: string;
  gameId: string;
  player: RecapPlayerRow;
  open: boolean;
  onClose: () => void;
  maxAttempts?: number | null;
}) {
  const [loaded, setLoaded] = useState<{ key: string; detail: RecapPlayerDetail } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { load, phase } = useRetryingLoad(
    () => roomFetch(`/api/rooms/${roomId}/runs/${encodeURIComponent(gameId)}/recap/players/${encodeURIComponent(player.key)}`),
    async res => {
      const json = await res.json() as RecapPlayerDetail;
      if (!json || !Array.isArray(json.games) || !Array.isArray(json.sessions)) throw new Error('bad shape');
      setLoaded({ key: player.key, detail: json });
    },
    `${gameId}:${player.key}`,
  );

  useEffect(() => {
    if (open && player.play_stats === 'shown') load();
  }, [open, load, player.play_stats]);

  const detail = loaded && loaded.key === player.key ? loaded.detail : null;
  const shown = player.play_stats === 'shown';
  const name = playerName(player);
  const games = detail?.games ?? [];
  const witnessGames = games.filter(g => g.n != null);
  const maxScore = Math.max(1, ...witnessGames.map(g => g.score));
  const listed = showAll ? games : games.slice(0, GAME_ROWS_SHOWN);

  return (
    <Dialog
      open={open}
      onOpenChange={o => { if (!o) onClose(); }}
      sheet
      label="Run detail"
      title={name}
    >
      <div className="flex flex-col gap-4" data-testid="player-run-detail">
        <div className="flex items-center gap-3">
          <PlayerAvatar
            username={player.iscored_username}
            discordUserId={player.discord_user_id}
            avatarHash={player.avatar_hash}
            avatarUrl={player.avatar_url}
            size={40}
          />
          <div className="min-w-0">
            <div className="text-lg font-display font-bold tabular-nums" title={formatScore(player.best)}>
              {formatScore(player.best)}
            </div>
            <div className="text-sm text-muted">Finished #{player.rank}</div>
            {shown && player.games != null && player.average != null && player.median != null && (
              <div className="text-sm text-muted" data-testid="player-summary">
                {player.games} {player.games === 1 ? 'game' : 'games'} · avg {formatRecapScore(player.average)} · median {formatRecapScore(player.median)}
              </div>
            )}
          </div>
        </div>

        {!shown && (
          <p className="m-0 text-sm text-muted">
            {player.play_stats === 'hidden'
              ? 'This player keeps play stats private. Their best score and finish are public.'
              : 'Typed in or synced scores only, so there are no games to show.'}
          </p>
        )}

        {shown && phase === 'loading' && <SkeletonRows count={3} label="Loading the player's games" />}
        {shown && phase === 'retrying' && <LoadFailedNotice what="this player's games" onRetry={load} className="py-6" />}

        {shown && detail && (
          <>
            {player.attempts_used != null && maxAttempts != null && (
              <p className="m-0 text-sm text-muted">{player.attempts_used} of {maxAttempts} attempts</p>
            )}

            {witnessGames.length > 0 && (
              <section>
                <h4 className="m-0 mb-1.5 text-xs uppercase tracking-wider text-faint font-medium">Games, in order</h4>
                <div
                  className="flex items-end gap-px h-16 overflow-hidden"
                  role="img"
                  aria-label={`${witnessGames.length} games in order; personal bests and the best game are marked in the list below`}
                  data-testid="game-bars"
                >
                  {witnessGames.map(g => (
                    <span
                      key={g.n}
                      className={`flex-1 min-w-px rounded-t-sm ${g.is_best ? 'bg-neon-amber' : g.is_pb ? 'bg-neon-cyan' : 'bg-neon-cyan/35'}`}
                      style={{ height: `${Math.max(4, (g.score / maxScore) * 100)}%` }}
                    />
                  ))}
                </div>
                <p className="m-0 mt-1 text-xs text-faint">Bright bars are personal bests, gold is the best game.</p>
              </section>
            )}

            {games.length > 0 && (
              <section>
                <ol className="m-0 p-0 list-none flex flex-col gap-1" data-testid="game-list">
                  {listed.map((g, i) => (
                    <li key={`${g.n ?? 'x'}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="text-faint tabular-nums">{g.n != null ? `Game ${g.n}` : 'Typed in'}</span>
                      <span
                        className={`tabular-nums font-medium ${g.is_best ? 'text-neon-amber' : 'text-primary'}`}
                        title={formatScore(g.score)}
                      >
                        {formatRecapScore(g.score)}
                      </span>
                      <span className="text-muted">
                        {formatRecapDay(g.day)}{g.time ? ` ${g.time}` : ''}
                      </span>
                      {g.is_pb && <span className="text-xs text-neon-cyan">PB</span>}
                      {g.is_best && <span className="text-xs text-neon-amber">Best</span>}
                    </li>
                  ))}
                </ol>
                {games.length > GAME_ROWS_SHOWN && !showAll && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="part-focus mt-2 text-sm text-neon-cyan cursor-pointer"
                  >
                    Show all {games.length} games
                  </button>
                )}
              </section>
            )}

            {detail.sessions.length > 0 && (
              <section>
                <h4 className="m-0 mb-1.5 text-xs uppercase tracking-wider text-faint font-medium">Sessions</h4>
                <ul className="m-0 p-0 list-none flex flex-col gap-1" data-testid="session-list">
                  {detail.sessions.map(s => (
                    <li key={s.n} className="text-sm text-muted">
                      <span className="text-primary">Session {s.n}</span>
                      {' · '}{s.games} {s.games === 1 ? 'game' : 'games'}
                      {' · '}{s.minutes} min
                      {' · best '}<span title={formatScore(s.best)}>{formatRecapScore(s.best)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.hours && (
              <section>
                <h4 className="m-0 mb-1.5 text-xs uppercase tracking-wider text-faint font-medium">Games by hour</h4>
                <div className="flex items-end gap-px h-12" data-testid="hour-bars">
                  {detail.hours.map((n, h) => (
                    <span
                      key={h}
                      title={`${hourLabel(h)}: ${n}`}
                      className="flex-1 bg-neon-purple rounded-t-sm"
                      style={{ height: `${Math.max(n > 0 ? 6 : 1, (n / Math.max(1, ...detail.hours!)) * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-xs text-faint mt-1">
                  <span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
