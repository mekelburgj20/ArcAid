import { Plus, Minus } from 'lucide-react';
import type { RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar } from '../ScoreboardComponents';
import type { ShowcaseThemeConfig } from '../../lib/scoreboardThemes';
import type { ScoreHistoryEntry } from './useScoreExpand';

interface ShowcasePodiumProps {
  entries: RankedEntry[];  // top 3 (or fewer)
  theme: ShowcaseThemeConfig;
  hasMultiple?: (username: string) => boolean;
  expandedPlayer?: string | null;
  playerHistory?: ScoreHistoryEntry[];
  historyLoading?: boolean;
  onTogglePlayer?: (username: string) => void;
}

function formatScore(score: number): string {
  if (score >= 1_000_000_000_000) return `${(score / 1_000_000_000_000).toFixed(1)}T`;
  return score.toLocaleString();
}

/** Shared expanded history panel rendered below a podium block */
function ExpandedHistory({ playerHistory, historyLoading, theme }: { playerHistory?: ScoreHistoryEntry[]; historyLoading?: boolean; theme: ShowcaseThemeConfig }) {
  return (
    <div style={{ margin: '4px 20px 8px', padding: '6px 10px', background: 'rgba(0,0,0,0.35)', borderRadius: 6 }}>
      {historyLoading ? (
        <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', margin: '2px 0' }}>Loading...</p>
      ) : (playerHistory && playerHistory.length > 0) ? (
        <div>
          {playerHistory.map(h => (
            <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: theme.monoFontFamily }}>{h.score.toLocaleString()}</span>
              <span style={{ color: 'rgba(255,255,255,0.25)' }}>{new Date(h.created_at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', margin: '2px 0' }}>No additional scores.</p>
      )}
    </div>
  );
}

function PyramidPodium({ entries, theme, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer }: ShowcasePodiumProps) {
  const [first, second, third] = entries;
  const configs = [
    { entry: first, pod: theme.podiumGold, avatarSize: 36, fontSize: 11, scoreSize: 12, nameClass: 'pn1', label: '1st', emoji: '\u{1F3C6}' },
    { entry: second, pod: theme.podiumSilver, avatarSize: 26, fontSize: 10, scoreSize: 10, nameClass: 'pnn', label: '2nd', emoji: '' },
    { entry: third, pod: theme.podiumBronze, avatarSize: 26, fontSize: 10, scoreSize: 10, nameClass: 'pnn', label: '3rd', emoji: '' },
  ];

  return (
    <div style={{ padding: '0 20px', marginBottom: '4px' }}>
      {/* Top — 1st place */}
      {first && (() => {
        const canExpand = hasMultiple?.(first.iscored_username) ?? false;
        const isExpanded = expandedPlayer === first.iscored_username;
        return (
          <>
            <div
              style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px', ...(canExpand ? { cursor: 'pointer' } : {}) }}
              onClick={canExpand ? () => onTogglePlayer?.(first.iscored_username) : undefined}
            >
              <div style={{
                width: '55%',
                borderRadius: '12px',
                textAlign: 'center',
                padding: '14px 10px 12px',
                background: configs[0]!.pod.bg,
                border: configs[0]!.pod.border,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', marginBottom: '6px' }}>
                  <span style={{ fontSize: '14px', lineHeight: 1 }}>{'\u{1F3C6}'}</span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: configs[0]!.pod.rankColor }}>1st</span>
                  {canExpand && (
                    isExpanded
                      ? <Minus size={10} style={{ color: 'var(--color-neon-cyan, #00e5ff)' }} />
                      : <Plus size={10} style={{ color: configs[0]!.pod.rankColor }} />
                  )}
                </div>
                <div style={{ margin: '0 auto 5px' }}>
                  <PlayerAvatar username={first.iscored_username} discordUserId={first.discord_user_id} avatarHash={first.avatar_hash} size={36} />
                </div>
                <div style={{
                  fontWeight: 600,
                  marginBottom: '2px',
                  color: configs[0]!.pod.textColor,
                  fontSize: 11,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {first.iscored_username}
                </div>
                <div style={{
                  fontWeight: 700,
                  fontFamily: theme.monoFontFamily,
                  color: configs[0]!.pod.scoreColor,
                  fontSize: 12,
                }}
                  title={first.score >= 1_000_000_000_000 ? first.score.toLocaleString() : undefined}
                >
                  {formatScore(first.score)}
                </div>
              </div>
            </div>
            {isExpanded && <ExpandedHistory playerHistory={playerHistory} historyLoading={historyLoading} theme={theme} />}
          </>
        );
      })()}

      {/* Bottom — 2nd and 3rd */}
      {(second || third) && (
        <>
          <div style={{ display: 'flex', gap: '8px' }}>
            {[second, third].map((entry, i) => {
              if (!entry) return <div key={i} style={{ flex: 1 }} />;
              const cfg = configs[i + 1]!;
              const canExpand = hasMultiple?.(entry.iscored_username) ?? false;
              const isExpanded = expandedPlayer === entry.iscored_username;
              return (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    borderRadius: '12px',
                    textAlign: 'center',
                    padding: '8px',
                    background: cfg.pod.bg,
                    border: cfg.pod.border,
                    ...(canExpand ? { cursor: 'pointer' } : {}),
                  }}
                  onClick={canExpand ? () => onTogglePlayer?.(entry.iscored_username) : undefined}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', marginBottom: '6px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: cfg.pod.rankColor }}>{cfg.label}</span>
                    {canExpand && (
                      isExpanded
                        ? <Minus size={9} style={{ color: 'var(--color-neon-cyan, #00e5ff)' }} />
                        : <Plus size={9} style={{ color: cfg.pod.rankColor }} />
                    )}
                  </div>
                  <div style={{ margin: '0 auto 5px' }}>
                    <PlayerAvatar username={entry.iscored_username} discordUserId={entry.discord_user_id} avatarHash={entry.avatar_hash} size={26} />
                  </div>
                  <div style={{
                    fontWeight: 600,
                    marginBottom: '2px',
                    color: cfg.pod.textColor,
                    fontSize: cfg.fontSize,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {entry.iscored_username}
                  </div>
                  <div style={{
                    fontWeight: 700,
                    fontFamily: theme.monoFontFamily,
                    color: cfg.pod.scoreColor,
                    fontSize: cfg.scoreSize,
                  }}
                    title={entry.score >= 1_000_000_000_000 ? entry.score.toLocaleString() : undefined}
                  >
                    {formatScore(entry.score)}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Expanded history for 2nd or 3rd (shown below the row) */}
          {[second, third].map((entry, i) => {
            if (!entry) return null;
            if (expandedPlayer !== entry.iscored_username) return null;
            return <ExpandedHistory key={`hist-${i}`} playerHistory={playerHistory} historyLoading={historyLoading} theme={theme} />;
          })}
        </>
      )}
    </div>
  );
}

function ChipPodium({ entries, theme, hasMultiple, expandedPlayer, playerHistory: _ph, historyLoading: _hl, onTogglePlayer }: ShowcasePodiumProps) {
  const [first, second, third] = entries;

  const renderExpandIcon = (entry: RankedEntry, size: number, color: string) => {
    const canExpand = hasMultiple?.(entry.iscored_username) ?? false;
    if (!canExpand) return null;
    const isExpanded = expandedPlayer === entry.iscored_username;
    return isExpanded
      ? <Minus size={size} style={{ color: 'var(--color-neon-cyan, #00e5ff)', cursor: 'pointer' }} onClick={() => onTogglePlayer?.(entry.iscored_username)} />
      : <Plus size={size} style={{ color, cursor: 'pointer' }} onClick={() => onTogglePlayer?.(entry.iscored_username)} />;
  };

  return (
    <div style={{ position: 'relative', height: '280px', margin: '0 20px' }}>
      {/* 1st place — large BGA chip, offset left */}
      {first && (
        <div
          style={{
            position: 'absolute',
            left: '30px',
            top: '8px',
            width: '165px',
            height: '82px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(255,215,0,0.38), rgba(255,215,0,0.15))',
            border: '1px solid rgba(255,215,0,0.50)',
            borderRadius: '6px',
            boxShadow: '0 0 20px rgba(255,215,0,0.20), inset 0 0 15px rgba(255,215,0,0.08)',
            ...(hasMultiple?.(first.iscored_username) ? { cursor: 'pointer' } : {}),
          }}
          onClick={hasMultiple?.(first.iscored_username) ? () => onTogglePlayer?.(first.iscored_username) : undefined}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
            <span style={{ fontSize: '12px' }}>{'\u{1F3C6}'}</span>
            <span style={{ fontWeight: 700, color: theme.podiumGold.rankColor, textShadow: '0 0 8px rgba(255,215,0,0.4)', fontSize: '11px' }}>1ST</span>
            {renderExpandIcon(first, 10, theme.podiumGold.rankColor)}
          </div>
          <div style={{
            fontFamily: theme.monoFontFamily,
            fontWeight: 600,
            fontSize: '13px',
            color: theme.podiumGold.textColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%',
            textAlign: 'center',
            padding: '0 8px',
          }}>
            {first.iscored_username}
          </div>
          <div style={{
            fontFamily: theme.monoFontFamily,
            fontWeight: 700,
            fontSize: '14px',
            color: theme.podiumGold.scoreColor,
            textShadow: '0 0 10px rgba(255,0,200,0.5)',
          }}
            title={first.score >= 1_000_000_000_000 ? first.score.toLocaleString() : undefined}
          >
            {formatScore(first.score)}
          </div>
        </div>
      )}

      {/* Circuit trace connector 1→2 */}
      <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }} viewBox="0 0 340 280">
        <path d="M 112 90 L 112 115 L 80 115 L 80 133" stroke="rgba(120,0,255,0.3)" strokeWidth="2" fill="none" />
        <circle cx="112" cy="90" r="3" fill="rgba(120,0,255,0.4)" />
        <circle cx="80" cy="133" r="3" fill="rgba(120,0,255,0.4)" />
        <circle cx="112" cy="115" r="2" fill="rgba(0,224,255,0.3)" />
        <circle cx="80" cy="115" r="2" fill="rgba(0,224,255,0.3)" />
        <path d="M 145 163 L 180 163 L 180 200 L 200 200" stroke="rgba(255,0,200,0.25)" strokeWidth="2" fill="none" />
        <circle cx="145" cy="163" r="3" fill="rgba(255,0,200,0.3)" />
        <circle cx="200" cy="200" r="3" fill="rgba(255,0,200,0.3)" />
        <circle cx="180" cy="163" r="2" fill="rgba(0,224,255,0.3)" />
        <circle cx="180" cy="200" r="2" fill="rgba(0,224,255,0.3)" />
      </svg>

      {/* 2nd place */}
      {second && (
        <div
          style={{
            position: 'absolute',
            left: '15px',
            top: '133px',
            width: '130px',
            height: '60px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(192,192,192,0.32), rgba(192,192,192,0.12))',
            border: '1px solid rgba(192,192,192,0.45)',
            borderRadius: '4px',
            boxShadow: '0 0 15px rgba(192,192,192,0.18)',
            zIndex: 2,
            ...(hasMultiple?.(second.iscored_username) ? { cursor: 'pointer' } : {}),
          }}
          onClick={hasMultiple?.(second.iscored_username) ? () => onTogglePlayer?.(second.iscored_username) : undefined}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
            <span style={{ fontWeight: 700, color: theme.podiumSilver.rankColor, textShadow: '0 0 6px rgba(192,192,192,0.3)', fontSize: '9px' }}>2ND</span>
            {renderExpandIcon(second, 9, theme.podiumSilver.rankColor)}
          </div>
          <div style={{
            fontFamily: theme.monoFontFamily,
            fontWeight: 600,
            fontSize: '11px',
            color: theme.podiumSilver.textColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%',
            textAlign: 'center',
            padding: '0 6px',
          }}>
            {second.iscored_username}
          </div>
          <div style={{
            fontFamily: theme.monoFontFamily,
            fontWeight: 700,
            fontSize: '11px',
            color: theme.podiumSilver.scoreColor,
          }}
            title={second.score >= 1_000_000_000_000 ? second.score.toLocaleString() : undefined}
          >
            {formatScore(second.score)}
          </div>
        </div>
      )}

      {/* 3rd place */}
      {third && (
        <div
          style={{
            position: 'absolute',
            left: '200px',
            top: '198px',
            width: '110px',
            height: '50px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(205,127,50,0.32), rgba(205,127,50,0.12))',
            border: '1px solid rgba(205,127,50,0.42)',
            borderRadius: '3px',
            boxShadow: '0 0 10px rgba(205,127,50,0.16)',
            zIndex: 2,
            ...(hasMultiple?.(third.iscored_username) ? { cursor: 'pointer' } : {}),
          }}
          onClick={hasMultiple?.(third.iscored_username) ? () => onTogglePlayer?.(third.iscored_username) : undefined}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
            <span style={{ fontWeight: 700, color: theme.podiumBronze.rankColor, textShadow: '0 0 6px rgba(205,127,50,0.3)', fontSize: '8px' }}>3RD</span>
            {renderExpandIcon(third, 8, theme.podiumBronze.rankColor)}
          </div>
          <div style={{
            fontFamily: theme.monoFontFamily,
            fontWeight: 600,
            fontSize: '10px',
            color: theme.podiumBronze.textColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%',
            textAlign: 'center',
            padding: '0 4px',
          }}>
            {third.iscored_username}
          </div>
          <div style={{
            fontFamily: theme.monoFontFamily,
            fontWeight: 700,
            fontSize: '10px',
            color: theme.podiumBronze.scoreColor,
          }}
            title={third.score >= 1_000_000_000_000 ? third.score.toLocaleString() : undefined}
          >
            {formatScore(third.score)}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ShowcasePodium(props: ShowcasePodiumProps) {
  if (props.entries.length === 0) return null;

  // For chip podium, expanded history renders below the container
  const expandedEntry = props.entries.find(e => e.iscored_username === props.expandedPlayer);

  return (
    <>
      {props.theme.podiumVariant === 'chip'
        ? <ChipPodium {...props} />
        : <PyramidPodium {...props} />
      }
      {/* Chip podium history renders outside the absolute-positioned container */}
      {props.theme.podiumVariant === 'chip' && expandedEntry && (
        <ExpandedHistory playerHistory={props.playerHistory} historyLoading={props.historyLoading} theme={props.theme} />
      )}
    </>
  );
}
