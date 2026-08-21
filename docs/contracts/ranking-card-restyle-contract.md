# Contract: Ranking-card restyle (v2.31.0)

Orchestrator contract for the implementing agent. Recon findings are embedded — do not re-derive them; verify line numbers before editing (they may have drifted a few lines).

## Problem

`RankingGroupCard` (admin-ui/src/components/ScoreboardComponents.tsx:805-1278) renders flat gray for banner/minimal rooms. Root cause: the themed background source (`showcaseTheme`, lines ~819-821) is gated on `scoreboardStyle === 'showcase'`; every other path falls back to `var(--color-surface, #1a1a2e)` / `bg-surface`. `rankingsStyle: 'match'` matches layout only, never background. Ranking cards also show only the group's own name — no underlying tournament names/types.

## Deliverables

### D1 — Backend: attach tournaments to the rankings payload (additive, no migration)

In `src/services/RankingService.ts`, extend the objects returned by `getActiveWithRankings()` (service ~:565-577, feeds `GET /rooms/:roomId/rankings` in `src/api/routes/rooms.ts` ~:335-344) so each `group` carries:

```ts
tournaments: { id: string; name: string; type: string }[]
```

Sourced via the existing `ranking_group_tournaments` join table + `tournaments(id, name, type)` columns. One batched query for all groups is preferred over per-group N+1 (small N either way — keep it simple, a per-group query loop is acceptable if the code reads cleaner alongside the existing `tournament_ids` loading). Also attach in `getAll`/`getById` ONLY if it falls out naturally from shared code — do not widen scope to other endpoints otherwise.

Widen the FE type `RankingGroupData['group']` (ScoreboardComponents.tsx ~:59-67) with `tournaments?: {id: string; name: string; type: string}[]` (optional — FE must tolerate its absence, e.g. cached/stale responses).

### D2 — FE tournament-type color helper

New file `admin-ui/src/lib/tournamentColors.ts`. Port the logic of `src/utils/discord.ts:5-24` `getTournamentColor` to hex strings:

```ts
const TAG_COLORS: Record<string, string> = {
  'DG': '#FFD700', 'WG-VPXS': '#00BFFF', 'WG-VR': '#AA00FF', 'MG': '#00FF88',
  'daily': '#FFD700', 'weekly': '#00BFFF', 'monthly': '#AA00FF', 'custom': '#00FF88',
};
export function getTournamentColorHex(type?: string | null): string {
  if (!type) return '#888888';
  return TAG_COLORS[type.toUpperCase()] ?? TAG_COLORS[type] ?? '#888888';
}
```

Match the BE lookup order exactly (uppercase first, then raw key, then gray). Do NOT reuse or modify the existing `TOURNAMENT_COLORS`/`TOURNAMENT_BORDER_COLORS` maps (ScoreboardComponents.tsx ~:82-87, BannerCard.tsx ~:45-50) — those are a different scheme (card border by tag) and must stay untouched.

### D3 — Tournament chips in RankingGroupCard

A small internal subcomponent (e.g. `TournamentChips`) rendered in the header/title area of ALL SIX variants (match×banner, match×showcase, match×minimal, plaque, compact, sidebar). Behavior:

- One chip per entry in `group.tournaments` (skip rendering entirely when absent/empty).
- Chip = tournament name in the type color from D2. Suggested treatment: small pill — `color: <hex>`, `border: 1px solid <hex at ~45% alpha>`, `background: <hex at ~12% alpha>`, font ~10-11px, `borderRadius` matching existing chip idiom in the file. Use hex+alpha via 8-digit hex or rgba conversion — keep it simple.
- Cap visible chips at 4; if more, show `+N` overflow chip in muted gray. Chips wrap (`flex-wrap`) within the card width — must not widen the card (widths are hardcoded per variant, see Constraints).
- `compact` variant: chips may be a single inline row after the group name at reduced size, or omitted from `compact` if it genuinely cannot fit without breaking the dense layout — implementer's call, note the decision in the PR body.

### D4 — Themed background for banner/minimal (the "gray" fix)

- Showcase paths: UNCHANGED (already use `showcaseTheme.cardBg`).
- Banner + minimal paths (the `tokens.bg` fallback at ~:868 AND the match×banner `bg-surface` div at ~:1262-1278 AND the match×minimal flat background at ~:1229-1260): replace the flat fill with a theme-derived gradient built from the room's public-theme CSS variables, so all 17 themes flow through automatically. Suggested (tune freely for taste — user iterates from screenshots):

```css
background: linear-gradient(165deg,
  color-mix(in srgb, var(--accent) 18%, var(--surface)) 0%,
  var(--surface) 55%,
  color-mix(in srgb, var(--accent) 8%, var(--surface)) 100%);
border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
```

**Verification step (do FIRST):** inspect `ThemeProvider.tsx` / `admin-ui/src/index.css` to find the ACTUAL CSS variable names for surface + accent colors and confirm both are defined in all theme classes (and the no-class dark default). Use the real names with sensible fallbacks (`var(--color-accent, #6366f1)`-style). If no accent-like var exists across themes, STOP and return a blocker naming the vars that do exist — do not invent variables.

- `compact` keeps no card chrome (background untouched).
- `color-mix` is fine (baseline browser support long-settled); still include literal fallback colors inside `var()`.
- Text contrast: the gradient is surface-anchored (max 18% accent tint) so existing text colors stay readable; do not change text colors in this pass except the D3 chips.

## Constraints (violating any of these = revision round)

1. FE-only apart from D1's additive payload change. NO migration — next free is 113 and must remain free. No new settings keys, no admin settings UI changes (`Rankings.tsx` / `ScoreboardPreferencesModal.tsx` untouched — no new option is being added).
2. Every variant's outermost rendered wrapper must keep its `scoreboard-card-slot` class AND its `qrTopPad` margin/padding (lines ~891, 1183, 1231, 1264) — mobile ≤640px full-width override and kiosk QR overhang reservation depend on them. New background markup goes INSIDE, never as a sibling.
3. Do not change card widths. The width ternary is triplicated (RankingGroupCard ~:882, RankingsColumn ~:1296, RankingsRow ~:1310) — leave all three alone.
4. `cardOpacity` prop wiring: leave exactly as-is (legacy, still consumed by RankingGroupCard only).
5. Showcase behavior byte-equivalent where possible: showcase rooms should see ONLY the new chips, no background change.
6. `KioskScoreboard.tsx` and admin `Leaderboard.tsx` render flow through the shared component — check `Leaderboard.tsx` (admin) for whether it renders RankingGroupCard; if yes, eyeball-verify nothing breaks (no code change expected).
7. Known pre-existing defect NOT in scope: RankingsColumn's mobile max-width cap (left/right positions). Do not fix, do not worsen.
8. Repo hygiene: NEVER `git add -A` (huge untracked data/ dirs — stage explicit paths only). Version bumps via Edit tool, never full-file Write (CRLF). NO service-worker bump (automatic since v2.28). Backend is CommonJS/NodeNext; admin-ui is ESM — keep imports idiomatic per side.

## Tests

- New: `admin-ui/src/lib/__tests__/tournamentColors.test.ts` — tag-code keys, generic keys, case-insensitivity, unknown→gray, null/undefined→gray. Mirror the BE lookup-order semantics.
- New/extend: a scoreboardConfig test asserting `rankingsStyle` derivation/validation (valid values pass, junk falls back to 'match') — closes the existing coverage gap cheaply.
- Backend: extend or add a RankingService test ONLY if a test harness for it already exists (check `src/**/__tests__` / vitest config); do not build new BE test infrastructure for this.

## Process

1. Branch `ranking-card-restyle` off current `main`.
2. Implement D1→D4.
3. Gates (ALL must pass): root `npm run build`; `cd admin-ui && npm run build`; admin-ui `npx vitest run` (expect prior 48 + new all green); `docker compose build` from repo root.
4. Version: root `package.json` → **2.31.0** (Edit tool). Do NOT touch CHANGELOG.md (orchestrator handles it at release).
5. Commit(s) on the branch with `feature:` prefix. Do NOT push, do NOT open a PR — the orchestrator reviews first.
6. Final report: files changed w/ line-level summary, decisions made where the contract allowed discretion (chip treatment, compact handling, actual CSS var names found), gate results verbatim, and any deviations. If blocked (e.g. D4's CSS-var verification fails), STOP and return the blocker — do not guess.
