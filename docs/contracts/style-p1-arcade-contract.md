# Style revamp Phase 1 — Arcade card family: work-package contract

Status: DRAFT (Fable, 2026-08-13). Base branch: main after PR #217 (v2.105.0 P0) merges.
Owner decisions settled: default look = Global Scoreboard ("Arcade"); auto-convert legacy rooms; kiosk keys in profiles (P2); viewer-prefs trim now (P3). Podium MUST be swappable — owner is sending a replacement Podium design.

## Recon corrections (vs. the published plan artifact)

- **Global grid is 3-col, not 4** — `admin-ui/src/lib/globalGrid.ts` reduced 4→3 in v2.65.0 declutter. Irrelevant to rooms anyway: room layout is `ScoreCardGrid` driven by `STYLE_WIDTHS` card width, not the Global page grid.
- **Global cards carry no platform chips** — removed v2.59.0 (ADR 0016 P4); what remains is the fidelity `CategoryChip` + hover tooltip. Room cards have `ProvenanceTags`. Arcade = Global's visual language on ROOM card behavior (see scope).

## Design decisions (Fable, consistent with settled owner decisions — surface in recap)

1. **Theme interaction: HYBRID.** Arcade's base surfaces/borders/text track the room's `--color-*` tokens (so the admin's chosen theme — cyberpunk, ocean, etc. — still applies at the base level, like Banner/Minimal), while the signature Global accents (per-category neon frame, gold/silver/bronze podium tints, footer treatment) are fixed tokens ported from the `--sb-*` family. Rationale: Arcade becomes the DEFAULT for every room; a default that ignores the room's theme choice reads as broken, but the fixed neon signature preserves the owner's cohesiveness goal. (Showcase's full opt-out precedent rejected; full 17-theme re-derivation of the neon palette rejected as scope explosion.)
2. **Podium seam: `ArcadePodium.tsx`**, following the `ShowcaseCard`/`ShowcasePodium` precedent exactly. Props contract: `entries` (top-3 `RankedEntry[]`), `slug`, empty-slot claim callback (port `ClaimRow` "Claim this spot →" from `GlobalGameCard.tsx:339-373` — an affordance Showcase lacks), expand-history plumbing (`hasMultiple`, `expandedPlayer`, `playerHistory`, `historyLoading`, `onTogglePlayer`). Colors via CSS tokens, not literal-hex theme objects, so the incoming owner podium design is a single-file swap.
3. **Behavioral scope: room-card contract, Global skin.** Keep every room-card behavior: verified badge, inline score-history expand, viewer-row injection, QR block, maintenance timer, tournament name/type labels, admin style-image resolution (`resolveImages()` per BannerCard precedent, falling back to `lb.imageUrl`). Scope OUT Global-only payload features: origin `RoomTag`, `neighbors`/density planner, `score_count` footer semantics (use room semantics: players-shown count).
4. **Auto-convert rule:** migration converts rooms with NO `SCOREBOARD_STYLE` row (the legacy-path rooms) → `'arcade'`. Rooms with an explicit stored choice (banner/showcase/minimal) keep it. New-room seed in `GameRoomService.create` flips `'banner'` → `'arcade'` (the P0 comment marks the spot). Update `api-public-room-creation.test.ts:67,89` assertions.

## File checklist (from recon, verified paths)

1. `admin-ui/src/lib/scoreboardThemes.ts:206` — `ScoreboardStyle` union += `'arcade'`; `STYLE_WIDTHS` + `STYLE_LABELS` entries.
2. `admin-ui/src/lib/scoreboardConfig.ts:97` — validation whitelist += `'arcade'`.
3. `admin-ui/src/components/scoreboard/CardRouter.tsx` — import + `case 'arcade':`.
4. NEW `admin-ui/src/components/scoreboard/ArcadeCard.tsx` — same `commonProps` contract as siblings.
5. NEW `admin-ui/src/components/scoreboard/ArcadePodium.tsx` — the swap seam.
6. `admin-ui/src/components/scoreboard/StyleThemePicker.tsx` — `STYLE_ICONS` + style array += arcade (first position; it's the flagship/default).
7. `admin-ui/src/components/ScoreboardPreferencesModal.tsx:33-37` — second hardcoded `STYLE_OPTIONS` list (silently omits Arcade if missed).
8. CSS: new `--sb-arcade-*` (or reuse `--sb-*`) tokens in `admin-ui/src/index.css`; ensure `.theme-light`/`.theme-coffee` overrides where Global already defines them; base colors via `--color-*` utilities per decision 1.
9. `src/services/GameRoomService.ts:87-96` — seed flip `'banner'`→`'arcade'`.
10. NEW migration (claim next free number in `database.ts`): insert `SCOREBOARD_STYLE='arcade'` for rooms lacking the key.
11. Tests: `scoreboardConfig.test.ts`, `StyleThemePicker.test.tsx`, `ScoreboardWysiwygParity.test.tsx` (parametrized table line ~168), `api-public-room-creation.test.ts`, new `ArcadeCard`/`ArcadePodium` tests.
12. No changes needed: `ScoreCardGrid`, `ScoreboardSurface`, `ScoreboardPreview`, `KioskScoreboard` (generic dispatch).

## Acceptance

- Mock-data screenshot loop (vite preview + repo playwright, SW blocked, generic mocks first) per rapid-UI-iteration feedback; then owner's room (rtx) screenshots — owner judges by screenshot before merge.
- No ellipsized game titles (wrap/scale, FitRowName where applicable).
- Backend + admin-ui suites green from their baselines; both builds; CRLF check.
- Phase 1 ALSO includes (same arc, possibly follow-up PR): three-tier picker (Looks row Arcade·Banner·Showcase·Minimal), pruned advanced editor ~61→~30 with named sections, Settings preview replaced with real `ScoreboardSurface` + phone toggle.
