import type { RankedEntry } from '../ScoreboardComponents';
import type { ShowcaseThemeConfig } from '../../lib/scoreboardThemes';

interface ShowcasePodiumProps {
  entries: RankedEntry[];  // top 3 (or fewer)
  theme: ShowcaseThemeConfig;
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

function PyramidPodium({ entries, theme }: ShowcasePodiumProps) {
  const [first, second, third] = entries;
  const configs = [
    { entry: first, pod: theme.podiumGold, avatarSize: 36, fontSize: 11, scoreSize: 12, nameClass: 'pn1', label: '1st', emoji: '\u{1F3C6}' },
    { entry: second, pod: theme.podiumSilver, avatarSize: 26, fontSize: 10, scoreSize: 10, nameClass: 'pnn', label: '2nd', emoji: '' },
    { entry: third, pod: theme.podiumBronze, avatarSize: 26, fontSize: 10, scoreSize: 10, nameClass: 'pnn', label: '3rd', emoji: '' },
  ];

  return (
    <div style={{ padding: '0 20px', marginBottom: '4px' }}>
      {/* Top — 1st place */}
      {first && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
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
            </div>
            <div style={{
              borderRadius: '50%',
              margin: '0 auto 5px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              background: 'linear-gradient(135deg, #ffd700, #f7a800)',
              color: '#1a1a24',
              width: 36,
              height: 36,
              fontSize: 11,
            }}>
              {initials(first.iscored_username)}
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
      )}

      {/* Bottom — 2nd and 3rd */}
      {(second || third) && (
        <div style={{ display: 'flex', gap: '8px' }}>
          {[second, third].map((entry, i) => {
            if (!entry) return <div key={i} style={{ flex: 1 }} />;
            const cfg = configs[i + 1]!;
            const avatarGrad = i === 0
              ? 'linear-gradient(135deg, #c0c0c0, #a0a8b0)'
              : 'linear-gradient(135deg, #cd7f32, #a0622e)';
            return (
              <div key={i} style={{
                flex: 1,
                borderRadius: '12px',
                textAlign: 'center',
                padding: '8px',
                background: cfg.pod.bg,
                border: cfg.pod.border,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', marginBottom: '6px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: cfg.pod.rankColor }}>{cfg.label}</span>
                </div>
                <div style={{
                  borderRadius: '50%',
                  margin: '0 auto 5px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  background: avatarGrad,
                  color: '#1a1a24',
                  width: 26,
                  height: 26,
                  fontSize: 8,
                }}>
                  {initials(entry.iscored_username)}
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
      )}
    </div>
  );
}

function ChipPodium({ entries, theme }: ShowcasePodiumProps) {
  const [first, second, third] = entries;

  // Chip podium: positioned text overlays on a relative container
  // The chip shapes are rendered as styled divs with border effects
  return (
    <div style={{ position: 'relative', height: '280px', margin: '0 20px' }}>
      {/* 1st place — large BGA chip, offset left */}
      {first && (
        <div style={{
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
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
            <span style={{ fontSize: '12px' }}>{'\u{1F3C6}'}</span>
            <span style={{ fontWeight: 700, color: theme.podiumGold.rankColor, textShadow: '0 0 8px rgba(255,215,0,0.4)', fontSize: '11px' }}>1ST</span>
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
        {/* Trace from chip 1 to chip 2 */}
        <path d="M 112 90 L 112 115 L 80 115 L 80 133" stroke="rgba(120,0,255,0.3)" strokeWidth="2" fill="none" />
        <circle cx="112" cy="90" r="3" fill="rgba(120,0,255,0.4)" />
        <circle cx="80" cy="133" r="3" fill="rgba(120,0,255,0.4)" />
        <circle cx="112" cy="115" r="2" fill="rgba(0,224,255,0.3)" />
        <circle cx="80" cy="115" r="2" fill="rgba(0,224,255,0.3)" />

        {/* Trace from chip 2 to chip 3 */}
        <path d="M 145 163 L 180 163 L 180 200 L 200 200" stroke="rgba(255,0,200,0.25)" strokeWidth="2" fill="none" />
        <circle cx="145" cy="163" r="3" fill="rgba(255,0,200,0.3)" />
        <circle cx="200" cy="200" r="3" fill="rgba(255,0,200,0.3)" />
        <circle cx="180" cy="163" r="2" fill="rgba(0,224,255,0.3)" />
        <circle cx="180" cy="200" r="2" fill="rgba(0,224,255,0.3)" />
      </svg>

      {/* 2nd place — medium SOIC chip */}
      {second && (
        <div style={{
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
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
            <span style={{ fontWeight: 700, color: theme.podiumSilver.rankColor, textShadow: '0 0 6px rgba(192,192,192,0.3)', fontSize: '9px' }}>2ND</span>
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

      {/* 3rd place — small chip, offset right */}
      {third && (
        <div style={{
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
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
            <span style={{ fontWeight: 700, color: theme.podiumBronze.rankColor, textShadow: '0 0 6px rgba(205,127,50,0.3)', fontSize: '8px' }}>3RD</span>
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

export default function ShowcasePodium({ entries, theme }: ShowcasePodiumProps) {
  if (entries.length === 0) return null;

  if (theme.podiumVariant === 'chip') {
    return <ChipPodium entries={entries} theme={theme} />;
  }

  return <PyramidPodium entries={entries} theme={theme} />;
}
