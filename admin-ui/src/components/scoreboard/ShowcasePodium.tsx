import type { ReactNode } from 'react';
import { Plus, Minus } from 'lucide-react';
import type { RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import PlayerNameLink from '../PlayerNameLink';
import type { ShowcaseThemeConfig } from '../../lib/scoreboardThemes';
import type { ScoreHistoryEntry } from './useScoreExpand';
import { TrophyIcon } from '../../assets/icons/ThemedIcons';

interface ShowcasePodiumProps {
  entries: RankedEntry[];  // top 3 (or fewer)
  theme: ShowcaseThemeConfig;
  /** v2.2.10: needed for the player-stats Link on usernames. */
  slug?: string;
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
    /* v2.2.10: bumped text contrast substantially — previously scores were
       at rgba(255,255,255,0.5) which blended into the card's busy background
       (see image #12 feedback). Now scores use the theme's normal text color
       and dates are ~75% opacity. */
    <div style={{ padding: '6px 10px 8px', background: 'rgba(0,0,0,0.55)', borderRadius: '0 0 8px 8px', marginTop: -2 }}>
      {historyLoading ? (
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', margin: '2px 0' }}>Loading…</p>
      ) : (playerHistory && playerHistory.length > 0) ? (
        <div>
          {playerHistory.map(h => (
            <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}>
              <span style={{ color: 'rgba(255,255,255,0.95)', fontFamily: theme.monoFontFamily, fontWeight: 600 }}>{h.score.toLocaleString()}</span>
              <span style={{ color: 'rgba(255,255,255,0.65)' }}>{new Date(h.created_at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', margin: '2px 0' }}>No additional scores.</p>
      )}
    </div>
  );
}

interface PodiumSlotConfig {
  entry: RankedEntry | undefined;
  label: string;
  icon: ReactNode | null;
  pod: { bg: string; border: string; rankColor: string; textColor: string; scoreColor: string };
  avatarSize: number;
  nameSize: number;
  scoreSize: number;
}

/** A single podium card — always rendered (empty state if no entry) */
function PodiumSlot({
  config, theme, slug, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer,
}: {
  config: PodiumSlotConfig;
  theme: ShowcaseThemeConfig;
  slug?: string;
  hasMultiple?: (username: string) => boolean;
  expandedPlayer?: string | null;
  playerHistory?: ScoreHistoryEntry[];
  historyLoading?: boolean;
  onTogglePlayer?: (username: string) => void;
}) {
  const { entry, label, icon, pod, avatarSize, nameSize, scoreSize } = config;
  const canExpand = entry ? (hasMultiple?.(entry.iscored_username) ?? false) : false;
  const isExpanded = entry ? expandedPlayer === entry.iscored_username : false;

  return (
    /* v2.2.7: also set pointerEvents: 'auto' on the outer wrapper when
       canExpand, so every pixel of this podium column (not just the inner
       tinted box) captures expand clicks. Previously the inner div alone
       had pointer-events auto — padding / surrounding flex area fell back
       to the wrapper's pointer-events-none and clicks there navigated
       instead of expanding. */
    <div style={{ flex: 1, minWidth: 0, ...(canExpand ? { pointerEvents: 'auto' } : {}) }}>
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
          ...(canExpand ? { cursor: 'pointer', pointerEvents: 'auto' } : {}),
        }}
        onClick={canExpand ? () => onTogglePlayer?.(entry!.iscored_username) : undefined}
      >
        {/* Rank label */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 6 }}>
          {icon && <span style={{ display: 'inline-flex', lineHeight: 1, color: pod.rankColor }}>{icon}</span>}
          <span style={{ fontSize: 11, fontWeight: 700, color: pod.rankColor }}>{label}</span>
        </div>

        {entry ? (
          <>
            {/* Avatar + Username row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, marginBottom: 4, maxWidth: '100%' }}>
              <PlayerAvatar
                username={playerName(entry)}
                discordUserId={entry.discord_user_id}
                avatarHash={entry.avatar_hash}
                size={avatarSize}
              />
              {slug ? (
                <PlayerNameLink
                  slug={slug}
                  entry={entry}
                  onClick={e => e.stopPropagation()}
                  style={{
                    fontWeight: 600,
                    color: pod.textColor,
                    fontSize: nameSize,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: 'none',
                    pointerEvents: 'auto',
                  }}
                />
              ) : (
                <span style={{
                  fontWeight: 600,
                  color: pod.textColor,
                  fontSize: nameSize,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {playerName(entry)}
                </span>
              )}
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

function PyramidPodium({ entries, theme, slug, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer }: ShowcasePodiumProps) {
  const [first, second, third] = entries;

  const configs: PodiumSlotConfig[] = [
    { entry: first, pod: theme.podiumGold, avatarSize: 28, nameSize: 15, scoreSize: 13, label: '1st', icon: <TrophyIcon size={13} title="1st place" /> },
    { entry: second, pod: theme.podiumSilver, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '2nd', icon: null },
    { entry: third, pod: theme.podiumBronze, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '3rd', icon: null },
  ];

  return (
    <div style={{ padding: '0 20px', marginBottom: 4 }}>
      {/* Top — 1st place (centered, wider) */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ width: '65%', minWidth: 160 }}>
          <PodiumSlot
            config={configs[0]}
            theme={theme}
            slug={slug}
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
          slug={slug}
          hasMultiple={hasMultiple}
          expandedPlayer={expandedPlayer}
          playerHistory={playerHistory}
          historyLoading={historyLoading}
          onTogglePlayer={onTogglePlayer}
        />
        <PodiumSlot
          config={configs[2]}
          theme={theme}
          slug={slug}
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

function ChipPodium({ entries, theme, slug, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer }: ShowcasePodiumProps) {
  const [first, second, third] = entries;

  const configs: PodiumSlotConfig[] = [
    { entry: first, pod: theme.podiumGold, avatarSize: 28, nameSize: 15, scoreSize: 13, label: '1ST', icon: <TrophyIcon size={13} title="1st place" /> },
    { entry: second, pod: theme.podiumSilver, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '2ND', icon: null },
    { entry: third, pod: theme.podiumBronze, avatarSize: 24, nameSize: 14, scoreSize: 12, label: '3RD', icon: null },
  ];

  return (
    <div style={{ padding: '0 20px', marginBottom: 4 }}>
      {/* 1st place centered */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ width: '65%', minWidth: 160 }}>
          <PodiumSlot
            config={configs[0]}
            theme={theme}
            slug={slug}
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
          slug={slug}
          hasMultiple={hasMultiple}
          expandedPlayer={expandedPlayer}
          playerHistory={playerHistory}
          historyLoading={historyLoading}
          onTogglePlayer={onTogglePlayer}
        />
        <PodiumSlot
          config={configs[2]}
          theme={theme}
          slug={slug}
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
