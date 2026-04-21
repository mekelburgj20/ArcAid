# ArcAid v2.2.6 — Room-scoped card links, global-page nav, leaderboard UX, Mystery Award pool selector

**Released:** 2026-04-21
**Baseline:** v2.2.5 (commit `4aa4965f`)

Five UX follow-ups from v2.2.5 manual testing. No schema changes.

## 1. Tournament card links go to Room Game Detail

**Problem.** `GameCard.defaultLinkTarget` and `GamesTabView` preferred Global
Game Detail (`/games/:globalGameId?from=:slug`) whenever a game had a
`globalGameId`. The Global page correctly hides anonymous submissions via
the v2.2.0 fan-out gate, so users who just submitted as a guest would see
the score on the Tournament card, click through, and find an empty
leaderboard. Surfaced in playbook test 1: "Score does NOT appear on game
room at URL `/arcaid_demo/games/<uuid>` nor `/games/<uuid>?from=arcaid_demo`".

**Fix.** Always route to room-scoped Game Detail (`/:slug/games/:name`) from
room-page cards. Global Game Detail stays reachable — via `/scoreboard`
tiles, or by deep-link — but room-originated clicks keep the audience view
consistent.

## 2. UserMenu shared across Global pages

`GlobalScoreboard` and `GlobalGameDetail` had their own inline `avatar +
Logout` / `Login` UI. Now they use the same `UserMenu` component as
`PublicLayout`, so My Rooms / Friends / Scoreboard-display / Log out are
accessible from global surfaces too. Kiosk pages remain unchanged.

## 3. "Login" everywhere public-facing

`Friends`, `MyRooms`, `GlobalScoreboard`, `GlobalGameDetail` — all now say
"Login" instead of "Login with Discord". Admin login pages (`Login.tsx`,
`RoomLogin.tsx`) keep their existing labels because those are specifically
the admin flow affordances.

## 4. Room Game Detail leaderboard username click → player stats

The username in a Room Game Detail leaderboard row is now a `<Link>` to
`/:slug/players/:name` with `onClick stopPropagation` so the row-click
expand-history (v2.1.0) still works when the user clicks anywhere else on
the row.

## 5. Scorecard expand icons actually expand

**Problem.** `BannerCard` / `MinimalCard` / `ShowcasePodium` / `ScoreList`
all had expand logic wired (`togglePlayer`, `+` / `-` indicators, inline
history panels), but the `z-10` Link overlay in `GameCard` sat above the
card content. Every click went to the Link → navigate, never to the
expand onClick.

**Fix.** Wrap `CardRouter` in `<div className="relative z-20 pointer-events-none">`
in `GameCard`. Inside each card style, any element with an `onClick` gets
`pointer-events-auto` explicitly — interactive score rows capture their
own clicks; non-interactive areas still pass through to Link (card still
navigates on background clicks).

## 6. Mystery Award — Pool selector for multi-tournament rooms

`MysteryAwardPage` used to auto-pick the first active tournament (`.find(t => t.is_active)`)
and stop there. Rooms with multiple active tournaments (Daily Grind + Weekly
Grind + …) had no way to spin from a specific pool.

**Fix.** Load all active tournaments, render a small "Pool: [▼]" select in
the header overlay when there's >1. Changing it re-fetches
`/game-availability/:tournamentId` and re-spins against the new pool.
Defaults to the first active tournament (prior behavior for
single-tournament rooms). Hidden entirely when only one active tournament
exists, so the UI stays clean for typical rooms.

## Files touched

- `admin-ui/src/components/cards/GameCard.tsx` — link target + z-20 wrapper
- `admin-ui/src/components/GamesTabView.tsx` — link target
- `admin-ui/src/components/scoreboard/BannerCard.tsx` — pointer-events-auto
- `admin-ui/src/components/scoreboard/MinimalCard.tsx` — pointer-events-auto
- `admin-ui/src/components/scoreboard/ShowcasePodium.tsx` — pointer-events-auto (inline style)
- `admin-ui/src/components/scoreboard/ScoreList.tsx` — pointer-events-auto (inline style)
- `admin-ui/src/pages/GameDetail.tsx` — username → player-stats Link
- `admin-ui/src/pages/GlobalScoreboard.tsx` — shared UserMenu, "Login" label
- `admin-ui/src/pages/GlobalGameDetail.tsx` — shared UserMenu, "Login" label
- `admin-ui/src/pages/Friends.tsx` — "Login" label
- `admin-ui/src/pages/MyRooms.tsx` — "Login" label
- `admin-ui/src/pages/MysteryAwardPage.tsx` — tournament pool selector
- `package.json` + `admin-ui/package.json` — `2.2.5` → `2.2.6`

## Upgrade notes

Drop-in. No schema changes, no config changes.

## Rollback

Previous tag: `4aa4965f`. Safe.
