import { Plus, Minus, BadgeCheck } from 'lucide-react';
import type { RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import FitRowName from './FitRowName';
import PlayerNameLink from '../PlayerNameLink';
import type { ScoreHistoryEntry } from './useScoreExpand';
import { formatScore } from '../../lib/format';

interface ScoreListProps {
  entries: RankedEntry[];
  /** v2.2.10: required for username → player-stats Link. */
  slug?: string;
  fontFamily?: string;
  monoFontFamily?: string;
  zebraStripe?: string;
  hoverBorder?: string;
  rankColor?: string;
  nameColor?: string;
  scoreColor?: string;
  /**
   * Holo-steps runners-up treatment (owner podium handoff 2026-08-13): every
   * row is a quiet glass chip — uniform translucent background + hairline
   * border + blur — instead of the zebra stripe. Opt-in; all other consumers
   * render exactly as before.
   */
  glassRows?: boolean;
  // Score expand
  hasMultiple?: (username: string) => boolean;
  expandedPlayer?: string | null;
  playerHistory?: ScoreHistoryEntry[];
  historyLoading?: boolean;
  onTogglePlayer?: (username: string) => void;
}

export default function ScoreList({
  entries,
  slug,
  fontFamily,
  monoFontFamily,
  zebraStripe = 'rgba(255,255,255,0.015)',
  glassRows = false,
  hoverBorder,
  rankColor = 'rgba(255,255,255,0.18)',
  nameColor = 'rgba(255,255,255,0.45)',
  scoreColor = 'rgba(255,255,255,0.2)',
  hasMultiple,
  expandedPlayer,
  playerHistory,
  historyLoading,
  onTogglePlayer,
}: ScoreListProps) {
  if (entries.length === 0) return null;

  return (
    <div style={{ padding: '0 14px 10px' }}>
      {entries.map((entry, i) => {
        const canExpand = hasMultiple?.(entry.iscored_username) ?? false;
        const isExpanded = expandedPlayer === entry.iscored_username;

        return (
          <div key={`${entry.rank}-${entry.iscored_username}`}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 10px',
                borderRadius: glassRows ? '6px' : '4px',
                marginBottom: glassRows ? '3px' : '1px',
                ...(glassRows
                  ? {
                      background: 'color-mix(in srgb, var(--color-deep, #080a10) 55%, transparent)',
                      backdropFilter: 'blur(6px)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }
                  : {
                      borderLeft: '2px solid transparent',
                      background: i % 2 === 0 ? zebraStripe : 'transparent',
                    }),
                ...(hoverBorder ? { transition: 'border-color 0.15s' } : {}),
                ...(canExpand ? { cursor: 'pointer', pointerEvents: 'auto' } : {}),
              }}
              onClick={canExpand ? () => onTogglePlayer?.(entry.iscored_username) : undefined}
              onMouseEnter={hoverBorder ? (e) => { (e.currentTarget as HTMLElement).style.borderLeftColor = hoverBorder; } : undefined}
              onMouseLeave={hoverBorder ? (e) => { (e.currentTarget as HTMLElement).style.borderLeftColor = 'transparent'; } : undefined}
              role={canExpand ? 'button' : undefined}
              tabIndex={canExpand ? 0 : undefined}
              aria-expanded={canExpand ? isExpanded : undefined}
              onKeyDown={canExpand ? (e) => {
                // m3: ignore keydowns bubbled from a focused child (e.g. the
                // player-name Link) — only toggle when the row itself is focused.
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTogglePlayer?.(entry.iscored_username);
                }
              } : undefined}
            >
              {/* Rank. S21 — sb-fs-11 gives this a 12px mobile floor
                  (readable now that mobileScale defaults to 1.0/no-shrink). */}
              <span className="sb-fs-11" style={{
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
              <PlayerAvatar
                username={playerName(entry)}
                discordUserId={entry.discord_user_id}
                avatarHash={entry.avatar_hash}
                avatarUrl={entry.avatar_url}
                size={20}
              />

              {/* Name — v2.13.16: PlayerNameLink opens quick-view modal on
                  click; modifier-click falls through to full page. */}
              {/* FitRowName owns the clamp (flex:1) and scales an overlong
                  name down to fit one line — no wrap, no ellipsis. */}
              {slug ? (
                <FitRowName origin="left" className="sb-row-name" style={{ flex: 1, fontSize: '13px' }}>
                  <PlayerNameLink
                    slug={slug}
                    entry={entry}
                    onClick={e => e.stopPropagation()}
                    style={{
                      color: nameColor,
                      fontFamily: fontFamily || monoFontFamily,
                      textDecoration: 'none',
                      pointerEvents: 'auto',
                    }}
                  />
                </FitRowName>
              ) : (
                <FitRowName origin="left" className="sb-row-name" style={{ flex: 1, fontSize: '13px' }}>
                  <span style={{
                    color: nameColor,
                    fontFamily: fontFamily || monoFontFamily,
                  }}>
                    {playerName(entry)}
                  </span>
                </FitRowName>
              )}

              {/* Verified checkmark */}
              {entry.verified && (
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--color-neon-green, #00ff88)', flexShrink: 0 }}
                  title="Verified by an admin"
                  aria-label="Verified score"
                >
                  <BadgeCheck size={12} />
                </span>
              )}

              {/* Score */}
              <span
                className="sb-row-score"
                style={{
                  fontSize: '12px',
                  color: scoreColor,
                  fontFamily: monoFontFamily,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
                title={formatScore(entry.score).endsWith('T') ? entry.score.toLocaleString() : undefined}
              >
                {formatScore(entry.score)}
              </span>

              {/* Expand icon */}
              {canExpand && (
                isExpanded
                  ? <Minus size={11} style={{ color: 'var(--color-neon-cyan, #00e5ff)', flexShrink: 0 }} />
                  : <Plus size={11} style={{ color: rankColor, flexShrink: 0 }} />
              )}
            </div>

            {/* Expanded history */}
            {isExpanded && (
              <div style={{ marginLeft: 40, marginRight: 10, padding: '4px 8px', background: 'rgba(0,0,0,0.3)', borderRadius: 4, marginBottom: 2 }}>
                {historyLoading ? (
                  <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', margin: '2px 0' }}>Loading...</p>
                ) : (playerHistory && playerHistory.length > 0) ? (
                  <div>
                    {playerHistory.map(h => (
                      <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '1px 0' }}>
                        <span style={{ color: 'rgba(255,255,255,0.5)' }}>{h.score.toLocaleString()}</span>
                        <span style={{ color: 'rgba(255,255,255,0.25)' }}>{new Date(h.created_at).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', margin: '2px 0' }}>No additional scores.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
