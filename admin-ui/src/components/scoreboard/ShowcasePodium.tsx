import type { ReactNode } from 'react';
import { Plus, Minus, BadgeCheck } from 'lucide-react';
import type { RankedEntry } from '../ScoreboardComponents';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import PlayerNameLink from '../PlayerNameLink';
import type { ShowcaseThemeConfig } from '../../lib/scoreboardThemes';
import type { ScoreHistoryEntry } from './useScoreExpand';
import { TrophyIcon } from '../../assets/icons/ThemedIcons';
import { formatScore } from '../../lib/format';

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

/**
 * Length-aware font step for podium scores. Podium slots are equal-width flex
 * columns with no room to grow, and numbers can't be ellipsised, so long values
 * shrink to stay inside the slot. Thresholds mirror `StatCard` in GameDetail;
 * the floor (9px) keeps the longest realistic render ("999,999,999,999", 15
 * chars) legible.
 */
function podiumScoreFontSize(base: number, rendered: string): number {
  const scale = rendered.length > 13 ? 0.7 : rendered.length > 10 ? 0.8 : rendered.length > 7 ? 0.9 : 1;
  return Math.max(9, Math.round(base * scale));
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
                avatarUrl={entry.avatar_url}
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
              {entry.verified && (
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--color-neon-green, #00ff88)', flexShrink: 0 }}
                  title="Verified by an admin"
                  aria-label="Verified score"
                >
                  <BadgeCheck size={11} />
                </span>
              )}
            </div>

            {/* Score + expand icon row.
                The podium slot is a fixed-width flex column, so an ellipsis is
                not an option here — a truncated number is a wrong number. We
                step the font down for long values instead (the same trick
                StatCard uses) and keep it on one line: a 13-char score renders
                at ~78% of the slot's nominal size and still fits. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, maxWidth: '100%' }}>
              <span
                style={{
                  fontWeight: 700,
                  fontFamily: theme.monoFontFamily,
                  color: pod.scoreColor,
                  fontSize: podiumScoreFontSize(scoreSize, formatScore(entry.score)),
                  whiteSpace: 'nowrap',
                }}
                title={formatScore(entry.score).endsWith('T') ? entry.score.toLocaleString() : undefined}
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

// ═══════════════════════════════════════════
// Holo Steps (owner design handoff 2026-08-13 — tmp/design_handoff_podium_restyle)
// ═══════════════════════════════════════════

/** Metal color per rank — tokens, never literals (the light/coffee themes
 *  re-derive silver/bronze for a pale surface). */
const HOLO_METALS: Record<1 | 2 | 3, string> = {
  1: 'var(--color-neon-amber)',
  2: 'var(--color-medal-silver)',
  3: 'var(--color-medal-bronze)',
};

/** Riser heights, spec'd: literal stepped podium, 1st tallest. */
const HOLO_STEP_HEIGHTS: Record<1 | 2 | 3, number> = { 1: 64, 2: 44, 3: 32 };

/** Token-safe alpha: the spec's `{m}66`-style hex suffixes can't apply to a
 *  CSS var, so alpha is expressed as a color-mix percentage instead. */
const mixMetal = (metal: string, pct: number) => `color-mix(in srgb, ${metal} ${pct}%, transparent)`;

/**
 * One step: the name/score stack floating above a glass riser.
 * Empty slot = unlit riser (dim numeral, no stack, no animation) — the podium
 * silhouette is always complete, exactly like the other variants' blank slots.
 */
function HoloStep({
  entry, rank, theme, slug, hasMultiple, expandedPlayer, onTogglePlayer,
}: {
  entry: RankedEntry | undefined;
  rank: 1 | 2 | 3;
  theme: ShowcaseThemeConfig;
  slug?: string;
  hasMultiple?: (username: string) => boolean;
  expandedPlayer?: string | null;
  onTogglePlayer?: (username: string) => void;
}) {
  const m = HOLO_METALS[rank];
  const empty = !entry;
  const canExpand = entry ? (hasMultiple?.(entry.iscored_username) ?? false) : false;
  const isExpanded = entry ? expandedPlayer === entry.iscored_username : false;
  const first = rank === 1;
  const rendered = entry ? formatScore(entry.score) : '';

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', ...(canExpand ? { pointerEvents: 'auto' as const } : {}) }}>
      {entry && (
        <div
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginBottom: 8,
            ...(canExpand ? { cursor: 'pointer' } : {}),
          }}
          onClick={canExpand ? () => onTogglePlayer?.(entry.iscored_username) : undefined}
        >
          <PlayerAvatar
            username={playerName(entry)}
            discordUserId={entry.discord_user_id}
            avatarHash={entry.avatar_hash}
            avatarUrl={entry.avatar_url}
            size={first ? 30 : 24}
          />
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: '100%', minWidth: 0 }}>
            {slug ? (
              <PlayerNameLink
                slug={slug}
                entry={entry}
                onClick={e => e.stopPropagation()}
                style={{
                  fontSize: first ? 12.5 : 11, fontWeight: 600, color: '#fff',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  /* required for busy-backglass legibility, not decorative */
                  textShadow: '0 1px 4px rgba(0,0,0,0.9)',
                  textDecoration: 'none', pointerEvents: 'auto',
                }}
              />
            ) : (
              <span style={{
                fontSize: first ? 12.5 : 11, fontWeight: 600, color: '#fff',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                textShadow: '0 1px 4px rgba(0,0,0,0.9)',
              }}>
                {playerName(entry)}
              </span>
            )}
            {entry.verified && (
              <span
                style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--color-neon-green, #00ff88)', flexShrink: 0 }}
                title="Verified by an admin"
                aria-label="Verified score"
              >
                <BadgeCheck size={10} />
              </span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                fontFamily: theme.monoFontFamily,
                fontSize: podiumScoreFontSize(first ? 13 : 11, rendered),
                fontWeight: 700, color: m, whiteSpace: 'nowrap',
                textShadow: `0 0 10px ${mixMetal(m, 33)}, 0 1px 4px rgba(0,0,0,0.9)`,
              }}
              title={rendered.endsWith('T') ? entry.score.toLocaleString() : undefined}
            >
              {rendered}
            </span>
            {canExpand && (
              isExpanded
                ? <Minus size={10} style={{ color: 'var(--color-neon-cyan, #00e5ff)', flexShrink: 0 }} />
                : <Plus size={10} style={{ color: m, flexShrink: 0 }} />
            )}
          </span>
        </div>
      )}
      <div
        className={empty ? undefined : 'hs-riser'}
        data-testid={`holo-riser-${rank}`}
        style={{
          height: HOLO_STEP_HEIGHTS[rank],
          borderRadius: '6px 6px 0 0',
          position: 'relative',
          overflow: 'hidden',
          background: empty
            ? 'rgba(255,255,255,0.03)'
            : `linear-gradient(180deg, ${mixMetal(m, 40)} 0%, ${mixMetal(m, 23)} 55%, ${mixMetal(m, 9)} 100%), color-mix(in srgb, var(--color-deep, #080a10) 50%, transparent)`,
          borderTop: `2px solid ${empty ? 'rgba(255,255,255,0.12)' : m}`,
          backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          ...(empty ? {} : {
            ['--pr-glow' as string]: mixMetal(m, 27),
            ['--pr-glow-hi' as string]: mixMetal(m, 60),
            animation: `pr-breathe ${3.6 + rank * 0.6}s ease-in-out ${rank * 0.4}s infinite`,
          }),
        }}
      >
        {!empty && first && (
          /* scanline shimmer — gold ONLY (owner rejected it on silver/bronze) */
          <div
            className="hs-scan"
            style={{
              position: 'absolute', inset: 0,
              background: 'repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,0.045) 3px 4px)',
              backgroundSize: '100% 300%',
              animation: 'pr-scan 7s linear infinite',
            }}
          />
        )}
        <span
          className="font-display"
          style={{
            fontSize: 22, fontWeight: 800, marginTop: 6, lineHeight: 1,
            color: empty ? 'rgba(255,255,255,0.12)' : '#fff',
            textShadow: empty ? 'none' : `0 0 14px ${m}, 0 1px 3px rgba(0,0,0,0.8)`,
          }}
        >
          {rank}
        </span>
      </div>
    </div>
  );
}

/**
 * The stepped podium — risers in visual order 2·1·3, feet on a common
 * baseline. The expanded score history (any rank) drops as one full-width
 * panel under the steps: the columns are too narrow to host it per-slot
 * without breaking the silhouette.
 */
function HoloStepsPodium({ entries, theme, slug, hasMultiple, expandedPlayer, playerHistory, historyLoading, onTogglePlayer }: ShowcasePodiumProps) {
  const [first, second, third] = entries;
  const expandedIsPodium = !!expandedPlayer && entries.slice(0, 3).some(e => e && e.iscored_username === expandedPlayer);

  return (
    <div style={{ padding: '4px 16px 12px' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <HoloStep entry={second} rank={2} theme={theme} slug={slug} hasMultiple={hasMultiple} expandedPlayer={expandedPlayer} onTogglePlayer={onTogglePlayer} />
        <HoloStep entry={first} rank={1} theme={theme} slug={slug} hasMultiple={hasMultiple} expandedPlayer={expandedPlayer} onTogglePlayer={onTogglePlayer} />
        <HoloStep entry={third} rank={3} theme={theme} slug={slug} hasMultiple={hasMultiple} expandedPlayer={expandedPlayer} onTogglePlayer={onTogglePlayer} />
      </div>
      {expandedIsPodium && (
        <ExpandedHistory playerHistory={playerHistory} historyLoading={historyLoading} theme={theme} />
      )}
    </div>
  );
}

export default function ShowcasePodium(props: ShowcasePodiumProps) {
  switch (props.theme.podiumVariant) {
    case 'chip': return <ChipPodium {...props} />;
    case 'pyramid': return <PyramidPodium {...props} />;
    /* holo-steps is the default variant (deriveScoreboardConfig) — the owner's
       2026-08-13 podium redesign replaced pyramid/chip as what showcase rooms
       see unless they explicitly pin one back. */
    case 'holo-steps':
    default: return <HoloStepsPodium {...props} />;
  }
}
