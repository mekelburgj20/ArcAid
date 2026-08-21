# S21 Contract — True Mobile Card Layout + Kiosk Distance Tuning (v2.30.0)

**Branch:** `s21-mobile-cards` (create from current `main`).
**Scope:** admin-ui ONLY (recon confirmed FE-only is achievable — the settings store is generic and `KIOSK_*` already passes the `scoreboard-config` prefix whitelist). No backend changes, no migration (next free stays 113), no SW work (automatic).
**Version:** bump root `package.json` to `2.30.0` at the end.

All file:line refs verified by fresh recon (2026-07-23, post-S20). Where older docs disagree, this contract wins.

## Hard constraints

1. Never run `npm install`/anything writing a lockfile. No new dependencies. `npm ci` only if node_modules breaks.
2. Do NOT touch: `sw.js`, `swBuildId.ts`, the SW vite plugin, backend `src/`, `GlobalScoreboard.tsx`'s own local GameCard (separate system, deliberately out of scope).
3. Do NOT collide with S20's shipped work: the safe-area `calc(36px + env(...))` box-sizing pattern on the tickers, the reduced-motion guards, the 44px targets, ThemeProvider. Preserve those behaviors through your edits.
4. Ambiguity or contradiction → structured BLOCKER in the final report, don't guess.
5. Commit locally on the branch (`s21:` prefix). No push, no PR.

## Orchestrator decisions on the recon's open questions (final — encode these)

- **Q1 preview:** the admin ScoreboardPreview's inability to simulate ≤640px is OUT of scope. Do not build preview mobile simulation. (Goes in the deferred list.)
- **Q2 SCOREBOARD_ZOOM on phones:** gate it OFF at ≤640px on BOTH pages — phones always get the new natural-scale layout regardless of the TV-oriented zoom value. Desktop (>640px) behavior unchanged.
- **Q3 ticker:** ≥16px is KIOSK-ONLY (TV viewing distance). `components/ScoreboardTicker.tsx` (phone-facing) stays 12px, untouched.
- **Q4 wrapper inconsistency:** the new mobile layout applies UNIFORMLY — rankings rows included — on both Scoreboard and Kiosk pages (resolves the current inconsistency where Kiosk excluded top/bottom rankings from the scaled zone).
- **Q5 KIOSK_ZOOM per-viewer override:** NO. Room setting only (matches KIOSK_ENABLED precedent — kiosks are operator-controlled displays).
- **Q6 clamping:** keep the existing client-only convention; additionally clamp defensively in `deriveScoreboardConfig` (cheap, FE-side): mobileScale to [0.3, 1.0], kioskZoom to [50, 300].

## Work items

### 1. mobileScale becomes an opt-in densifier (default 1.0 = no shrink)

- `lib/scoreboardConfig.ts:134`: default `0.85` → `1.0`; update the interim-mitigation comment (S21 is the promised work — the hack is now opt-in only). Clamp parsed value to [0.3, 1.0].
- The CSS fallbacks `var(--mobile-scale, 0.85)` in `Scoreboard.tsx:335` and `KioskScoreboard.tsx:390` → `1`.
- Relabel both UI surfaces to density semantics: `Settings.tsx:1080-1095` (label/hint: shrink cards to fit more on screen; 1.0 = default full size) and `ScoreboardPreferencesModal.tsx:130`. Keep key name `SCOREBOARD_MOBILE_SCALE`, keep ranges. Rooms/viewers with an explicit value keep their behavior.

### 2. True mobile layout at ≤640px (the meat)

Target: with mobileScale at 1.0, a phone sees ONE full-width column of cards at natural (desktop) type scale — no zoom shrink, no fixed-px card width, readable text.

- **Card width:** at ≤640px (within the existing `.scoreboard-mobile-vertical` CSS blocks in `Scoreboard.tsx:334-354` / `KioskScoreboard.tsx:389-396`), cards render `width: 100%` — override the inline `min(280|380px, calc(100vw - 2rem))` caps (`Scoreboard.tsx:519,547,559,585` and Kiosk equivalents). Prefer extending the existing `.scoreboard-mobile-vertical` CSS (`width: 100% !important; max-width: 100% !important` on the card wrappers) over touching every inline style — but if a targeted class on the wrappers is cleaner, that's fine. Keep sensible horizontal page padding (~1rem) so cards aren't edge-glued.
- **Type floors on mobile:** the smallest fixed sizes become readable at natural scale. In the same ≤640px blocks (or via component-level responsive values — your call, but keep it maintainable and note the choice): `ScoreList.tsx` rank 11px / name 13px / score 12px get floors of 12/14/13px minimum on mobile; BannerCard's `text-[10px]`/`text-[11px]` rows and ShowcaseCard's 9-11px badge/timer/footer sizes get a +1-2px mobile floor similarly. Do NOT redesign the cards — this is floors, not a type-scale overhaul. Verify longest realistic player names/scores don't wrap破 or clip at 100% width (they have MORE room than before, so risk is low — but check the flex/truncate behavior).
- **Uniform wrapper scope (Q4):** on KioskScoreboard, bring the top/bottom `RankingsRow` (`:245-247`, `:336-338`) inside the same mobile-layout treatment as the main content area so ≤640px is consistent across both pages.
- **SCOREBOARD_ZOOM gate (Q2):** the legacy `zoom: ${zoom}%` wrappers (`Scoreboard.tsx:361`, `KioskScoreboard.tsx:210`) must not apply at ≤640px. Cleanest: move the zoom to a CSS var + media-query-guarded rule (mirror the mobile-scale mechanism) so ≤640px forces zoom 100%. Behavior >640px byte-identical.
- **Legacy GameCard path** (`deriveCardProps`, rooms with no `SCOREBOARD_STYLE`): gets the same 100%-width + no-zoom treatment via the shared wrapper CSS; do NOT redesign the legacy card internals.

### 3. KIOSK_ZOOM setting (kiosk distance tuning)

- New room setting key `KIOSK_ZOOM` (integer percent). **Fallback chain preserves existing TVs: `KIOSK_ZOOM` if set, else `SCOREBOARD_ZOOM`, else 100.** No sudden default change — the plan's "default ~130-150%" is expressed as UI hint text, not an applied default.
- `scoreboardConfig.ts`: add `kioskZoom` to the interface + derive (parse, clamp [50, 300], fallback chain as above — derive may need both raw keys; follow the existing `zoom` derive pattern at `:103`).
- `KioskScoreboard.tsx`: page zoom now uses `kioskZoom` (desktop only, per item 2's ≤640px gate).
- `Settings.tsx`: add to the `'Kiosk'` category (`:107`) + `SETTING_LABELS`; numeric input like SCOREBOARD_MOBILE_SCALE's; hint text: "Zoom for TV/kiosk displays. 130–150% recommended for across-the-room viewing. Leave empty to use Scoreboard Zoom." No per-viewer override (Q5).
- Flows through `GET /:roomId/scoreboard-config` automatically (prefix whitelist) — zero backend work; verify at runtime, and BLOCKER if that turns out wrong.

### 4. Kiosk ticker ≥16px

`KioskScoreboard.tsx:342-364`: ticker title/ago text `text-xs`(12px) → 16px (`text-base` or explicit), icon `size={12}` → ~16. Grow the ticker's content-box height (`:348` — currently `calc(36px + max(0px, env(safe-area-inset-bottom)))`) to fit (≈46px), PRESERVING the S20 safe-area pattern exactly (both the height calc and the matching paddingBottom). Also check the marquee animation distance/duration still reads well with larger text (duration is distance-based? verify). `ScoreboardTicker.tsx` untouched (Q3).

### 5. Showcase secondary-text alpha floors (~0.55)

`lib/scoreboardThemes.ts`: raise to 0.55 — glass-deck `timerColor` 0.5 (`:89`) + `metaColor` 0.4 (`:124`); neon-circuit `timerColor` 0.5 (`:152`) + `metaColor` 0.15 (`:190`). AND the hardcoded `rgba(255,255,255,0.5)` footer-meta in the `cardBgFill` branch at `ShowcaseCard.tsx:369` → 0.55 (recon: theme registry alone won't cover this call site). Values already ≥0.55 untouched. (`ScoreList.tsx` prop-default alphas are dead code — leave.)

### 6. Tests

New `lib/__tests__/scoreboardConfig.test.ts` (first coverage for this module): (a) mobileScale defaults to 1.0 when unset, parses+clamps when set (0.2→0.3, 5→1.0); (b) kioskZoom fallback chain (unset+SCOREBOARD_ZOOM=130 → 130; KIOSK_ZOOM=150 wins; neither → 100; clamp 20→50, 999→300); (c) mobileVertical default true. Plus, if cheaply testable in jsdom, a render assertion that the mobile CSS block contains the zoom-gate (low value if it's just string-matching a <style> — skip with a note if tautological).

## Gates

1. `cd admin-ui && npm run build` clean.
2. `cd admin-ui && npx vitest run` all green (32 existing + new).
3. Root `npm run build` clean (untouched, parity).
4. `git status` clean of strays.

## Deliverable

Report: per-item file:line summary; the mobile-floor values chosen and where they live; confirmation the >640px desktop render is unchanged (walk the logic — no visual tooling exists); deviations with rationale; deferred list (preview mobile simulation, ScoreboardTicker font, anything else); BLOCKERS if any. No push/PR.
