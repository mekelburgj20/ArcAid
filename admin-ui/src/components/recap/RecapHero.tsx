import GameArt from '../GameArt';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import { formatScore } from '../../lib/format';
import { formatDuration } from '../../lib/recapFormat';
import type { RunRecap } from '../../lib/runRecapTypes';

function dayRange(from: string | null, to: string | null): string | null {
  const fmt = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const a = fmt(from);
  const b = fmt(to);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a ?? b;
}

/** The winner's sentence facts as a caption: "Game #22 of 22 · about 7 hours before the close". */
function heroCaption(recap: RunRecap): string | null {
  const { hero, run } = recap;
  const parts: string[] = [];
  if (hero.best_source === 'other') parts.push('Typed in');
  else if (hero.winning_game_no != null) {
    parts.push(hero.winner_games != null ? `Game #${hero.winning_game_no} of ${hero.winner_games}` : `Game #${hero.winning_game_no}`);
  }
  if (run.state === 'completed' && hero.ms_before_close != null && hero.ms_before_close >= 0) {
    parts.push(`${formatDuration(hero.ms_before_close)} before the close`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export default function RecapHero({ recap }: { recap: RunRecap }) {
  const { run, hero, players } = recap;
  const winner = players.find(p => p.key === hero.winner_key) ?? null;
  const range = dayRange(run.start_date, run.end_date);
  const caption = heroCaption(recap);
  return (
    <div className="flex items-start gap-4" data-testid="recap-hero">
      <GameArt src={run.image_url} name={run.game_name} size={112} mobileSize={84} />
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <h2 className="m-0 break-words font-display font-bold text-xl sm:text-2xl leading-tight text-primary">
          {run.game_name}
        </h2>
        <p className="m-0 text-xs text-faint break-words">
          {run.tournament_name}{run.round_no != null ? ` · Round ${run.round_no}` : ''}{range ? ` · ${range}` : ''}
        </p>
        {winner && hero.best != null ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <PlayerAvatar
              username={winner.iscored_username}
              discordUserId={winner.discord_user_id}
              avatarHash={winner.avatar_hash}
              avatarUrl={winner.avatar_url}
              size={36}
            />
            <span className="min-w-0 break-words text-base font-medium text-neon-amber">
              {playerName(winner)}
              <span className="sr-only">{run.state === 'active' ? ' leads' : ' won'}</span>
            </span>
            <span className="tabular-nums font-display font-bold text-lg text-neon-amber" title={formatScore(hero.best)}>
              {formatScore(hero.best)}
            </span>
          </div>
        ) : (
          <p className="m-0 mt-1 text-sm text-faint">No scores yet</p>
        )}
        {caption && <p className="m-0 text-sm text-muted" data-testid="hero-caption">{caption}</p>}
      </div>
    </div>
  );
}
