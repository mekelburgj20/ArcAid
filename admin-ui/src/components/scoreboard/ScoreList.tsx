import type { RankedEntry } from '../ScoreboardComponents';

interface ScoreListProps {
  entries: RankedEntry[];
  fontFamily?: string;
  monoFontFamily?: string;
  zebraStripe?: string;
  hoverBorder?: string;
  rankColor?: string;
  nameColor?: string;
  scoreColor?: string;
  avatarBg?: string;
  avatarBorder?: string;
  avatarColor?: string;
}

function initials(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9 ]/g, '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatScore(score: number): string {
  if (score >= 1_000_000_000_000) return `${(score / 1_000_000_000_000).toFixed(1)}T`;
  return score.toLocaleString();
}

export default function ScoreList({
  entries,
  fontFamily,
  monoFontFamily,
  zebraStripe = 'rgba(255,255,255,0.015)',
  hoverBorder,
  rankColor = 'rgba(255,255,255,0.18)',
  nameColor = 'rgba(255,255,255,0.45)',
  scoreColor = 'rgba(255,255,255,0.2)',
  avatarBg = 'rgba(255,255,255,0.04)',
  avatarBorder,
  avatarColor = 'rgba(255,255,255,0.2)',
}: ScoreListProps) {
  if (entries.length === 0) return null;

  return (
    <div style={{ padding: '0 14px 10px' }}>
      {entries.map((entry, i) => (
        <div
          key={`${entry.rank}-${entry.iscored_username}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '5px 10px',
            borderRadius: '4px',
            marginBottom: '1px',
            borderLeft: '2px solid transparent',
            background: i % 2 === 0 ? zebraStripe : 'transparent',
            ...(hoverBorder ? { transition: 'border-color 0.15s' } : {}),
          }}
          onMouseEnter={hoverBorder ? (e) => { (e.currentTarget as HTMLElement).style.borderLeftColor = hoverBorder; } : undefined}
          onMouseLeave={hoverBorder ? (e) => { (e.currentTarget as HTMLElement).style.borderLeftColor = 'transparent'; } : undefined}
        >
          {/* Rank */}
          <span style={{
            fontFamily: monoFontFamily,
            fontSize: '11px',
            fontWeight: 600,
            width: '20px',
            textAlign: 'right',
            color: rankColor,
          }}>
            {entry.rank}
          </span>

          {/* Avatar */}
          <div style={{
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            background: avatarBg,
            border: avatarBorder || 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '7px',
            color: avatarColor,
            fontWeight: 600,
            flexShrink: 0,
            fontFamily: monoFontFamily,
          }}>
            {initials(entry.iscored_username)}
          </div>

          {/* Name */}
          <span style={{
            flex: 1,
            fontSize: '13px',
            color: nameColor,
            fontFamily: fontFamily || monoFontFamily,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {entry.iscored_username}
          </span>

          {/* Score */}
          <span
            style={{
              fontSize: '12px',
              color: scoreColor,
              fontFamily: monoFontFamily,
              fontWeight: 700,
              whiteSpace: 'nowrap',
            }}
            title={entry.score >= 1_000_000_000_000 ? entry.score.toLocaleString() : undefined}
          >
            {formatScore(entry.score)}
          </span>
        </div>
      ))}
    </div>
  );
}
