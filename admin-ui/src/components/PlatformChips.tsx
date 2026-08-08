import type { ReactNode } from 'react';
import { getPlatformDisplay, normalizePlatformList } from '../lib/platforms';
// ADR 0016 catalogue phase §6 — `global_games.platforms` is an ENGINE list, so
// catalogue chips render through the provenance helper the rest of the app
// already uses (`getLegacyPlatformLabel` handles BOTH vocabularies, which
// matters while a deploy is mid-rollout and rows exist in either shape). Room
// TAGS stay on `getPlatformDisplay` in the default (admin) mode: they are
// free-form strings on the old axis, not engines, and folding them would claim
// a meaning they don't have.
import { getLegacyPlatformLabel } from '../lib/scoreProvenance';

/**
 * Catalogue platforms + per-room tags as chips.
 *
 * **Two modes, one component.**
 *
 * Default (admin surfaces, e.g. the Game Library): catalogue platforms render
 * in cyan and per-room tags (custom platforms, ADR 0008) in amber, because an
 * admin editing the catalogue needs to see at a glance which half of a game's
 * platform set is global truth and which half their room invented.
 *
 * `uniformStyle` (player surfaces, e.g. Picks): one chip family, all cyan.
 * Owner decision (v2.84.0) — "room-added vs catalogue" is admin plumbing that
 * means nothing to a player deciding what to play; two colours just implied a
 * distinction they then had to decode. In this mode tags are also labelled
 * through `getLegacyPlatformLabel` and deduped against the platform chips, so
 * a room that tagged a game `vpx` gets ONE "VPX" chip rather than two. Unknown
 * free-form tags are unaffected — both helpers uppercase an unrecognised token.
 *
 * Extracted from `pages/GameLibrary.tsx` (v2.84.0) so the player-facing Picks
 * list shows the same chips the admin library does — one definition, so the
 * two surfaces cannot drift.
 */
export default function PlatformChips({
  platforms: raw,
  roomTags,
  dense = false,
  uniformStyle = false,
  emptyFallback = <span className="text-faint text-sm">None</span>,
}: {
  /** Already-parsed platform tokens — the caller owns column parsing. */
  platforms: string[];
  roomTags?: string[];
  /** `text-[10px]` chips for dense list rows (default is the `text-xs` admin size). */
  dense?: boolean;
  /** Render room tags as one family with the platform chips, deduped by label. */
  uniformStyle?: boolean;
  /** What to render when the game has neither platforms nor tags. Pass `null` to render nothing. */
  emptyFallback?: ReactNode;
}) {
  const list = normalizePlatformList(raw);
  const rawTags = (roomTags ?? []).filter(t => t && t.length > 0);

  // In uniform mode a tag is just another way to say "this game runs on X", so
  // one that resolves to a label a platform chip already shows is dropped.
  const platformLabels = list.map(p => getLegacyPlatformLabel(p));
  const seen = new Set(platformLabels.map(l => l.toLowerCase()));
  const tags = uniformStyle
    ? rawTags.filter(t => {
        const label = getLegacyPlatformLabel(t).toLowerCase();
        if (seen.has(label)) return false;
        seen.add(label);
        return true;
      })
    : rawTags;

  if (list.length === 0 && tags.length === 0) return <>{emptyFallback}</>;
  const size = dense ? 'text-[10px]' : 'text-xs';
  const tagClass = uniformStyle
    ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/30'
    : 'bg-neon-amber/10 text-neon-amber border-neon-amber/40';
  return (
    <div className="flex gap-1 flex-wrap">
      {list.map((p, i) => (
        <span key={`p-${p}`} className={`${size} px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30`}>{platformLabels[i]}</span>
      ))}
      {tags.map(t => (
        <span
          key={`t-${t}`}
          className={`${size} px-1.5 py-0.5 rounded border ${tagClass}`}
          title={uniformStyle ? undefined : 'Room-only tag'}
        >
          {uniformStyle ? getLegacyPlatformLabel(t) : getPlatformDisplay(t)}
        </span>
      ))}
    </div>
  );
}
