# Contract: first-login player tutorial (v2.48.0)

Spotlight-style intro tour for newly logged-in players, room-page perspective. Design source:
ROADMAP.md "First-login player tutorial". Migration budget: **121** (verified free). Version
2.48.0. No new dependencies — in-house overlay.

## Settled decisions (user-confirmed 2026-07-28 — do not relitigate)

1. **Trigger = first authenticated ROOM-page visit**, not literal first login. Fires when, inside
   the PublicLayout tree: `discordUser` is truthy AND server says tour not seen AND none of the
   exclusions below apply. A player who logs in on a global page simply gets the tour on their
   first room visit.
2. **Account-menu step spotlights the avatar trigger button only** with descriptive copy — do NOT
   add a controlled-open prop to UserMenu, do NOT force the menu open.
3. Logged-in players only; guests out of scope (no anon fallback in v1).
4. Kiosk (`/:slug/kiosk`) is structurally excluded (separate tree, no ViewerAuth) — no flag
   needed; just keep all tour code inside the PublicLayout tree.

## Persistence

- **Migration 121** `121_user_preferences_tutorial_seen`:
  `ALTER TABLE user_preferences ADD COLUMN tutorial_seen_at TEXT` (nullable ISO timestamp —
  chosen over boolean for future re-show resets). Idempotent per the migration array's existing
  ALTER-add conventions (check how prior ALTER-add migrations guard on duplicate column).
- **Endpoints** in `global.ts` beside the other `/me/*` routes, `requireDiscordUser`:
  - `GET /api/me/tutorial-status` → `{ seenAt: string | null }`
  - `POST /api/me/tutorial-status` → sets `tutorial_seen_at = now` (idempotent). No body needed.
  - Implement via `PreferencesService` (typed static methods over the dedicated column — follow
    the ui_theme/scoreboard_prefs precedent, NOT the notification_prefs shared-JSON-blob pattern).
- **Session-only dismissal** ("skip but maybe later"): sessionStorage key
  `arcaid_tutorial_dismissed` — see Behavior.

## Behavior

- **TourController** component mounted inside PublicLayout (after the RoomJoinGate resolves, so a
  gated room never shows it). On mount with `discordUser` truthy:
  1. Bail if `useSearchParams()` has `submit-draft` or `submit-cancelled` (PendingSubmissionWatcher
     owns that moment — do not mark seen; tour appears on the next room visit).
  2. Bail if `sessionStorage['arcaid_tutorial_dismissed']` set.
  3. `GET /me/tutorial-status`; bail if `seenAt` non-null. (Fetch failure = bail silently; never
     block the page on this call.)
  4. Otherwise start the tour after a short delay (~600ms) so the page settles.
- **Steps (4):**
  1. **Nav bar** — anchor the nav-items container (`data-tour="nav"`). Copy draft: "Find your way
     around — Lobby, Scores, Picks, and more."
  2. **Scores tab** — anchor the Scores NavLink (`data-tour="nav-scores"`). Copy: "Scores is where
     the leaderboards live — and where you post your own."
  3. **Game card title** — anchor the first `[data-tour="game-card-title"]` in the DOM. Copy:
     "Click any game's title for full standings, details, and score submission." **Skip this step
     entirely if no such element exists** (empty room, or user not on the scoreboard page — do NOT
     navigate them; steps must tolerate missing anchors by skipping).
  4. **Account menu** — anchor the UserMenu trigger (`data-tour="user-menu"`). Copy: "That's you —
     Account settings, Scoreboard display options, and Friends live here."
- **Controls:** Back / Next buttons; step dots; "Skip tour" visible from step 1; a "Don't show
  this again" checkbox (default CHECKED) shown alongside Skip. Semantics: finishing the tour →
  always `POST /me/tutorial-status`. Skip with checkbox checked → POST. Skip with checkbox
  unchecked → sessionStorage dismissal only (tour returns next session). Esc = Skip (respecting
  the checkbox state). Clicking the dim backdrop does nothing (prevents accidental dismissal).
- Copy strings live in one exported const array (steps config) so the screenshot-loop iteration
  can tune them in one place.

## Overlay implementation

- New `admin-ui/src/components/TourOverlay.tsx` (+ the steps config + TourController; keep it to
  2-3 files). Rendered via `createPortal` (established pattern — Tooltip/GameInfoPopup), `z-[100]`
  (above the `z-50` modals/toasts).
- **Spotlight cutout:** a fixed-position div matching the target's `getBoundingClientRect()`
  (plus ~8px padding, rounded corners) with `box-shadow: 0 0 0 9999px rgba(0,0,0,0.7)` — the
  simple cutout technique, no SVG mask. Recompute on step change and on window resize (listener);
  `scrollIntoView({ block: 'nearest', inline: 'nearest' })` the target first (the mobile nav
  strip scrolls horizontally — a target can be off-screen).
- **Tooltip bubble:** positioned adjacent to the cutout (above/below by available space), theme
  tokens ONLY (`bg-surface`, `border border-border`, `text-primary`/`text-muted`, `text-neon-cyan`
  accent for the step count / Next) — must look right in all 17 themes incl. light.
- **Focus trap + restore** per the hand-rolled GameQuickView pattern (Tab loop, restore
  `previouslyFocused` on close). `role="dialog"` + `aria-label="Welcome tour"`.
- **Reduced motion:** any transition/animation (spotlight move, fade-in) gets the scoped inline
  `<style>` block with `@media (prefers-reduced-motion: reduce) { ... { animation: none !important;
  transition: none !important; } }` — the LandingPage.tsx convention.

## Anchor groundwork (required)

- `PublicLayout.tsx`: `data-tour="nav"` on the nav-items scroll container; `data-tour="nav-scores"`
  on the Scores NavLink (and nothing else — other items don't need attributes yet).
- `UserMenu.tsx`: `data-tour="user-menu"` on the trigger button (attribute only, no behavior change).
- `BannerCard.tsx` / `ShowcaseCard.tsx` / `MinimalCard.tsx`: `data-tour="game-card-title"` on the
  title link element in each (there is no stable style/theme-agnostic selector otherwise).

## Tests

- BE: migration 121 fresh-run + endpoints (GET null → POST → GET timestamp; unauthenticated 401;
  idempotent double-POST).
- FE (vitest + RTL, following existing admin-ui test conventions): TourOverlay renders steps,
  Next/Back advance, missing-anchor step is skipped, Skip-with-checkbox fires the POST (mock
  fetch), Skip-unchecked sets sessionStorage and does not POST.
- Existing suites stay green (746 BE / 132 FE baseline).

## Docs

- CHANGELOG v2.48.0 entry. Do NOT touch ROADMAP/SPRINT_STATUS (session close handles them).
- Copy uses "Arcaid" casing.

## Gates (all mandatory)

Root build · admin-ui build · full BE + FE suites · CRLF numstat check · **no commit/branch/push**.

## Blockers policy

Code contradicting the contract (PublicLayout structure drifted, PreferencesService shape doesn't
fit, RTL harness can't portal-test) → stop and report, don't guess. Visual polish beyond the
theme-token baseline is deliberately deferred to a Fable-run screenshot loop after this lands —
build it clean and structural, not pixel-perfect.
