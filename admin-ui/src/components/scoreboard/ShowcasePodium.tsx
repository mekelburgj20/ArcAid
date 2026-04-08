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

/** Expanded history panel for a podium entry */
function ExpandedHistory({ playerHistory, historyLoading, theme }: { playerHistory?: ScoreHistoryEntry[]; historyLoading?: boolean; theme: ShowcaseThemeConfig }) {
  return (
    <div style={{ padding: '4px 8px 6px', background: 'rgba(0,0,0,0.3)', borderRadius: '0 0 8px 8px', marginTop: -2 }}>
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

interface PodiumSlotConfig {
  entry: RankedEntry | undefined;
  label: string;
  emoji: string;
  pod: { bg: string; border: string; rankColor: string; textColor: string; scoreColor: string };
  avatarSize: number;
  nameSize: number;
  scoreSize: number;
}

/** A single podium card — always rendered (empty state if no entry) */
function PodiumSlot({
  config, theme, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer,
}: {
  config: PodiumSlotConfig;
  theme: ShowcaseThemeConfig;
  hasMultiple?: (username: string) => boolean;
  expandedPlayer?: string | null;
  playerHistory?: ScoreHistoryEntry[];
  historyLoading?: boolean;
  onTogglePlayer?: (username: string) => void;
}) {
  const { entry, label, emoji, pod, avatarSize, nameSize, scoreSize } = config;
  const canExpand = entry ? (hasMultiple?.(entry.iscored_username) ?? false) : false;
  const isExpanded = entry ? expandedPlayer === entry.iscored_username : false;

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          borderRadius: isExpanded ? '12px 12px 0 0' : '12px',
          textAlign: 'center',
          padding: '10px 8px',
          background: pod.bg,
          border: pod.border,
          minHeight: 90,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          ...(canExpand ? { cursor: 'pointer' } : {}),
        }}
        onClick={canExpand ? () => onTogglePlayer?.(entry!.iscored_username) : undefined}
      >
        {/* Rank label */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 6 }}>
          {emoji && <span style={{ fontSize: 13, lineHeight: 1 }}>{emoji}</span>}
          <span style={{ fontSize: 11, fontWeight: 700, color: pod.rankColor }}>{label}</span>
        </div>

        {entry ? (
          <>
            {/* Avatar + Username row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, marginBottom: 4, maxWidth: '100%' }}>
              <PlayerAvatar
                username={entry.iscored_username}
                discordUserId={entry.discord_user_id}
                avatarHash={entry.avatar_hash}
                size={avatarSize}
              />
              <span style={{
                fontWeight: 600,
                color: pod.textColor,
                fontSize: nameSize,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {entry.iscored_username}
              </span>
            </div>

            {/* Score + expand icon row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <span
                style={{
                  fontWeight: 700,
                  fontFamily: theme.monoFontFamily,
                  color: pod.scoreColor,
                  fontSize: scoreSize,
                }}
                title={entry.score >= 1_000_000_000_000 ? entry.score.toLocaleString() : undefined}
              >
                {formatScore(entry.score)}
              </span>
              {canExpand && (
                isExpanded
                  ? <Minus size={11} style={{ color: 'var(--color-neon-cyan, #00e5ff)', flexShrink: 0 }} />
                  : <Plus size={11} style={{ color: pod.rankColor, flexShrink: 0 }} />
              )}
            </div>
          </>
        ) : (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.15)' }}>&mdash;</span>
        )}
      </div>

      {/* Expanded history directly below this slot */}
      {isExpanded && (
        <ExpandedHistory playerHistory={playerHistory} historyLoading={historyLoading} theme={theme} />
      )}
    </div>
  );
}

function PyramidPodium({ entries, theme, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer }: ShowcasePodiumProps) {
  const [first, second, third] = entries;

  const configs: PodiumSlotConfig[] = [
    { entry: first, pod: theme.podiumGold, avatarSize: 28, nameSize: 15, scoreSize: 13, label: '1st', emoji: '\u{1F3C6}' },
    { entry: second, pod: theme.podiumSilver, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '2nd', emoji: '' },
    { entry: third, pod: theme.podiumBronze, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '3rd', emoji: '' },
  ];

  return (
    <div style={{ padding: '0 20px', marginBottom: 4 }}>
      {/* Top — 1st place (centered, wider) */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ width: '65%', minWidth: 160 }}>
          <PodiumSlot
            config={configs[0]}
            theme={theme}
            hasMultiple={hasMultiple}
            expandedPlayer={expandedPlayer}
            playerHistory={playerHistory}
            historyLoading={historyLoading}
            onTogglePlayer={onTogglePlayer}
          />
        </div>
      </div>

      {/* Bottom — 2nd and 3rd side by side */}
      <div style={{ display: 'flex', gap: 8 }}>
        <PodiumSlot
          config={configs[1]}
          theme={theme}
          hasMultiple={hasMultiple}
          expandedPlayer={expandedPlayer}
          playerHistory={playerHistory}
          historyLoading={historyLoading}
          onTogglePlayer={onTogglePlayer}
        />
        <PodiumSlot
          config={configs[2]}
          theme={theme}
          hasMultiple={hasMultiple}
          expandedPlayer={expandedPlayer}
          playerHistory={playerHistory}
          historyLoading={historyLoading}
          onTogglePlayer={onTogglePlayer}
        />
      </div>
    </div>
  );
}

function ChipPodium({ entries, theme, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer }: ShowcasePodiumProps) {
  const [first, second, third] = entries;

  const configs: PodiumSlotConfig[] = [
    { entry: first, pod: theme.podiumGold, avatarSize: 28, nameSize: 15, scoreSize: 13, label: '1ST', emoji: '\u{1F3C6}' },
    { entry: second, pod: theme.podiumSilver, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '2ND', emoji: '' },
    { entry: third, pod: theme.podiumBronze, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '3RD', emoji: '' },
  ];

  return (
    <div style={{ padding: '0 20px', marginBottom: 4 }}>
      {/* 1st place centered */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ width: '65%', minWidth: 160 }}>
          <PodiumSlot
            config={configs[0]}
            theme={theme}
            hasMultiple={hasMultiple}
            expandedPlayer={expandedPlayer}
            playerHistory={playerHistory}
            historyLoading={historyLoading}
            onTogglePlayer={onTogglePlayer}
          />
        </div>
      </div>

      {/* 2nd and 3rd side by side */}
      <div style={{ display: 'flex', gap: 8 }}>
        <PodiumSlot
          config={configs[1]}
          theme={theme}
          hasMultiple={hasMultiple}
          expandedPlayer={expandedPlayer}
          playerHistory={playerHistory}
          historyLoading={historyLoading}
          onTogglePlayer={onTogglePlayer}
        />
        <PodiumSlot
          config={configs[2]}
          theme={theme}
          hasMultiple={hasMultiple}
          expandedPlayer={expandedPlayer}
          playerHistory={playerHistory}
          historyLoading={historyLoading}
          onTogglePlayer={onTogglePlayer}
        />
      </div>
    </div>
  );
}

export default function ShowcasePodium(props: ShowcasePodiumProps) {
  return props.theme.podiumVariant === 'chip'
    ? <ChipPodium {...props} />
    : <PyramidPodium {...props} />;
}
