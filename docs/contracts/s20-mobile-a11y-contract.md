# S20 Contract — Mobile & Accessibility Quick Wins (v2.29.0)

**Branch:** `s20-mobile-a11y` (create from current `main`).
**Scope:** admin-ui ONLY. No backend `src/` changes, no migration (next free stays 113), no `sw.js` changes (BUILD_ID is automatic since v2.28.0 — the manual CACHE_NAME ritual is retired forever).
**Version:** bump root `package.json` to `2.29.0` at the end.

This contract is based on a fresh recon (2026-07-22) — all file:line references below are CURRENT, unlike the June sprint plan. Where this contract and older docs disagree, this contract wins.

## Hard constraints

1. **Never run `npm install` / `npm audit fix` / anything that writes a lockfile** (Windows strips Linux optional deps → breaks the Docker build). No new dependencies — everything here is achievable with what's installed. `npm ci` is allowed if node_modules is broken, nothing else.
2. Do NOT touch: `admin-ui/public/sw.js`, `admin-ui/scripts/swBuildId.ts`, the `arcaid-sw-build-id` plugin in `vite.config.ts`, anything under repo-root `src/`.
3. Follow existing conventions: Tailwind utility classes for styling; raw `@media` only where the codebase already does it (`index.css` for the new global reduced-motion block; component `<style>` blocks that already exist). Comments only for constraints code can't express.
4. If anything is ambiguous or contradicts what you find, STOP on that item and return it as a structured blocker in your final report — do not guess.
5. Commit locally on the branch with a descriptive message (`s20: ...`). Do NOT push, do NOT open a PR.

## Reference patterns (read these first)

- `components/ScoreboardTicker.tsx:122-127` — the `prefers-reduced-motion` guard template.
- `components/UserMenu.tsx` — the codebase's best ARIA/keyboard reference (roving tabindex, aria-expanded, Escape-restores-focus).
- `pages/Scoreboard.tsx:473,512` — the ALREADY-CORRECT always-visible 44px "+" submit button (contrast with ScoreCardGrid's broken version).
- `components/ConfirmModal.tsx` — themed confirm replacement, props `{title, message, confirmLabel?, onConfirm, onCancel}`. Adopted in GameStates/Settings/GameRoomManager/Rankings.
- `components/Toast.tsx` — `useToast()`, provider already mounted at `App.tsx:114`.
- `src/components/__tests__/PublicLayout.test.tsx` — the test pattern to copy (MemoryRouter + fetch stub + probe component).

## Work items

### 1. Hover-only controls → touch/keyboard accessible

Fix pattern: controls must be visible and operable without hover. Preferred fix: always-visible at reduced emphasis on non-hover devices — add `focus:opacity-100 focus-visible:opacity-100` AND a `@media (hover: none)` / Tailwind arbitrary variant (e.g. `[@media(hover:none)]:opacity-100`) so touch devices always see them. Keep the hover-reveal aesthetic on pointer devices.

- `components/ScoreCardGrid.tsx:140-147` — the "+" submit button (`opacity-0 group-hover/card:opacity-100`, 32px). Make touch-visible AND bump to the 44px hit-target pattern used by `Scoreboard.tsx:473` (`w-11 h-11` outer hit area; visual can stay smaller).
- `pages/GameDetail.tsx:1539-1548` (`ScoreHistoryRow`) — self-delete trash: `opacity-0 group-hover:opacity-100`, NO focus fallback, ~12px icon. Add touch/focus visibility + pad the hit area to ≥44px (e.g. `p-3 -m-2` style, keep visual size).
- `pages/Leaderboard.tsx:498` (`AdminCardWrapper` toolbar) and `:711` (per-submission delete) — same fix.
- `pages/StyleCatalogue.tsx:241-254` — same fix (one-line class change; its `confirm()` at :83 is NOT in scope).
- `components/SetupChecklist.tsx:153` — SKIP (decorative text, not a control).

### 2. Replace `confirm()`/`alert()` — scoped to three files

Use `ConfirmModal` for confirms and `useToast()` for alerts. IN SCOPE:

- `pages/GameDetail.tsx:459,467,507` (score-delete confirm + failure alerts)
- `pages/GlobalGameDetail.tsx:365` (self-delete score)
- `pages/Leaderboard.tsx:538,766,781` (the file already half-uses toast in ManageScoresModal — finish the job)

NOT in scope (defer, listed in your report): GlobalCatalogue, LobbyAdmin, StyleCatalogue, SetupWizard, and Settings.tsx:582,653 (those two are unsaved-changes/router guards where synchronous `confirm` semantics are load-bearing — leave them).

### 3. Global `prefers-reduced-motion`

- `index.css`: one `@media (prefers-reduced-motion: reduce)` block disabling the keyframe-driven classes: `.title-glow` (:542 area), `.title-fire`, `.title-plasma`, `.pulse` (animation: none). This is deliberately the first `@media` block in index.css.
- Per-component guards mirroring `ScoreboardTicker.tsx:122-127`: `pages/KioskScoreboard.tsx:370` (`kiosk-ticker-scroll` — also serves OLED burn-in), `components/scoreboard/neonCircuitAssets.tsx:130` (`glow-pulse`), `components/MysteryAward.tsx:935` (`mystery-gi-pulse`).
- `pages/Scoreboard.tsx:309` `slideDown` toast — optional, one-shot animation, include only if trivial.

### 4. PublicLayout nav (`components/PublicLayout.tsx:87-143`)

- Convert `<Link>` → `<NavLink>` (react-router-dom, already a dependency); the `navItems` `end?: boolean` field already exists unconsumed — wire it. Active state: visible styling (accent color/underline consistent with the app's theme tokens) + `aria-current="page"` (NavLink provides this automatically).
- `aria-label` on the `<nav>` element; per-link `aria-label={item.label}` so mobile icon-only links are announced.
- Mobile (< sm): show small text labels under icons (e.g. `text-[10px]` stacked column) so the nav is labeled, AND bring per-item touch targets to ≥44px (`min-h-11`, adjusted padding). If labels make the row overflow with the current item count, fall back to icon-only + aria-labels at 44px and NOTE it in your report — the user does visual field-checks and will iterate.
- Discord login button (:135-143) and `UserMenu` trigger (`UserMenu.tsx:114`): bump to ≥44px hit area on mobile (visual size may stay).

### 5. color-scheme

- `index.css`: add `color-scheme: light;` inside the existing `.theme-light` (:59) and `.theme-coffee` (:173) blocks. Check the other 14 `.theme-*` blocks — any other light-background theme (judge by its `--color-bg`) also gets it. List which ones you included in your report.
- `pages/GlobalCatalogue.tsx:812,823,834`: delete the hardcoded `style={{ colorScheme: 'dark' }}` and change `text-white` on those `<select>`s to the themed text class used elsewhere on the page (match siblings).

### 6. ThemeProvider re-theme + per-slug key (S18-deferred item — the meat of this sprint)

Current architecture (`components/ThemeProvider.tsx`): mounted INSIDE `BrowserRouter` (main.tsx → AppWithTheme at App.tsx:219-227) — `useLocation()` IS available (the old "mounts above the router" note is wrong; verified). Root cause of the no-re-theme bug: `globalTheme = isAdminRoute() ? adminThemeState : publicThemeState` (:81) reads `window.location.pathname` directly and nothing re-renders on navigation.

Required behavior:
a. **Re-theme on navigation**: use `useLocation()`; derive admin-vs-public from `location.pathname`; include pathname (or the derived slug) in the hydration effect deps (:90) so admin↔public transitions and slug changes re-apply the correct theme class immediately.
b. **Read the per-slug key**: `arcaid-theme-public-${slug}` is currently write-only (:141). On entering a public route for slug X, initial/local theme resolution order = per-slug key → legacy `arcaid-theme-public` (STORAGE_PUBLIC_KEY, :71) → default; then the async `getPortal(slug).public_theme` hydrate may overwrite as today. Keep writing the per-slug key on `setPublicTheme`; keep the legacy un-suffixed write for back-compat (cheap, avoids breaking the pre-existing key's semantics for old sessions).
c. **No fetch storms**: `getPortal()` (lib/portal.ts) is cached/deduped per slug — calling it on navigation is fine; do not add new fetch paths.
d. Slug extraction must not misfire on non-room routes (`/scoreboard`, `/games/:id`, `/friends`, `/admin/*` — see App.tsx route table): only treat the first path segment as a slug on room-scoped public routes, matching however ThemeProvider/isAdminRoute distinguishes these today.

**Tests (required, this is the sprint's regression surface):** new `ThemeProvider` test file following the PublicLayout.test.tsx pattern: (1) navigating admin→public swaps `document.documentElement` class; (2) room A with saved per-slug theme, then navigating to room B, does NOT keep A's theme (per-slug isolation); (3) per-slug key is read at entry (seed localStorage, assert applied class). Stub `getPortal`/fetch.

### 7. Keyboard/ARIA

- `components/HorizontalScrollNav.tsx`: arrows currently only render off a document-level `mousemove` (:130-149) — no keyboard path. Add: reveal on `focusin`/focus-within of the scroll region, and make the scroll container focusable (`tabIndex={0}`, `role="region"`, `aria-label`) with ArrowLeft/ArrowRight scrolling handlers. Touch behavior unchanged (native scroll is intentional per the comment at :48-50).
- `components/GameQuickView.tsx`: add `role="dialog"`, `aria-modal="true"`, an `aria-label`, initial focus into the dialog on open, focus-return to trigger on close, and a minimal Tab focus loop (a small local/shared hook is fine — no library). Escape-close already exists (:59-63).
- `components/ConfirmModal.tsx`: add `role="dialog"` + `aria-modal` + initial focus on the confirm (or cancel) button — we're adopting it widely in item 2. Other modals: NOT in scope; list in the report as deferred.
- Expandable score rows — add keyboard operability (`role="button"`, `tabIndex={0}`, Enter/Space in `onKeyDown`, `aria-expanded`): `pages/GameDetail.tsx:715-720`, `pages/Leaderboard.tsx:669-673`, `components/scoreboard/ScoreList.tsx:66` (the live CardRouter path). The legacy `components/ScoreboardComponents.tsx:645-646` path: include only if trivial; otherwise defer + note.
- Add a vitest case for ScoreList keyboard expand (Enter toggles) if the component renders standalone in jsdom without heavy scaffolding; otherwise note why.

### 8. PWA polish

Icons ALREADY EXIST (generated by the orchestrator, committed with your work): `admin-ui/public/arcaid-icon-512-maskable.png` (512×512, art in the 80% safe zone, dark navy bleed) and `admin-ui/public/apple-touch-icon-180.png` (180×180). Your wiring:

- `public/manifest.json`: add `{ "src": "/arcaid-icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }` to `icons`. Leave `start_url: "/"` (decision: per-room manifest deferred).
- `index.html`: point `apple-touch-icon` at `/apple-touch-icon-180.png` with `sizes="180x180"` (replacing the current non-square `/arcaid-logo.png` link); add `viewport-fit=cover` to the viewport meta.
- Safe-area insets (required WITH viewport-fit=cover or notched iPhones will clip): `env(safe-area-inset-top)` padding on the PublicLayout fixed/top nav, `env(safe-area-inset-bottom)` on the ScoreboardTicker bottom marquee and KioskScoreboard bottom ticker. Use the CSS `max(existing, env(...))` pattern so non-notched devices are unaffected.

### 9. mobileScale interim bump (mitigation until S21)

Default 0.6 → **0.85** in ALL FOUR places (no shared constant exists — change all, note the drift risk in your report): `lib/scoreboardConfig.ts:132` fallback; the literal `var(--mobile-scale, 0.6)` in `pages/Scoreboard.tsx:330` and `pages/KioskScoreboard.tsx:378`; any displayed default in `Settings.tsx:1086-1094` / `ScoreboardPreferencesModal.tsx:130`. Keep min/max/step ranges as-is. Rooms with an explicit `SCOREBOARD_MOBILE_SCALE` keep their value — only unset rooms change.

### 10. 44px touch-target sweep (public surfaces)

Bring these to ≥44px hit areas (visual size may stay smaller — use padding/negative margin or min-w/min-h):
- PublicLayout nav items + Discord button + UserMenu trigger (covered in item 4)
- ScoreCardGrid "+" (covered in item 1)
- `pages/GameDetail.tsx:852-876` platform filter chips (~24px tall)
- `pages/Scoreboard.tsx:393-406` tab strip (good ARIA already, ~24px tall)
- Trash icons `GameDetail.tsx:1543` / `Leaderboard.tsx:711` (covered in item 1)
- `components/ShareButton.tsx:86-96` icon-only variant (~26px)
- `pages/GlobalGameDetail.tsx:648-664` delete/report icons (~14px)

## Gates (all must pass before you finish)

1. `cd admin-ui && npm run build` — clean.
2. `cd admin-ui && npx vitest run` — all green including your new tests.
3. Root `npm run build` — clean (should be untouched; run for parity).
4. `git status` — no stray files outside admin-ui + root package.json + this contract's expected surface.

## Deliverable

Final report: per-item summary of what changed (file:line), the new test list, every deviation from this contract with rationale, deferred-item list (for the ROADMAP note), and any BLOCKERS (structured: item, what you found, what you need decided). Do not push or open a PR.
