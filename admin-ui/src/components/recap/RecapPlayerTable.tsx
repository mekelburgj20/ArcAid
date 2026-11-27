import { useMemo, useState } from 'react';
import { formatScore } from '../../lib/format';
import { formatRecapScore } from '../../lib/recapFormat';
import type { RecapPlayerRow } from '../../lib/runRecapTypes';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';

type Col = 'rank' | 'games' | 'average' | 'median' | 'best';
const COLS: Array<{ id: Exclude<Col, 'rank'>; label: string }> = [
  { id: 'games', label: 'Games' },
  { id: 'average', label: 'Avg' },
  { id: 'median', label: 'Median' },
  { id: 'best', label: 'Best' },
];

const REASON = {
  none: 'Typed in or synced only',
  hidden: 'Keeps play stats private',
} as const;
const MARK = { none: '†', hidden: '‡' } as const;

function cell(p: RecapPlayerRow, col: Exclude<Col, 'rank'>) {
  const v = p[col];
  if (v == null) {
    const reason = p.play_stats === 'hidden' ? REASON.hidden : REASON.none;
    const mark = p.play_stats === 'hidden' ? MARK.hidden : MARK.none;
    return <span title={reason} aria-label={reason}>{'—'}<span className="text-xs">{mark}</span></span>;
  }
  if (col === 'games') return String(v);
  return <span title={formatScore(v)}>{formatRecapScore(v)}</span>;
}

/** Sortable player table; a row opens that player's run detail. Nulls sort last whichever way. */
export default function RecapPlayerTable({ players, onOpen }: {
  players: RecapPlayerRow[];
  onOpen: (key: string) => void;
}) {
  const [sort, setSort] = useState<{ col: Col; dir: 'asc' | 'desc' }>({ col: 'rank', dir: 'asc' });

  const rows = useMemo(() => {
    const out = [...players];
    const { col, dir } = sort;
    out.sort((a, b) => {
      const av = col === 'rank' ? a.rank : a[col];
      const bv = col === 'rank' ? b.rank : b[col];
      if (av == null && bv == null) return a.rank - b.rank;
      if (av == null) return 1;
      if (bv == null) return -1;
      const d = av === bv ? a.rank - b.rank : (dir === 'asc' ? av - bv : bv - av);
      return d;
    });
    return out;
  }, [players, sort]);

  const press = (col: Col) =>
    setSort(prev => prev.col === col
      ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: col === 'rank' ? 'asc' : 'desc' });
  const ariaSort = (col: Col): 'ascending' | 'descending' | 'none' =>
    sort.col === col ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = (col: Col) => (sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const hasNone = players.some(p => p.play_stats === 'none');
  const hasHidden = players.some(p => p.play_stats === 'hidden');

  return (
    <div data-testid="recap-player-table">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-faint">
              <th scope="col" aria-sort={ariaSort('rank')} className="py-1.5 pr-1 font-medium">
                <button type="button" onClick={() => press('rank')} className="part-focus cursor-pointer text-faint hover:text-primary">
                  Player{arrow('rank')}
                </button>
              </th>
              {COLS.map(c => (
                <th key={c.id} scope="col" aria-sort={ariaSort(c.id)} className="py-1.5 px-1 text-right font-medium">
                  <button type="button" onClick={() => press(c.id)} className="part-focus cursor-pointer text-faint hover:text-primary">
                    {c.label}{arrow(c.id)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr
                key={p.key}
                data-testid="recap-player-row"
                onClick={() => onOpen(p.key)}
                className="border-t border-border/40 cursor-pointer hover:bg-raised"
              >
                <th scope="row" className="py-2 pr-1 text-left font-normal">
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); onOpen(p.key); }}
                    className="part-focus flex items-center gap-2 min-w-0 text-left cursor-pointer"
                  >
                    <span className="w-5 flex-shrink-0 text-faint tabular-nums">{p.rank}</span>
                    <PlayerAvatar
                      username={p.iscored_username}
                      discordUserId={p.discord_user_id}
                      avatarHash={p.avatar_hash}
                      avatarUrl={p.avatar_url}
                      size={24}
                    />
                    <span className={`min-w-0 break-words ${p.rank === 1 ? 'text-neon-amber font-medium' : 'text-primary'}`}>
                      {playerName(p)}
                    </span>
                  </button>
                </th>
                {COLS.map(c => (
                  <td
                    key={c.id}
                    className={`py-2 px-1 text-right tabular-nums whitespace-nowrap ${c.id === 'best' ? (p.rank === 1 ? 'text-neon-amber font-medium' : 'text-primary font-medium') : 'text-muted'}`}
                  >
                    {cell(p, c.id)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(hasNone || hasHidden) && (
        <p className="m-0 mt-2 text-xs text-faint">
          {hasNone && <span className="mr-3">{MARK.none} {REASON.none}</span>}
          {hasHidden && <span>{MARK.hidden} {REASON.hidden}</span>}
        </p>
      )}
    </div>
  );
}
