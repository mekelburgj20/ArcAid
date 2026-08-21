# Contract: landing-page login + My Game Rooms + Brave push hint (v2.37.0)

Three FE-focused deliverables from live user feedback. No migration (next free 115 stays free).

## D1 — Login on the landing page

`admin-ui/src/pages/LandingPage.tsx` (route `/` in App.tsx, currently NOT wrapped in ViewerAuthProvider — verified in earlier recon):

1. Wrap the `/` route in `<ViewerAuthProvider>` in App.tsx (mirror `/my-rooms`).
2. Header (the bar with the "Admin" link): signed-out → the shared `LoginButtons` (both providers, compact — check LoginButtons' existing size/variant props; if it only comes large, a compact variant prop is in scope). Signed-in → the shared `UserMenu` (same props pattern as GlobalScoreboard's usage — it's one of the 3 existing UserMenu call sites, copy its wiring). Keep the "Admin" link (it serves the super/room-admin login path) — place it beside the login area, deemphasized as today.
3. Login state must NOT disturb the logged-out layout otherwise (hero, Global Scoreboard strip, room grid unchanged).

## D2 — My Game Rooms section

When signed in, fetch `GET /api/me/rooms` (existing endpoint powering MyRooms.tsx — reuse its fetch/auth-header pattern; verify response shape from MyRooms.tsx and the BE route in global.ts).

1. New section "My Game Rooms" ABOVE the existing "Game Rooms" section: same RoomCard grid, listing the user's rooms (member/admin). Render only when signed in AND the list is non-empty.
2. Dedupe: rooms shown in "My Game Rooms" are EXCLUDED from the public "Game Rooms" grid below (match by room id).
3. If `/api/me/rooms` rooms lack the enrichment fields the public cards show (activeGames/activePlayers/logo etc. from GET /api/rooms), prefer the simplest correct approach: intersect — my-rooms ids against the already-fetched public rooms list for card data, and for member rooms NOT in the public list (unlisted rooms the user belongs to), render the card with whatever fields `/api/me/rooms` provides (graceful degradation). Do NOT add BE enrichment to /api/me/rooms unless it's trivial reuse of the existing enrichment helper in global.ts — implementer's call, document it.
4. The existing "Create Game Room" card stays at the end of the public grid (unchanged).

## D3 — Brave push hint (AccountSettings)

`admin-ui/src/pages/AccountSettings.tsx` (~:375 subscribe + ~:397 catch): when `pushManager.subscribe()` rejects AND `Notification.permission === 'granted'` (i.e. the AbortError/"push service error" class — permission was fine but the browser's push service refused), extend the error message with a Brave-aware hint: "If you use Brave: enable 'Use Google services for push messaging' in brave://settings/privacy, relaunch, and try again." Detection: `err.name === 'AbortError'` OR message containing 'push service'; do not attempt navigator.brave detection gymnastics — show the hint for the whole failure class (harmless for non-Brave users hitting the same class). Keep the existing denied/not-granted messages untouched.

## Constraints

- FE-only unless D2.3's trivial-reuse clause triggers (document if so). No migration. No new deps.
- LandingPage stays functional logged-out with zero visual regression (screenshot-comparable).
- Do not touch: room creation flow, GlobalScoreboard strip, UserMenu items themselves.
- Hygiene: no `git add -A`; version via Edit; no SW bump.

## Tests

- Extend/add: a LandingPage test if the harness mounts pages cheaply (check existing page-test precedent; PublicLayout has tests) — minimum: the dedupe logic extracted as a pure helper with unit tests (my-rooms ∩ public split). D3: if the error-message branch is extractable as a pure function, unit-test it; else note manual-only.
- Existing suites green (backend full — should be untouched; admin-ui build + vitest).

## Process

Branch `landing-login` off main. Implement, gates (root build, backend vitest, admin-ui build+vitest, docker compose build), version → **2.37.0**, no CHANGELOG edit, commit `feature:`, do NOT push/PR. Report: files, decisions (esp. D2.3 enrichment choice), verbatim gates, SHA, blockers.
