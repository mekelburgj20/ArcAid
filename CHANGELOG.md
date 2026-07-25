# Changelog

This file is the single source of truth for ArcAid release history. The legacy `releases/v*/README.md` per-version-directory convention was retired as of v2.3.0 — see [`releases/README.md`](releases/README.md) for context.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/).

---

## [2.39.0] — unreleased

**Approval rooms (private rooms).** A room can now be set to require approval — invisible to non-members beyond its name/logo, with a request-to-join queue.

- **`JOIN_POLICY` per-room setting** (`open` default | `approval`), a hand-rendered select beside the login-policy control in room Settings, in `DANGEROUS_KEYS`. Flipping to approval shows a confirm dialog (room becomes invisible to non-members AND its scores leave the Global Scoreboard).
- **View gate** — one `roomVisibilityGate` mounted once in `rooms.ts` (after portal/scoreboard-config, which stay reachable so the join screen renders on-brand). Non-members/guests get `403 APPROVAL_REQUIRED` on every scores/stats/lobby/history/games/pick endpoint; members, room admins, and super-admins pass. Portal carries `join_policy` + `viewer_status` so the FE gates before calling anything.
- **Join requests** (migration 116, `join_requests` + partial-unique on pending): `POST /api/me/rooms/:roomId/join-request`; room-admin queue page with approve/deny (approve → membership via v2.38's hardened path) + a 60s-polled nav badge. Approvers = room owner + room admins.
- **Leak closures** — WebSocket `join:room`/`join:lobby`/`join:game` membership-checked (token via Socket.io handshake `auth`); OG link-preview returns the generic shell for approval rooms; the five Discord cross-room read commands exclude approval rooms; global fan-out skips approval rooms and flipping to approval scrubs already-fanned rows + recalcs; the public `GET /api/rooms` list zeroes approval rooms' activity counts and nulls their invite URL (keeps name/slug/logo/`join_policy` for discovery).
- **Member-picker admin add** — room admins are added by picking from the member list (name + avatar, works for Google- or Discord-authed members) instead of pasting an opaque user ID; raw-ID entry kept as an advanced fallback.
- **Kiosk on approval rooms: not supported** this release (renders the join gate; `KIOSK_KEY` pairing is on the roadmap).
- **Security**: Opus adversarial review PASS-with-minors — view gate un-bypassable incl. the legacy-alias vector; the one metadata leak found (activity counts) fixed. 63 new tests; backend 516, admin-ui 110.

Migration 116 consumed — **next free is now 117**.

---

## [2.38.1] — unreleased

**Super-admin login hardening (no data was ever exposed).** Removed the public "Admin" link from the landing page — it invited any visitor to OAuth in with super-admin intent and land on the (data-less, server-403-gated) Super Admin shell, which looked alarming despite exposing nothing. `SuperAdminLayout` now role-guards on the token's `role` claim: a non-super-admin token bounces to `/login` instead of rendering the chrome. Server-side `requireSuperAdmin` was and remains the real gate (every `/admin/*` call 403s for non-super-admins); this closes the confusing empty-shell and trims needless attack surface. Super admins reach the panel directly at `/login`.

---

## [2.38.0] — unreleased

**Explicit room join/leave.** My Game Rooms is now curatable, not just activity-derived.

- **Join/leave endpoints** — idempotent `POST`/`DELETE /api/me/rooms/:roomId` (any signed-in provider). Implicit membership on score submission stays; leaving never touches admin grants; re-submitting a score re-joins.
- **Bookmark toggle on landing room cards** (`BookmarkPlus`/`BookmarkCheck`) with optimistic section re-splitting; room pages get a contextual join/leave item in the user menu; My Rooms page gets per-room leave. Shared `useMyRooms` hook backs all three.
- **Migration 115** — widens `room_members.source`'s CHECK to admit `'self_join'` (table rebuild per house pattern; handler-based so a failed rebuild halts startup instead of being silently marked applied).
- **Silent-failure hardening** — the join route re-verifies the insert landed and errors loudly if not; found via the implementing agent proving the old CHECK constraint made joins silently no-op while reporting success (a live instance of the known swallowed-SQL-error gotcha). Regression test included.
- **Tests** — 22 new (9 BE route incl. the silent-failure regression; 13 FE hook/toggle/menu/leave).

Migration 115 consumed — **next free is now 116**.

---

## [2.37.1] — unreleased

**Landing-page user-menu z-fix.** The header's `backdrop-blur` creates a stacking context that trapped the UserMenu dropdown's z-index — page sections below (promo strip, room cards) painted over the open menu. Header now carries `relative z-40`.

---

## [2.37.0] — unreleased

**Landing-page login + My Game Rooms + Brave push hint.**

- **Sign in from the front door** — the landing page header now offers Discord/Google login (and the standard user menu once signed in) beside the existing Admin link. Logged-out layout unchanged.
- **My Game Rooms** — signed-in visitors see the rooms they belong to in their own section above the public grid (deduped from it; unlisted member rooms render gracefully without public stats). Powered by the existing `/api/me/rooms` — FE-only.
- **Brave push hint** — when enabling browser push fails with the push-service-abort class despite granted permission (Brave with "Use Google services for push messaging" off), the error now appends the exact brave://settings/privacy fix instead of leaving a bare browser error.
- **Tests** — 14 new (landingRooms split/dedupe, pushError classification, LandingPage mount incl. logged-out regression).

FE-only, no migration (next free still 115).

---

## [2.36.0] — unreleased

**Google ↔ Discord account linking.** A user who started with Google can link their Discord account — both logins then resolve to one canonical identity (the Discord one), so names, scores, admin grants, and Discord features all unify.

- **Migration 114**: `user_identity_links(provider_user_id PK → canonical_user_id)` + canonical index.
- **Login-time canonical resolution** in both OAuth callbacks and token refresh: once linked, "Sign in with Google" signs you in *as your Discord-linked self*. Unlinked users: exact no-op.
- **Ownership-proving link flow**: Account Settings → "Link Discord account" → one-time crypto-random nonce (10-min TTL, single-use, bound to the authenticated Google identity) → standard Discord OAuth → server proves both identities before writing the link and rewriting attribution (scores across all four score tables, room memberships, preferences, push subscriptions, admin grants, sessions) in one transaction. Last-write-wins conflict rules (beta-accepted).
- **Unlink** (row delete only — identities diverge going forward; no un-merge, the confirm says so).
- **UserMenu** shows a "Link Discord account" nudge for Google-identity users and now reports the actual login provider (fixed a hardcoded "Logged in with Discord" label).
- **Security**: Opus adversarial review PASS — account-takeover vectors (link-to-victim's-Discord incl. super-admin escalation, victim's-Google-to-attacker's-Discord, nonce replay/CSRF/race) all verified blocked; 35 new tests incl. fail-on-revert takeover cases.

Migration 114 consumed — **next free is now 115**.

---

## [2.35.0] — unreleased

**Sign in with Google.** ArcAid is no longer Discord-only — Google is a full second login provider.

- **Google OAuth** end-to-end: `GET/POST /api/auth/google[/callback]` mirroring the Discord flow (no new dependencies; identity proven via Google's userinfo endpoint). Google users get namespaced subject IDs (`google:<sub>`) flowing through the existing identity columns — score attribution, display names, room membership, admin grants, web push, and web picks all work identically. Discord-channel features (DMs, @mentions, slash-command identity) are provider-gated and simply don't fire for Google users.
- **`provider` JWT claim** (absent = legacy = Discord) + `src/utils/identityProvider.ts` helpers; six ID-vs-username dispatch sites fixed to recognize namespaced IDs.
- **Google users can win tournaments**: winner resolution now prefers the top submission's own attribution before the Discord-command-populated `user_mappings` lookup — Google (and previously-unmapped Discord web) winners get picker slots and web-push "your turn to pick" instead of the silent admin-picks-manually path. Includes a sentinel-ID guard (`ANON`/`COMMUNITY`/`SYSTEM` legacy values can never be crowned).
- **3-state room login policy**: `REQUIRE_DISCORD_LOGIN` becomes Guests / Any login / Discord required (3-option select in room Settings; SubmissionSheet shows the right buttons + copy per policy; orphan-on-flip semantics preserved incl. a fixed `false→discord` transition bug).
- **Avatars**: migration 113 adds `user_profiles.avatar_url` (Google picture URLs) beside the Discord hash; shared `resolveAvatarUrl` helper replaces six hardcoded CDN-template sites.
- **All 12 login surfaces** show both providers (Discord-integrated rooms get a "Sign in with Discord for DM notifications and picks" nudge at the two config-aware sites).
- **Also fixed en route** (pre-existing): `/scoreboard-config` never included `REQUIRE_DISCORD_LOGIN`/`DISCORD_ENABLED` (silently-dead FE prop); token-refresh username/avatar now read `user_profiles` per doctrine (was `user_mappings`).
- **Security**: `GOOGLE_CLIENT_SECRET` encrypted at rest from day one (`DISCORD_CLIENT_SECRET`'s plaintext-at-rest gap documented in ROADMAP — not flipped here to avoid breaking prod decrypt-on-read). Opus adversarial security review: PASS, no majors.
- **Tests**: 5 new backend suites (identity helpers, Google OAuth, 3-state middleware matrix, notification gating, winner attribution) + FE avatar/login-policy coverage — backend 425, admin-ui 74.

Migration 113 consumed — **next free is now 114**. Requires `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in Global Settings for the Google buttons to function (Discord-only continues to work without them).

---

## [2.34.1] — unreleased

**Play-tester fixes: room-exit nav + number-field editing.**

- **Way back to the main page** — the ArcAid logo in the room header now links to the landing page (all game rooms); the room name still links to the room's home. Previously both were one link to the room home, leaving no path from inside a room back to the site's front page. Logged-in users also get an "All Game Rooms" entry in the user menu (all three surfaces that share it); guests' path is the logo (no guest menu exists).
- **Timeout/number fields can be emptied while typing** — `NumberStepper` (winner/runner-up pick windows, cleanup count, etc.) no longer snaps back to the minimum on every keystroke; the field may sit empty mid-edit and commits a clamped value on blur (reverting to the last valid number if left empty). ± buttons unchanged.
- **Tests** — 6 new NumberStepper cases (first coverage).

No DB migration (next free still 113).

---

## [2.34.0] — unreleased

**Card title alignment + info-popup hover.**

- **Reserved two-line title box** (Banner/Showcase/Minimal cards): a wrapping game title (e.g. "Black Knight Sword of Rage (Stern, 2019)") no longer pushes the card's meta row and podium/score area down relative to sibling cards — every title gets a fixed two-line box (derived from the card's title font size × its actual line-height), vertically centered, text clamped at 2 lines (full name remains on the game-detail page). Single-line titles center in the same box, so rows align exactly.
- **Game info "ⓘ" popup opens on hover** (mouse): hovering the icon opens the bubble after a 100ms intent delay; moving the pointer into the bubble keeps it open, and leaving both closes it after a 300ms grace period — so the game-source link inside is reachable and clickable. Touch keeps tap-to-toggle (hover handlers are gated on `(hover: hover)`); keyboard/Escape behavior unchanged.
- **Tests** — first GameInfoPopup coverage (3 fake-timer cases: open delay, grace-period close, re-enter cancels close).

No DB migration (next free still 113).

---

## [2.33.0] — unreleased

**Public self-serve room creation.** Anyone can create a game room from the landing site — no super-admin needed.

- **Landing page** gains a "Create Game Room" card after the room grid (doubles as the empty-state CTA). Links to the new `/create-room` page.
- **`/create-room`** — Discord-login-gated page (MyRooms pattern): room name, auto-derived editable URL slug, description, "list on landing page" checkbox. On success the creator is routed through the existing room-admin OAuth flow straight into their new room's admin dashboard (zero new auth surface — `DiscordCallback`/`auth.ts` untouched).
- **`POST /api/rooms`** (public, `requireDiscordUser`): creates the room in **standalone** mode (Discord/iScored off — upgrade later via Settings) and writes the creator as `role='owner'` in `game_room_admins`, atomically (room insert + settings seeds + owner grant in one transaction).
- **Guardrails:** 3 owned rooms per Discord user; new `roomCreateLimiter` (3/hour per user, per-`discordId` keyed) on top of the per-IP general limiter; server-side `RESERVED_ROOM_SLUGS` list so a room can't shadow `/admin`, `/scoreboard`, `/games`, `/assets`, etc.; `PUBLIC_ROOM_CREATION_ENABLED` global-setting kill switch (default on, unseeded — the future monetization lever).
- Super-admin create path (`POST /admin/rooms`, GameRoomManager) unchanged: no cap, no reserved-list.
- **Tests** — 6 new route-level cases (auth 401, create + owner grant + standalone seeds, reserved-slug 400, duplicate 409, cap 403, kill-switch 403).

No DB migration (next free still 113). Adversarial review PASS-with-minors; accepted residual risks documented in-code (bounded cap race) and in the PR (throwaway-account friction is Discord's, plus the kill switch).

---

## [2.32.0] — unreleased

**Standalone "pure ArcAid" room mode — Phase 1.** A room can now run with no Discord server and no iScored board, end to end.

- **Room creation choice** — super-admin create-room form gains a Connected / Standalone segmented choice (default Connected). Standalone seeds `DISCORD_ENABLED='false'` + `ISCORED_ENABLED='false'` at creation; the copy-onboarding-message generator branches to web-only setup steps (no Guild ID / iScored credential prompts). Absent mode = connected — existing callers and rooms unchanged.
- **Settings packaging** — the Discord and iScored credential categories collapse behind a quiet "Enable integrations…" affordance when their toggle is off (per-category; unset = visible, so existing rooms see no change). The Integrations toggles card and Discord Admins card stay visible — Discord OAuth is a room-independent identity provider.
- **Health card room-scoping (leak fix)** — `GET /:roomId/admin/health` now returns `iscored: {enabled, configured}` and filters poller accounts to the room's own iScored account. Previously the dashboard showed the GLOBAL poller map — i.e. other rooms' sync health — on every room's dashboard. Disabled rooms get a neutral gray "iScored disabled" state mirroring the Discord treatment.
- **Notification fixes (the bugs that would have silently killed the standalone winner flow):**
  - `NotificationService.notify()` no longer short-circuits on `DISCORD_ENABLED='false'` before the web-push branch — the gate now suppresses only the Discord DM, so standalone rooms' players get web push (`tournamentWin`, `rankDethroned`, and now `turnToPick`). Connected-room behavior is unchanged path-for-path.
  - `turnToPick` is now web-push-eligible with a deep link to the room's Picks page (was DM-only — the single most actionable notification in the pick flow had zero non-Discord delivery channel).
- **Tests** — 4 new web-push cases (Discord-disabled room still pushes, connected-room parity, turnToPick push with correct deep link, push-flag-off isolation).

No DB migration (next free still 113). Web push requires `WEB_PUSH_VAPID_*` keys seeded server-wide (S15) — verify on prod at deploy.

---

## [2.31.0] — unreleased

**Ranking-card restyle.** Ranking-group cards on the public scoreboard/kiosk no longer render flat gray for banner/minimal rooms, and now show which tournaments feed each ranking group.

- **Theme-derived card background** — banner/minimal rooms' ranking cards (all rankings styles: match, plaque, sidebar; compact keeps its deliberate no-chrome look) get an accent-tinted gradient built from the room theme's CSS variables (`--color-border-glow` over `--color-surface` via `color-mix`), so all 17 public themes flow through automatically. Root cause of the gray: the only themed background source was gated on showcase style — banner/minimal fell back to flat `var(--color-surface)` in every variant. Showcase rooms are background-unchanged.
- **Tournament chips** — each ranking card's header now lists the group's underlying tournaments as small pills colored by tournament type (gold/blue/purple/green — same scheme as Discord embeds, incl. tag-code types like `DG`/`WG-VPXS` via a FE port of `getTournamentColor`; unknown types render gray). Capped at 4 visible + `+N` overflow; chips wrap within the fixed card width.
- **Backend (additive)** — `GET /rooms/:roomId/rankings` group objects now carry `tournaments: [{id, name, type}]` (from the existing `ranking_group_tournaments` join — no schema change). FE tolerates its absence.
- **Tests** — new `tournamentColors` FE suite (5), `rankingsStyle` derivation coverage (3 — closing a pre-existing gap), and 3 backend `RankingService.tournaments` cases.

No DB migration (next free still 113).

---

## [2.30.2] — unreleased

**Kiosk scrollbar polish.** The kiosk page's horizontal card-row scrollbar is hidden entirely (`scrollbar-width: none` + webkit equivalent) — visual noise on a non-interactive TV display. Scrolling still works for the auto-scroll attract mode and incidental touch; the public Scoreboard page keeps its visible thin scrollbar (interactive surface, separate CSS copy).

---

## [2.30.1] — unreleased

**Kiosk auto-scroll attract mode.** When the kiosk's horizontal card row overflows the screen (typical once Kiosk Zoom is raised for TV distance), the row now slowly ping-pongs (40px/s, 3s dwell at each end) so every card gets screen time. Only activates on actual overflow; pauses 10s on any user input (wheel/touch/pointer); skipped under `prefers-reduced-motion`. New room toggle `KIOSK_AUTO_SCROLL` (Settings → Kiosk, default ON) — flows through the existing `KIOSK_` prefix whitelist, no backend changes.

---

## [2.30.0] — unreleased

**S21 — True mobile card layout + kiosk distance tuning.** Retires the mobile `zoom` shrink hack and decouples TV zoom from phone rendering.

- **True mobile layout (≤640px)** — cards render as one full-width column at natural type scale via `.scoreboard-card-slot` overrides (applied to layout wrappers AND the card components' own fixed-px root widths — Banner 280 / Showcase 380 / Minimal 380 / all six RankingGroupCard variants). Smallest text gets +1–2px readability floors (`.sb-fs-*` classes; `!important` so they beat inline `fontSize` styles).
- **`mobileScale` is now an opt-in densifier** — default 0.85 → **1.0** (no shrink unless a room/viewer explicitly sets it); relabeled "Mobile Density" in Settings + viewer prefs. S20's 0.85 was the interim mitigation; this is the promised fix.
- **`SCOREBOARD_ZOOM` no longer applies at ≤640px** on either page (`.scoreboard-page-zoom` gate) — a TV operator's zoom stops re-scaling phone visitors.
- **New `KIOSK_ZOOM` room setting** (Settings → Kiosk, 50–300%, hint recommends 130–150% for TV distance) with back-compat fallback chain `KIOSK_ZOOM → SCOREBOARD_ZOOM → 100` — existing TVs are byte-identical until the operator opts in. Flows through the `KIOSK_` prefix whitelist; zero backend changes.
- **Kiosk ticker** 12px → 16px text, bar height 36 → 46px (S20 safe-area pattern preserved).
- **Showcase secondary-text alpha floors ≥0.55** — glass-deck + neon-circuit `timerColor`/`metaColor` (neon-circuit meta was 0.15, near-invisible) + the hardcoded `cardBgFill` footer branch in `ShowcaseCard`.
- **Field-check fixes (pre-merge, all pre-existing defects surfaced by first real kiosk/mobile inspection):** the activity ticker was a fixed-bottom overlay painting over the Privacy/Terms footer — now mounted in-flow by `PublicLayout` above the footer (scoreboard route only; footer takes over the safe-area inset); both tickers' fixed 60s marquee (crawled on short feeds) replaced with distance-based speed (~70px/s, clamped 15–90s); bottom-anchored kiosk QR codes rendered cut off — the v2.13.3 overhang reservation had only ever been applied to `Scoreboard.tsx`, now mirrored across all six kiosk card-slot wrappers.
- **Tests** — first-ever coverage for `scoreboardConfig` derivation (15 cases: defaults, clamps, kioskZoom fallback chain incl. unparseable-input cascade) + a PublicLayout ticker-placement regression test.

No DB migration (next free still 113).

---

## [2.29.0] — unreleased

**S20 — Mobile & accessibility quick wins.**

- **Hover-only controls now touch/keyboard accessible** — the card submit "+" (ScoreCardGrid), GameDetail self-delete trash, Leaderboard admin toolbar + per-submission delete, StyleCatalogue icons: visible under `@media(hover:none)` and keyboard focus, with ≥44px hit areas.
- **`confirm()`/`alert()` → `ConfirmModal` + toast** in GameDetail, GlobalGameDetail, Leaderboard (remaining admin pages deferred to ROADMAP).
- **Global `prefers-reduced-motion` support** — index.css block for the shared keyframe classes + per-component guards (kiosk ticker, Neon Circuit glow, MysteryAward pulse, score toast).
- **PublicLayout nav** — `NavLink` with visible active state + `aria-current`, per-item aria-labels, small visible labels under icons on mobile, 44px targets (nav items, Discord button, UserMenu trigger).
- **ThemeProvider re-theme + per-slug theme key (S18-deferred)** — theme now derives from `useLocation()` (the "mounts above the router" premise was stale — it's a `BrowserRouter` descendant): admin↔public transitions and room changes re-theme immediately; the per-slug `arcaid-theme-public-<slug>` key is finally READ (was write-only — themes bled across rooms); reserved top-level routes guarded against slug misfire. Review caught + fixed a hydrate-on-every-navigation regression that would have reverted viewer-set personal themes (fails-on-revert regression test included).
- **`color-scheme`** — `.theme-light`/`.theme-coffee` get `color-scheme: light`; the default moved `body` → `html` so the per-theme cascade actually reaches native controls; GlobalCatalogue's hardcoded dark selects fixed.
- **Keyboard/ARIA** — HorizontalScrollNav focusable region + arrow-key scroll + focus-revealed arrows; GameQuickView + ConfirmModal get `role="dialog"`/`aria-modal`/focus management (`NeonButton` converted to `forwardRef` so refs actually work); expandable score rows keyboard-operable in all four implementations, with child-link Enter passthrough.
- **PWA polish** — new maskable 512px icon + real 180×180 apple-touch icon (the old link pointed at a non-square 1131×1189 logo); `viewport-fit=cover` + `env(safe-area-inset-*)` on the top nav and bottom tickers.
- **`mobileScale` interim default 0.6 → 0.85** (superseded by 2.30.0's 1.0).
- **44px touch-target sweep** — platform chips, scoreboard tab strip, ShareButton icon variant, GlobalGameDetail row icons.
- **Tests** — ThemeProvider navigation/per-slug isolation (4 cases) + ScoreList keyboard expand (2 cases).

No DB migration (next free still 113).

---

## [2.28.0] — unreleased

**S19 — Service-worker overhaul.** Kills the manual `CACHE_NAME` bump ritual and the unbounded image cache in `admin-ui/public/sw.js`, without breaking the update path for already-installed PWAs.

- **Build-derived BUILD_ID, no more manual bumping** — `admin-ui/vite.config.ts`'s new `arcaid-sw-build-id` Vite plugin (+ `admin-ui/scripts/swBuildId.ts`) computes a deterministic 12-hex-char id (sha-256 over the sorted built-asset filenames + `index.html` contents) and injects it into `sw.js`'s static cache name at `closeBundle`; throws loudly if the placeholder or `dist/sw.js`/`dist/index.html` are missing. Same build output → same BUILD_ID. `.claude/commands/release-docs.md` step 5 and `update-docs.md`'s doc inventory updated — the SW cache bump is no longer a release-checklist item.
- **Two caches, path-scoped routing** — `STATIC_CACHE` (`arcaid-static-<BUILD_ID>`, a new name every build) covers JS/CSS/fonts/`/assets/*`; `IMAGE_CACHE` (`arcaid-images-v1`, stable across deploys) covers the four image mounts (`/api/catalogue-images`, `/api/styles/images`, `/api/room-assets`, `/api/score-photos`) via stale-while-revalidate, LRU-capped at 200 entries. Image routes are matched before the static-asset extension regex, so they can no longer leak into the static cache — previously unbounded growth (4.9GB / 187k files of catalogue images alone) is now capped.
- **Activate sweep fixed to not eat the image cache** — deletes every cache except the two current names, clearing legacy `arcaid-v###` caches from pre-v2.28 installs and stale `arcaid-static-*` generations from prior deploys, while `IMAGE_CACHE` survives every deploy.
- **HTTP cache headers** (`src/api/server.ts`) — new exported `frontendStaticOptions()` sets `sw.js`/`index.html` to `Cache-Control: no-cache` on both the static mount and the SPA catch-all's `sendFile`/OG-shell response branches, so an installed PWA always revalidates and discovers the new BUILD_ID; `/assets/*` (Vite's content-hashed output) gets `public, max-age=31536000, immutable`.
- **Tests** — new `admin-ui/src/__tests__/sw.test.ts` (activate cache sweep, image/static/network-only routing, LRU eviction, `computeBuildId`/`injectBuildId`) and a new backend `src/__tests__/s19-static-cache-headers.test.ts` asserting the header contract against a fixture dist directory.
- Push notification handlers (S15) untouched, byte-identical.

No DB migration (next free still 113).

---

## [2.27.0] — unreleased

**S18 — RoomContext refactor (frontend-only).** Public pages resolved slug→room data redundantly: 9 raw `fetch('/api/portal?slug=…')` call sites plus 6 public pages fetching the FULL `/api/rooms` list just to resolve slug→roomId. Consolidated into one shared module-level portal cache plus one portal fetch in `PublicLayout`, provided to every child page via the existing `RoomContext`.

- **New `admin-ui/src/lib/portal.ts`** — `getPortal(slug)` returns a shared, module-level cached promise per (lowercased) slug, so concurrent callers for the same slug share one network request. Failed lookups are NOT cached (the map entry is deleted before the rejection propagates), so a transient failure doesn't permanently poison a slug.
- **`PublicLayout`** now does the ONE portal fetch for its entire subtree (dropped its separate full `/api/rooms` list fetch) and provides `RoomContext.Provider` around the `Outlet`/`PlayerQuickViewProvider` — every public page under it gets `{roomId, roomSlug, roomName}` for free via `useRoom()`, no fetch of its own. Loading renders the standard `LoadingState`; a portal 404 renders a friendly "Room not found" state instead of a blank/broken page. The nav-bar lobby-activity-dot poll no longer fetches the portal itself — it now waits on the layout's already-resolved roomId.
- **7 pages converted to `useRoom()`, 2 hooks to the shared cache:** `Scoreboard.tsx`, `Lobby.tsx`, `GameDetail.tsx` (were fetching `/api/portal` directly), plus `PlayerDetail.tsx`, `PublicStats.tsx`, `PublicHistory.tsx`, `ComparePlayers.tsx` (were fetching the full `/api/rooms` list purely to resolve slug→id). `usePickAwardEnabled` and `ThemeProvider`'s room-theme hydration now read through the same shared `getPortal` cache instead of their own private fetches. Five more pages call `getPortal(slug)` directly rather than `useRoom()` because they either sit outside `PublicLayout`'s subtree or need a field (`logo_url`) that isn't in `RoomContextType`'s frozen `{roomId, roomSlug, roomName}` shape: `KioskScoreboard.tsx`, `ScoreSubmit.tsx`, `GlobalGameDetail.tsx`'s `?from=<slug>` branch (standalone, can't sit under the provider), plus `Picks.tsx` and `MysteryAwardPage.tsx` (need `logo_url` for their cabinet backglass art — the portal response already carries it, so this drops their full `/api/rooms` list fetch too, at zero extra network cost since the slug's portal is already cached by `PublicLayout`).

Fetch-elimination tally: portal/rooms-list call sites collapsed from 9 raw `/api/portal` fetches + 6 full `/api/rooms` list fetches (used purely for slug→room resolution) down to 1 shared portal fetch per slug, reused by all 14 consumers. SW → `arcaid-v101`. No migration (backend untouched this sprint).

---

## [2.26.0] — unreleased

**S17 — Frontend performance (Phase D).** No behavior changes for players except faster loads and one filter-correctness fix.

- **Route-level code splitting** — the entire admin surface (both admin layouts + all 21 admin pages) is now `React.lazy`-loaded behind a single Suspense boundary. A player scanning a QR code no longer downloads a byte of admin code; admins pay one spinner on their first admin navigation per deploy. (Bundle numbers in the PR.)
- **`formatScore` centralized** — 11 page/component-local copies (plan said 8; it had grown) collapse into `lib/format.ts` (`formatScore` + `formatCompactNumber` for the LandingPage aggregate tiers). One deliberate keep: PublicStats' 4-tier K-compressor renders genuinely different output. Countdown helpers were already centralized next to `playerName()`; the two remaining variants have different signatures on purpose and were left.
- **GlobalScoreboard's third divergent platform taxonomy retired** — its local groups predated the FX-family split and sent retired tokens (`pinball_fx3`, `vr`) that match no post-migration-094 row, so **FX-era games silently dropped out of the "Virtual Pinball" filter chip; that's now fixed**. Groups + short chip labels now come from `lib/platforms.ts` (new `PLATFORM_GROUPS` + `getPlatformShortLabel` exports, mirroring the backend category taxonomy). One deliberate correction: AtGames moved from the Virtual Pinball group to Physical, matching the backend.
- **Lazy images** — `loading="lazy" decoding="async"` on below-the-header in-card images (score-row avatars, the global catalogue grid art, admin leaderboard style headers, YouTube tutorial thumbs); `decoding="async"` everywhere. Card-header art, page logos, and detail-page heroes deliberately stay **eager** — the first card row is the page's LCP candidate and the kiosk wall is always fully visible (adversarial-review catch).
- **Dead code deleted** — `PinballPicker.tsx` (1,093 lines) + the abandoned `cards/GameCard.tsx` wrapper (~450 lines), both zero-import.
- **Stale ROADMAP corrected** — the "batched score-counts endpoint" follow-up actually shipped in v2.19.0; re-verified and marked done. Folding counts into the leaderboard payload deliberately declined (one saved request isn't worth coupling the responses).

- **Flake-family straggler fixed (backend, 2 files)** — the v2.24.1 drain-hook sweep missed `void`-style fire-and-forgets: `MaintenanceRunService.record` raced the S10 tests' (and Force Maintenance's) read of the trail row — now awaited inside `runMaintenance` (record never throws, so the run can't break); ScoreSyncPoller's two `void OpsAlertService.sendOperatorAlert` calls now register with the background-task tracker. Surfaced by a CI flake on this PR's first run.

SW → `arcaid-v100`. No migration (next free still 113).

---

## [2.25.0] — unreleased

**Report-a-problem: user-filed catalogue corrections + per-field source stamping.** The long-parked ROADMAP feature, unblocked by ADR 0014's source-precedence policy.

- **"Report a problem" on game pages** — a flag link on the room Game Detail (below About This Game, shown when the game maps to a catalogue entry) and on the Global Game Detail hero. Discord-authed only (logged-out viewers get a login prompt in the modal). The form asks what's wrong (name / manufacturer / year / platforms / artwork / duplicate / other), an optional suggested correction, and an optional note. The server snapshots the disputed field's **current** value at filing time (never trusted from the client); duplicate open reports per (game, reporter, field) are rejected with a friendly 409, refiling after resolution is allowed.
- **Super-admin review queue** — new "Game Info Reports" card on `/admin/catalogue` (Open/Resolved toggle). Each report shows the game (with a "game removed" badge if it was merged/deleted since — reports are FK-less with a denormalized name), the disputed field, current → suggested values, the reporter's note, IPDB/OPDB reference links, a "Find in list" shortcut into the catalogue browser, and a **source badge** answering "is this field ours to fix or upstream's?". Resolutions: **Fixed** / **Upstream** / **Dismiss**, each with an optional resolution note.
- **Per-field source stamping (`global_games.field_sources`)** — the piece ADR 0014 deferred to this feature. Every write path now stamps which source last wrote each report-relevant field: catalogue importers via the `GlobalGameService.upsert` chokepoint (fields a source actually supplies get its `imported_from` label), admin manual edits stamp `manual` (presence-based — an explicit clear is still a manual write), and the background image downloaders stamp `artwork`. Legacy rows show "unknown" until a re-sync or edit touches them.
- **Migration 112** — `game_feedback` table (mirrors `score_reports`' shape; partial UNIQUE index blocks duplicate open reports) + the `field_sources` column. **Next free migration = 113.**

New `rap-game-feedback.test.ts` (9 cases: authz, server-side snapshot, duplicate/refile, unknown-game 404, empty-report 400, queue authz + list/resolve lifecycle, report-survives-game-deletion, and stamping at all three chokepoints). SW → `arcaid-v99`.

---

## [2.24.1] — unreleased

**Fix: CI flake — fire-and-forget post-submit chains raced the test DB reset.** The nested-transaction / `SQLITE_MISUSE` flakes (`community-scores-attribution` case (b), 2026-07-15; `room-scores` case (b), 2026-07-18 — the latter blocked the v2.24.0 deploy until rerun) were caused by fire-and-forget chains (lobby feed → achievements/milestones/friend events/notifications/web push, `RoomEventService.log`) still running when the next test reset the shared in-memory DB. New `src/utils/backgroundTasks.ts` — `trackBackground()` registry + `drainBackgroundTasks()` — wraps every such chain (the dynamic-import hops now RETURN the inner promise so the tracked chain settles only when the real work settles); the vitest setup drains before each DB reset. Production behavior unchanged (a Set add/delete per chain). `RoomEventService.log` is tracked at the source, covering its ~14 unawaited call sites at once.

---

## [2.24.0] — unreleased

**S16 — Shareability (Phase C): Web Share + OG link-preview meta.**

- **OG meta injection for link unfurls** — when a link-preview crawler (Discord, Slack, Twitter, Facebook, Telegram, WhatsApp, …) fetches `/:slug/games/:name` or `/:slug/players/:id`, the SPA shell is served with injected `og:title` / `og:description` / `og:url` / `og:image` + `twitter:*` tags, so shared links unfurl with the game or player name, the room name, and catalogue art (game art → room logo → ArcAid logo fallback). Player titles follow the display-resolution rule (`display_name ?? iscored_username`). **Safety contract:** only a curated preview-bot UA list ever receives modified HTML — human browsers always get the byte-identical shell via the unchanged `sendFile` path, every failure mode falls through to the unmodified shell, and the `OG_META_ENABLED` global setting (default on, select on Global Settings) is a kill-switch. New `src/api/ogMeta.ts`; the injection rides the existing SPA catch-all in `server.ts`.
- **Web Share buttons** — new `ShareButton` component (native `navigator.share` sheet where available; clipboard copy + 2s "Copied!" state otherwise): on the room Game Detail hero, the Player Detail action row (next to Follow/Compare), and the post-submit result card ("I'm #1 on Medieval Madness!" / "I'm #4 of 12 on …" with a link to the game's leaderboard — the OG meta above makes that link unfurl rich).

New `s16-og-meta.test.ts` (13 cases: bot-vs-human fall-through, kill-switch, unknown slug, display-name resolution, HTML escaping, catalogue-art og:image absolutization, route parsing incl. malformed encoding). SW → `arcaid-v98`. No migration (next free still 112).

---

## [2.23.2] — unreleased

**Room nicknames become a recognized identity lookup on room stat pages.** Discord OAuth login writes NO `user_mappings` row (a long-standing doc error claimed otherwise) — a player who logs in and submits on the web gets score attribution + a per-room `room_members.display_name` claim, but the name everyone sees them under was invisible to NAME-typed lookups, which read `user_mappings` only (field report: the operator's own alt). The room-scoped resolvers (`comparePlayersHeadToHead.resolve`, `getEnhancedPlayerStatsByUsername`) now fall back to `room_members(room_id, display_name)` when the global alias misses. Global alias always wins; **lookup-only** — no identity records are created, and NULL-attribution synced rows still fold solely via real alias links (per-room first-claim ≠ global alias ownership; the phantom-claim doctrine stands). Side benefit: player pages reached by a claimed nickname now expose `discordUserId`, so Follow gating works for web-native players. Backend-only, no SW bump, no migration. +3 tests.

---

## [2.23.1] — unreleased

**Fix: Compare / streaks / personal bests missed a Discord-linked player's pre-link scores (field report).** Comparing two players on the same leaderboard could return "No shared games yet": rows synced from iScored **before** an alias was Discord-linked carry `submitted_by_user_id` NULL and keyed as `iscored:<alias>` — a key the player-resolution side never produces for a mapped name, so half the player's history was invisible. All three S14/S13 per-player stats queries (`comparePlayersHeadToHead.bestPerGame`, `getParticipationStreak`, `getPersonalBests`) now use the **three-leg identity key** — `COALESCE(submitted_by_user_id, user_mappings.discord_user_id, 'iscored:' || LOWER(iscored_username))` — folding a linked alias's NULL-attribution rows into the mapped user (also collapses phantom split entries in personal-bests room ranks). Backend-only, no SW bump, no migration. +3 regression tests in `s14-social-loops.test.ts` (field-report shape, name-vs-snowflake cluster equality, streak fold).

---

## [2.23.0] — unreleased

**S15 — Web push (Phase C).** Browser push notifications as a second channel beside Discord DMs — opt-in, smallest shippable: `rankDethroned` + `tournamentWin` only.

- **Dispatch inside `NotificationService.notify`** — a push rides the SAME per-type opt-in + rate-limit result as the DM (one event = one budget slot), additionally gated on the user's `webPush` channel flag (in the `notification_prefs` JSON, set when they subscribe a browser) and the `WEB_PUSH_TYPES` allowlist. Fire-and-forget both ways: a push failure never affects the DM, and closed DMs never suppress the push. Payload = per-type title + markdown-stripped first line + deep link (`pushUrl` supplied by the two high-value call sites) + collapse tag.
- **`WebPushService`** — VAPID-signed sends via the `web-push` library; keys live in global settings (`WEB_PUSH_VAPID_PUBLIC_KEY` + `WEB_PUSH_VAPID_PRIVATE_KEY`, the private key added to `ENCRYPTED_SETTING_KEYS` so it's AES-GCM at rest), read through a 10s TTL cache. Both keys unset → the whole feature is inert (S10 OPS_ALERT ship-inert pattern). New `npm run generate-vapid-keys` prints a pair to paste into the super-admin Global Settings page (fields added there, private key masked).
- **Migration 111** — `push_subscriptions` (per-device rows keyed on `discord_user_id`, globally-unique `endpoint`, FK-less by design). Expired endpoints (HTTP 404/410) are pruned at send time; the account-deletion purge (S12) now deletes the user's rows.
- **Endpoints** — public `GET /api/push/vapid-public-key` (`key: null` = unconfigured, FE hides the UI); `POST /api/me/push-subscriptions` (Discord-authed + write-limited; endpoint-keyed upsert + merges `webPush: true` into the user's prefs server-side); `DELETE /api/me/push-subscriptions` (own rows only, device-level — the channel flag deliberately survives so other devices keep receiving).
- **Account Settings — "Browser push"** sub-block in the Notifications card: one device-level toggle (permission prompt → subscribe → server registration, with rollback on server rejection), blocked-permission guidance, iOS install-to-Home-Screen hint, hidden entirely when the server has no VAPID keys.
- **Service worker** — `push` (payload → tray notification) + `notificationclick` (focus an existing tab on the target URL or open one) handlers. SW → `arcaid-v97`.

New `s15-web-push.test.ts` (10 cases: payload shape/deep-link/markdown-strip, every suppress gate, shared rate budget, channel independence, 410 prune vs 500 keep, deletion purge, private-key encryption round-trip). **Migration 111 consumed → next free = 112.**

---

## [2.22.0] — unreleased

**S14 — Social & competitive loops (Phase C).** Built via the established Fable-orchestrated Sonnet workflow (recon → 4 work packages → check → orchestrator review; zero blockers).

- **Follow from player surfaces** — `POST /api/me/friends` now also accepts `{friendUserId}` (Discord snowflake; target verified against `user_profiles`/`user_mappings`, 404 unknown, 400 self; legacy typed-username path untouched). PlayerDetail + PlayerQuickView gain a Follow/Unfollow toggle (Discord-authed viewers, targets with a Discord identity only, optimistic with revert).
- **Head-to-head Compare** — new public `GET /:roomId/stats/compare?a=&b=` on the canonical `score_history` partition (best-per-game per player, alias-collapsed): shared games with leader + gap, exclusive-game counts, win totals. New `/:slug/compare` page (searchable picker; Compare buttons on PlayerDetail/QuickView pre-fill the viewer as the opponent).
- **Participation streaks** — `participationStreak {currentWeeks, bestWeeks}` on the enhanced player stats (SQL `LAG`-based week-consecutiveness — immune to the `%Y-%W` year-boundary trap), rendered as a Weekly Streak stat on both player surfaces (distinct from the champion streak). New `streak_extended` lobby feed event on a player's first score of the week when it extends a ≥2-week run (feed-toggle-gated).
- **Staleness challenge — the dead config knob finally works.** LobbyAdmin has shipped the setting (threshold, default 14d) and the feed renderer since Lobby v1 with **no backend emitter**; a new daily Scheduler job (per-room, `isTypeEnabled`-gated, app-level lookback dedupe, one emission max, per-room try/catch) now emits "It's been N days since anyone scored on X — beat the record!" with the record to beat in metadata.
- **Scoreboard ticker** — kiosk-style fixed-bottom marquee on the public Scoreboard (all three tabs): seeded from the lobby feed, kept live over the `lobby:` WebSocket channel (true push — the kiosk's poll-on-event pattern was not ported), pause-on-hover, `prefers-reduced-motion` fallback, hidden when empty.

Review fixes: compare pre-fill sends the viewer's snowflake (not the raw Discord username the resolver can't parse); `aOnlyGames`/`bOnlyGames` wire-type mismatch; Follow gated on the target having a Discord identity; `display_name` now mapped through on the all-players stats endpoint (pre-existing omission). New `s14-social-loops.test.ts` (follow-by-id, compare w/ alias collapse, deterministic streak week-math, streak-event dedupe, staleness gate/dedupe). SW → `arcaid-v96`. No migration (next free still 111).

---

## [2.21.3] — unreleased

**Safe bulk-merge learns corporate aliases + faithful JP recreations.** The first prod Execute (5 merged / 30 skipped) showed ~26 of the skips weren't real conflicts: (1) **corporate aliases** — the same maker under renamed/rebranded labels (`Alvin G.`=`Alvin G. & Co`, `Sonic`=`Segasa`, `Bell Games`=`Nuova Bell Games`, `MAC`=`Maguinas / Mac Pinball`, `Allied Leisure`→`Fascination`, `Cirsa`=`Unidesa`, `Spinball`=`Spinball S.A.L.`, `International`=`International Concepts`, `Jocmatic`≈`Joctronic`) — now a curated normalized-form alias map in the bulk-merge manufacturer normalizer (which also strips `/` and curly apostrophes); (2) **the `JP's` veto relaxed** — it now only fires when the manufacturer is *also* virtual-only, so JPSalas's faithful recreations of real machines (`JP's The Lord of the Rings (Stern, 2003)`) merge into the real machine's entry while `JP's Cyclone (Original, 2022)` fan tables stay excluded. Genuinely-different-maker groups (e.g. `Stern` vs `Allied Leisure`) still skip for human adjudication. +5 test cases. Backend-only, no SW bump. No migration (next free still 111).

---

## [2.21.2] — unreleased

**Safe bulk-merge surfaced on the Dedup Audit card.** After stripping, the second prod audit run left 35 real-vs-real shared-IPDB groups — exactly what `POST /admin/catalogue/merge-ipdb-duplicates` (the v2.13.0 safe bulk-merge: exact-year match, normalized-manufacturer agreement, community/digital rows excluded, richest-row-wins target selection) was built for, but it had no UI. The Dedup Audit card now has **Preview Safe Bulk-Merge** (dry run — shows mergeable count + per-group skip reasons) and **Execute Safe Bulk-Merge** (confirm-gated; re-runs the audit after). Skipped groups render with their reason (`year-disagreement` / `manufacturer-incompatible`) so the leftovers are a ready-made adjudication list. FE-only. SW → `arcaid-v95`. No migration (next free still 111).

---

## [2.21.1] — unreleased

**Fix: VPS "Not Available" placeholder junk polluted the dedup audit.** The first prod audit run (95 suspects) revealed a third failure mode: VPS ships a literal `"Not Available"` string in its `ipdbUrl` field and the importer copied it verbatim for years — harmless to dedup (unparseable, never matched the IPDB step) but junk in the identity column, and the v2.21.0 routing could even "preserve" it into `based_on_ipdb_url` on virtual rows.

- **Migration 110** — one-shot clear of every unparseable value (no `machine.cgi?id=`) from BOTH `ipdb_url` and `based_on_ipdb_url`; logs counts.
- **`upsert` door check** — unparseable IPDB values in either input field are dropped before routing/dedup, so junk can't re-enter from any importer.
- **Audit** — suspects now require a *parseable* link (real identity claims only); **strip** clears junk outright instead of relocating it to the reference column.

Extends `catalogue-dedup-hardening.test.ts` with junk cases (audit filter, strip-clears, upsert-drop, migration shape). No SW bump (backend-only). **Migration 110 consumed → next free 111.**

---

## [2.21.0] — unreleased

**Catalogue dedup hardening (ADR 0014)** — closes the class of corruption found in the 2026-07-02 prod dup review, where virtual-only tables (Zen Studios originals, `Original` fan tables) carrying the real machine's IPDB link got merged into the physical machine's catalogue identity. Doctrine: **manufacturer is the dedup discriminator** — same real manufacturer + shared IPDB = same machine; virtual-only/missing manufacturer = a different game whose IPDB link is a thematic reference.

- **Guard** — `resolveDedupCandidates`' IPDB step now refuses the match when either side's manufacturer is virtual-only (`isVirtualOnlyManufacturer`: 'Zen Studios'/'Original'/missing), falling through to name matching; covers `upsert` AND `findCandidates` via the shared walker. The old `manufacturerYearAgree` NULL-tolerance was the hole.
- **Routing (migration 109)** — new `global_games.based_on_ipdb_url` reference column; `upsert` normalizes input at the single chokepoint every importer flows through: a virtual-only row's incoming `ipdb_url` moves to `based_on_ipdb_url`, identity stays NULL. Also closes the re-plant hole: `upsert`'s `COALESCE(input, existing)` UPDATE meant every VPS re-sync since the 2026-07-04 strip run could silently restore stripped IPDB links.
- **Admin audit tool** — `GET /admin/catalogue/dedup-audit` (super-admin): state-based scan reporting suspects (virtual-only rows still holding an identity `ipdb_url`) and shared-IPDB groups (unresolved duplicates with a suggested action); `POST …/strip` remediates in-app (moves the link to `based_on_ipdb_url`, idempotent, auto-audited). Surfaced as a "Dedup Audit" card on the Catalogue admin page with per-row/Strip-All actions and merge-modal handoff for mergeable groups (`MergeModal` gained an optional `restrictToIds` prop).
- Source-precedence policy documented in ADR 0014 (real-machine mfr/year: IPDB > VPS > OPDB; external IDs: OPDB; virtual metadata: VPS). Per-field source storage deferred to report-a-problem.

New `catalogue-dedup-hardening.test.ts` (guard refusal + both-real merge, routing on virtual/missing mfr, re-sync re-plant regression, audit + strip idempotency). SW → `arcaid-v94`. **Migration 109 consumed → next free 110.**

---

## [2.20.2] — unreleased

**Three user-reported fixes from the v2.20.x tour (history completeness, game-page stats correctness, non-active game experience).**

- **History showed only recently-completed games** — `GET /:roomId/history` filtered `status='COMPLETED'` while the weekly cleanup flips old games to `ARCHIVED` (the `IN ('COMPLETED','ARCHIVED')` convention used everywhere else in StatsService). Both the admin History page and the public `/:slug/history` now show the full record.
- **Game-page stats missed community scores** — `StatsService.getGameStats` + `getGamePlayerRankings` read `submissions`, but community/freeplay submits write `score_history` only, so a new community high score didn't move Unique Players / Avg / All-Time High / Record Holder. Both now read `score_history` (canonical player partition, orphans excluded); Past Results stays tournament-derived. The rankings rewrite dodges SQLite's bare-column-with-multiple-MAX trap via the `ROW_NUMBER` pattern (a check-agent catch, reproduced empirically: a merged multi-alias user could otherwise show the wrong alias next to their best score).
- **Non-active games get the full page** — the game page only resolved a catalogue id (and leaderboard rows) from the ACTIVE tournament boards, so completed/pinned games had no About This Game section, no leaderboard, no expand/percentile. Now falls back to the room-scores data: an "All-Time Leaderboard" with expandable score-history rows + percentile, plus the About section. `GET /:roomId/score-counts` gains an optional `gameNames` param (name-keyed counts, needed because fallback cards carry catalogue ids, not games-table ids). The Leaderboard tab now also appears for permanently-pinned games.
- **About-section polish** — renders only when the catalogue row has real metadata; the "Unknown manufacturer" placeholder is gone (only present parts render).

New `gamedetail-history-stats.test.ts` (ARCHIVED inclusion, community-score stats, gameNames counts, orphan exclusion, multi-alias best-score alias regression). SW → `arcaid-v93`. No migration (next free still 109).

---

## [2.20.1] — unreleased

**Room game page gains the catalogue's "About this game" metadata** (user request, same-day as S13). The room Game Detail (`/:slug/games/:name`) and the global catalogue page (`/games/:id`) are deliberately separate — room-scoped scores/tournament context vs. the catalogue entity — but the room page never surfaced the catalogue metadata even though it already resolves the game's `globalGameId` (for the Global Leaderboard cross-link). Now, when a room game maps to an approved catalogue entry, the room page renders an "About This Game" section below the tab content: manufacturer/year/type, theme chips, designers, Table Authors, Downloads (`table_download_urls`), Tutorials (`tutorial_urls`, YouTube ids resolved), and References (`rules_urls` + IPDB). Fetched from the existing public `GET /api/global/games/:id`; hidden entirely (and silently) for unmapped games or fetch failures. SW → `arcaid-v92`. No migration (next free still 109).

---

## [2.20.0] — unreleased

**S13 — Trophy case + public history (Phase C Recognition).** Built via a Fable-orchestrated Sonnet workflow (4 work packages + cross-seam check; zero blockers).

- **`player_achievements` (migration 108)** — append-only, FK-less trophy log (the `maintenance_runs` treatment). Three types written from the moments that already detect them: `tournament_win` (TournamentEngine winner resolution; deduped one-per-game via a partial UNIQUE index), `milestone` (MilestoneService threshold crossings, metadata carries scope+threshold), `room_record` (hooked off `isNewRoomTop` directly — independent of the cosmetic feed toggle, same pattern as the dethrone DM). `AchievementService.award` never throws. Migration backfills historical tournament wins from the top `submissions` row per COMPLETED game (matching both live winner derivations), idempotent via INSERT OR IGNORE.
- **Trophies on player surfaces** — `stats/enhanced/player/:identifier` now ships `achievements` (per-type counts + 10 most recent) and `personalBests` (best per game with canonical-partition room rank + total players, cap 50). PlayerDetail gains a Trophies section + Personal Bests table; PlayerQuickView gains a condensed counts strip; GameDetail's player expand gains a "Top X%" percentile line.
- **Public history page** — new `/:slug/history` (the `GET /:roomId/history` endpoint was already public; the page was admin-mounted only). Winner + score + date per completed game, paginated, type filter; linked from the public Stats page.
- New `s13-achievements.test.ts` (backfill idempotency, win dedup, cross-identity `getForPlayer`, endpoint shape with room ranks).

SW → `arcaid-v91`. **Migration 108 consumed → next free 109.**

---

## [2.19.0] — unreleased

**Hardening: batched score-counts + community-scores attribution.** Two pre-beta trust/stability fixes, built via a Fable-orchestrated Sonnet workflow.

- **Batched score-counts** — new `GET /:roomId/score-counts?gameIds=…` (cap 100, one grouped `VALUES`-join query with the exact same per-game semantics as the single-game route, every requested id pre-seeded so callers get a stable key set) + a FE request coalescer (`scoreCountsBatcher.ts`, 50ms window, per-room dedupe + chunking, resolves `{}` on failure so cards degrade instead of throwing). A 48-card Room Scores page now fires **1** counts request instead of 48 — the burst that brushed the 100/min per-IP limiter in the v2.18.1 incident. The single-game route stays for `GameDetail`.
- **Attribution spoof closed** — `POST /:roomId/community-scores/:gameName` no longer reads `discord_user_id` from the request body (a guest could attribute a score, and its global fan-out, to any Discord user). Attribution now derives exclusively from the verified Bearer token (`req.user.discordId`); the field is removed from `CommunityScoreSchema`. Audit of every other `submitScore` call site (global routes, freeplay, pick-award, Discord command) confirmed none trust client-supplied ids. New `community-scores-attribution.test.ts` (guest spoof rejected, authed spoof overridden by token, non-regression).
- CLAUDE.md corrections: documented the `community_scores` → `score_history` dual-write (score_history is the physical union — the fact whose absence misled the v2.18.0 design agents) and removed the phantom public `/catalogue` route from the standalone-pages list.

SW → `arcaid-v90`. No migration (next free still 108).

---

## [2.18.1] — unreleased

**Fix: Room Scores tab infinite fetch loop (v2.18.0 launch-day bug).** `RoomScoresView` put the object returned by `usePlayerHeaders()` into its `fetchPage` `useCallback` deps — but that hook builds a **new object every render**, so the first-page effect refired on every render: each cycle toggled `loading`, unmounting/remounting all 48 cards, and every remounted card's `useScoreExpand` re-fetched `score-counts/:gameId` on mount. The resulting request storm tripped the 100/min per-IP rate-limit backstop, 429ing everything including `/room-scores` itself — the tab blipped in and out with a permanent spinner. Fixed by deriving the Authorization header inside `fetchPage` from the stable `playerToken` string (already destructured from `useViewerAuth()`) and depending on that. The Tournaments and Global tabs were unaffected (neither has the headers object in a dep array). SW → `arcaid-v89`.

---

## [2.18.0] — unreleased

**Scores-page redesign — Tournaments | Room Scores | Global.** The room Scoreboard's fragmented "All Games" tab (a community-only "Played at" list plus a scoreless catalogue browser) is replaced by three top-level tabs, each a real score scope. Built via a multi-agent design/judge → implement → adversarial-verify workflow per the session's execution directive.

*Room Scores (new).* Every score ever set in the room, best-per-player-per-game across sources. Served by the new `RoomScoresService` reading `score_history` alone — it is already the physical union (community submits dual-write into it), and the admin wipe path deletes `score_history` but deliberately not `community_scores`, so a literal two-table union would resurrect admin-wiped scores. The ranking query is the exact canonical partition from `LeaderboardService.recalculate` minus the tournament-window filter, so Tournaments, Room Scores, and Global agree on player identity; `display_name` now resolves via `user_profiles` (the old community endpoint never JOINed it — multi-alias users rendered under raw iScored names). Endpoint renamed `GET /:roomId/community-leaderboards` → `/:roomId/room-scores` (single grep-verified consumer, no alias) returning `{data, total, hasMore}` with symmetric offset pagination, server-side search, Recent/A–Z/Most-played sort, and a best-effort per-card `viewerEntry` ("Your best — Rank #N") from an optional player Bearer.

*Global (new lens).* Per-game global top scores inside room chrome, bounded to games that actually have global scores via a new opt-in `hasScores` flag on `GET /api/global/scoreboard` — flag absent leaves the standalone `/scoreboard` byte-identical (regression-tested). Cross-link banner to `/scoreboard`; card submits keep the freeplay path.

*Catalogue browsing* leaves the scores page: role-aware link (room admins → Game Library, everyone else → the Global Scoreboard).

- **Migration 107** — one-time backfill of legacy pre-dual-write `community_scores` rows into `score_history`, double-guarded: an idempotent twin check plus a `deleted_score_suppressions` tombstone check so admin-wiped scores are never resurrected. Logs the candidate count (expected ~0 on prod).
- **FE** — new shared `ScoreCardGrid` (one card renderer for all three tabs, extracted from the deleted `GamesTabView.tsx`), `RoomScoresView`, `GlobalScoresView`, and a centralized `scoresCopy.ts`. Legacy `?tab=all-games`/`games`/`played-here` URLs redirect and normalize to `?tab=room`; `GameDetail`/`GlobalGameDetail`/`GameQuickView` back-links echo the new tabs. Tournaments tab body unchanged.

Adds `room-scores.test.ts` (cross-source best, multi-alias collapse, display-name/`iscored:*` resolution, canonical player_count, orphan exclusion, search/sort/pagination, viewerEntry incl. bad-token 200, agreement with `/leaderboard`, 404 on the old path, migration idempotency + suppression guard) and `global-scoreboard-hasscores.test.ts`. SW → `arcaid-v88`. Migration 107 consumed → next free 108.

---

## [2.17.0] — unreleased

**S12 — Privacy floor.** Account deletion, Terms/Privacy pages, and photo-on-delete cleanup — the data-rights baseline before public beta. Built via a multi-agent audit → design → implement → verify workflow; a dedicated completeness lens independently re-derived the schema and confirmed the purge misses no table.

*Account deletion (anonymize-and-keep-scores).* `DELETE /api/me/account` (self, Discord-authed) + an admin-assisted `DELETE /api/admin/users/:id` (super-admin), both audit-logged, via a new transactional `AccountDeletionService`. It **deletes** all personal/identity data — `user_profiles`, `user_mappings`, `user_preferences`, `sessions`, `room_members`, friendships (both directions), comments + ratings (room and global), per-room/super-admin grants, the milestone ledger — and **anonymizes** the score rows: identity columns are stripped (attribution nulled; a `DELETED` sentinel on NOT-NULL id columns) while `iscored_username` + score stay, so leaderboards and rankings remain intact and de-identified. Proof-photo files are deleted from disk and `photo_url` nulled. Documented policy carve-outs: `user_bans` are retained (abuse-evasion prevention — legitimate interest), `merge_records` / `score_reports` are kept-but-anonymized, `audit_log` is retained, and guest `anon_room_claims` are untouched (device token, not the account).

- **Terms of Service + Privacy Policy** — new public `/terms` and `/privacy` pages (footer-linked) covering what's collected, why, retention, and the deletion path. **Starter copy — needs operator/legal review before launch** (contact, jurisdiction, entity, liability).
- **Photo-on-delete cleanup** — the existing per-row and admin score-delete paths (room + global) now delete the proof-photo file from disk, not just the DB reference.
- **Delete-account UI** — a type-to-confirm Danger Zone in Account Settings that calls the endpoint and logs the user out.

Adds `AccountDeletionService`, the `scorePhotoCleanup` util, and `s12-account-deletion.test.ts` (24 cases: every table purged/anonymized, scores survive de-identified, cross-user isolation, authz tiers). SW → `arcaid-v87`. No migration.

---

## [2.16.1] — unreleased

**Fix: S11 broke game comments in login-required rooms.** S11 mounted `conditionalRequireDiscordUser` on the room comment GET/POST/DELETE routes, which enforces the room's `REQUIRE_DISCORD_LOGIN` setting — but the comment form sends no Bearer token, so in a login-required room (the default for new rooms) the comment routes returned **401 for everyone** (guests *and* logged-in users): viewing showed an empty section, posting silently failed. Comments/tips are lower-stakes social content that stayed open to guests pre-S11. Fixed with a new `optionalDiscordUser` middleware — decodes a token when present (so the S11 author/admin delete-authz tiers still work when a client sends one) but **never blocks** — swapped onto all three comment routes. The score-submission gate (`community-scores`) is unchanged and still honors `REQUIRE_DISCORD_LOGIN`. Regression tests added (guest POST/GET in a login-required room; score gate still 401s).

---

## [2.16.0] — unreleased

**S11 — Trust & safety hardening.** Guest-write rate limiting, an authorization sweep, and input-validation hardening across the public API. Built via a multi-agent audit → implement → verify workflow; the adversarial verify pass surfaced several gaps beyond the initial scope, fixed here.

*Rate limiting.* Dedicated limiters now guard every guest-writable route that previously sat on only the 100/min general backstop: room community-scores, comments (POST + DELETE), and ratings; global submission-drafts (POST / commit-as-guest / DELETE) and rating; plus the account-creating `invite/accept` (now at the 5/min auth tier) and the Discord-lookup `submit/anonymous-check`. New `guestContentLimiter` (10/min) for comment/rating spam — keyed on IP, **not** the client-controlled `x-user-id` header (which could be rotated to bypass it).

*Authorization.* Room comment-delete now enforces tiered authz mirroring the score-history delete (super-admin → any; room-admin → any in their room; author → their own) with a cross-tenant room-scope guard. The comment-list endpoint no longer discloses other users' author ids (each caller sees only their own), closing a broken-access-control hole where a stranger could read a comment's id and replay it as `x-user-id` to delete it.

*Input validation.* Score values are bounded at `MAX_SCORE` (1e15, below 2^53) on the three submit schemas **and** on the two inline-parsed global paths (`/global/scores`, submission-drafts) — guards against precision-loss / overflow leaderboard poisoning. Uploaded images are validated by magic bytes (PNG/APNG, JPEG, WebP) after multer rather than by the spoofable client MIME type, across all room/global/admin upload routes.

*Deferred (tracked for follow-up):* comment moderation for password/local (non-Discord) admins needs token-bearing FE wiring (→ S22 moderation); `community-scores` still trusts a client-supplied `discord_user_id` for attribution; room ratings key on `x-user-id` and aren't room-scoped in `RatingService`.

Bumps SW cache to `arcaid-v86`. Adds `s11-trust-safety.test.ts` (rate-limit enforcement, comment-delete authz tiers, score caps, upload magic-byte checks).

---

## [2.15.2] — unreleased

**Help search reworked into a real in-page find** — replaces the section-filter-only search that just hid non-matching sections.

- **Highlights every occurrence** of each search term across the whole guide, via the CSS Custom Highlight API (no DOM mutation, so it's safe against React re-renders; degrades gracefully to jump-to chips where the API is unavailable).
- **Match navigation** — a live match count + prev/next (‹ / › buttons, or Enter / Shift+Enter) that scrolls to and emphasizes the current hit in cyan while all other hits stay amber.
- **Multi-term** — space-separated terms are each highlighted.
- **Stops hiding content** — the sidebar TOC now always shows all sections, with a per-section match-count badge, instead of filtering everything else away.

`::highlight()` styling lives in `admin-ui/src/index.css` (lightningcss warns it's an unrecognized pseudo-element but preserves it in the output). Bumps SW cache to `arcaid-v85`.

---

## [2.15.1] — unreleased

**Help guide brought current + made searchable, plus a Tournaments timezone polish.** Follow-up to S10.

*Help search.* A top-of-page full-text search on the room-admin Help guide (`admin-ui/src/pages/Help.tsx`), indexed by walking the rendered content once after mount (no per-section rewrite). Filters the sidebar TOC and surfaces clickable jump-to chips — works on mobile where the sidebar is hidden; `✕` clears.

*Help currency — all 14 sections.* A 3-agent content audit found the guide had drifted 3–4 sprints behind the app; corrected throughout: Settings reorg (read-only Game Room, Integrations + Kiosk cards, 17 themes, QR/Zoom moved to Leaderboard Display, dead Tournament Defaults / Platforms / System Actions cards removed), Game Library = the shared global catalogue (correct Add Game / CSV flows, Pin/Tag/smart search), Tournaments (Pause/Resume, delete-with-auto-deactivate, the S10 Last-run/Next-fire columns, corrected field labels + platform-rule semantics), the Dashboard System Status health card, missing Discord commands (`/ping`, `/arcaid-notifications`) + corrected `/setup`, corrected public routes (Picks, Lobby, Global Scoreboard, Friends), Game States (Reconcile iScored, Archived status), and the Leaderboard Manage Scores modal + Suppressions.

*Tournaments "Next fire" timezone.* The Next Fire column now renders in each tournament's configured timezone with an abbreviation (e.g. "Tue, 10:00 PM CDT") so it agrees with the Schedule column instead of the viewer's browser-local time.

Bumps SW cache to `arcaid-v84`.

---

## [2.15.0] — unreleased

**S10 — Room-admin observability + alerting.** Turns "why didn't my game activate / is sync down?" from an undiagnosable mystery into a real in-product health surface, plus a server-level alert on sustained iScored-sync failure and an in-app version/build display.

*Real health, not env-var theater.* The Dashboard "Bot Online" dot was `!!(DISCORD_BOT_TOKEN && DISCORD_CLIENT_ID)` — env-var presence, not connection state. `DiscordClient` now exposes `isReady()` / `isInGuild(guildId)` via a module-level `getDiscordClient()` accessor (the gateway `Client` was previously unreachable from route code), so the new health card reports genuine gateway readiness + guild membership.

*`GET /:roomId/admin/health`.* Aggregates Discord readiness, `ScoreSyncPoller` sync status (per-account last-success / last-error timestamps via a new `getStatus()`), per-tournament last-run outcome + next-fire time, and the running version. The Dashboard renders it as a live health card (30s poll); the Tournaments page gains "Last run" + "Next fire" columns.

*Maintenance-run trail (migration 106).* `runMaintenance()` now records a `maintenance_runs` row (success / skipped / error + summary + duration) for every cron and forced run, so failure paths are finally admin-visible. `MaintenanceRunService` reads latest-per-tournament for the health surface.

*Force Maintenance tells the truth.* `POST .../game-states/force-maintenance` now **awaits** the run and returns its real outcome, replacing the optimistic "triggered" response + blind 3s refetch; the Game States page reports what actually happened.

*Operator alerting (ships inert).* After 5 consecutive `ScoreSyncPoller` failures for one iScored account, `OpsAlertService` fires a one-time Discord DM to `OPS_ALERT_DISCORD_USER_ID` (re-armed on recovery). Gated behind `OPS_ALERT_ENABLED` (default off) — zero behavior change until a super-admin configures it.

*In-app version display.* `GET /api/version` → `{ version, commit, builtAt }` (version from root `package.json` via `npm_package_version`; commit/builtAt baked as Docker build-args in `deploy.yml` + `Dockerfile`). Shown on the Dashboard health card + Help footer. Distinct from the SW cache counter.

*Tests.* New `s10-observability.test.ts` — OpsAlert gating, poller alert-once/re-arm debounce, and maintenance-trail success/skipped/error (via the S2 fake-client seam). Full suite 229/229.

Bumps SW cache to `arcaid-v83`.

---

## [2.14.0] — unreleased

**Dependency + platform modernization: the entire Dependabot backlog cleared (16 PRs), and production moved to Ubuntu 24.04 (noble) + Node 24 + sqlite3 6.** Plus a super-admin Backups Delete button.

*Dependency overhaul (16 Dependabot PRs).* Safe minor/patch group (`actions/checkout` 6→7, admin-ui minor/patch ×11, backend minor/patch ×13 — including `playwright` 1.58→1.61, which required a coordinating Dockerfile base-image bump to keep the pinned browsers in sync). Admin-ui majors (#43): **vite 7→8 (Rolldown bundler)**, `@vitejs/plugin-react` 6, TypeScript 6, ESLint 10, lucide-react 1, react-easy-crop 6, `@types/node` 26, globals 17, uuid 14 — validated on both glibc and musl. Backend majors (#44): uuid 14, TypeScript 6, `@types/bcryptjs` 3.

*Production OS migration (#46).* sqlite3 6.0.1's prebuilt binary requires glibc ≥ 2.38, which the jammy base (glibc 2.35) lacks, so the production image moved **`playwright:v1.61.1-jammy` → `-noble`** (Ubuntu 24.04, glibc 2.39). Noble ships Node 24, so the prod runtime is now Node 24 (pinned via NodeSource `setup_24.x`; the Docker build stages stay Node 20). `arcaid` is pinned to **uid 999** so it can write the existing 999-owned `/app/data` — a UID mismatch (noble's default 997) caused a `SQLITE_READONLY` crash on the first attempt (#45, reverted), diagnosed by reproducing against a copy of the prod DB. Added a `.dockerignore` (the repo had none).

*Backups Delete button (#47).* `DELETE /api/admin/backups/:name` (super-admin, auto-audited) + `BackupService.deleteBackup` (path-traversal guarded, refuses the shared assets-mirror) + a per-row Delete button/confirm modal on the super-admin Backups page. Closes the gap that let backups accumulate until prod hit 100% disk.

Bumps SW cache to `arcaid-v82`.

---

## [2.13.16] — unreleased

**Public-side player names now open a lightweight `PlayerQuickView` modal on click + `PlayerDetail` back link respects originating tab.** Same UX pattern as `GameQuickView` from v2.13.12.

*New `PlayerQuickViewContext`* (`admin-ui/src/contexts/PlayerQuickViewContext.tsx`) provides `open({ slug, entry, fromTab })`. The provider renders the modal itself; descendants only need the hook. Wrapped around the `<Outlet />` in `PublicLayout` so any public-side page can trigger it.

*Modal content (lightweight preview).* Header: avatar + display name + iScored alias when different. Stats grid: Games / Wins / Win % / Avg Finish / Top 5 % / Streak (sourced from the existing `/api/rooms/:roomId/stats/enhanced/player/:id` endpoint — no schema changes). Best Game callout. Top 5 recent scores list. Footer: "View full player page →" (links to `/:slug/players/:name?from=<slug>&tab=<tab>` so the full-page back link returns to the correct view) and "All Players →" (keeps the existing entry point visible from the modal). ESC closes, click-outside closes, body scroll locked while open.

*New `PlayerNameLink` component* (`admin-ui/src/components/PlayerNameLink.tsx`) wraps a player name in a `<Link>` whose `to=` is the real PlayerDetail URL with `?from` + `?tab` threaded, AND intercepts plain left-click to open the modal via context. Modifier-click (ctrl/cmd/shift) falls through to native navigation so middle-click and "open in new tab" still work. Accepts `style` + `className` + caller `onClick` (for parent-row stopPropagation patterns). Replaces all 6 inline `<Link to={`/${slug}/players/${name}`}>` call sites across the public side: `BannerCard`, `MinimalCard`, `ScoreList`, `ShowcasePodium`, `GameDetail`, `PublicStats`.

*`PlayerDetail` back-link.* Now reads `?from` + `?tab` via `useSearchParams()`. When `from` is present (set by `PlayerNameLink` or the modal's full-page link), renders two header links: `← Back to Leaderboard` (to the originating room) AND `All Players` (kept available as before). Without `from`, falls back to the original `← All Players` single link. Fixes the v2.13.0 regression where users coming from a leaderboard had no path back besides browser-back.

*Mobile sizing.* Modal uses `items-start sm:items-center` so small screens land it at the top (better when content is taller than viewport), `w-full max-w-md` for fluid sizing with a cap on tablets+, `max-h-[90vh] overflow-y-auto` so internal scrolling kicks in for long content, `p-3 sm:p-4` for tighter padding on mobile. ESC won't fire on touch but the X button + tap-outside-to-close both work.

Bumps SW cache to `arcaid-v68`.

---

## [2.13.15] — unreleased

**Leaderboard horizontal scroll: arrows extend to viewport edges + click-and-hold drag-to-scroll.** Two enhancements to the v2.13.14 edge-hover nav.

*Arrows now reach the viewport edge.* Pre-fix the arrow buttons sat at the wrapper's left/right edges, which left a clickable gap between the wrapper and the actual browser edge — clicks in that gap did nothing. Refactored `HorizontalScrollNav` to render the arrow buttons via `createPortal` to `document.body` at `position: fixed` with width computed as `wrapperRect.left + zone` (left arrow) and `viewportWidth - wrapperRect.right + zone` (right arrow). The chevron icon stays anchored to the visible edge (`justify-start` / `justify-end` with `pl-3` / `pr-3`); the rest of the button is a transparent click target that extends to viewport edge. Hover detection moved from `onMouseMove` on the wrapper to a document-level `mousemove` listener so cursor in the viewport-edge gap still triggers the arrow.

*Drag-to-scroll on the card area.* Mousedown on a non-input element starts tracking; once cursor movement exceeds `dragThresholdPx` (default 5px) it engages drag mode — `cursor: grabbing` on body, `userSelect: none` to prevent text selection, `scrollLeft` follows the cursor delta. On mouseup, if drag was engaged the upcoming click event is suppressed via a one-shot capture-phase listener so a card title click that turned into a drag doesn't also open the QuickView modal. Movement under threshold passes through normally — quick clicks on titles still open the modal. Touch unaffected — native swipe still handles horizontal scroll, and the drag listeners check for mouse-button only.

Bumps SW cache to `arcaid-v67`.

---

## [2.13.14] — unreleased

**Public leaderboard horizontal scroll: scrollbar replaced with edge-hover arrow controls.** New `HorizontalScrollNav` component wraps the horizontal-scroll layout's card row. Behavior:

- Scrollbar hidden (CSS — `.scoreboard-hscroll-layout` and `.scoreboard-hscroll-nobar` both set `scrollbar-width: none` and `::-webkit-scrollbar { display: none }`).
- Two arrow buttons (chevron left / chevron right) sit absolutely positioned over the wrapper's left and right edges.
- An arrow is visible only when (a) the cursor is within ~120px (or 15% of the wrapper width, whichever is smaller) of the corresponding edge, AND (b) there's actually more content to scroll in that direction (`scrollLeft > 0` for left; `scrollLeft + clientWidth < scrollWidth` for right). At the leftmost position the left arrow stays hidden even on hover; at the rightmost position the right arrow stays hidden — matches the user's "if there's no more cards to display, don't show" requirement.
- Click → smooth scroll by 400px. Mousedown sustained → after a 280ms delay, continuous scroll kicks in at 18px/frame so a held button glides through the list. Quick click only fires the chunk.
- Cleanup on mouseleave/mouseup/unmount cancels any pending hold timers + intervals.
- Touch / mobile unaffected: `mousemove`/`mousedown` don't fire on touch so arrows stay hidden; native swipe still scrolls because the container keeps `overflow-x: auto` (just with the scrollbar visually removed).
- `ResizeObserver` on the scroll element re-checks `canLeft`/`canRight` when content or container width changes (cards added/removed, sidebar toggle, window resize).

Currently wired into `Scoreboard.tsx` (public leaderboard) only. `KioskScoreboard.tsx` still uses the same `.scoreboard-hscroll-layout` class so its scrollbar is also hidden, but no arrow nav is added there (kiosk auto-scrolls and isn't mouse-driven).

Bumps SW cache to `arcaid-v66`.

---

## [2.13.13] — unreleased

**Three follow-up fixes to v2.13.12** — the GlobalGameDetail nav still said "Scoreboard", clicking the per-card "i" info icon was also firing the new GameQuickView modal, and the resulting info bubble was clipped by the card's `overflow: hidden`.

*GlobalGameDetail nav text:* `GlobalGameDetail.tsx`'s secondary "Scoreboard" link and the "Global Scoreboard" not-found copy both renamed to "Leaderboard" / "Global Leaderboard". v2.13.12's terminology sweep updated the `to=` href via the `backToRoomHref` refactor but left the visible text unchanged in two spots.

*Info-icon click no longer triggers the quick-view modal:* `handleTitleClick` in both `Scoreboard.tsx` and `GamesTabView.tsx` now bails early when `e.target.closest('button')` is truthy — defense-in-depth in case `e.stopPropagation()` inside the `GameInfoPopup` button doesn't reliably block the parent `<Link>`'s onClick in production builds.

*Info bubble visibility:* `GameInfoPopup` refactored to render the bubble via `createPortal` to `document.body` with `position: fixed` coordinates computed from the trigger button's `getBoundingClientRect`. Pre-fix the bubble was `position: absolute` inside the trigger's wrapper, which sat inside a card with `overflow: hidden`, so the bubble (positioned above the icon) was clipped at the card's top edge and invisible. Now it floats above all card chrome at `z-[60]`. Added ESC-to-close and scroll-to-close handlers. The trigger button's click also now calls `e.preventDefault()` in addition to `e.stopPropagation()` for stronger isolation from the parent `<Link>`.

Bumps SW cache to `arcaid-v65`.

---

## [2.13.12] — unreleased

**Four targeted fixes shipped together** — Overall Rankings query correctness, game-info navigation, QR positioning + sizing, and a Scoreboard→Leaderboard terminology sweep.

*Overall Rankings query rewritten to read from `score_history` filtered by `submitted_during_tournament_id` matching the game's owning tournament — mirrors `LeaderboardService.recalculate`'s pattern. Pre-v2.13.12 the query read from `submissions` filtered only by `games.tournament_id`, which mis-attributed scores submitted via the community/freeplay path (`source = 'community'`, `submitted_during_tournament_id = null` in score_history) because submissions doesn't carry submission-time tournament context — `submissions.game_id` was set to the matching tournament game's id, and the query treated it as a tournament-window score. Confirmed on prod: mekelburgj's 450,000 on Black Rose was a community submission landing in Daily Grind Overall as 100 points / 1 game played, despite no tournament-window context. After fix, that row is correctly excluded (its score_history row has `submitted_during_tournament_id = NULL`). Per-row deletes naturally fall out — the watermark was also updated to source from `score_history` so per-row deletes invalidate the cache correctly. Multi-alias collapse via `COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))`. Old cache rows auto-invalidate on first read after deploy (different watermark formula).*

*Game-info navigation — back link now preserves the originating tab.* `titleLinkTo` constructions in `Scoreboard.tsx` (tournament cards) and `GamesTabView.tsx` (All Games cards) append `&tab=tournaments` / `&tab=all-games`. `GlobalGameDetail` and `GameDetail` read the `tab` query param and use it in the back link. Pre-v2.13.12 `GlobalGameDetail` hardcoded `?tab=all-games` so users who started on the Tournaments tab landed on All Games after going through any global-page round trip.

*Game-info lightweight modal preview.* New `GameQuickView` component, triggered by plain left-click on a card title. Modal shows top 10 scores + game image + catalogue metadata (manufacturer, year, platforms). Footer links: "View full info →" (navigates to `GameDetail` with tab preserved) and "Global Leaderboard →" (navigates to `GlobalGameDetail` when `globalGameId` is present). Modifier-click / middle-click / right-click on the title falls through to the underlying `<Link>` so users can still open the full page in a new tab. Wired into both `Scoreboard.tsx` (tournament cards) and `GamesTabView.tsx` (All Games cards) via the existing `titleLinkOnClick` prop on `CardRouter`. Also renamed the "More info →" link in `GameDetail`'s header to "Global Leaderboard →" since that's its actual destination.

*QR codes: new bottom-edge overlap setting + bigger default size.* New `SCOREBOARD_QR_OVERLAP_PX` setting (default 10) controls how many pixels the QR overlaps the card's bottom edge — 0 = QR touches the bottom edge from below, higher = more of the QR sits inside the card. Applies to both `bottom-right` and `bottom-center` QR positions (was bottom-center only; `qrBottomMetrics` refactored to handle both). Bumped default `SCOREBOARD_QR_SIZE` from 24 → 30 (~25% larger) for easier phone scanning at desk distance. Layout reservation (`cardMarginBottom`) updated to use the new overlap so the QR's overhang is properly reserved below the card. Threaded `qrOverlapPx` through `CardRouter` → all 3 card variants (Banner/Showcase/Minimal) and through both `Scoreboard.tsx` and `KioskScoreboard.tsx`. New setting exposed in `ScoreboardPreferencesModal`'s Advanced section.

*Terminology sweep: visible "Scoreboard" → "Leaderboard" across the app.* ~25 user-visible strings updated across `GameDetail`, `GlobalScoreboard` (page title), `GameLibrary` (Pin dialog), `GlobalSettings`, `Settings` (descriptions + section heading + dropdown options + toggle labels), `Help` (admin help tables), `Tournaments` (admin descriptions), `LandingPage`, `ScoreSubmit` (back link), `GameRoomManager` (admin column header), `Rankings` (display style picker labels), `ScoreboardPreferencesModal` (QR mode option + Rankings Card Style option + description text), `GameQuickView` (links + descriptions), and `Scoreboard.tsx` (tabs aria-label). URL paths, code identifiers, setting keys (`SCOREBOARD_STYLE` etc.), DB columns, and API paths intentionally kept unchanged — backward compat. One link description ("global ArcAid Leaderboard at arcaid.app/scoreboard") keeps the URL path literal.

Bumps SW cache to `arcaid-v64`.

---

## [2.13.11] — unreleased

**Ranking-card variants now stretch vertically to match the tallest game card in their row.** Follow-up to v2.13.10 — width parity was fixed but height wasn't. The ranking cards sat at their natural ~150px content height while game cards next to them filled 700px+, leaving an awkward gap below the rankings cards.

*Root cause:* in horizontal-scroll and grid layouts the parent flex/grid container has default `align-items: stretch`, so the immediate wrapper around `<RankingGroupCard>` (lines 454/494/532 in `Scoreboard.tsx`) does stretch to the row's max height. But the `outerWrap` div inside that wrapper had no `height: 100%`, so it collapsed to its content height. The inner card's `height: 100%` then resolved against the already-collapsed `outerWrap`, not the stretched outer slot.

*Fix:* added `height: '100%'` to `outerWrap` in `ScoreboardComponents.tsx`. Safe across layouts — in horizontal scroll and grid the value fills the stretched slot; in vertical layout the parent's height is indeterminate so `100%` falls back to `auto` (natural content height stays).

*Compact variant only — internal layout:* added `display: flex; flexDirection: column; height: 100%` to Compact's inner div and wrapped the rankings rows in a `flex: 1` div, so the footer ("X players · METHOD") floats to the bottom of the stretched slot instead of hugging the header. Plaque and Sidebar already had this distribution via their existing `flex-1` body div.

Bumps SW cache to `arcaid-v63`.

---

## [2.13.10] — unreleased

**Ranking-card variants (Plaque / Compact / Sidebar) now occupy the same slot dimensions as game cards and align with their top edges.** Follow-up to v2.13.9 — the new variants were rendered at intrinsic widths (220 / 320 / 180px) that made the layout look unbalanced beside game cards, and they didn't apply the 42px showcase top-padding so they sat above the game-card top edge.

*Width:* all three variants now derive their inner card width from the parent scoreboardStyle (showcase/minimal=380, banner=280, other=320) instead of fixed values. Visual distinction comes from internal rendering — frame, typography, chrome — not footprint. `rankingsStyleWidth()` removed; `RankingsColumn` / `RankingsRow` reverted to the original game-card-width logic.

*Top-edge alignment:* a new `outerWrap` helper in `RankingGroupCard` applies `paddingTop: 42` when scoreboardStyle is `showcase` (matching the existing showcase ranking variant's pattern). Removed the v2.13.9 `RankingsColumn` change that stripped column-level topPad for non-match styles.

*Mobile vertical centering:* `outerWrap` is a `display: flex; justifyContent: center` container so the inner card centers horizontally within its slot whenever the slot is wider than the card — covers mobile vertical layout and any narrow-slot edge case.

*Sidebar header content:* replaced the literal "Rankings" label with a two-line header — small "OVERALL" eyebrow + `{group.name}` as the main title. Players can now tell which ranking group the card represents (e.g., "Daily Grind Overall" vs "Monthly").

Bumps SW cache to `arcaid-v62`.

---

## [2.13.9] — unreleased

**Overall Rankings cards can now be styled independently of game cards.** Three new ranking-card treatments — Plaque, Compact List, Sidebar Block — plus the existing Match-Scoreboard default. Addresses the problem where the rankings card mirrored game-card layout 1:1 (same header, same body shape, same width) and read as "yet another game card" on the scoreboard.

*New setting key `SCOREBOARD_RANKINGS_STYLE`* in `game_room_settings`. Reader in `admin-ui/src/lib/scoreboardConfig.ts` validates against `{match, plaque, compact, sidebar}` and falls back to `match` for unknown/missing values, so existing rooms see no visual change.

*Renderer in `RankingGroupCard`* (`admin-ui/src/components/ScoreboardComponents.tsx`) — three new early-return branches before the existing showcase/minimal/banner trio. When `rankingsStyle === 'match'` the legacy 3-branch logic runs unchanged. The new variants borrow theme tokens (card background, border color, title color, fonts, Google-fonts href) from the active showcase theme when one is set, so a Glass-Deck-flavored Plaque looks Glass-Deck-y rather than generic. `RankingsColumn` / `RankingsRow` derive their container width from the new style's intrinsic width (plaque 220px, compact 320px, sidebar 180px) instead of the parent scoreboard style's width.

- **Plaque** — tall + narrow (220px) hall-of-fame frame with double-border outline, centered rank/name/score stack per entry, ✦ glyph above the title. Reads as a commemorative object distinct from any game card.
- **Compact List** — text-only, no card chrome, dotted leaders between name and score. Quietest variant; great when rankings are reference info that shouldn't compete for attention.
- **Sidebar Block** — narrow (180px) column with abbreviated scores (`2.4k`, `1.2M`). Best when rankings sit beside the game-card grid as a supporting widget.

*Pickers in two places* — room-admin default on the Rankings admin page (`/:slug/admin/rankings`, new "Display Style" section above the groups list, reads/writes via `/api/rooms/:roomId/settings`), and per-user override in the Scoreboard Preferences modal (`SCOREBOARD_RANKINGS_STYLE` added to the `SELECT_PREFS` list so it picks up the existing Reset-to-default affordance). Same option set in both places.

*Plumbed through* `admin-ui/src/pages/Scoreboard.tsx` + `admin-ui/src/pages/KioskScoreboard.tsx` to all 12 ranking-card call sites (RankingsRow, RankingsColumn, and inline RankingGroupCard inside layout containers).

Bumps SW cache to `arcaid-v61`.

---

## [2.13.8] — unreleased

**Public landing page room cards are now clickable surfaces.** Clicking anywhere on a room card at `arcaid.app` navigates to that room's scoreboard at `/<slug>/`. Previously only the small "View Scoreboard →" link in the card footer was clickable, which most visitors didn't notice.

*Implementation:* absolutely-positioned `<Link to="/${room.slug}/">` overlay (`inset: 0`, `z-index: 1`) layered over the card content as a sibling, with the existing "View Scoreboard →" Link and the "Join Discord" anchor lifted to `z-index: 2` so they continue catching their own clicks (Discord still opens in a new tab; the visible CTA still works). Uses a real `<Link>` rather than `onClick + useNavigate` so middle-click, ctrl-click, and right-click → "Open in new tab" all keep working. Added a subtle hover affordance (2px lift, green-tinted shadow, border tint) so users know the card is clickable. `aria-label` on the overlay names the destination ("View {room.name} scoreboard") for screen readers. Avoided the `<a>`-nested-inside-`<a>` trap that wrapping the card in a single `<Link>` would have caused.

Bumps SW cache to `arcaid-v60`.

---

## [2.13.7] — unreleased

**Game-detail leaderboard defaults to the originating room + paginates 20/page; mobile score input no longer summons the OS keypad.** Three small UX fixes that came up testing a locked-tournament submit on rtx_pinball.

*Tournament-card title clicks land on `GlobalGameDetail` (rich page with wheel art, downloads, tutorials) when the game has a `globalGameId`. The leaderboard there was hardcoded to `scope=global`, so a player who just submitted to their room's locked tournament saw all-rooms scores instead of theirs.* Fix: when navigated with `?from=<slug>`, default the scope dropdown to that room. Picking "All rooms (global)" now writes `?room=global` as an explicit sentinel so the choice persists across refresh / share. URL `?room=<slug>` semantics unchanged. Known limitation, intentional: `GlobalGameDetail` reads `global_scores`, which excludes guest/anon submissions per the existing `GlobalScoreService.fanOutFromRoomSubmission` gate — so scoping to a room here is not 100% identical to the room's `GameDetail`. To bridge, added a small "More info →" link in the room `GameDetail` header that opens the rich global page from a room context.

*Leaderboard had no pagination — `?limit=50` hardcoded, no controls past the 50th row.* Now 20 per page with prev/next + "Showing X–Y of N" + "Page N of M" footer. Server (`/api/global/scoreboard/:globalGameId`) already supported `offset` / `limit`; client wiring + footer was missing.

*Mobile OS keypad obscured the score photo when the player focused the score input.* The in-app `OnScreenKeyboard` was already opening on focus, but `type="number"` + `inputMode="numeric"` also triggered the native keypad (and `inputMode="none"` is silently ignored on iOS Safari when paired with `type="number"`). Fix: on touch devices only, swap to `type="text"` + `inputMode="none"` so the in-app keyboard is the sole input path; added a digit-only `onChange` filter to compensate for losing the numeric-type guard. Desktop unchanged. Name field unchanged — alpha input still relies on the OS keyboard.

Bumps SW cache to `arcaid-v59`.

---

## [2.13.6] — unreleased

**AtGames cabinet sub-tags moved from platform list to feature list.** The AtGames importer wrote 9 platforms per machine — the umbrella `atgames` plus up to 8 cabinet variants (`atgames_hd`, `atgames_4k`, `atgames_micro`, `atgames_hdp`, `atgames_alu`, `atgames_mini`, `atgames_gamer`, `atgames_core`). The variants polluted the tournament Platform Rules picker with options no realistic tournament design uses ("must be available on AtGames Micro only" is not a thing). Cabinet availability is a catalogue-level attribute — same axis as `wizard_auto` / `has_puppack` / `fps_45` — and now lives in `global_games.features` where it can drive a future "filter by my cabinet" UX without cluttering tournament eligibility rules.

*Migration 101* — for every `global_games` row with `atgames_*` in `platforms`: strip the sub-cabinet entries and union them into `features`. Idempotent; safe to re-run. Same pass strips dead sub-cabinet entries from any `tournaments.platform_rules` JSON (`required` + `excluded` arrays) since the umbrella `atgames` already covers eligibility on those rows. On prod: 8 catalogue rows touched (out of 273 with the umbrella `atgames` tag — the source sheet only fills cabinet-availability cells for a subset of titles), 1 tournament (WG-VPXS) cleaned. No `room_game_tags` entries reference sub-cabinets; no `submissions` / `score_history` / `community_scores` / `global_scores` rows have sub-cabinet platforms.

*Importer + canonical lists* — `AtGamesImportService` now writes `platforms: ['atgames']` and `features: [...cabinetVariants]`. Both canonical platform maps drop the 8 sub-cabinet entries (`src/utils/platformMapping.ts` and `admin-ui/src/lib/platforms.ts`). FE platform filter groups (`src/utils/platformMapping.ts` Physical group and `admin-ui/src/pages/GlobalScoreboard.tsx` vpin group) drop `atgames_hd` / `atgames_4k`.

*Out of scope:* `scripts/analyze-catalogue.ts` still references `atgames_hd` / `atgames_4k` defensively — harmless (umbrella `atgames` is in the same `.includes()` check) and the script isn't user-facing.

Bumps SW cache to `arcaid-v58`.

---

## [2.13.5] — unreleased

**Discord-login round-trip on public room pages now keeps you on the page, surfaces the "Room admin" link immediately, and skips the second password prompt at `/admin/login`.** Three symptoms, one root cause + one wiring miss.

*Login redirected to `/lobby` regardless of origin.* `PublicLayout.tsx`'s Discord login button called `loginWithDiscord(slug)` with no `returnPath`, and `ViewerAuthContext.loginWithDiscord` hardcodes `/${slug}/lobby` as the default. Fix: pass `location.pathname + location.search` so `DiscordCallback` round-trips you back to the originating page.

*"Room admin" item missing from the profile menu after Discord login, even for users who are in `game_room_admins`.* `UserMenu` gates the link on the `hasAdminToken` prop, which `PublicLayout` derives from `localStorage.getItem('arcaid_token')` — the *admin* token slot. Backend already issues a `role: 'room_admin'` JWT for these users (`src/api/routes/auth.ts` via `AdminService.getRoomsForDiscordUser`), but `DiscordCallback`'s player-flow branch writes the JWT only into `arcaid_player_token`. Fix: when the decoded role is `room_admin` or `super_admin`, also seed `arcaid_token` + `arcaid_admin_refresh_token`. Guarded on the admin slot being empty so a higher-privilege session already active in the browser isn't silently downgraded.

*`/:slug/admin/login` re-prompted for a password even though you'd just authed via Discord.* `RoomLogin.tsx`'s `isTokenValid(getToken())` auto-bounce checks the admin slot, which was empty by the bug above. Falls out of the same fix — the auto-bounce now triggers and lands you on the dashboard.

*Admin Leaderboard page button labelled "View Public Scoreboard".* Renamed to "View Public Leaderboard" per terminology preference. (Caveat: the destination page is still titled "Scoreboard" elsewhere in the product — broader rename out of scope.)

Bumps SW cache to `arcaid-v57`.

---

## [2.13.4] — unreleased

**Two All-Games-tab card bugs.**

*Banner cards overlapped horizontally in the All-Games grid.* `BannerCard.tsx` hardcoded `width: 280` on its outer container without a `maxWidth: '100%'` escape, so when `GamesTabView`'s grid sized cells from `minmax(min(238px, 100%), 1fr)` each card bled ~40px to the right, into the next column. The Tournaments tab forces banner into horizontal scroll (`effectiveLayout = 'scroll'`) where every cell is exactly 280px wide, so it never showed. Fix: add `maxWidth: '100%'` to the BannerCard root, matching the existing pattern on `ShowcaseCard` (`width: 380, maxWidth: '100%'`) and `MinimalCard` (`maxWidth: 380`).

*"Played at" cards rendered without backgrounds or header art.* `/api/rooms/:roomId/community-leaderboards` returned `imageUrl` as the raw DB column (`data/catalogue-images/foo.png`) instead of the public-URL form (`/api/catalogue-images/foo.png`), so every `backgroundImage: url(...)` lookup 404'd silently. The Tournament tab's `LeaderboardService.getActiveLeaderboards` runs the same value through `normalizeImageUrl()`; the community endpoint didn't. Fix: export the helper from `LeaderboardService.ts` and apply it in the community handler. Untouched: cards whose `community_scores.game_name` doesn't case-insensitively match a row in `global_games(name)` will still render bare — that's a data-hygiene gap, not a code path.

**`IScoredClient.deleteGame` now post-flight-verifies the delete.** The modal-hidden + networkidle signal isn't proof that iScored actually deleted the row — observed failure mode: modal hides on click even on silent backend reject, leaving the entity on iScored while the caller logs success. `deleteGame` now re-navigates to the Games tab and re-checks `#selectGame` for the option; returns `false` if the row is still present (so callers can branch on real success vs. false success). Pre-flight skip path (game not in dropdown) still returns `false`, unchanged. Throw behavior unchanged.

Bumps SW cache to `arcaid-v56`.

---

## [2.13.3] — unreleased

**Bottom-center QR overhang now reserved in layout.** Symptom: at common viewport sizes, only a 4px sliver of each card's QR was visible — the rest hung below the viewport, and scrolling to the maximum still left ~30-60px of QR clipped. Root cause: `marginBottom: qrMetrics.overhang` was set on each card component's outer div (BannerCard, ShowcaseCard, MinimalCard). That div also has `height: 100%`, which interacts with `align-items: stretch` and parent auto-sizing such that the margin escapes outside the parent's border-box. The flex line cross size (and grid track size) was computed without the overhang, so the QR — positioned `absolute, bottom: -overhang` — rendered outside the scrollable region entirely.

Fix: move the `marginBottom` from each card's inner outer-div to the wrapper around `<CardRouter>` in `Scoreboard.tsx` (the actual flex/grid layout item). Flex item margins DO contribute to flex line cross size and grid track sizing, so the QR's reserved space now lives inside the scrollable layout. No visual change to the QR's relative position; the QR still peeks 4px inside the card with 96px hanging below (for `qrSize=100`).

Also applied to the inline `RankingGroupCard` wrappers so they stay vertically aligned with adjacent leaderboard cards.

Bumps SW cache to `arcaid-v55`.

---

## [2.13.2] — unreleased

**Bottom-center QR peek tightened.** `qrBottomMetrics` in `admin-ui/src/lib/scoreboardConfig.ts` lowered the peek cap from 10px → 4px and the size-proportional factor from 0.2 → 0.1. Effect at common QR sizes: `18` → peek 3.6 → 1.8, `24` → peek 4.8 → 2.4, `50+` → peek 10 → 4. The QR's bottom-edge `overhang` grows correspondingly, so every QR sits noticeably lower below the card. Bumps SW cache to `arcaid-v54`.

The May 1 (v2.10.x) tightening from `qrSize * 0.2` to `min(10px, qrSize * 0.2)` was correct for medium/large QRs but kept the 20% factor for small QRs (18-24), where the peek-to-size ratio is what the eye reads — so users who'd shrunk their QR via `SCOREBOARD_QR_SIZE` user-pref still saw "mostly inside the card." This release closes that gap.

---

## [2.13.1] — unreleased

**iScored game-create lookup hardened.** `IScoredClient.createGame` previously located the newly created row by case-insensitive exact name match against the post-create lineup. iScored mutates names on save (observed: strips apostrophes — `JP's` → `JPs`), so any catalogue entry with apostrophes (and likely other punctuation) failed activation with `Failed to find newly created Game in lineup.` while silently leaving 1-2 orphan rows per attempt on iScored (one per retry).

The lookup now snapshots lineup IDs before clicking *Create Blank Game* and identifies the new row by ID-diff. Robust to any name mutation iScored applies. When the stored name differs from the requested one, the divergence is logged at INFO for observability. If somehow more than one new row appears between snapshot and check, a WARN is logged and the last row is selected.

Orphan rows on iScored from prior failed activations are not auto-cleaned — manual delete on iScored is required.

---

## [2.12.0] — unreleased

**Catalogue source provenance + structured Wizard download.** v2.11.0's merge primitive correctly cascaded data but dropped the Wizard row's `external_url` whenever the target row already had its own (e.g. VPS database link). Manual merges done before this release for Blood Machines and Ace Ventura therefore lost the GitHub link to the vpxs_manual table source. This release ships the structural fix and a Wizard re-sync covers the backfill automatically.

### Migration 100

```sql
ALTER TABLE global_games ADD COLUMN merged_from_sources TEXT DEFAULT '[]';
```

Tracks which sources a row absorbed via `merge` or cross-source `upsert`. The base `imported_from` column says where the row was *first* imported from; `merged_from_sources` accumulates additional contributing sources. Used to render `vps, wizard` in the admin catalogue when both have fed metadata into the same row.

### Wizard importer now emits `table_download_urls`

Every Wizard table now writes `[{ format: 'wizard', url: <github tree URL> }]` to `table_download_urls` alongside the existing `external_url`. The structured entry is what survives a merge — `external_url` is per-row metadata that a merge fills only when the target's is empty.

### `upsert` UPDATE branch: cross-source semantics

When `input.imported_from` differs from `existing.imported_from`, the URL object-arrays (`table_download_urls`, `tutorial_urls`, `rules_urls`) now **union by `.url`** instead of overwriting via COALESCE. Same-source re-imports keep overwrite semantics so source-side updates can prune stale entries; cross-source imports preserve everything from both sides. The cross-source path also appends the input's source name to `merged_from_sources`.

This is what backfills Blood Machines and Ace Ventura on the next Wizard sync: dedup finds the post-merge row, the upsert's UPDATE branch detects the cross-source case (input from `wizard`, row from `vps`), unions the GitHub link into `table_download_urls`, and records `wizard` in `merged_from_sources`.

### `merge` primitive: fold external_url + track source provenance

When source has an `external_url` that target doesn't already have, the merge primitive now folds it into target's `table_download_urls` with `format: <source.imported_from>`. Source's `imported_from` and any prior `merged_from_sources` are union'd into target's `merged_from_sources` so the lineage survives multi-step merges.

### Admin catalogue UI

Each row in the Browse Games list now shows platform tags (chips, large screens) and a combined source string. Rows that absorbed cross-source data render as `VPS, WIZARD` instead of just `VPS`. Expanded view's Source detail follows the same convention.

### Backfill plan

After deploy, run a Wizard sync from `/admin/catalogue`. The sync's upsert path matches the merged Blood Machines and Ace Ventura rows via the v2.11.0 dedup improvements, detects the cross-source case, and writes the GitHub link + `wizard` source provenance. No separate migration needed.

### Risks worth flagging

- **Cross-source upsert semantics changed.** A future cross-source import of a row's `tutorial_urls` will now append rather than replace. If a source is the canonical owner of a row's tutorials and you want it to fully replace, the row's `imported_from` would need to be set to that source first.
- **`merged_from_sources` is additive only.** No code path removes a source from this list. If a merge gets reversed (no current path for that), the lineage entry persists. Acceptable: this is metadata for display, not for FK integrity.

---

## [2.11.0] — unreleased

**Catalogue dedup: merge vpx + vpxs_manual variants of the same game.** The Wizard importer's `(VPW Original 2022)` parenthetical was producing manufacturer mismatches against VPS's plain `Original`, blocking step-4 dedup. Hyphen-as-separator names like `Ace Ventura - Pet Detective` vs `Ace Ventura Pet Detective` weren't normalizing equal either. Plus the existing `merge` primitive was throwing away the source row's `table_download_urls`, `themes`, `designers`, `table_authors`, etc. — exactly the data admins want to keep on the surviving row.

### `GlobalGameService.merge` now actually unions data

Before this release, `merge` only cascaded FK references (scores, library links, games table) and unioned `platforms`. Source's content arrays and scalar fields were dropped on `DELETE FROM global_games`.

Now the merge primitive:

- **Cascades** `global_scores`, `global_leaderboard_cache`, `game_room_game_library`, `games`, plus the previously-missing `global_game_ratings` (UNIQUE-constraint-aware), `global_game_comments`, and `room_game_tags` (PRIMARY-KEY-aware).
- **Unions** the target's content from the source: `platforms`, `themes`, `designers`, `table_authors`, `features` (string arrays); `table_download_urls`, `tutorial_urls`, `rules_urls` (object arrays, deduped by `.url` so re-merging is idempotent).
- **Fills target gaps** from source for `description`, `image_url`, `local_image_path`, `wheel_image_path`, `source_rating`, `source_updated_at`, plus the existing external IDs (`opdb_id`, `vps_id`, `igdb_id`, `ipdb_url`, `external_url`).
- **Never** pulls identity fields from source: `name`, `display_name`, `manufacturer`, `year`, `subtype`, `players` belong to the target.

The clicking-Blood-Machines-game-detail-shows-vpxs_manual-download path the user asked for falls out for free: both download URLs now coexist in `target.table_download_urls`.

### Merge UI on the Browse Games admin page

Per-row Merge button next to Reject/Delete, opens a search-driven target picker. Modal warns that target's external IDs (vps_id, opdb_id) are preserved and source is deleted, so the admin should pick the rich row as target. Source self-filters out of candidate list.

### Dedup prevention for new imports

- **`normalizeGameName`** now collapses whitespace-surrounded hyphens (`Ace Ventura - Pet Detective` → `ace ventura pet detective`). Hyphens between letters (`Spider-Man`, `X-Men`) untouched. Run before the existing punctuation pass.
- **`WizardImportService.parseNameParts`** strips short all-caps team prefix when manufacturer is `<TEAM> Original` or `<TEAM> MOD` (matches `[A-Z]{2,5}\s+(Original|MOD)`). `VPW Original` → `Original`, `VPDB MOD` → `MOD`. Real manufacturer names (`Williams`, `Stern`) are case-mixed and left alone.

### Migration 099

```ts
// Strips team prefix from existing global_games rows so the next Wizard
// import can find them via concrete (mfg, year) match instead of inserting
// new rows alongside.
UPDATE global_games SET manufacturer = '<stripped>' WHERE manufacturer matches /^[A-Z]{2,5}\s+(Original|MOD)$/i
```

Idempotent re-run: subsequent runs find no matching rows.

### Risks and mitigations

- **`normalizeGameName` change affects every existing row.** New "concrete match" hits between previously-distinct rows could cause the next sync to merge things that shouldn't merge. Spot-check by running a Wizard sync after deploy and watching `imported_from='wizard'` counts; if `updated` jumps unexpectedly, investigate.
- **Merge UI's target picker uses the existing `/admin/catalogue/games` search endpoint.** No new endpoint, no new auth surface.
- **Existing `POST /admin/catalogue/games/merge` semantics changed.** Anyone calling it gets the enhanced behavior; the only existing caller is the catalogue-approval pending flow, which benefits from preserving more data.

---

## [2.10.2] — unreleased

**Rename game status `HIDDEN` → `ARCHIVED`.** The pre-rename name conflicted with iScored's own "Hidden" concept (game still in lineup, soft-hidden from scoreboard). ArcAid's value actually means "post-cleanup, kept locally as a historical anchor for score attribution." `ARCHIVED` captures that intent.

### Migration 098

```sql
UPDATE games SET status = 'ARCHIVED' WHERE status = 'HIDDEN';
```

Idempotent. No CHECK constraint to update — the column is plain TEXT.

### Code surface touched

Pure mechanical rename of the string literal across:
- `GameStatus` type union (`src/types/index.ts`)
- `UpdateGameStateSchema` Zod enum (`src/api/schemas.ts`)
- `TournamentEngine.runCleanup`, log messages, and the doc comment on `deleteGameCompletely` (`src/engine/TournamentEngine.ts`)
- 14 `('COMPLETED', 'HIDDEN')` clauses in `StatsService` queries
- `RankingService` test that simulated post-maintenance hiding
- The two `iscoredGame.isHidden ? 'HIDDEN' : ...` mappings in `/sync-state` (Discord)
- The admin status-change endpoint at `rooms.ts` (`PATCH /:roomId/admin/game-states/:gameId/status`)
- `GameStates.tsx` filter chips + badge map and `StatusBadge.tsx`

### UX: ARCHIVED chip + ALL excludes archive

The Game States page's "ALL" chip used to silently include archived rows, but no chip targeted ARCHIVED specifically — so a room with cleaned-up tournaments would show `ACTIVE (0) QUEUED (0) COMPLETED (0)` next to a populated table, which is what surfaced this rename in the first place. Now:

- ALL = ACTIVE + QUEUED + COMPLETED only (matches the page's "rescue" intent)
- New ARCHIVED chip with its own count
- Every chip displays its count, including ALL
- Frontend always fetches every status; chip filtering is client-side so counts stay accurate regardless of which chip is active

### Behavior preserved

- The `setGameStatus(..., { hidden: true })` call to iScored when an admin sets status=ARCHIVED with `syncIScored=true` is unchanged. iScored's API still calls this "hidden"; we just don't conflate the names locally.
- `Stats` and `Ranking` services continue to read from rows in `('COMPLETED', 'ARCHIVED')`, so historical leaderboards stay coherent across the rename.

---

## [2.10.1] — unreleased

**Ranking groups self-invalidate via data watermark.** Eliminates the class of bugs where a score-mutation code path forgot to call `RankingService.invalidate*()` and rankings stayed stale until a manual recompute. Resolves the user-reported staleness after weekly maintenance and after manual game deletes.

### Root cause

`ranking_groups_cache` had no auto-invalidation — it was only cleared by (a) the manual admin "Recompute" button, (b) `RankingService.update()` when a group's config changed, and (c) the Discord `/submit-score` command. Every other score-mutation path (web `/submit-score`, `/freeplay-score`, `/community-scores`, the v2.9.0 per-row delete + admin wipe-player endpoints, `TournamentEngine.{deactivateGame, deleteGameCompletely, runCleanup}`, ScoreSyncPoller, pin/unpin) silently skipped invalidation. After Wed maintenance flipped games' status to HIDDEN, `computeRankings`'s `WHERE status IN ('ACTIVE','COMPLETED')` filter dropped them, but the cached snapshot still reflected the pre-maintenance state — so the public ranking page showed stale points/standings until manual intervention.

### Fix — data watermark

Migration **097** adds `data_watermark TEXT` to `ranking_groups_cache`. `RankingService` computes a cheap fingerprint of the underlying data state at compute time, stores it alongside the cached rankings, and re-validates on every read. If anything changed, the cache silently recomputes. **No invalidation calls anywhere in mutation code paths** — adding a new score endpoint requires zero ranking-related awareness.

The watermark composition (one round-trip, sub-10ms over indexed columns):

| Component | Captures |
|---|---|
| `eligible_games_count` (status IN ACTIVE/COMPLETED) | maintenance hiding games, new games activating, status flips |
| `score_count` (non-orphaned, in eligible games) | inserts, deletes, orphans |
| `score_sum` | inserts (sum rises), deletes (drops), upserts to higher value (rises) |
| `MAX(games.end_date)` over the group's tournaments | game completions |
| `MAX(games.start_date)` over the group's tournaments | game activations (auto-pick / manual / queue rotation) |

The only mutation the watermark can't detect is an upsert that lands the same value as before — which is a no-op anyway. Display-name and avatar updates from `user_profiles` are deliberately excluded; the slight rendering lag in cached rankings is acceptable and including them would add a JOIN per read for negligible UX benefit.

### Why this over alternatives

- **vs. application-level invalidation hooks at every mutation site (~7 fan-out points)** — every new score endpoint is a chance to forget. The data tells us when it's stale; no code-path discipline required.
- **vs. SQLite triggers** — opaque, hard to debug, log poorly, can fire on operations we don't care about.
- **vs. compute-on-every-read** — wastes CPU when nothing changed (the common case).
- **vs. version-counter on writes** — still needs every mutation site to increment. Same forgetfulness problem at smaller scale.

### Behavior carried forward

- **Manual "Recompute" button stays** as a diagnostic escape hatch (`POST /:roomId/admin/ranking-groups/:id/recompute` and the room-wide variant). With the watermark, it's no longer load-bearing; pressing it just deletes the cache row to force a fresh compute.
- **`RankingService.update()`'s explicit invalidate** is retained — config changes (best_n, rank_method, tournament_ids) aren't reflected in the data layer, so the watermark wouldn't catch them.
- **Discord `/submit-score`'s `RankingService.invalidateAll()` call removed** — now redundant. Pre-fix, it nuked all groups' caches on every Discord submit, even groups that didn't include the affected tournament. Watermark recomputes only the groups that actually changed.

### Tests

- 4 new `cache watermark auto-invalidation` tests in `RankingService.test.ts`. Cover: insert score after first compute, status flip to HIDDEN, score deletion, no-op (cache hit when nothing changed). 133/133 total tests pass.

### Migration / rollout

- **Migration 097** adds the column with NULL default. Existing cache rows have NULL watermarks; `getRankings` treats NULL as "always recompute" so the first read after deploy lands fresh data. No-downtime upgrade.
- **No FE changes.** SW `CACHE_NAME` unchanged.

---

## [2.10.0] — 2026-05-02

**Per-account iScored session registry.** Eliminates the parallel-Playwright-session contention that caused silent `deleteGame` no-ops at Wed 22:00 maintenance fires. Resolves the open ROADMAP entry from the 2026-04-29 incident (CSI / X-Men Wolverine LE / Paranormal / Attack from Mars stayed visible on iScored despite local DB being marked HIDDEN).

### Root cause

iScored treats one logged-in user as one browser session. When 4 weeklies + Daily Grind fire maintenance at the same minute on `rtx_pinball` — all sharing the `mekelburgj@gmail.com` iScored account — each path used to construct its own `IScoredClient`. Multiple Playwright contexts on the same iScored account contend over server-side state. Symptom: the `<select id="selectGame">` dropdown gets repopulated mid-call between `navigateToGamesTab()` and the option lookup, `IScoredClient.deleteGame` finds zero matching options at line 692, logs `Game '<name>' not found in dropdown. Skipping delete.`, and returns. The caller then logged `Deleted from iScored: <name>` regardless because `deleteGame` returned `void` — failure was indistinguishable from success.

### Architectural fix

- **New `IScoredSessionRegistry` (`src/engine/IScoredSessionRegistry.ts`).** Singleton with `withSession(creds, fn)` API. Calls for the same iScored account chain serially: only one `fn` callback runs at a time per account. The underlying `IScoredClient` is held open across consecutive calls within a 1.5s idle TTL so cron-fire batches reuse the same Playwright login (saves ~3-9s per fire when 5 tournaments share an account).
- **All iScored mutations route through the registry.** Refactored every direct `new IScoredClient()` call site to use `withSession()`: `TournamentEngine` (runMaintenance, runCleanup, runScheduledCleanup, deactivateGame, deleteGameCompletely, reorderIScoredLineup), `TimeoutManager.fallbackToAutoSelection`, `gameCreation.{pinGameToScoreboard,unpinGameFromScoreboard}`, `IScoredSubmitSync`, the four `rooms.ts` admin endpoints, the `admin.ts` backup endpoint, and the four Discord commands (`/activate-game`, `/pick-game`, `/submit-score`, `/sync-state`). The only construction site is now `IScoredSessionRegistry.acquireClient`.
- **Inline cleanup reuses the maintenance client.** Pre-fix, `runMaintenanceWork` opened one client for slot processing then `runCleanup` opened another — two sequential Playwright sessions per maintenance run, even within a single tournament. Now the same client threads through. `runCleanup` accepts an optional `(sharedClient, sharedCreds)` pair; when present it skips its own registry acquisition.
- **`reorderIScoredLineup` scoped to one room.** Pre-fix, every maintenance fire reordered every room's lineup (5 weeklies on rtx_pinball = 5× redundant reorders of the same lineup). Now it accepts `(gameRoomId?, sharedClient?)`; the maintenance flow passes its own room and shared client, and the function only reorders that room. Standalone calls preserve the iterate-all-rooms behavior.

### Honest `deleteGame` return value

- **`IScoredClient.deleteGame` now returns `Promise<boolean>`.** Returns `false` when the dropdown short-circuit fires (no matching option), `true` when the delete confirmation modal was driven through. Throws on actual errors.
- **All callers branch on the result.** `runCleanup` logs `-> Cleanup skipped <name> on iScored (not in dropdown). Local row will still be marked HIDDEN.` instead of the false `Deleted from iScored: <name>`. `deleteGameCompletely` sets `iscoredStatus: 'failed'` with an actionable error (`Game not found in iScored dropdown — iScored entity may need manual cleanup.`) so admin UI surfaces the orphan rather than reporting a fake success.

### Behavior carried forward

- **Per-tournament maintenance mutex** (`maintenanceLocks` in `TournamentEngine`) is preserved — guards re-entry within the same tournament. Cross-tournament serialization is now handled by the registry instead.
- **`ScoreSyncPoller.pause()/resume()`** is preserved at the `runMaintenanceInternal` level. Concurrent maintenance fires for different tournaments still pause/resume the poller; the registry serialization means the work itself is sequential, so the pause window is well-defined.
- **`runMaintenanceWork` v2.9.0 inline cleanup behavior** is preserved (cleanup-cron-matches-now still fires inline). Now load-bearing for fewer reasons since registry serialization solves the original race, but kept for belt-and-suspenders.

### Tests

- Build clean (`tsc` + `vite build`), **129/129 tests pass**. No new test files — the registry's chain logic is small and best validated by the next Wed 22:00 maintenance run; the fan-out through every iScored caller is covered by existing route smoke tests.

### Migration / rollout

- **No DB schema changes.**
- **No frontend changes.** SW `CACHE_NAME` does NOT need a bump — backend-only refactor.
- **Backwards-compatible deploy.** Drop-in replacement; old code paths and new code paths produce identical correct outputs in the single-fire case. The fix is observable only at concurrent-fire moments (Wed 22:00, Thu/last-day-of-month 22:00 for rtx_pinball).

---

## [2.9.0] — 2026-04-29

**Per-row score moderation + multi-slot picker correctness.** Two user-visible features and two latent-bug fixes that surfaced during the same arc, shipped as a single minor.

### Score moderation

Players were able to self-delete on the **Global** scoreboard's GameDetail page (`DELETE /api/me/global-scores/:scoreId`) but had no equivalent for room-scoped scores. Room admins had a backend endpoint (`DELETE /api/rooms/:roomId/admin/games/:gameId/submissions/:submissionId`) but its only UI was on the legacy `AdminGameCard` rendering path which doesn't render once `SCOREBOARD_STYLE` is set — i.e. dead code in production for everyone using the v2.x card system.

- **Player self-delete + admin per-row delete on `GameDetail.tsx`.** Trash icon appears on hover next to each `score_history` row in the per-player history expand, gated client-side by decoded JWT claims (`role`, `gameRoomIds`, `discordId`). Server-side authorization in the new endpoint independently re-checks. Restricted to `source IN ('tournament','sync')` rows — community-source delete needs a `community_scores` cascade that isn't built yet.
- **Admin "Manage Scores" modal on the Leaderboard page.** New "Scores" button in `AdminCardWrapper` (alongside Style/Notes/Name/Remove) opens a modal listing per-player submissions with delete buttons. Targets the existing admin endpoint (now fixed — see below).
- **Latent bug: existing admin endpoint didn't actually remove the score from the leaderboard.** Tournament leaderboards have read `score_history` filtered by `submitted_during_tournament_id` since v2.1.0, but the admin delete endpoint only ran `DELETE FROM submissions`. Cache invalidation re-computed from `score_history` on next render and the score reappeared. Fix: cascade to `score_history` rows matching `(game_room_id, iscored_username, game_id-or-game_name)`.
- **Latent bug: pinned games were 404'ing.** The verification query in the admin endpoint used `INNER JOIN tournaments` — pinned rows (`tournament_id IS NULL`, ADR 0005) didn't match. Switched to `LEFT JOIN tournaments` with an `ownedByRoom` check that accepts either `tournaments.game_room_id` or `games.game_room_id`.
- **New per-row endpoint: `DELETE /api/rooms/:roomId/score-history/:historyId`.** `requireDiscordUser` + per-row authorization (`super_admin` OR `room_admin` for this room OR `submitted_by_user_id === viewer.discordId`). Recomputes the corresponding `submissions` row from remaining `score_history` (`ORDER BY score DESC, created_at ASC LIMIT 1` — preserves the timestamp of the displayed highest score) — deletes if no rows left, else updates `score`+`timestamp`.
- **Sync-resistant tombstone (migration 096).** New `deleted_score_suppressions(game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)` table. Both delete endpoints write a tombstone (`MAX(existing, deleted_score)` on conflict so repeat deletes never lower the threshold). `ScoreSyncPoller.pollOneAccount` bulk-loads the suppression map per game and skips `score <= suppressed_score` before the existing `>` check — new higher scores still flow through, deleted scores stay deleted across poll cycles. iScored has no per-score delete API, so without this the sync poller would re-import deleted scores within ~30s. Caveat documented: the iScored side keeps the entry; admins must clean up manually until the iScored cascade lands (ROADMAP).

### Cron race fix

Daily Grind on rtx_pinball had `0 22 * * *` maintenance + `0 22 * * 3` cleanup. On Wednesdays both cron tasks fired at the same instant, with no serialization between them. Cleanup's first SELECT ran before maintenance had completed today's active game; one game per Wed survived as `COMPLETED`-but-not-`HIDDEN` until next week's cleanup. Black Knight 2000 on 2026-04-29 was the latest casualty.

- **Fix.** When `runMaintenanceWork` finishes the slot loop, if `cleanupRule.mode === 'scheduled'` AND the cleanup cron's `min/hour/dom/mon/dow` would all match right now in its timezone, run cleanup inline. The separate cleanup cron is left registered — it still fires (idempotent: zero `COMPLETED` rows left after the inline pass).
- **New helper.** `TournamentEngine.cleanupCronMatchesNow(cron, tz)` — small private cron-field matcher supporting `*`, single integers, comma lists (`1,3,5`), and inclusive ranges (`1-5`). That's the full set the codebase uses; no `step` values, no named weekdays, no `L` (the maintenance cron's `L`-handling is in `Scheduler.resolveCron`).
- **`emitLeaderboardUpdated` now broadcasts globally.** The function existed but was never called and was scoped to `io.to('game:gameId')` — no FE page joins per-game rooms, so it would have reached zero clients. Both delete endpoints now emit globally so other open Scoreboard / admin Leaderboard / Game Detail tabs repaint without a manual reload.

### Multi-slot picker correctness

When one user won multiple slots in a single maintenance run (e.g. Weekly Grind - VPXS `max=2` with the same player on top of both), we emitted exactly **one** `[Pending Pick]` placeholder + **one** turn-to-pick DM, collapsing the wins. Symptom on rtx_pinball 2026-04-29: user won X-Men Wolverine LE + CSI in one rotation; only one slot got refilled, the other sat empty.

- **Dedup rescoped.** Was `(tournament_id, picker_discord_id)`, now `(tournament_id, picker_discord_id, won_game_id)`. Each slot win emits its own placeholder + DM; re-runs of maintenance for the same `(tournament, winner, won_game)` still no-op.
- **DM + embed copy now names the won game.** Channel embed: `Pick Needed — {gameName}` / *"you won {gameName}! Use /pick-game within X minutes to select the next game for this slot."* DM: *"You won {gameName} in {tournamentName} — it's your turn to pick the next game for that slot."* Players who win multiple slots get one set per slot, each clearly labeled with which slot they're filling.
- **`/pick-status` API extended.** Now returns `pick_slot_id`, `won_game_id`, `won_game_name` per pending pick. `Picks.tsx` uses `pick_slot_id` for stable React keys (was `tournament_id`, which collided on multi-slot pendings) and renders `won {game}` next to the tournament name.
- **Discord `/pick-game` now fulfils placeholders.** Pre-fix the command branched only on `hasOpenSlot` — never checked for an outstanding `[Pending Pick]`. Effects: with an open slot, the placeholder dangled as stale `QUEUED`; with all slots full, the new game appended to the queue tail while the placeholder sat at the front, so the next rotation activated nothing useful and the user waited an extra round. Three branches now mirror the web `/pick-game` route:
  - **Pending + slots full** → `UPDATE` the placeholder's name + style_id (keeps `queue_order = NULL`, sorts ahead of explicit queue games via `processSlotMaintenance`'s `ORDER BY queue_order ASC, rowid ASC`).
  - **Open slot (with or without pending)** → create on iScored, drop placeholder if present, `activateGame` — all in one txn.
  - **No pending + slots full** → `queueGame` (unchanged, appends to tail).
- **Embed adds a third "queuedFromPick" path** so the user can tell whether their pick jumped the queue (won-pick reward) vs landed at the tail (regular queue).

### Files

- `src/api/routes/rooms.ts` — admin endpoint cascade + pinned-game support, new per-row endpoint, websocket emit, `/pick-status` extended
- `src/services/ScoreHistoryService.ts` — `getPlayerGameHistory` returns `submitted_by_user_id`
- `src/api/websocket.ts` — `emitLeaderboardUpdated` global broadcast
- `src/database/database.ts` — migration 096 (`deleted_score_suppressions`)
- `src/engine/ScoreSyncPoller.ts` — suppression check before insert (matches both `resolvedName` and original iScored name post-alias)
- `src/engine/TournamentEngine.ts` — picker dedup rescoped, embed/DM copy, inline-cleanup-on-overlap, `cleanupCronMatchesNow` helper
- `src/discord/commands/pickgame.ts` — three-branch fulfillment matching the web route
- `admin-ui/src/pages/GameDetail.tsx` — viewer claims decode, `ScoreHistoryRow` trash icon, `handleDeleteScoreHistory`
- `admin-ui/src/pages/Leaderboard.tsx` — `ManageScoresModal`, `Scores` button on `AdminCardWrapper`
- `admin-ui/src/pages/Picks.tsx` — `PendingPick` interface gains `pick_slot_id` / `won_game_id` / `won_game_name`; row keying + render
- `admin-ui/public/sw.js` — `CACHE_NAME` walked `arcaid-v42` → `arcaid-v43` → `arcaid-v44`

### Migration notes

- **096 (`deleted_score_suppressions`)** — idempotent, runs on container start. No backfill (forward-looking).
- No data migrations, no breaking schema changes. Pre-existing `[Pending Pick]` rows that were dangled by the old Discord `/pick-game` path will be cleared by `TimeoutManager.fallbackToAutoSelection()`'s orphan sweep at their pick-window expiry (default 60min).

### Tests

129/129 passing. No new test files this release — handlers exercise paths already covered by route smoke tests; the cron-field matcher is a small private helper best verified by inline-cleanup behaviour next Wed at 22:00 Central.

### Known followups (in ROADMAP)

- **iScored per-score delete (true cascade)** — current model suppresses re-import on our side only; iScored's public page keeps the deleted entry until manual cleanup.
- **Parallel iScored Playwright sessions step on each other on Wed 22:00** — multiple maintenance/cleanup runs spin up concurrent sessions against the same iScored account; symptom 2026-04-29: WG-VPXS cleanup logged `Game 'CSI' not found in dropdown. Skipping delete.` for both CSI and X-Men Wolverine LE despite the DB marking them HIDDEN.

---

## [2.8.2] — 2026-04-28

**Display-name on the two surfaces deferred from v2.8.1.** Closes the v2.8.1 loose ends.

- **`GET /api/global/recent-scores`** (LandingPage ticker) now returns `player_display_name` alongside the existing game-level `display_name`. SQL pulls from `user_profiles` joined via `COALESCE(submitted_by_user_id, um.discord_user_id, gs.player_id)` so attributed-by-merge rows resolve correctly. FE `RecentScore` interface adds `player_display_name`; `ScoreTickerCard` renders the chosen name with a `playerLabel` fallback to `iscored_username`.
- **`StatsService.getRoomOverview`** (`/:roomId/stats/overview`) latest-submission card now includes `display_name`. Same JOIN pattern (`user_mappings` for iscored:* synthetic ids → `user_profiles` for the chosen name). `PublicStats` overview card renders display_name when set.

No schema changes. No new tests; both are read-only display tweaks covered by manual verification.

---

## [2.8.1] — 2026-04-27

**FE polish: render user-chosen display_name in scoreboard cards.** The v2.8.0 BE work shipped `display_name` alongside `iscored_username` in every leaderboard, ranking, and stats response, but the FE components were still rendering raw `iscored_username`. After saving a display name on `/account/settings`, users saw their old iScored alias on every public surface.

- New `playerName(entry)` helper exported from `ScoreboardComponents` — single resolution rule (`display_name || iscored_username`) used across components. Match/key/route logic deliberately keeps using `iscored_username` for stable identifiers.
- Display substituted in: `BannerCard`, `MinimalCard`, `ScoreList`, `ShowcasePodium`, `ScoreboardComponents` (compact/horizontal/ranking-group rows), `Leaderboard`, `GameDetail` (tournament leaderboard, score history, community board, recent submissions, player rankings list), `GlobalScoreboard` (podium + spillover list), `GlobalGameDetail` (rankings table), `Stats`, `PublicStats`, `Rankings`, `Friends`.
- `RankedEntry`, `RankingGroupData.rankings[]`, plus the local interfaces in `GlobalScoreboard`, `GlobalGameDetail`, `GameDetail`, `PublicStats`, `Rankings`, `Stats`, `Friends` all now carry an optional `display_name` field.
- `FriendsService.getFriends` LEFT JOINs `user_profiles` so the friends list pulls each friend's `display_name` and `avatar_hash` (replacing the old `user_mappings.avatar_hash` source). Many-to-one mapping handled by `MIN(m.iscored_username)` + GROUP BY.

### Known still-pending
- `LandingPage` recent-scores card still renders the iScored alias (its `display_name` field already serves the *game* name; needs a separate `player_display_name` field added to the BE response).
- `PublicStats` "Latest submission" overview card on the Stats overview row (`StatsService.getOverview`) doesn't include `display_name` yet.

Both are minor non-leaderboard surfaces; rolled into a future v2.8.2 cleanup.

---

## [2.8.0] — 2026-04-27

**Identity merge forward-attribution + Discord-style display names.** Two-part feature shipped together. Closes the long-standing gap where admin "merge anonymous identity → Discord user" only retrofitted historical rows; future iScored scores under the same nickname continued to land as anonymous synthetic IDs.

### Forward attribution

- `MergeService.recordMerge` now writes a `user_mappings` row inside the merge transaction, so the next `ScoreSyncPoller` cycle attributes new scores under the merged nickname to the target Discord user automatically.
- `MergeService.reverseMerge` cleans up: drops the `user_mappings` alias row + re-anonymizes any post-merge auto-attributed rows that aren't in the original snapshot. Restores the pre-merge state across all four score tables.
- `user_mappings` schema now many-to-one (one Discord user can hold many iScored aliases): dropped the `discord_user_id` PRIMARY KEY, added `UNIQUE(iscored_username COLLATE NOCASE)`, added `created_at`. Migration 095 detects and refuses to run if any case-only collisions exist on existing rows.
- New helper `fetchAvatarHash` in `src/utils/discord.ts` — best-effort Discord REST call; called after merge to seed the user's avatar cache.
- Mapping-conflict pre-check in `recordMerge` surfaces a `MAPPING_CONFLICT` typed error when the alias is already owned by a different Discord user, so the admin sees a clean message instead of a 500.

### Discord-style display names

- New `user_profiles` table (one row per Discord user). Holds the user-chosen `display_name` plus the avatar cache. Globally unique display name, case-insensitive, also collision-checked against other users' iScored aliases.
- New `UserProfileService` (validate, upsert, batch-lookup, availability check).
- New `/account/settings` page (admin-ui). Display-name input with debounced availability check, read-only avatar preview, list of linked iScored aliases. Linked from the user menu dropdown.
- New `/api/users/me/profile` (GET/PATCH) and `/api/users/me/profile/check-display-name` (GET).
- Leaderboards collapse-by-Discord-user: `LeaderboardService.recalculate`, `getForGameByPlatform`, `GlobalLeaderboardService.recalculate`, and the cross-game top-N helper now `PARTITION BY COALESCE(submitted_by_user_id, 'iscored:'||LOWER(iscored_username))`. Multi-alias users render as one row per game; anon rows still partition per-name.
- All leaderboard responses + ranking groups + Stats overview now ship `display_name` alongside `iscored_username`. FE renders `display_name` when set, falls back to `iscored_username`.
- `LobbyFeedGenerator` resolves display name for new-#1 / rank-change / score-posted / friend-score event titles + `rankDethroned` / `friendScore` DMs.
- `TournamentEngine` winner announcement embeds + picker-assigned ticker use the user-chosen display name.
- Avatar cache moved from `user_mappings.avatar_hash` to `user_profiles.avatar_hash`. `auth.ts` Discord OAuth callback now writes the new column. Existing leaderboard reads now pull avatar from `user_profiles` via `discord_user_id` (with `user_mappings` still resolving `iscored:*` synthetic IDs).

### Behavior changes

- **`/map-user` Discord command** changes from "replace this user's mapping" to "add an alias for this user." With many-to-one mappings the old replacement semantic no longer makes sense. Errors if the name is already mapped to a different user. A `/unmap-user` companion command is deferred.
- All `user_mappings` UPSERT call sites (auth.ts, global.ts, mapuser.ts, submitscore.ts, IdentityManager.ts) switched conflict key from `discord_user_id` to `iscored_username`. The intent of each call site is unchanged: "register this alias for this user; if the name is already taken, leave it alone."

### Tests

- `MergeService.test.ts` — coverage for forward-attribution write, MAPPING_CONFLICT, idempotent re-merge, case-insensitive collision check, reverseMerge cleanup, and a regression check for the v2.7.x freeze-gate fix.
- `UserProfileService.test.ts` — display-name validation, uniqueness rules, own-alias allowance, batch lookup.

### Migration

- **095** — `user_mappings` rebuild + `user_profiles` create + backfill. Aborts with a clear error if pre-existing case-only collisions are present.

---

## [2.7.2] — 2026-04-27

**Duplicate dethrone DM root cause + Deactivate/Delete admin split.** Bug fix arc that grew into a small admin-UX refactor when the simple "always delete on deactivate" first cut turned out wrong for normal end-of-round semantics.

### Bug

User received two identical `rankDethroned` Discord DMs for the same WHO dunnit submission on rtx_pinball at 2026-04-27 02:56 UTC. Same score (96,814,400), same dethroner (PBW2023), 763ms apart.

Forensics: two `games` rows shared an `iscored_id = "95570"` — one ACTIVE in **Daily Grind**, one COMPLETED in **Weekly Grind - VR**. Both were created when WHO dunnit was activated in two different tournaments; the older row never had its iScored game deleted (just locked under the legacy contract), so the newer activation's `IScoredClient.createGame` reused the existing iScored entity.

When PBW2023 submitted via web `/submit-score` (anonymous), the route inserted into `submissions` keyed on the Daily Grind row's `game_id`. `CommunityScoreService.submitScore` fired `LobbyFeedGenerator.onScoreSubmitted` once → DM #1. Then the SyncPoller pulled the score back from iScored: its `db.get` lookup matched the *Weekly Grind* row first (no `ORDER BY`, no status filter), found no `submissions` entry under that `game_id`, treated the score as new, and fired `onScoreSubmitted` a second time → DM #2.

### Fix

Two architectural changes plus one admin-UX addition, shipped across three commits.

**Fix B — `7c7cf8b8` — SyncPoller deterministic lookup.** `ScoreSyncPoller.pollOneAccount` now orders by `CASE g.status WHEN 'ACTIVE' THEN 0 WHEN 'COMPLETED' THEN 1 ELSE 2 END, g.created_at DESC LIMIT 1`. With this in place, the poller always picks the same row the web/Discord routes pick, regardless of how many legacy rows share an `iscored_id`. This alone neutralizes the duplicate-DM bug for the existing prod data — it's the correctness fix.

**First-cut Fix A (reverted) — `7c7cf8b8`.** Deactivation hard-deleted the iScored game and NULLed `iscored_id` on the games row. This killed the structural cause but turned out wrong for normal end-of-round behavior — admins still want history visible on iScored after a round closes; deletion belongs to the rare "wrong game in wrong tournament" case. Reverted in `aef1d0ff`.

**Final Fix A — `aef1d0ff` — Deactivate vs Delete split.** Two distinct admin actions on an ACTIVE game:

| Action | iScored | ArcAid `games` row | Use case |
|---|---|---|---|
| **Deactivate** | `setGameStatus({ locked: true })` | status=COMPLETED, `iscored_id` retained | Normal end-of-round / cron rotation |
| **Delete** | `deleteGame()` | DELETE FROM games, scores orphaned per ADR 0005 | Wrong game in wrong tournament |

Both run a new `TournamentEngine.finalSyncScoresForGame()` helper first — pulls iScored scores into `submissions` + `score_history` so anything submitted between the last poll cycle and the action is captured before destruction. The helper does **not** fire `LobbyFeedGenerator.onScoreSubmitted` (data capture only, no live events).

`processSlotMaintenance()` (cron rotation) follows the same lock+sync contract as admin Deactivate. Keeping `iscored_id` non-NULL on COMPLETED rows lets `runCleanup` (cleanup_rule retain/scheduled/immediate) find them later.

**Retained-completed admin section — `bd58481c`.** Daily Grind on rtx_pinball uses `cleanup_rule.mode = 'scheduled'`, which keeps every COMPLETED game on the public scoreboard until the Wednesday cleanup cron. Pre-fix, an admin who deactivated a game with no scores had no UI affordance to remove it before that scheduled run. New endpoint `GET /api/rooms/:roomId/games/retained-completed` mirrors `LeaderboardService.getActiveLeaderboards`'s retention logic (capped at 100 rows per tournament for `scheduled` mode). Tournaments admin page now renders a "Retained Completed Games" card below Active Games with a Delete button per row, reusing the same type-to-confirm dialog and the new `DELETE /api/rooms/:roomId/games/:id` endpoint.

### Architecture

`TournamentEngine.deleteGameCompletely(gameId, opts?)` is the new destructive variant. Steps: final-sync → `deleteGame()` on iScored (shared-`iscored_id` guarded) → orphan local scores (`UPDATE submissions/score_history SET game_id = NULL`, `UPDATE global_scores SET origin_game_id = NULL`) → `DELETE FROM games`. Score *records* are preserved per the ADR 0005 cascade pattern so player personal history survives a "wrong game" delete.

The `finalSyncScoresForGame()` helper is shared by `deactivateGame()`, `processSlotMaintenance()`, and `deleteGameCompletely()`. It pulls via `IScoredApiClient.getGameScores` (HTTP, fast), respects `player_aliases` + `user_mappings` exactly like the live SyncPoller, and uses `iscored:<name>` synthetic discord_user_ids for unmapped iScored users.

The duplicate-DM bug had two layers:
1. **Root cause** — iScored game IDs got reused across `games` rows because the legacy "lock on deactivate" never deleted them. Cleared structurally for new flows by the Deactivate-vs-Delete split (Delete cleans iScored when an admin chooses to; Deactivate locks but keeps the link, and the SyncPoller's `ORDER BY` handles the legacy reuse case).
2. **Surface fault** — SyncPoller's non-deterministic `db.get` could pick the wrong row when an `iscored_id` was shared. Fixed by Fix B's `ORDER BY`.

Both layers shipped — Fix B is the correctness patch, Fix A is the structural cleanup.

### Files

Backend:
- `src/engine/ScoreSyncPoller.ts` — `ORDER BY` status pref + `created_at DESC LIMIT 1` on the per-account local-game lookup
- `src/engine/TournamentEngine.ts` — `deactivateGame()` rewritten (lock + final-sync, keeps `iscored_id`); `processSlotMaintenance()` follows the same contract; new `deleteGameCompletely()` method; new private `finalSyncScoresForGame()` helper
- `src/api/routes/rooms.ts` — new `DELETE /:roomId/games/:id` route → `deleteGameCompletely`; new `GET /:roomId/games/retained-completed` route mirroring `LeaderboardService` retention logic
- `src/discord/commands/deactivategame.ts` — embed wording reverted to "locked on iScored"; surfaces `finalSyncedScores` count

Frontend:
- `admin-ui/src/pages/Tournaments.tsx` — new "Retained Completed Games" `NeonCard`; new "Delete" button on Active Games rows; new type-to-confirm dialog; broadened `deleteGameTarget` state to a structural `DeletableGame` type so both ActiveGame and RetainedCompletedGame work; deactivate toast wording updated to reflect lock semantics + captured-late-scores suffix
- `admin-ui/public/sw.js` — `CACHE_NAME` bumped `arcaid-v34` → `arcaid-v37` (three bumps across the v2.7.2 cycle)

Docs:
- `CLAUDE.md` — "iScored integration" section now documents the Deactivate vs Delete contract, `finalSyncScoresForGame` semantics, and the SyncPoller `ORDER BY` defense
- `CHANGELOG.md` — this entry
- `package.json` — `version: 2.7.2`

Note: commit `e28cdb81` (between `7c7cf8b8` and `aef1d0ff`) was a user-authored fix for a `MergeService` query referencing a non-existent `tournaments.end_date` column — the query was rewritten to derive a completion timestamp from `MAX(games.end_date) WHERE status='COMPLETED'` for the tournament. Unrelated to the dethrone-DM arc but bundled into the same release window.

### Migration notes

None — no schema or data changes.

One-off prod cleanup: a "Spooky Retro" games row (deactivated under the first-cut "always delete" version of v2.7.2) was sitting on the public scoreboard with no admin affordance to remove it. Deleted via `docker exec arcaid node -e ... TournamentEngine.getInstance().deleteGameCompletely('5fab0c5e-…')` — `iScored: skipped` (admin had already cleared it manually), 0 scores orphaned. Future occurrences of this scenario are now self-service via the Retained Completed Games card.

### Open followups

None new from this arc. Existing items in `ROADMAP.md` (style overlay re-keying, ScoreSyncPoller adaptive backoff, fetch-agent self-heal on N consecutive failures) are unaffected.

---

## [2.7.1] — 2026-04-26

**Tournament platform-rules orthogonality (ADR 0009).** Patch release fixing a submission-picker bug surfaced after v2.7.0 deploy.

### Bug

Player attempting to submit a VPX score for **WHO dunnit** (catalogue + room tags = 6 platforms: vpx, vpxs, real, pinball_fx, pinball_fx_vr, atgames) under the **Daily Grind** tournament (`Must = [atgames]`, `NotAllowed = []`) saw only AtGames in the picker — captioned "(only platform for this game)".

The game *is* multi-platform; the tournament rule's `Must` clause was incorrectly narrowing the submission picker. Per the user-clarified semantics, `Must` is purely a game-level eligibility gate ("this game qualifies for the tournament") — once a game is admitted, scores from any of its platforms count (modulo `Not allowed on`).

### Fix

Two commits, FE + BE:

- **`9dc58ad4` (FE)** — `SubmissionSheet` now also tracks `data.platforms` (full pre-rule set) from `/api/submit/platforms` into `fullGamePlatforms` state. The single-platform chip caption disambiguates: `fullGamePlatforms.length > 1` → "(only platform allowed by this tournament)" else "(only platform for this game)". SW `CACHE_NAME` → `arcaid-v34`.
- **`faf86557` (BE)** — `resolveSubmittablePlatforms` drops the `required` clause. Returns `gamePlatforms − excluded`, period. `passesplatformRules` (game-level gate) unchanged — still checks `required` only. The two helpers now enforce one axis each, no overlap. JSDoc on both helpers rewritten to spell out the orthogonal-axes contract. `ensurePlatformAllowed` (server-side validator) inherits the corrected behavior through the same helper.

### Architecture

ADR 0009 — **Tournament platform rules are orthogonal axes**:

| Rule | Helper | Axis |
|---|---|---|
| `required` ("Must") | `passesplatformRules` | Game-level eligibility ONLY |
| `excluded` ("NotAllowed") | `resolveSubmittablePlatforms` | Submission-level filter ONLY |

Worked example: WHO dunnit on `[vpx, vpxs, real, fx, fx_vr, atgames]`, tournament `Must=[atgames], NotAllowed=[]`:
- `passesplatformRules` → TRUE (game has atgames → admissible)
- `resolveSubmittablePlatforms` → all 6 platforms (nothing excluded)
- Picker: 6-option dropdown. Player submits any.

ADR 0006 (platform stratification) is not formally superseded — its core decision (every score row carries `platform`; per-game picker UX) is intact. The Decision section's "∩ required" phrase is now stale; ADR 0006 has a Notes section pointing at 0009 for the corrected resolver semantics.

### Files

- `src/utils/platformRules.ts` — `resolveSubmittablePlatforms` simplified; both helpers' JSDoc rewritten
- `admin-ui/src/components/SubmissionSheet.tsx` — `fullGamePlatforms` state + caption disambiguation
- `admin-ui/public/sw.js` — `CACHE_NAME` → `arcaid-v34`
- `CLAUDE.md` — Platform stratification section rewritten with two-axis table + worked example
- `README.md` — feature blurb + Tournament Settings table corrected to reflect orthogonality
- `docs/decisions/0009-tournament-platform-rules-orthogonal.md` — new ADR (full Context / Decision / Consequences / Alternatives)
- `docs/decisions/0006-score-platform-stratification.md` — Notes section pointing at 0009
- `docs/decisions/README.md` — index entry

### Migration notes

None — no schema or data changes. Behavior shift is deliberate: tournaments previously created with `Must=[X]` expecting it to lock submissions to platform X will now accept all of an admitted game's platforms. Admins wanting a hard submission lock should use `NotAllowed` for the platforms they want to block.

---

## [2.7.0] — 2026-04-26

**Multi-arc release.** Per-room game tagging (ADR 0008), tournament platform-rules semantics shift, two new catalogue sync sources (Pinball FX VR + AtGames Sheet), library bulk operations + search overhaul, iScored credentials hardening, ScoreSyncPoller log-spam fix.

### Per-room game tagging — ADR 0008

New `room_game_tags(game_room_id, global_game_id, tag)` table. Variant-keyed via `global_games.id` so the FE's variant rows tag independently. Tags are lowercased + trimmed on write; rendered via `getPlatformDisplay` (uppercase fallback for non-canonical tokens like "WMS"). Distinct from the surviving (deprecated) `game_room_game_library` overlay so the eventual style-overlay re-keying doesn't have to touch tags.

Read paths union catalogue platforms with room tags everywhere a game-level platform check happens:
- `ensurePlatformAllowed` (submission-level)
- `/api/submit/platforms` resolver
- `/:roomId/platforms/available` (tournament rules picker)
- `/:roomId/game_library` returns `room_tags: string[]` per row
- Web pick-game route, admin activate-game route
- Discord `/activate-game`, `/pick-game` autocomplete
- `TournamentEngine.autoPickAndActivate` (tournament rotation auto-pick)
- `TimeoutManager` fallback auto-pick

Endpoints (all under `/api/rooms/:roomId/`): `GET /games/:globalGameId/tags`, `POST /games/:globalGameId/tags`, `DELETE /games/:globalGameId/tags/:tag`, `POST /games/bulk-tag` (cap 500), `POST /games/bulk-untag`.

`RoomGameTagsService.getTagMapByGameNameForRoom(roomId)` powers the autopick / autocomplete batch lookups (single SQL JOIN, no N+1).

Migration 093 inline. See ADR 0008 for the rationale.

### Tournament platform-rules semantics shift

`Not allowed on` was previously a game-level rejection ("game with this platform tag won't enter the tournament"). It's now a **submission-level filter only** ("the score's selected platform can't be in this list — game itself can still be picked"). `Must be available on` stays a game-level gate (game must list at least one required platform).

The shift required:
- `passesplatformRules` drops the `excluded` clause (game-level gate checks `required` only).
- `TournamentEngine` autopick + `TimeoutManager` fallback autopick filters drop the inline excluded check.
- Tournament form's "Not allowed on" subtitle copy: "(blocks score submissions, not game selection)".
- Inline validator catches the contradictory case: same platform in both `Must` and `Not Allowed` → error chip + Create/Save buttons disabled. `getPlatformRuleConflicts` exported helper.

Backwards-compat note: existing tournaments with `excluded=[X]` under the old semantics silently begin admitting games that carry X. Behavior shift is deliberate.

### Pinball FX VR catalogue tagger

Hand-curated source-of-truth (`tmp/fx-vr-tables-draft.md`, gitignored) → emitted TS data module (`src/services/fxVrPackContents.ts`, committed) → `FxVrImportService.applyTags()`. 39 tables across 17 packs (Williams Vols 1/2/3/9/10 + Tomb Raider + Universal Monsters + Scared Stiff + Elvira + Charlie Brown + Godzilla vs Kong + Bethesda + Universal TV Classics + 5 standalone titles + 3 base FX VR Zen originals).

Service uses `GlobalGameService.upsert` so real-machine recreations (Theatre of Magic, etc.) merge `pinball_fx_vr` into existing VPS-imported rows without clobbering manufacturer/year, and Zen originals (Sky Pirates: Treasures of the Clouds, etc.) auto-create with `imported_from='fx-vr'`. Idempotent.

Migration 094 cleans up the legacy bare `vr` token (3 prod rows: Monster Bash, Indiana Jones, Theatre of Magic) — promotes to `pinball_fx_classic_vr` if `pinball_fx_classic` was already present, then strips the bare token.

Admin endpoint `POST /admin/catalogue/sync-fx-vr` + button on the Catalogue page. Refresh cycle: edit `tmp/fx-vr-tables-draft.md`, regenerate via `node tmp/emit-fx-vr-data-ts.js > src/services/fxVrPackContents.ts`, click "Sync FX VR".

### AtGames catalogue sync from curated Google Sheet

`AtGamesImportService` pulls column A of the user's curated availability sheet (`https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=...`, no API key — public CSV export). Same upsert pattern as FX VR.

Phase 2 extension parses cabinet variants from columns H/I/J/K (per-porter-studio cells with values like `HD`, `4K`, `Micro`, `HDP`, `ALU`, `Mini`, `Gamer`, `Core`). Strips `(most)` / `(some)` parentheticals; skips leading-paren `(coming soon)` cells; skips non-cabinet tokens (Steam, Pinball Arcade, Mobile, Xbox, etc.). Always-tag invariant: every row in column A gets the broad `atgames` tag plus one `atgames_<variant>` per detected cabinet (deduped).

Six new canonical platform IDs: `atgames_micro`, `atgames_hdp`, `atgames_alu`, `atgames_mini`, `atgames_gamer`, `atgames_core`. HD + 4K already existed. Display labels shortened: "AtGames Legends" → "AtGames" (and HD/4K variants). Mirrored across `src/utils/platformMapping.ts` (BE) and `admin-ui/src/lib/platforms.ts` (FE).

Tiny inline CSV parser in the service (no `papaparse` backend dep). Unicode-quote normalization (`’` → `'`) so curly-quoted sheet names match catalogue rows that store straight quotes. Studio attribution via column A fill color skipped per user direction — HTML export path is achievable later if a use case appears.

Endpoint `POST /admin/catalogue/sync-atgames` + button. Production result: 260 rows updated, 0 created (every sheet name matched an existing VPS-imported catalogue row).

### Library page — bulk ops + manufacturer filter (initial) + search overhaul

**Bulk select** — checkbox column on the library table, header checkbox toggles "select all on this page" with selection persisting across pagination. Sticky bottom action bar when ≥1 row is selected: `Tag…` / `Activate…` / `Pin` / `Clear`. Bulk tag uses the new `bulk-tag` endpoint (single SQL multi-insert). Bulk activate + pin use 5-way concurrent worker loops over the existing single-game endpoints with best-effort summary toasts.

**Per-row Tag button** next to Activate/Pin/Style. Opens a dialog with chip-style remove + add input + suggestions from existing room tags.

**Tag chips** render in amber (distinct from cyan catalogue platform chips) so room-only tags are visually separable from catalogue truth.

**Search bar** rewritten:
- Substring match across `name`, `manufacturer`, `year`, `platforms`, `room_tags`, `designers`, `themes`, `table_authors`, `catalogue_aliases`. (Server endpoint extended to ship `designers` / `themes` / `table_authors` / `catalogue_aliases` — VPS catalogue metadata that wasn't in the FE response before.)
- Inline year-range syntax: `2001-2020` (with optional whitespace around the hyphen). `Williams 2001-2020` ANDs the range with the substring query. Strict `\d{4}-\d{4}` pattern in `[1900, 2100]` so we don't consume hyphens in real game titles.
- Live preview line shows what the parser extracted vs. substring-matched.
- Hint text under the input lists every searched field.

**Manufacturer chip-row filter was added then removed in the same release.** Initial design overshot; user wanted smarter search instead. Reverted in favor of the search-bar metadata expansion above.

**Variant disambiguation on the library row** (post-step-2 follow-up): catalogue rows for "Carnival" (4 variants: Bally 1948, Bally 1957, Sega 1971, Playmatic 1977) now show a sub-line `Manufacturer, Year` to visually distinguish. Server returns `id`, `manufacturer`, `year` per row; FE keys React rows by `id` to fix the duplicate-key reconciliation glitch causing the "alphabet restart" symptom users were seeing.

**Client-side pagination** (100 rows/page, `[Prev] [1] [2] … [N] [Next]` with truncation). Resets to page 1 on filter/search/sort change. Search/filter/sort still operate over the full dataset; only the render is paged.

`PlatformChips` got an uppercase fallback for unknown platform IDs: `fx2` → `FX2`, bare `vr` → `VR` (until cleanup migration kills these legacy tokens).

### iScored credentials hardening

**Bug**: admin would activate a game (worked), then deactivate the game (silently failed to lock on iScored — game orphaned). Cause: activate handler used `new IScoredClient()` (env fallback creds), deactivate handler used `getIScoredCredsForRoom()` (per-room creds). When per-room creds were misconfigured, only deactivate failed.

**Fixes**:
- Activate handler now uses `getIScoredCredsForRoom()` like every other path. If per-room creds are wrong, activate fails visibly upfront — before the DB row is created — instead of papering over with env fallback.
- `TournamentEngine.deactivateGame` return signature gains `iscoredStatus: 'locked' | 'failed' | 'shared' | 'skipped'` plus `iscoredError`. FE renders four distinct toasts so admins know whether iScored was locked, skipped intentionally (DB-only), still active in another tournament, or failed (with the error).
- `IScoredClient.connect` classifies login-timeout failures: detects whether the Log In button is still visible after the userDropdown wait fails, and throws either `"iScored rejected the credentials (wrong username or password)."` or `"iScored login timed out — possible rate limit, iScored slow/down, or login page changed."` — replacing the raw Playwright `locator.waitFor: Timeout 15000ms exceeded waiting for #userDropdown` dump.
- New `POST /api/rooms/:roomId/iscored/validate` endpoint runs a quick login attempt and reports `{ ok, username, error }`. New `IScoredCredentialsCheck` component on Settings → iScored renders a `Validate Credentials` button + green-check / red-x result inline. Useful for pre-flighting credential issues.

### ScoreSyncPoller — per-account error suppression

After a 14-minute iScored API outage produced 32 consecutive identical `TimeoutError` log lines, found two bugs:

1. **Per-account errors logged unconditionally.** Outer `poll()` catch had suppression (logs first 3, suppresses thereafter), but `pollOneAccount` failures were caught at the per-account level inside the for-loop and logged on every cycle.
2. **`_lastPollSucceeded` was always `true`.** Set after the per-account loop completed regardless of per-account outcomes.

Fixes:
- New `accountConsecutiveErrors: Map<gameroomName, number>` mirrors the outer counter at per-account scope. Logs first 3 errors per account, suppresses thereafter, logs a `recovered after N failure(s)` line when an account that was failing succeeds.
- `_lastPollSucceeded` reflects whether at least one account succeeded.

Not in scope (next step if needed): adaptive backoff during sustained outages (currently still hits iScored every 5s during outage, just doesn't log it).

### Build + deploy

SW `CACHE_NAME` walked v20 → v33 across 11 UI-visible commits. Backend tsc clean throughout. Admin-ui vite build clean. **109/109 tests pass.**

Migrations 090 (alias column), 091 (alias backfill), 092 (DROP TABLE game_library), 093 (room_game_tags), 094 (legacy `vr` cleanup) all idempotent. New canonical platform IDs require no DB migration (platforms are JSON-array TEXT).

---

## [2.6.0] — 2026-04-26

**Refactor.** Step-2 cleanup of the legacy `game_library` table and the `game_room_game_library` overlay reads. Completes the "library = global catalogue" arc started in v2.5.1 — tournaments, Discord autocomplete, leaderboard image fallback, and the per-room library page now all read from `global_games` directly. Plan: `docs/step-2-cleanup-plan.md`. Shipped in 7 sequential commits (2c → 2a → 2b → 2g → 2d → 2f → 2e), each independently buildable.

**2c — drop `game_room_game_library` overlay reads.** Removed all reads of `custom_platforms` and per-room `display_name` (added in v2.4.0). Nine sites dropped the JOIN + `mergeEffectivePlatforms` step: `ensurePlatformAllowed`, `/api/submit/platforms`, pick-game route, activate-game route, TournamentEngine auto-pick, TimeoutManager fallback, Discord `submitscore` + `pickgame` + `activategame`. Deleted `PUT /:roomId/game_library/:name/overlay` (server-only — no FE caller). `GameLibraryService.{setRoomCustomPlatforms,setRoomDisplayName,getEffectivePlatformsForGame}` removed. `roomOverlay.test.ts` deleted.

**2a — preserve `game_library.aliases` onto `global_games`.** Migration 090 added `global_games.aliases TEXT DEFAULT '[]'`. Migration 091 walked `game_library` and JSON-encoded each non-empty CSV alias list onto the matching `global_games` row, keyed via `gl.global_game_id`. Production: **2523 rows** backfilled. Honest scope note — `game_library.aliases` turned out to be write-only metadata; no runtime reader. Preserved as insurance for a future search-by-alias / iScored alt-name feature.

**2b — switch tournament/leaderboard reads to `global_games`.** `LeaderboardService.getActiveLeaderboards`, `TournamentEngine.activateGame`/`processSlotMaintenance`/auto-pick, `TimeoutManager` fallback auto-pick, `gameCreation.ts` (pin path), `rooms.ts` (game-info image_url, game-availability listing, pick-game read, freeplay/community card-data, admin activate-game, pin validation, iScored sync-create), Discord `submitscore`/`pickgame`/`activategame`/`viewstats`/`viewselection` autocomplete — all switched. Image fallback collapses to `gg.local_image_path → gg.wheel_image_path → gg.image_url`. iScored `client.createGame(name, styleId)` now passes `undefined` (defaults take over). `client.applyStyle(...)` calls dropped — the style-learning loop had no consumer post-2c.

**2g — admin-ui catalogue browser.** `GameLibrary.tsx` is now read-only with two write paths: Add Game (→ `submit_to_global` only) and Import CSV (→ `submit_to_global` only). Removed: edit modal, delete-selection checkboxes, "Edit" + "Delete Selected" buttons, "Style ID" column, `aliases` / `style_id` / CSS-override fields in the Add form, `ConfirmModal` import. Proposal panel: exact-match shows "already in catalogue, pin/activate from the table"; possible-match shows duplicates as informational rows + a single "submit as new" CTA. CSV preview's needs_review rows lose the per-row "use existing" / "room_only" buttons. CSV template simplified: `name,manufacturer,year,mode,platforms`. Sort key drops `style_id`. Backend: `GameLibraryService.search` queries `global_games` (status='approved', `GROUP BY LOWER(name)`). SW `CACHE_NAME` → `arcaid-v19`.

**2d — simplify proposal + CSV-import endpoints.** DELETE `POST /:roomId/game_library/use_global` (catalogue is the library — link is a no-op). DELETE `POST /:roomId/game_library/room_only` (no per-room library). KEEP `/proposals` (read-only dedup preview). Simplify `/submit_to_global` to insert the pending `global_games` row only — no library writes. Simplify `/import-csv-commit` to handle `submit_to_global` decisions only; auto_link rows skipped client-side. Counts shape: `{ submitted_pending, skipped, errors }`. `UseGlobalGameSchema` removed; `ImportCsvCommitSchema.decision` narrowed to `z.literal('submit_to_global')`.

**2f — drop legacy admin endpoints.** Removed 7 endpoints from plan §2f plus 3 sibling super-admin endpoints depending on dying tables: `GET /admin/game_library`, `POST /admin/game_library/{import,delete,merge,import-vps,import-wizard}`, `PUT /admin/game_library/:name`, `POST /:roomId/game_library/{import,delete}`, `PUT /:roomId/game_library/:name`. `VpsImportService` + `WizardImportService` dropped their dual-write to `game_library` + the `addToRoom` calls in `/catalogue/sync-vps`+`/catalogue/sync-wizard`. `TournamentEngine` style-learning loop (`client.syncStyle` → `GameLibraryService.updateStyles`) removed. `/admin/games-for-picker` switched the "library games" half to query `global_games` directly. `GameLibraryService` trimmed to 3 still-used methods: `search`, `setRoomGameStyle`, `getRoomGameStyle`. Schemas dropped: `ImportGamesSchema`, `UpdateGameSchema`, `gameFields`, `platformsField` helper.

**2e — DROP TABLE game_library.** Migration 092 (`DROP TABLE IF EXISTS game_library`) runs after 091's alias backfill. Final reader cleanups: `/api/submit/platforms` drops the `gl` first-leg lookup; admin display_name endpoint drops the dual-write; `GlobalScoreService.fanOutFromRoomSubmission` third resolution leg switches from `game_library` to `global_games WHERE status='approved'`; `GlobalGameService.merge` drops the `UPDATE game_library SET global_game_id` repointing call; boot-time `tournament_types→platforms` migration code removed (years-old, applied long ago in prod); `migrateToMultiRoom` step 5 (`INSERT INTO game_room_game_library SELECT FROM game_library`) removed. The `CREATE TABLE` for `game_library` at the top of `initDatabase` is intentionally left in place — fresh DBs need it to satisfy the early ALTER migrations (005, 006, 009, 027, 033, 039) and the alias backfill in 091, before 092 finally drops it.

**Scope deviation from the plan: drops only `game_library`, not `game_room_game_library`.** The plan's column audit for the bridge table listed `custom_platforms`, `display_name`, `global_game_id`, and the PK — but missed the per-room style overlay columns (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`) that are still actively read by `gameCreation.ts` + `TournamentEngine` + `StyleCatalogueService` and written by `GameLibraryService.{set,get}RoomGameStyle` + the StylePicker FE. Dropping `game_room_game_library` without re-keying that overlay onto a new `(game_room_id, global_game_id)` table would lose data and break Style assignment. Out of step-2 scope; tracked as a follow-up cleanup.

**Tests:** 109/109 pass. Three test files affected: `roomOverlay.test.ts` deleted (4 tests — overlay surfaces gone); `catalogueBackfill.test.ts` deleted (4 tests — tested migration 069 backfilling the soon-to-be-extinct table); `thinDuplicateMerge.test.ts` first test dropped its `repoints game_library` assertion (game_library no longer exists at runtime); `pinEndpoint.test.ts` setup seeds `global_games` instead of `game_library`.

**Production deploy verification:** migration 091 backfilled aliases onto **2523 `global_games` rows**; migration 092 dropped `game_library`; `ScoreSyncPoller` resumed normally with 18 entries on first poll. ADR 0007 ("Library = global catalogue") still applies — this release is the natural completion of step 1.

---

## [2.5.2] — 2026-04-26

**Patch.** Game library page showed duplicate platform tags per game (`fp` AND `FP`, `vpx` AND `VPX`, `pinball_fx_classic` AND `FX3`). Migration 083 only rewrote the literal `pinball_fx3` token; case mismatches and aliases survived in `global_games.platforms` / `game_library.platforms` JSON arrays.

- **Migration 089** — one-time normalization sweep. Walks every JSON platform array (`global_games.platforms`, `game_library.platforms`, `game_room_game_library.custom_platforms`, `tournaments.platform_rules`) and folds each entry through `normalizePlatform()`. Dedupes case-insensitively. Production landed: 2733 `global_games` rows, 2813 `game_library` rows, 4 tournament rule rows normalized. Idempotent.
- **`GameLibrary.tsx`** — defense-in-depth at render time. `PlatformChips` alias-folds + dedupes via `normalizePlatformList()` then renders `getPlatformDisplay(id)` (e.g. "FX Classic" instead of `pinball_fx_classic`). Filter pill row above the grid does the same. Filter match logic normalizes the game's raw list so filtering works on pre-089 data too.

SW `CACHE_NAME` → `arcaid-v18`.

---

## [2.5.1] — 2026-04-26

**Feature + patch.** Per-room library page reads from `global_games WHERE status='approved'` directly — every room sees the full approved catalogue. The legacy `game_room_game_library` curation overlay is no longer consulted for the list view. This is "step 1" of a two-step cleanup; step 2 (drop the legacy `game_library` / `game_room_game_library` tables, move aliases onto `global_games`, simplify proposal endpoints) is documented in `docs/step-2-cleanup-plan.md`. Tournaments still pick from `game_library` for now — out of scope for step 1.

Three platform-display bugs fixed:

- **Submission picker showed raw IDs and case-mismatch duplicates.** `/api/submit/platforms` resolver now alias-folds + dedupes via `normalizePlatform()` server-side; `SubmissionSheet` renders display names from a new FE-side `admin-ui/src/lib/platforms.ts` helper. Same treatment applied to `GameDetail` tabs and per-row platform badges.
- **Display names shortened** for the Zen Studios FX family + Zaccaria: `"Pinball FX Classic"` → `"FX Classic"`, etc. Catalogue IDs unchanged. Display-only — no DB migration.
- **Global game detail page now has a Platform column** on the cross-room leaderboard. `GlobalLeaderboardService.recalculate` SELECTs `gs.platform`, propagates through `GlobalRankedEntry`, renders as a chip. Migration 088 flushes both leaderboard caches so existing entries pick up the platform field on next read.

SW `CACHE_NAME` → `arcaid-v17`.

---

## [2.5.0] — 2026-04-26

**Feature.** VR + Steam-pinball platform taxonomy expansion, score-platform stratification, per-room contribution flow rationalization. Coordinated bundle — score-platform is required end-to-end, so partial deploys would reject every submission.

**Platform taxonomy.** Adds 7 canonical IDs: `pinball_fx_classic` (replaces `pinball_fx3`, Zen rebrand), `pinball_fx_classic_vr`, `pinball_fx_midnight`, `pinball_fx_vr`, `star_wars_pinball_vr`, `zaccaria`, `zaccaria_vr`. Removed legacy `pinball_fx3` + generic `vr` bucket. New `'VR'` `PLATFORM_GROUPS` quick-pick. `PLATFORM_ALIASES` + `VPS_FORMAT_MAP` fold pre-rebrand names forward.

**Steam Pinball importer.** `SteamPinballImportService` pulls DLC lists from six Steam apps. Curated `PACK_CONTENTS` map (78 packs → 220 table entries) baked in via `steamPinballPackContents.ts`; pack DLCs expand into per-table upserts rather than landing as a single pack-named row. Skip-list catches Volume/Pack/Bundle/Tables/VR/Soundtrack/Editor/Mode entries. `cleanTableName` strips ™/®/©/℠ + wrapping quotes. `findSuffixVariantMatch` folds "X" / "X Pinball" duplicates pre-upsert. 1100ms inter-fetch throttle; 30s back-off on HTTP 429. Production import: 152 imported / 198 updated / 78 packs expanded / 0 errors. Admin route: `POST /api/admin/catalogue/sync-steam-pinball`. UI: new "Steam Pinball" button on `/admin/catalogue`.

**Score-platform stratification.** Required `platform` field on `submissions`, `score_history`, `community_scores`, `global_scores` (column nullable in SQL for legacy rows; required at the API boundary via Zod). New `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` helper — game's effective platforms ∩ active tournament rules. Server-side `ensurePlatformAllowed` re-validates at every submit handler. `SubmissionSheet` picker: read-only chip when 1 platform, required dropdown when 2+. Discord `/submit-score` auto-fills when 1, rejects with valid-choices reply when 2+. `ScoreSyncPoller` stamps `tournament.iscored_default_platform` on synced rows. Leaderboard endpoint accepts `?platform=<id>`; per-game distinct-platform list returned for the GameDetail tab strip. RankedEntry carries per-row platform; "All" view shows platform badges + demotes NULL-platform rows to a "Platform unknown" tail.

**Per-room contribution flow.** Removed legacy "Import from VPS" / "Import VPXS Wizard" buttons from the per-room game library page (server endpoints kept for now). New `GlobalGameService.findCandidates` (read-only dedup walker, extracted from `upsert`) powers four new per-room routes: `/game_library/proposals`, `/use_global`, `/room_only`, `/submit_to_global`. Add Game UX renders an inline result panel (exact / possible / no-match) with the three commit choices. CSV import switched to two-step preview/commit: `/import-csv-preview` categorizes rows into `auto_link` / `auto_submit` / `needs_review`; FE renders bucketed preview with per-row decision UI; `/import-csv-commit` applies decisions per-row best-effort.

**Super-admin Catalogue Approvals.** `GET /admin/catalogue/pending` (joined with submitter + room), `/pending-count` (nav badge polled every 60s), `POST /pending/:id/approve`, `/reject` (audited reason), `/merge_into/:targetId` (delegates to `GlobalGameService.merge`). New `CatalogueApproval.tsx` page; nav badge in `SuperAdminLayout`.

**Visibility hardening.** Public `GET /global/games` hard-codes `status='approved'` (was honoring `?status=` query — leak risk). Aligned `'pending_review'` stub references to `'pending'` across `getCounts` + status PATCH validator.

**Migrations 083–087.**
- 083 — rename `pinball_fx3` → `pinball_fx_classic` across `global_games`, `game_library`, `game_room_game_library`, tournament `platform_rules`. Production landed: 102 `global_games` rows + 99 `game_library` rows.
- 084 — `ALTER TABLE … ADD COLUMN platform TEXT` on submissions/score_history/community_scores/global_scores + composite indexes; `tournaments.iscored_default_platform`; `submission_drafts.platform`.
- 085 — backfill platform on legacy score rows where the source game has exactly 1 platform; multi-platform rows stay NULL. Production: resolved 62 submissions / 9 score_history / 67 community_scores; left NULL: 18 / 80 / 10 / 23 (multi-platform games).
- 086 — flush `leaderboard_cache` + `global_leaderboard_cache` for the new platform-bearing `RankedEntry` shape.
- 087 — `global_games.{submitted_by_user_id, submitted_by_room_id, submitted_at}` + partial index on `(status, submitted_at) WHERE status='pending'`.

**Bug surfaced + fixed inline:** four sites used `JOIN game_library gl ON gl.id = grgl.game_library_id` — but `game_library`'s PK is `name` and the FK column is `game_name`. Would have failed at runtime on first `docker compose up`.

SW `CACHE_NAME` → `arcaid-v16`.

---

## [2.4.16] — 2026-04-25

**Patch.** Catalogue UX + diagnostics.

- **Logger writes `Error.stack` to file instead of `{}`.** `formatLogArg()` in `src/utils/logger.ts` special-cases `Error` so the rotating file stream and the admin Logs viewer get the actual stack — previously every `logError(msg, err)` site silently lost detail because `Error.message` and `.stack` are non-enumerable and `JSON.stringify` skipped them. Console output was unaffected (Node's `util.inspect` handles Error specially), so this had been hiding for the entire life of the project. The trigger was `Background OPDB sync error: {}` showing in the file.
- **OPDB / IGDB sync routes return 400 when credentials are missing.** Previously they returned `202 started`, threw inside the background task, and the only signal was a swallowed log line. Routes now validate `process.env.OPDB_API_KEY` / `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` upfront. The admin-ui catch-and-toast pattern surfaces the message directly.
- **OPDB API Key + Twitch Client ID/Secret added to Global Settings → Configuration.** Three new fields with masked inputs + reveal toggles for the secrets. The error messages now point to a section that actually exists.
- **`OPDB_API_KEY` and `TWITCH_CLIENT_SECRET` join the at-rest encryption allowlist.** Parity with `ISCORED_PASSWORD`. Twitch Client ID stays plaintext (it's a public identifier).
- **VPS catalogue import accepts broken-flagged entries.** Bluey, Britney Spears, Chime Speed Test Table and similar rows showed up as bare entries on `/scoreboard` because the importer's `playable` filter (gating both legacy `game_library` and global catalogue) excluded VPS entries with `broken: true`. The filter served the legacy path correctly — broken tables shouldn't be selectable for tournament picks — but it also blocked the global catalogue, which is just identity + metadata + images. Split into `playable` (game_library) and `cataloguable` (any entry with a name → global_games + image download pass).

SW `CACHE_NAME` → `arcaid-v15`.

---

## [2.4.15] — 2026-04-24

**Patch.** VPS re-indexing case. VPS occasionally re-registers entries with new `vps_id` values; on the next sync, step 1 (external-ID lookup) misses, and step 4's dedup excluded the row via the `hasExternalIdConflict` Frankenstein-prevention guard, causing `INSERT` to collide on the composite UNIQUE INDEX. Three games failed: "Hot Tip" (Williams 1977), "A-ha" (Original 2025), "Evel Knievel" (Bally 1977).

Fix: step 4 concrete-match path now filters against the full `nameMatches` set instead of `nonConflicting`. A pinball machine has a single canonical `(name, manufacturer, year)` identity by physical reality — divergent external IDs just mean the source re-indexed itself, not that we'd merge unrelated rows. The COALESCE-based UPDATE adopts the new authoritative external ID. The loose path (NULL mfg or year) still applies the conflict guard, since there's no canonical anchor without those.

---

## [2.4.14] — 2026-04-23

**Feature.** Per-tournament scheduler logs gain a `[room-slug]` prefix so site-admin Logs no longer show un-attributed "Scheduling maintenance for Daily Grind" lines. `Scheduler.start()` LEFT JOINs `game_rooms` to obtain the slug; `scheduleTournament` and `scheduleCleanup` accept it as an optional parameter. Super-admin Dashboard adds an **Activity Log** link per room card linking to `/${room.slug}/admin/activity` for per-room drill-down.

---

## [2.4.13] — 2026-04-22

**Feature.** Wizard import is now section-aware. The README parser distinguishes `wizard_auto` (verified VPXS auto-install tables) from `wizard_manual` (Manual Install Tables — hit-or-miss on AtGames Standalone). `WizardImportService.platformsForTable()` tags rows accordingly: `vpxs` for auto, `vpxs_manual` for manual. New canonical platform `vpxs_manual` ("VPX Standalone (Manual Install)") added to `platformMapping.ts`. `reconcileWizardPlatformTags` strips stale tags when a table moves between sections on a re-import. Tournaments requiring reliable VPXS can now exclude unreliable manual ones.

Also: SpongeBob no-parens edge case. Wizard input had no `(Original, 2021)` parens so `parseNameParts` returned undefined mfg/year, and the catalogue had both a rich (Original, 2021) row and a thin backfill residue (NULL, NULL) — both passed the NULL-tolerant `manufacturerYearAgree`. Step 4 loose path now applies a richest-row tie-breaker (`opdb_id + vps_id + igdb_id + manufacturer-not-null + year-not-null` score; created_at as final tie).

---

## [2.4.12] — 2026-04-22

**Patch.** `findByNormalizedName` rewritten to drop the SQL `LIKE '%word%'` prefilter. The previous version computed `firstWord = normalizeGameName(input).split(' ')[0]` and used it to prefilter rows by raw `name` LIKE, but normalization strips punctuation while raw names retain it — so `"gilligans"` couldn't match the stored `"Gilligan's Island"` because the apostrophe broke the substring match. Now does a full-table scan and JS-side normalize compare. At ~5k rows the scan runs in milliseconds; negligible for admin-triggered imports.

---

## [2.4.11] — 2026-04-22

**Patch.** Step 4 concrete filter now requires exact year match (not ±1 tolerance). Tolerance let "Breaking Bad (Original, 2021)" and "Breaking Bad (Original, 2022)" both count as concrete matches for a 2022 input — `concrete.length=2` → fall-through → INSERT → UNIQUE collision. Multi-concrete case adds a richest-row tie-breaker (most external IDs first, oldest `created_at` as tiebreak).

---

## [2.4.10] — 2026-04-22

**Patch.** Two-tier step 4 match. `manufacturerYearAgree` treats NULL mfg/year as "pass," which lets thin-backfill rows (NULL/NULL leftovers from the v2.4.0 backfill) blend into the candidate set and prevent single-hit resolution. Step 4 now prefers candidates that *concretely* agree on both mfg AND year (non-null on both sides, exact match) before falling back to the NULL-tolerant check. Migration 082 re-runs the thin-duplicate merger.

---

## [2.4.9] — 2026-04-22

**Patch.** Removed stale `SYNC_ALERT_CHANNEL_ID = 1467561374040461527` from the seed; it had been baked in and was firing 404s on every sync attempt. Migration 081 scrubs the value if it exists in the live `settings` table.

---

## [2.4.8] — 2026-04-21

**Patch.** Composite UNIQUE INDEX swap. Migration 080 drops `idx_global_games_name_type` (UNIQUE on `(LOWER(name), type)`) and creates `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))`. The strict 2-column index rejected legitimate same-name pinballs from different manufacturers (Stern Batman 2008 vs Data East Batman 1991, etc.) — 115 errors on the first Wizard import. The composite preserves dedup of true duplicates while letting variants coexist.

---

## [2.4.7] — 2026-04-21

**Patch.** Migration 079 catches no-comma `(Mfg YYYY)` thin duplicates that 078's strict comma regex missed.

---

## [2.4.6] — 2026-04-21

**Patch.** Migration 078 merges thin backfilled catalogue duplicates (rows where `name` contains a parens-baked-in `(Mfg, YYYY)` suffix and a corresponding rich row exists with stripped name + populated mfg/year).

---

## [2.4.5] — 2026-04-21

**Patch.** All Games tab fixes: catalogue card link now resolves to room game detail when mapped (was always going to global); rows with no image are hidden by default to keep the carousel art-forward.

---

## [2.4.4] — 2026-04-21

**Patch.** Migration ledger order fix. Migration 077 (drop NOT NULL on `submissions.game_id`) now runs before 070 (orphan cleanup, which `UPDATE`s `submissions.game_id = NULL`). Pre-fix, prod boot crashed on the orphan cleanup because the column still required non-null.

---

## [2.4.3] — 2026-04-21

**Patch.** v2.4.0 backfill (migration 069) now uses a strict `LOWER(name) + type` exact-match helper instead of `GlobalGameService.upsert`'s 4-step dedup. The dedup matched too aggressively (normalizeGameName collapsed multiple distinct names to the same key) and re-INSERTed rows the migration was meant to backfill, recreating duplicates.

---

## [2.4.2] — 2026-04-21

**Patch.** Migration 068 audit pass now runs multi-pass (up to 3 iterations) to catch residuals where a duplicate group's "winner" itself has another duplicate. Logs unresolved-group diagnostics if any remain.

---

## [2.4.1] — 2026-04-21

**Patch.** Migration 068 auto-merges legacy duplicate `(name, type)` groups instead of aborting. Prod had 112 duplicate groups in `global_games` — pre-fix the unique index creation aborted on first attempt and prod failed to boot.

---

## [2.4.0] — 2026-04-21

**Major.** Catalogue Unification + Pin to Scoreboard.

**Catalogue unification.**
- **Backfill.** Migration 069 populates `global_game_id` on every relevant row in `games`, `game_library`, and `game_room_game_library`. Pre-sprint fill rate was 0% / 0% / 51%; identity now resolved through the FK rather than name-based JOINs (with name-based COALESCE fallbacks kept as defense in depth).
- **UNIQUE INDEX `idx_global_games_name_type`** on `(LOWER(name), type)` (later replaced by composite identity index in v2.4.8) closes the read-check-insert race in `GlobalGameService.upsert`.
- **Orphan cleanup.** Migration 070 deletes the 5 legacy pinned games (Walking Dead, Spider-Man, Iron Maiden, 24, Game of Thrones) with `tournament_id=NULL` that the broken `/list-active` was returning. Reference audit confirmed zero dangling submissions.
- **Per-room overlay.** `game_room_game_library.custom_platforms` and `display_name` columns (migration 071). `effectivePlatforms = union(global, room-custom)`. WMS leagues can add their own platform tags without touching the shared catalogue.
- **Query migration.** High-impact joins switched to FK-based: `rooms.ts` library JOIN, `GameLibraryService` room-library queries, `GlobalScoreService` fan-out short-circuits, `LeaderboardService` + `DashboardService` style-resolution.

**Pin to Scoreboard.**
- Room admins can now pin a game to the scoreboard from the Game Library page, optionally creating it on the room's iScored account in the same step. Pinned games render with a "Pinned" chip on Banner/Showcase/Minimal cards, stay ACTIVE until manually unpinned, don't contribute to cross-tournament rankings, and survive maintenance cycles.
- **Schema.** `games.game_room_id` (denormalized for pinned rows; tournament rows still derive via `tournament_id`), `games.display_order`, unique partial index `idx_games_pinned_unique` on `(game_room_id, LOWER(name)) WHERE tournament_id IS NULL`.
- **Cascade on unpin.** Submissions, score_history, and global_scores `origin_game_id` get `UPDATE … SET game_id = NULL` before the row DELETE — score history preserved even when the game row goes away.
- **Shared `createGameWithIScoredSync()` helper** (`src/engine/gameCreation.ts`) extracted from three duplicated `TournamentEngine` call sites. Returns structured `{ gameId, iscoredStatus: 'created' | 'failed' | 'skipped' }`.

Migrations 068–076 (9 total). 119 tests pass (was 89 + 30 new).

---

## [2.3.3] — 2026-04-19

**Patch.** Discord read commands (`/list-active`, `/list-tournaments`, etc.) now exclude `games` rows with `tournament_id IS NULL` (orphans). The legacy "pinned" attempt left 5 orphan rows on prod that surfaced through these commands as ghost active games. v2.4.0 deletes them; v2.3.3 prevents re-emergence in case future code paths leave orphans.

---

## [2.3.2] — 2026-04-19

**Patch.** Discord-disabled rooms (per-room `DISCORD_ENABLED=false`) now excluded from slash-command queries. Pre-fix, `/list-active` in a connected room would return data from disconnected rooms too.

---

## [2.3.1] — 2026-04-19

**Patch.** Discord slash commands and DM dispatch now gate on the per-room `DISCORD_ENABLED` flag. Demo room could disable Discord but still receive DMs from notification hooks.

---

## [2.3.0] — 2026-04-19

**Major.** Per-room iScored / Discord configuration + at-rest secret encryption.

- **Per-room moves.** Discord guild ID, admin role ID, announcement channel ID, and iScored credentials moved from global to per-room `game_room_settings`. Each room can independently connect to its own Discord guild and iScored account, or disable either integration.
- **At-rest encryption.** New `src/utils/secrets.ts` provides AES-GCM encryption keyed off `SECRETS_KEY` (32-byte hex from env). `ENCRYPTED_SETTING_KEYS` allowlist (currently `ISCORED_PASSWORD`) controls which keys are encrypted on write and decrypted on read. `SettingsService` and `GameRoomSettingsService` consult the registry transparently. Allowlist is intentional (no convention-based auto-encrypt) so a typo like `IS_CORED_PASSWORD` won't silently land in plaintext. `maskEncryptedValues` returns a `[ENCRYPTED]` placeholder on `GET /admin/settings` so the UI never round-trips ciphertext.
- **Pre-deploy DB snapshot pattern** captured for the migration that introduced encrypted columns.

---

## [2.2.15] — 2026-04-18

**Patch.** Room Settings reorganized + Identity moves.

- Room Settings sections reordered: Theme → Scoreboard Display → Scoreboard Branding → Kiosk → Game Room → Integrations → Discord → Users → iScored.
- "Refresh Schedules" button moved to bottom of Tournaments page (was under "System Actions" on Settings).
- Merge / Rename Player moved from Settings to the Identity admin page (`/:slug/admin/identity`).
- Platforms management removed from Settings — covered by the `+` button next to Platforms in the Game Library row editor.
- Discord admin "user not found" error now surfaces a distinct 400 with actionable text.
- Default scoreboard display picker shows the new card styles first (Banner/Showcase/Minimal) with a "Show legacy styles" expander revealing the older card system.

---

## [2.2.14] — 2026-04-21

**Patch.** Swapped Fire and Queue button positions on the Mystery Award cabinet — Queue now sits on the left, Fire on the right. Matches pinball cabinet convention where the "commit/hit" button is on the right. SW `CACHE_NAME` → `arcaid-v9`.

---

## [2.2.13] — 2026-04-21

**Patch.** Mystery Award cabinet redesign.

- **Tournament Pool is now a pinball cabinet topper.** New `TournamentPoolTopper` component renders directly above the backbox as a cabinet attachment — orange LED glow strip, chunky silhouette, "TOURNAMENT POOL — Daily Grind ▼" pill. Clicking opens a drop-down list that overlays the top of the backbox; selecting collapses it back. `MysteryAward` accepts an optional `topper` slot so the page composes it in.
- **Fire and Queue buttons are always visible as circles.** Replaced the branching Hit Mystery / Add to Queue / Log in to queue / Play Again / Close button stack with two persistent circular pinball-cabinet buttons. Fire is always live (triggers a new spin, disabled only while cycling); Queue is grayed out until a game is revealed and the viewer has a Discord login. Labels beneath ("SPIN" / "ADD") clarify action.
- **Queue color matches the cabinet.** Was green. Now an amber-orange sibling of Fire (slightly deeper tint) so both buttons read as part of the same cabinet.
- **"Hit Mystery" renamed to "Fire"** per user preference — matches the cabinet action-button vocabulary.
- **Close moved to a footer text button** (was a NeonButton in the control panel). Less visually competitive with the round action buttons.

SW `CACHE_NAME` bumped to `arcaid-v8` so the cabinet redesign propagates to installed PWAs on next reload.

---

## [2.2.12] — 2026-04-21

**Patch.** Mystery Award: Tournament Pool selector was at `top-[14%]` which overlapped the backbox graphic on mobile. Collapsed it into the top nav row alongside the back link + login CTA — single fixed header at `top-0`, selector centered between the two, so it sits directly above the backbox with no overlap at any viewport width. Label shows "Tournament Pool:" on sm+ and "Pool:" on xs.

SW `CACHE_NAME` bumped to `arcaid-v7` so clients pick up the new bundle on next reload.

---

## [2.2.11] — 2026-04-21

**Patch.** Service-worker cache-bust. `sw.js` uses cache-first for JS/CSS assets and its `CACHE_NAME` had been pinned at `arcaid-v5` since v2.0.x, so installed service workers were serving stale bundles even after browser hard-refreshes. Bumped to `arcaid-v6`. The SW's `activate` handler deletes all caches not matching the current name, so on the user's next page load the old cache is purged and everything reloads fresh.

This is why v2.2.10's username-Link / expand-contrast / Picks-URL changes weren't visible to the tester even though the bundle was correctly deployed.

---

## [2.2.10] — 2026-04-21

**Patch.** Five follow-ups from v2.2.9 testing.

- **Username → player stats everywhere.** BannerCard, MinimalCard, ShowcasePodium (all 3 slots), and ScoreList now render each leaderboard username as a `<Link>` to `/:slug/players/:name` with `stopPropagation` so row-click expand still works. Previously only Room Game Detail's leaderboard had the Link.
- **Expanded history contrast bumped.** The inline mini-history panel under an expanded player was rendering scores at 50% opacity and dates at 25% — nearly invisible against the card background (image #12). Now scores at ~95%, dates at ~65%, panel background opacity bumped from 30% → 55%. Font size up 1px.
- **Mystery Award: pool selector moved under the back link → centered above the modal.** Was tucked in the top-right corner disconnected from the object it controls. Now sits at `top-[14%]` centered horizontally so the Tournament → Mystery Award relationship is visually obvious. Label changed from `Pool:` → `Tournament Pool:`.
- **Pinball-backbox-style action button.** `Hit Mystery` / `Add to Queue` buttons now render as chunky pinball-cabinet buttons — chrome bezel, neon gradient face, pressed-in `:active` state, color-coded (orange for spin, green for queue). Full CSS lives in `index.css` as the `.pinball-action-btn` family.
- **Picks URL is human-readable.** `/:slug/picks?t=<uuid>` became `/:slug/picks?t=daily_grind` (tournament name slugified — lowercased + non-alphanumerics collapsed to underscores). Resolved back to tournament id once the list loads. Back-compat: UUID still works if an old link is clicked.

---

## [2.2.9] — 2026-04-21

**Patch.** Apply the v2.2.8 Link-overlay removal to the places that actually render scorecards.

v2.2.8 removed the Link overlay + passed `titleLinkTo` through CardRouter — but only via `GameCard`. **The public Scoreboard (`Scoreboard.tsx`) and `GamesTabView.tsx` render `CardRouter` directly**, with their *own* overlay Link wrapping. v2.2.8's fix never applied to the room scoreboard the user actually sees. This patch:

- Drops the overlay Links from `Scoreboard.tsx` (all three layouts: grid / vertical / horizontal) and `GamesTabView.tsx`.
- Passes `titleLinkTo={linkForTournamentCard(lb)}` to each `CardRouter` call.
- Drops the now-unused `Link` imports from both files to satisfy TypeScript `noUnusedLocals`.

Same behavior goal as v2.2.8, this time applied to the actual render paths.

---

## [2.2.8] — 2026-04-21

**Patch.** Structural fix for the scoreboard click-routing problem + Mystery Award visibility.

Instead of stacking a z-10 Link overlay across the whole card and juggling `pointer-events` on every interactive child — which kept losing to one layout or another — removed the overlay entirely. Each card variant (BannerCard / MinimalCard / ShowcaseCard) now wraps *its own title* in a `<Link>` to the Room Game Detail. Score rows, `+` expand icons, and the submit button all have natural clickability with no competing overlay.

- **Scoreboard card click routing.** Title click → Room Game Detail. `+` / score row click → inline expand (when the player has multi-score). Submit button → submit sheet. No more "click `+` navigates away."
- **Removed title-click-submits-score behavior.** Previously clicking the title area opened the submit sheet when `onSubmitScore` was set. This was redundant with the explicit `+` button and conflicted with making title a Link. The `+` button is the single submit affordance now.
- **Mystery Award header overlay `z-[60]` + `fixed` positioning.** `MysteryAward` renders as `fixed inset-0 z-50`; the header overlay was at `z-10` inside a `relative` wrapper, so it sat underneath the modal entirely — including the Pool dropdown. Now `fixed` + `z-[60]` so it renders above the modal.

Full details → [releases/v2.2.8/README.md](releases/v2.2.8/README.md)

---

## [2.2.7] — 2026-04-21

**Patch.** Two v2.2.6 follow-ups + a playbook clarification.

- **Shared `DiscordLoginButton` component** so GlobalScoreboard, GlobalGameDetail (and any future global-surface pages) render the same Discord-brand blue button with the Discord SVG logo that PublicLayout uses on room pages. Previously globals used lucide's generic `LogIn` icon on a neon-cyan button, which broke visual parity after the v2.2.6 "Login" text normalization.
- **ShowcasePodium pointer-events reinforcement.** Outer wrapper of each podium slot now also sets `pointerEvents: 'auto'` when `canExpand`, so clicks on the slot's padding / surrounding flex area (not just the tinted inner box) still trigger the inline expand. The inner's `pointerEvents: 'auto'` was already there in v2.2.6 but didn't cover edge clicks.
- **Playbook clarified.** The `+` expand indicator only renders on rows where the player has >1 submission on that game. Rows for single-submission players never show `+` — that's the intended design, not a missing feature.

Full details → [releases/v2.2.7/README.md](releases/v2.2.7/README.md)

---

## [2.2.6] — 2026-04-21

**Patch.** Five UX follow-ups from v2.2.5 playbook feedback.

- **Tournament card / All Games card links now go to Room Game Detail** (`/:slug/games/:name`) instead of Global Game Detail when the game has a global mapping. Pre-v2.2.6 clicks routed to the Global page, which (correctly) hides anon submissions via the fan-out gate — so guest scores appeared to vanish on click. Global remains reachable via `/scoreboard` tiles.
- **UserMenu on Global pages.** `/scoreboard` (GlobalScoreboard) and `/games/:id` (GlobalGameDetail) used their own inline login/logout UI; now they use the shared `UserMenu` component — My Rooms / Friends / Scoreboard-display / Log out are reachable from global pages too.
- **Login text normalized** to "Login" on all public-facing pages. Admin login pages keep their existing labels.
- **Room Game Detail leaderboard: username clicks go to player stats.** `/:slug/players/:name` instead of doing nothing. Row-click still expands the multi-score history (v2.1.0). `stopPropagation` keeps the two gestures separate.
- **Scoreboard card score rows are clickable again.** The `+` expand icon on scorecards was being intercepted by the z-10 Link overlay, so clicks navigated to Game Detail instead of expanding inline. Fix: wrap `CardRouter` in `relative z-20 pointer-events-none` and mark expandable score rows `pointer-events-auto` — interactive rows now capture their own clicks; non-interactive areas still pass through to Link → navigate.
- **Mystery Award tournament selector.** When a room has >1 active tournament, a Pool dropdown appears in the header overlay so users can pick which tournament's pool drives the spin. Defaults to first active tournament (prior behavior preserved for single-tournament rooms).

Full details → [releases/v2.2.6/README.md](releases/v2.2.6/README.md)

---

## [2.2.5] — 2026-04-20

**Patch.** Two correctness fixes + one UX lift from v2.2.3 manual testing.

- **`conditionalRequireDiscordUser` now decodes optional tokens.** Pre-v2.2.5, when a room had `REQUIRE_DISCORD_LOGIN=false`, the middleware called `return next()` without looking at the Authorization header — so a logged-in user's submission silently fell through as `COMMUNITY` (anon). Effect: their score didn't fan out to Global, their avatar join failed, and they appeared with a `?` silhouette on the Tournament card. Middleware now always attempts to decode a Bearer token when present; it only *requires* one when the room opts in.
- **Pre-submit name collision prompt.** `POST /:roomId/submit/name-check` returns `{ available, suggestion }` using `RoomNameClaimService.checkAvailability` (dry-run of the claim logic, no persistence). SubmissionSheet now runs this before POSTing for anon submissions — if the name is taken, it shows an editable "Name already in use" panel pre-filled with the server's next-free suggestion. User can accept, edit to something else (check re-runs), or cancel. Replaces the post-hoc "Submitted as Chad_2" disclosure message.
- **Resolved-name prefill.** `arcaid-player-name` localStorage now stores the *resolved* display name after a successful submit (e.g. `Chad_2` if the server suffixed), not the raw typed name. Next session prefills with the sticky identity.

Full details → [releases/v2.2.5/README.md](releases/v2.2.5/README.md)

---

## [2.2.4] — 2026-04-20

**Patch.** Post-login redirect lands on the Lobby, not Picks.

When a user logs in with Discord from a game room's public pages (landing → Scoreboard → Login), they were being dropped on `/:slug/picks` — the winner-pick surface. New default is `/:slug/lobby` (social hub), which is what users expect after a fresh login. Global pages (`/scoreboard`, `/friends`, `/my-rooms`) and in-flight flows (pending-submission OAuth handoff) still pass their own explicit `returnPath`, so those are unaffected.

Changed: `ViewerAuthContext.loginWithDiscord` default path and `DiscordCallback`'s `player:<slug>` fallback.

---

## [2.2.3] — 2026-04-19

**Patch.** Fix first-claim-wins over-sticking: typing a different name from the same browser was silently collapsed back to the browser's first claim, so "Bob_2" and "Bob_3" submitted from the "Bob"-claimed browser were stored as "Bob" and merged into Bob's leaderboard row.

`RoomNameClaimService.resolveAndClaim` dropped the token→name idempotent short-circuit. The suffix loop now checks whether the requested name is free OR already owned by the submitting claimant — either is fine, otherwise suffix. Symmetric for Discord users (they can rotate their per-room display name too).

Migration 066 rebuilds `anon_room_claims` with PK `(anon_token, room_id, display_name)` so one token can hold multiple name claims in the same room. Unique name-per-room index preserved.

Full details → [releases/v2.2.3/README.md](releases/v2.2.3/README.md)

---

## [2.2.2] — 2026-04-19

**Patch.** Closes the "freeplay scores never reach iScored" gap.

Before v2.2.2 only the Tournament-card / Game-Detail submit path (`POST /:roomId/submit-score/:gameName`) fired the fire-and-forget iScored sync. Scores submitted via `/freeplay-score` or the legacy `/community-scores/:gameName` endpoint stayed local-only — so players who used the Freeplay page never appeared on iScored even when the game matched an active tournament.

Extracted the sync into a shared `IScoredSubmitSync.syncScoreToIScored` helper and wired it into all three web submission paths. Same guards (game must be ACTIVE with an `iscored_id`), same API-preferred / Playwright-fallback logic, same error handling. All three paths now pass the resolved `displayName` (post-v2.2.0 auto-suffix), so the name on iScored matches the name on ArcAid's scoreboard.

Full details → [releases/v2.2.2/README.md](releases/v2.2.2/README.md)

---

## [2.2.1] — 2026-04-19

**Patch.** Three follow-ups from v2.2.0 manual testing.

- **Winner resolution reads local DB first.** `TournamentEngine.processSlotMaintenance` now picks the winner from `submissions` (which has everything — Discord, guest, iScored-synced) and only falls back to iScored when local is empty. Previously the reverse — the bot would announce whoever iScored had on top, even when ArcAid's own scoreboard knew better. Broke badly for guest-allowed rooms where iScored rejected a submission (the "Access Denied" case below).
- **iScored API `submitScore` handles non-JSON rejections.** iScored responds `200 OK` with a plain-text body like `"Access Denied"` when it rejects a submission (seen on a guest's 99.9B score). The client now parses response text before JSON and surfaces a clean error instead of a raw `SyntaxError` that crashed the surrounding sync pipeline.
- **Anon-winner Discord message** now includes claim guidance: *"Is this you? Log in with Discord on {scoreboard} to claim future scores. If your Discord name differs from `{name}`, ask an admin to merge identities. An admin will pick the next game in the meantime."* No more broken `@mentions`; no more picker-slot created for a winner that can't use `/pick-game`.
- **GameDetail leaderboard React key fix** (shipped as `a368aaeb` on 2026-04-19) — anon rows were being de-duped by the reconciler because they share `discord_user_id="SYSTEM"`; composite `rank-username` key restores them.
- **Data cleanup (prod):** removed 61 legacy anon rows from `global_scores` that fanned out before the v2.2.0 gate landed, and flushed `global_leaderboard_cache` (7 entries). Global Game Detail now resolves to the Discord-authenticated row for affected usernames.

Full details → [releases/v2.2.1/README.md](releases/v2.2.1/README.md)

---

## [2.2.0] — 2026-04-19

**Minor.** Identity-correctness release. Closes the "guest score absorbs a logged-in user's leaderboard row" gap.

- **Global fan-out gate** — guest submissions never reach the Global Leaderboard. Every row on global is guaranteed to have a real Discord ID behind it. Implemented as a one-line early-return in `GlobalScoreService.fanOutFromRoomSubmission` keyed on `normalizeSubmitterUserId`.
- **First-claim-wins identity** — new `RoomNameClaimService` resolves a per-room display name at submission time. The first identity (Discord or anon) to use a name in a room owns it; later arrivals auto-suffix to `Bob_2`, `Bob_3`. Backed by a new `room_members.display_name` column and a new `anon_room_claims` table. SubmissionSheet shows "Submitted as Bob_2 — 'Bob' is already in use" when a suffix was applied.
- **`REQUIRE_DISCORD_LOGIN=true` default for new rooms** — safe-by-default identity. Existing rooms unaffected (flipping retroactively orphans anon scores).
- **SubmissionSheet polish** — always sends a stable anon-token; replaces the global-exclude checkbox with a guest-mode nudge ("Log in with Discord to also include it on the global ArcAid leaderboard").
- **UserMenu z-index fix** — dropdown bumped to `z-50` so it wins over game-card submit buttons.

Migrations 064 (DDL for first-claim-wins) and 065 (no-op marker for the default-flip event).

Full details → [releases/v2.2.0/README.md](releases/v2.2.0/README.md)

---

## [2.1.0] — 2026-04-18

**Minor.** Three net-new capabilities.

- **Tournament scoring reads `score_history`** filtered by `submitted_during_tournament_id` — best-during-the-window wins, no longer tied to all-time personal best. `submissions` writes preserved for back-compat. Migration 063 backfills existing rows.
- **Multi-score view** on Game Detail: click a username → inline expand with sparkline of progression, split into "This tournament" vs "All time" when an active tournament is in play. Photo-proof links per row.
- **Stats page Combo redesign** — 4-card overview at the top (plays this week / active players / hottest game / latest submission) on top of the existing Players / Games tabs. New `GET /:roomId/stats/overview` endpoint.

Full details → [releases/v2.1.0/README.md](releases/v2.1.0/README.md)

---

## [2.0.3] — 2026-04-18

**Patch.** Three smoke-test follow-ups.

- Default catalogue image restored on Tournament + All Games cards (backend COALESCE to `global_games` + ShowcaseCard fallback; admin style still wins)
- Submit button icon unified — `Plus` on both Tournament and All Games cards
- `/freeplay-score` now upserts `submissions` when the game is an active tournament game, so scores submitted via game detail count for the tournament just like Tournament-card submits

Full details → [releases/v2.0.3/README.md](releases/v2.0.3/README.md)

---

## [2.0.2] — 2026-04-18

**Hotfix.** Tournament card title routed to room-scoped URL instead of global catalogue.
`LeaderboardService.getActiveLeaderboards()` now selects `COALESCE(g.global_game_id, gl.global_game_id)`
so the frontend's `linkForTournamentCard` resolves to `/games/:id?from=:slug` when the game is mapped.

Full details → [releases/v2.0.2/README.md](releases/v2.0.2/README.md)

---

## [2.0.1] — 2026-04-18

**Patch release.** Seven fixes from v2.0.0 manual testing.

- Avatar leak on anonymous submissions (privacy regression — `LeaderboardService` + 3 siblings narrowed the username-fallback to `iscored:*` only)
- OAuth-cancel detection when user closes the Discord tab without a redirect
- Room-scoped GameDetail Community tab migrated to `SubmissionSheet` (photo upload + anon claim + error messaging)
- `SubmissionSheet` gained a `requireLogin` prop → login-required state up-front on gated rooms
- Global GameDetail Submit respects `?from=<slug>` room context → freeplay target when present
- Internal `Catalogue` / `Community` labels no longer leak onto cards
- Mystery Award direct URL: `/:slug/mystery-award` as a shareable Discord link + login hint

Migration 062: cache flush for the avatar-fix SQL changes.

Full details → [releases/v2.0.1/README.md](releases/v2.0.1/README.md)

---

## [2.0.0] — 2026-04-18

**Major release.** Scores/Nav Reorg — 12-sprint plan + Sprint 13 polish pass.

Highlights:
- Anonymous submission runtime with Discord-collision claim prompt + OAuth draft handoff
- Merge/unmerge admin flow at `/:slug/admin/identity` with freeze-rule protection
- `ENABLE_GAME_PICK_AWARD` opt-in gate hides the pick flow where not wanted
- Global Scoreboard room badges with `?room=<slug>` filter URLs
- Unified `SubmissionSheet` replaces 4 legacy submit modals
- Scoreboard tabs: `Tournaments | All Games` + "Played at" filter
- `/:slug/games` renamed to `/:slug/picks` with 301 redirect
- New nav UserMenu dropdown with full WAI-ARIA keyboard support
- Per-room `short_tag` column for custom badge abbreviations

Breaking: route rename + 4 components deleted + existing rooms must opt into `ENABLE_GAME_PICK_AWARD` to keep the Picks tab visible.

Full details → [releases/v2.0.0/README.md](releases/v2.0.0/README.md)

Commit: `595d9b0f`

---

## [1.x] — pre-2026-04-18

No per-version release notes exist for the 1.x line. Historical context is tracked in `SPRINT_STATUS.md` (current session notes) and `ROADMAP.md` (completed work). Starting with v2.0.0, every release gets a dedicated notes file.
