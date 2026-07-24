# ArcAid — Feature Inventory

ArcAid is a multi-tenant tournament management platform for virtual pinball and retro
gaming communities. A single deployment ("one instance") hosts any number of independent
**game rooms**, each with its own tournaments, leaderboards, admins, branding, and
optional Discord bot / iScored integrations. Players submit scores via the web, Discord,
or iScored; a cross-room Global Scoreboard aggregates identity-linked scores from every
room into one shared catalogue and leaderboard system.

**Current version:** v2.30.2 (2026-07-24)
**Production:** [arcaid.app](https://arcaid.app)

This document is a compiled, shipped-features-only inventory assembled from
`CHANGELOG.md`, `SPRINT_STATUS.md`, `ROADMAP.md`, `CLAUDE.md`, `README.md`, and the
admin-ui page / Discord command source trees. It excludes anything still in the
roadmap/future/deferred bucket — see `ROADMAP.md` for what's planned next. Audience tags:
**[Player]** = public/logged-in player facing, **[Room Admin]** = per-room admin panel,
**[Super Admin]** = server-wide admin panel.

---

## 1. Multi-Tenant Game Rooms

- **Independent game rooms** [Super Admin] — One ArcAid instance hosts unlimited rooms, each with its own tournaments, leaderboards, admins, settings, Discord guild, and iScored account. Rooms are addressed by URL slug (`arcaid.app/<slug>/`), matched case-insensitively.
- **Per-room Discord / iScored configuration** [Room Admin] — Each room connects independently to its own Discord guild and iScored account (or disables either integration entirely) via settings stored per room; the bot token and Discord client ID/secret stay global.
- **Three-tier auth** — Super-admin (server-wide password or Discord OAuth), room admin (per-room password, invite link, or Discord OAuth), and player (Discord-authenticated, non-admin) — plus guest access with no login at all on public pages.
- **Admin invite system** [Room Admin] — One-time invite links (optionally delivered via Discord DM) for onboarding new room admins without sharing a password.
- **Game Room Manager** [Super Admin] — Create, edit, and delete game rooms from a dedicated admin page, including each room's public/private visibility toggle (private rooms are hidden from the public directory) and a custom `short_tag` badge abbreviation used wherever a compact room label renders.
- **Public room directory / landing page** [Player] — `arcaid.app/` lists every room with a clickable card (whole card navigates, not just a small link) linking to that room's scoreboard, plus a Join Discord shortcut.
- **Audit logging** [Super/Room Admin] — Every admin write action is automatically tracked with actor, target, and timestamp; surfaced on a searchable Activity Log page per room and server-wide.

## 2. Tournaments & Game Rotation

- **Automated tournament rotation** [Room Admin] — Daily, Weekly, Monthly (including last-day-of-month, which `node-cron` doesn't natively support), or fully custom cron schedules drive when a tournament's active game changes.
- **Tiered pick system** — When a game completes, the winner gets a timed window to pick the next game; if they don't, it falls to the runner-up, then auto-selection. Both web (Discord-authenticated) and Discord slash-command picking are supported, with queue management (reorder, delete, cap of 5 games per tournament).
- **Game queue** [Player] — Players queue up to 5 games per tournament (FIFO); cooldown eligibility is re-validated at activation time and ineligible queued games are auto-removed during maintenance.
- **Per-slot picker prompts** — In multi-slot tournaments (e.g. `max=2`), each slot win emits its own clearly-labeled pick prompt and Discord DM naming the specific game won, instead of collapsing multiple wins into one prompt.
- **Mystery Award** [Player] — Canvas-based random game picker with an animated DMD dot-matrix display and a pinball-cabinet aesthetic (chrome bezel, glowing Fire/Queue action buttons, LED "Tournament Pool" topper above the backbox). Discord-authenticated users can add the selected game straight to their pick queue. The entire pick/award flow can be disabled per room (`ENABLE_GAME_PICK_AWARD` toggle), which also hides the Picks nav entry.
- **Cross-tournament ranking groups** [Room Admin] — Combine multiple tournaments into one "Overall" leaderboard with 4 selectable scoring methods; results self-invalidate via a data watermark (fingerprint over score counts/sums/dates) so they never need a manual recompute after normal play — a manual "Recompute" button remains as a diagnostic escape hatch.
- **Deactivate vs. Delete** [Room Admin] — Two distinct end-of-round actions on an active game: Deactivate (normal round close — locks the game on iScored, keeps history and the iScored link for cleanup bookkeeping) vs. Delete (destructive "wrong game in wrong tournament" fix — removes the game entirely while preserving each player's personal score history).
- **Retained Completed Games** [Room Admin] — Rooms using scheduled cleanup can manually delete a completed game (e.g. one that got no scores) before its scheduled cleanup date, instead of waiting for the weekly cron.
- **Platform-rules validator** [Room Admin] — Inline warning plus a disabled Create/Save button when a tournament's "Must be available on" and "Not allowed on" lists share a platform, which would otherwise reject every submission (phantom-tournament prevention).
- **Two orthogonal platform-rule axes** — "Must be available on" gates which games qualify for a tournament (game-level eligibility); "Not allowed on" filters which platforms a submission can be tagged with (submission-level only) — the two never interact.
- **Cleanup rules** [Room Admin] — Configurable per-tournament policy for what happens to completed games: immediate hide, retain the last N, or a scheduled cron sweep.
- **Room-admin health dashboard** [Room Admin] — Live card showing Discord gateway connection + guild membership, iScored sync status (per-account last success/error), per-tournament last-run outcome and next scheduled fire time (in the tournament's own timezone), and the running app version — turns "why didn't my game activate?" into a diagnosable, in-product answer instead of log spelunking.
- **Force Maintenance** [Room Admin] — Manually trigger a tournament's rotation cycle on demand and see the real outcome (success/skipped/error), not just an optimistic "triggered" toast.
- **Maintenance run history** [Room Admin] — Every cron-driven and forced maintenance run is logged (outcome + summary + duration), viewable per tournament.
- **Operator alerting** [Super Admin] — Optional Discord DM to a designated operator after sustained iScored-sync failures on one account (debounced, re-arms on recovery); off by default, inert until configured.

## 3. Score Submission & Leaderboards

- **Multiple submission paths, one leaderboard** [Player] — Scores can be submitted via the web (tournament card, Game Detail, Freeplay, or a standalone QR-code submit page), Discord's `/submit-score`, or iScored directly; a continuous background poller keeps everything reconciled.
- **Anonymous / guest submission with first-claim-wins names** [Player] — Guests can submit without logging in. The first identity (Discord or anonymous) to use a display name in a room owns it; later arrivals auto-suffix (`Bob` → `Bob_2`). A pre-submit name-collision check offers the suggested alternative before posting.
- **Photo-proof submissions** [Player] — Optional (per-room-configurable) photo upload alongside a score; images are cropped to a locked aspect ratio and stored as evidence, viewable per score row.
- **Per-platform score stratification** — Every submitted score is tagged with the platform it was played on (VPX, real cabinet, AtGames variant, FX family, etc.). Game Detail shows a platform tab strip; multi-platform games prompt a required platform dropdown at submit time; single-platform games show a read-only chip.
- **Score history / expandable per-player history** [Player] — Click a username on any leaderboard to expand their full submission history for that game, with a sparkline of score progression split into "this tournament" vs. "all time."
- **Score toast notifications** [Player] — Real-time WebSocket-powered slide-down notification when any player submits a new score while viewing the scoreboard.
- **"Your Best" quick stat** [Player] — Logged-in users see their own best score and rank in the footer of each game card.
- **Community / freeplay scores** [Player] — Submit scores outside of any active tournament window; per-game community leaderboards track them independently.
- **Room Scores tab** [Player] — A room-wide "every score ever set here, best per player per game across every source" view, separate from the tournament-scoped leaderboard and the cross-room Global tab.
- **Game tips & comments** [Player] — Player-submitted tips and comments on each game page (room and global), with author/admin delete controls.
- **Locked-game protection** — Submissions are blocked (403 server-side, locked UI client-side) once a game is completed/locked.
- **Score value bounds & upload validation** — Submitted scores are capped below floating-point precision-loss range; uploaded proof images are validated by file magic bytes (not just the spoofable client-declared MIME type).
- **Public/global rate limiting** — Dedicated rate limiters (distinct from the general API limiter) guard every guest-writable route — score submission, comments, ratings, invite acceptance — so a burst from one source can't degrade the whole API.
- **Batched score-count loading** — Card grids fetch score counts for many games in a single batched request (with client-side coalescing) instead of one request per card, keeping large scoreboards fast and under rate limits.

## 4. Global Scoreboard & Game Catalogue

- **Global Scoreboard** [Player] — A cross-room leaderboard at `arcaid.app/scoreboard` aggregating identity-linked scores from every room, with room badges, podium-style top 10, platform tags, and a `?room=<slug>` filter.
- **Global searchable game catalogue** — One shared catalogue (`global_games`) of every known table/game across manufacturers and platforms, browsable at `/catalogue` (public) and as a per-room library (room-scoped view of the same data, plus per-room tags and style overlays).
- **Smart catalogue search** — A single search box matches across name, manufacturer, year, designers, themes, table authors, aliases, platforms, and per-room tags, with inline year-range syntax (`2001-2020` or `Williams 2001-2020`).
- **4-step dedup hierarchy** — New catalogue entries are deduplicated by external ID match, IPDB cross-reference (manufacturer-aware — virtual-only tables can't hijack a real machine's identity), and normalized-name matching, so the same table imported from multiple sources lands on one row instead of creating duplicates.
- **Game merge tool** [Super Admin] — Consolidate duplicate catalogue rows (unions download links, themes, designers, external IDs, tags, and cascades every dependent table); auto-merges near-duplicate names (comma/hyphen variant spellings) during import.
- **Dedup Audit tool** [Super Admin] — Scans the live catalogue for suspect virtual-only rows still carrying a real machine's IPDB identity and for unresolved shared-IPDB duplicate groups, with in-app one-click "Strip" (clear the spurious link) and "Strip All" remediation.
- **Safe bulk-merge** [Super Admin] — Automatically merges catalogue duplicate groups that share an IPDB link, agree on year, and have compatible (including corporate-alias-aware) manufacturer names — previewable as a dry run before executing, with skip reasons shown for groups left for human review.
- **Per-field source stamping** — Every catalogue field records which import source (or a manual admin edit) last wrote it, so a "report a problem" reviewer can tell whether a field is ours to fix or sourced from an upstream catalogue (IPDB/OPDB/VPS).
- **Report a problem** [Player] — Discord-authenticated flag link on any game page to dispute a specific field (name, manufacturer, year, platforms, artwork, duplicate, other) with an optional suggested correction; lands in a super-admin review queue showing current vs. suggested value, the reporter's note, and the field's source badge; resolutions are Fixed / Upstream / Dismiss.
- **Pending-approval flow for room-submitted games** [Room Admin / Super Admin] — Room admins propose new catalogue entries; super-admins approve, reject (with an audited reason), or merge them into an existing row from a dedicated approvals queue.
- **Per-room game tags** [Room Admin] — Tag any catalogue game with a custom label for a specific room (e.g. "WMS"); tags participate in tournament platform rules so a "Must = WMS" tournament admits only tagged games in that room.
- **Library bulk operations** [Room Admin] — Multi-select game rows to bulk-tag, bulk-activate into a tournament, or bulk-pin to the scoreboard in one action; selection persists across pagination.
- **Pin to Scoreboard** [Room Admin] — Pin any catalogue game directly to the room scoreboard without creating a tournament, with an optional one-step iScored mirror; pinned games show a "Pinned" chip and stay live until manually unpinned.
- **"About This Game" metadata section** [Player] — Room and global game pages render manufacturer/year/type, theme chips, designers, table authors, download links, YouTube tutorials, and rules/IPDB references when the game maps to a catalogue entry.
- **All-time leaderboard for non-active games** [Player] — Completed or permanently-pinned games still get a full page: an all-time leaderboard with expandable score history and percentile, even outside an active tournament window.
- **Public history page** [Player] — `/:slug/history` lists winner + score + date for every completed game, paginated and filterable by tournament type.

### Catalogue importers

| Importer | Covers | Notes |
|---|---|---|
| **VPS** (Virtual Pinball Spreadsheet) | Primary virtual-pinball metadata source | Splits playable vs. cataloguable filters; downloads images in the background |
| **VPXS Wizard** | Verified VPX Standalone tables | Splits auto-install (`wizard_auto`) from Manual Install Tables (`wizard_manual`) so tournaments can require reliability |
| **OPDB** | Pinball metadata + manufacturer/year | Requires an OPDB API key |
| **IGDB** | Arcade/console video games | Via Twitch OAuth |
| **Steam Pinball** | Zen + Zaccaria DLC catalogues across six Steam apps | Curated pack-to-table expansion |
| **FX VR** | Pinball FX VR (Meta Quest standalone) | 39 tables across 17 packs |
| **AtGames** | AtGames cabinet availability | Pulls a curated public Google Sheet; tags the broad `atgames` platform plus per-cabinet variants (HD/4K/Micro/HDP/ALU/Mini/Gamer/Core) as catalogue features |

All six feed the same dedup/upsert path, so re-running any of them is safe and idempotent.

## 5. Player Identity & Accounts

- **Global display name** [Player] — Logged-in players pick a globally-unique display name at `/account/settings` that renders on every leaderboard, ranking, stats page, lobby feed event, and Discord DM/announcement, in place of their raw iScored alias.
- **Multi-alias identity linking** [Room Admin] — One Discord user can hold many iScored aliases; the admin Identity Merge tool consolidates them into a single player row per game. Forward attribution means future iScored scores under the merged alias auto-attribute to the linked Discord user going forward, not just historically. Reverse-merge cleanly undoes both.
- **`/map-user` self-service alias linking** [Player] — Players can add an iScored username as an alias of their own Discord account via a Discord command (additive — doesn't replace existing aliases).
- **Room-scoped first-claim names collapse into global identity where linked** — A player's per-room display-name claim and their global alias are recognized together on player stat pages, without creating a new identity record.
- **Session persistence** — Login pages auto-redirect if a valid JWT already exists; JWT refresh tokens keep a session alive for 30 days with automatic silent refresh in the background.
- **Account Settings** [Player] — One page to set the global display name, view linked iScored aliases, manage notification preferences, manage browser push subscriptions, and delete the account.
- **Account deletion (anonymize-and-keep-scores)** [Player / Super Admin] — Self-service (Discord-authenticated) or admin-assisted account deletion. Deletes all personal/identity data (profile, mappings, preferences, sessions, per-room name claims, friendships, comments, ratings, push subscriptions) while anonymizing score rows so leaderboards and rankings stay intact and de-identified; proof photos are deleted from disk.
- **Terms of Service & Privacy Policy pages** [Player] — Public `/terms` and `/privacy` pages, footer-linked, covering what's collected and the deletion path.
- **My Rooms** [Player] — A page listing every room a logged-in player has submitted scores in.
- **Discord OAuth login on public pages** [Player] — Any public page can log a visitor in with Discord to unlock picking/queuing, comments, following, and score attribution — without needing a room-admin account.

## 6. Social & Engagement

- **Lobby / live activity feed** [Player] — Per-room feed of recent scores, milestones, staleness challenges, and announcements, updated live over WebSocket; the default landing page after login.
- **Lobby announcements rail** [Room Admin] — Scheduled announcement banners on the lobby page: image, body text, call-to-action link/label, event date, display window, and sort order, managed from a dedicated Lobby admin page.
- **Community shelf** [Room Admin] — A curated media shelf on the lobby page (YouTube/Twitch/etc. links with thumbnails) for featuring community content, managed from the same Lobby admin page along with social links, a pinned message, and per-event-type feed toggles.
- **Kiosk & Scoreboard activity ticker** [Player] — A marquee ticker seeded from the lobby feed, updated live, with distance-appropriate scroll speed, hidden when empty, pause-on-hover, and respecting reduced-motion preferences.
- **Friends (follow model)** [Player] — Unidirectional follow from any player surface (player page, quick-view popup); a global `/friends` page lists everyone a logged-in player follows, with targeted notifications when a followed player posts a new score.
- **Head-to-head Compare** [Player] — Pick any two players in a room and see their shared games, per-game leader and score gap, exclusive-game counts, and overall win totals; pre-fillable from a player's own profile.
- **Participation streaks** [Player] — Weekly participation streak (current and best) shown alongside the separate "champion streak" (consecutive wins) stat.
- **Trophy case** [Player] — Player profile section showing tournament wins, milestone crossings, and room-record moments, with per-type counts and the 10 most recent; deduped so a game only credits one win.
- **Personal Bests** [Player] — Best score per game with the player's room rank and total competitors, capped at 50 games, on the player profile.
- **Enhanced public stats** [Player] — Average finish, top-5% frequency, and champion streak surfaced on the public Stats page and player profiles.
- **Staleness challenge** [Player] — Automatic daily lobby-feed callout ("It's been N days since anyone scored on X — beat the record!") when a game has gone quiet past a configurable threshold.
- **Player quick-view popup** [Player] — Clicking any username opens a lightweight stats preview (games/wins/win%/avg finish/streak, best game, recent scores) without leaving the page, with a link through to the full profile.
- **Game quick-view popup** [Player] — Clicking a game title opens a lightweight preview (top 10 scores, image, catalogue metadata) with links through to the full game page or the Global leaderboard.

## 7. Notifications

- **Discord DM notifications** [Player] — Five opt-in notification types (tournament win, turn-to-pick, tournament starting, rank dethroned, friend scored), each rate-limited per user and managed via `/arcaid-notifications`; all default off.
- **Browser push notifications** [Player] — Opt-in web push (rank dethroned, tournament win) as a second channel alongside Discord DMs, for players who'd rather get a phone/desktop notification than a DM; per-device subscription managed from Account Settings, with an install-to-Home-Screen hint on iOS. Requires the server operator to configure push keys — inert until then.
- **Post-score rating flow (Discord)** [Player] — Star-rating buttons and a comment modal appear automatically after `/submit-score`.
- **Discord post-score comment cross-post** — Ratings/tips left after a Discord submission surface back on the game page.

## 8. Scoreboard Display & Theming

- **3 scoreboard card styles** [Room Admin] — Banner (compact, iScored-compatible), Showcase (art-forward with a top-3 podium), and Minimal (typography-only) — plus legacy layouts (Compact/Wheel/Sidebar) retained for continuity.
- **Showcase themes** — Glass Deck and Neon Circuit, each with theme-matched secondary-text legibility.
- **Style-matched rankings cards** — Overall Rankings cards can inherit the active game-card style, or be independently styled as Plaque (hall-of-fame frame), Compact List (text-only), or Sidebar Block (abbreviated scores), sized and top-aligned to match adjacent game cards.
- **17 UI themes** — Dark (default), Light, Retro, Cyberpunk, Ocean, Sunset, Backglass, CRT Green, Cabinet, Silverball, Coffee, Minimal, and more; admin theme is per-user, public/scoreboard theme is per-room, with per-room-slug isolation so a viewer's personal theme choice doesn't bleed across rooms they visit.
- **12 game title styles** — Default, Glow, Neon Magenta (animated), Chrome, Fire (animated gradient), Plasma, Backglass, Marquee, Retro, Pixel, Shadow, Outlined.
- **Layout presets** — 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament), with automatic detection when a room has customized past a preset.
- **Live preview** [Room Admin] — Settings page renders a scaled multi-card preview with real game art, updating instantly as options change.
- **Global card style overrides** [Room Admin] — Room-wide color customization for card titles, scores, borders, and backgrounds.
- **Scoreboard branding** [Room Admin] — Custom logo, background image, and title style/size per room; independent logo-visibility toggle for the scoreboard vs. the Mystery Award backglass.
- **QR code score submission** [Player] — Configurable QR codes on cards (disabled/kiosk-only/all rooms) linking straight to that game's submit page, with adjustable size and position.
- **Kiosk mode** [Player] — Dedicated auto-refreshing, nav-free scoreboard display for TVs, with a configurable Kiosk Zoom (distance-tuned magnification, independent of the interactive scoreboard's zoom) and configurable auto-refresh interval.
- **Kiosk auto-scroll attract mode** — When the kiosk's card row overflows the screen (typical at higher Kiosk Zoom), it automatically ping-pong-scrolls so every card gets screen time; pauses on any touch/input, skips under reduced-motion, and is a per-room toggle.
- **Kiosk scrollbar hidden** — The kiosk's horizontal scrollbar is visually suppressed (a non-interactive display doesn't need it); the interactive public Scoreboard keeps its visible scrollbar.
- **True mobile card layout** [Player] — Phones (≤640px) render one full-width column at natural, undistorted type scale, decoupled from the TV/kiosk zoom setting so a TV operator's zoom no longer shrinks or re-scales phone visitors' view.
- **Mobile Density control** [Room Admin] — Opt-in card-density slider for mobile (defaults to full size; a room can choose a denser layout).
- **Inline rankings** — Overall Rankings cards render inline with game cards by default, or as sticky side columns (configurable position: top/bottom/left/right).
- **Horizontal-scroll navigation** — Edge-hover arrow controls and click-and-hold drag-to-scroll on horizontally-scrolling card rows, with the native OS scrollbar hidden for a cleaner look; keyboard-focusable with arrow-key scrolling.
- **Reduced-motion support** — Every animated element (kiosk ticker, glow/pulse effects, score toast, card animations) respects `prefers-reduced-motion` and is skipped for users who've requested it.
- **Readable, responsive card text** — Fixed responsive font sizes with readability floors for the smallest text sizes, so titles and scores stay legible at any card width or screen size.
- **Game display names & smart title auto-hide** [Room Admin] — Optional per-game display-name override; game name text auto-hides on cards that already carry an identifier image.
- **Image cropper** [Room Admin] — Locked-aspect-ratio cropping for branding uploads and style catalogue images.
- **Style catalogue** [Room Admin] — iScored visual styles imported or uploaded and assigned per game, with independent logo and background art from different catalogue entries.
- **Card background fill** [Room Admin] — Background image can fill the entire card behind a glass-panel overlay (adjustable opacity), instead of a header-only image.

## 9. Sharing & Discovery

- **Web Share buttons** [Player] — Native share-sheet (or clipboard-copy fallback) on the room Game Detail hero, the Player Detail action row, and the post-submit result card ("I'm #1 on Medieval Madness!").
- **Rich link previews (OG meta)** — Links to a game or player page unfurl on Discord/Slack/Twitter/Facebook/Telegram/WhatsApp with the game or player name, room name, and catalogue art — real crawlers only, human visitors always get the identical page.
- **Clickable landing-page room cards** [Player] — The whole room card on the public directory is a clickable link to that room's scoreboard, not just a small footer link.

## 10. Discord Integration

- **Full slash-command bot** — Player and admin command suites (see tables below), backed by Discord.js v14.
- **Discord OAuth login** — Available on every login surface (super-admin, room-admin, public player pages); scoped to `identify` only.
- **Discord-disabled rooms excluded from cross-room queries** — A room can disable Discord entirely; its data is excluded from any slash command that spans rooms.
- **Per-room announcement configuration** [Room Admin] — Announcement channel and admin role are configured per room, with a tournament-level override and an env-level fallback chain.
- **Embed color coding** — Daily/weekly/monthly/custom tournament announcements use distinct embed colors for at-a-glance recognition.

### Player commands

| Command | Description |
|---|---|
| `/list-active` | Show currently active games across all tournaments |
| `/list-scores` | Leaderboard for active games (optional user filter, pagination) |
| `/submit-score` | Submit a score + photo to iScored; prompts a star rating + comment afterward |
| `/ping` | Check bot responsiveness |
| `/view-stats` | Historical stats for any game (autocomplete) |
| `/my-stats` | Personal stats card (wins, win%, average, best, recent games) |
| `/list-winners` | Hall of fame — recent tournament winners |
| `/view-selection` | Show queued games and what's next in the lineup |
| `/pick-game` | Nominated picker selects the next game (eligible games only) |
| `/map-user` | Add an iScored alias to your own Discord account |
| `/create-backup` | Trigger a database backup |
| `/sync-state` | Reconcile the local DB with live iScored data |
| `/arcaid-notifications` | Manage Discord DM notification opt-ins |

### Admin commands

| Command | Description |
|---|---|
| `/force-maintenance` | Manually trigger a tournament rotation cycle |
| `/activate-game` | Immediately activate a specific game for a tournament |
| `/deactivate-game` | Deactivate an active game (optionally locks on iScored) |
| `/run-cleanup` | Delete completed/orphan games from iScored per cleanup rules |
| `/pause-pick` | Inject a specific game into the tournament queue |
| `/nominate-picker` | Manually assign picker rights to a user |
| `/reorder-lineup` | Reorder queued games in a tournament's iScored lineup |
| `/setup` | Configure Discord channels, roles, and pick windows |

## 11. iScored Integration

- **Dual-path sync** — REST API preferred (fast) for score reads/writes, with Playwright browser automation as the fallback and for game management (create/hide/delete) that the API can't do; hot-reloads settings without a restart.
- **Continuous background polling** — Keeps local leaderboards in sync with iScored across every submission method (web, Discord, iScored's own site), with pause/resume during maintenance windows.
- **Notification-gated polling** — Checks a lightweight per-account notification file before running an expensive full score fetch, cutting API traffic roughly 500,000:1 against actual score volume, with a configurable backstop interval.
- **Per-account session serialization** — Concurrent tournament fires sharing one iScored account are serialized so they can't step on each other's browser session state (previously caused silent, undetected delete failures).
- **Validate iScored Credentials** [Room Admin] — One-click test login that reports success or a specific, actionable failure reason (wrong credentials vs. timeout) instead of a raw stack trace.
- **Per-score suppression tombstone** — When a score is deleted on the ArcAid side, a suppression record keeps the next iScored sync from silently re-importing it.
- **Score sync across every web path** — Tournament, freeplay, and community score submissions all sync to iScored through one shared code path, so no submission surface is ever missed.

## 12. Moderation & Data Safety

- **Per-row score moderation** [Player / Room Admin] — Players can delete their own room-scoped scores from the per-player history expand; room admins can delete any score from the same UI or from a dedicated "Manage Scores" modal on each card.
- **Tiered delete authorization** — Super-admin (any row), room admin (any row in their rooms), and player (only their own rows) — enforced server-side independent of what the client UI shows.
- **Admin wipe-player-from-game** [Room Admin] — Fully removes a player's submission and score-history rows for a specific game, including on pinned (non-tournament) games.
- **Account deletion & data purge** [Player / Super Admin] — See Player Identity & Accounts above; anonymizes score rows while deleting all directly-identifying data, with an explicit policy carve-out list (ban records, merge/report records, and audit logs are retained; guest device claims are untouched).
- **Photo-on-delete cleanup** — Deleting a score also deletes its proof-photo file from disk, not just the database reference.
- **Comment/rating moderation authorization** — Tiered delete rules mirroring score moderation (author / room admin / super admin), with cross-tenant room-scope guards.
- **Guest-write rate limiting** — Dedicated limiters (keyed on IP, not a client-supplied header) on every guest-writable route to prevent comment/rating spam and submission floods.
- **At-rest secret encryption** — iScored passwords, the OPDB API key, the Twitch client secret, and web-push private keys are stored AES-GCM encrypted using a server-held master key; an explicit allowlist (not a naming convention) decides what gets encrypted, so a typo can't silently leave a secret in plaintext.
- **Audit log** [Super/Room Admin] — Every admin action (score deletes, bans, settings changes, catalogue merges, etc.) is logged with actor and target for later review.

## 13. Admin & Operations

- **Super-admin dashboard** — Server-wide overview of all rooms, quick links, and system status.
- **Room admin dashboard** — Per-room overview with the health card described under Tournaments above.
- **Backups** [Super Admin] — On-demand and Discord-triggerable database backups, with configurable retention and a per-backup delete action (path-traversal guarded).
- **Logs viewer** [Super Admin] — In-app viewer for application logs, with a configurable max-line cap.
- **In-app version display** — `GET /api/version` exposes the running app version, git commit, and build timestamp; surfaced on the Dashboard health card and the Help page footer, so support can confirm what's actually deployed.
- **Help guide** [Room Admin] — In-app documentation covering every admin page, kept in sync with the app each release, with full-text search (highlights every match across the whole guide and lets you step through hits) rather than just filtering sections.
- **Global Settings** [Super Admin] — Server-wide configuration: Discord bot token/client credentials, JWT secret, secrets-encryption key, backup retention, iScored API toggle/poll interval, OPDB/IGDB/Twitch credentials, web-push VAPID keys, and the OG-preview kill switch.
- **Per-room Settings** [Room Admin] — Room name/slug, Discord guild/role/channel, iScored credentials, timezone, platforms, cooldown/pick-window durations, theme, branding, kiosk options, card style, and callouts (an Easter-egg bot response to trigger words).
- **Tournament Settings** [Room Admin] — Name, type/tag, mode (pinball/videogame terminology switch), schedule, platform rules, cleanup rule, max active games, and per-tournament Discord overrides.
- **Game States page** [Room Admin] — Force-maintenance trigger, per-status filtering (Active/Queued/Completed/Archived), and manual status changes with optional iScored sync.
- **Admin Stats drill-down** [Room Admin] — Internal player-list → player-detail → game-detail statistics browser in the admin panel, separate from the public Stats page.
- **Background-sync validation** — Catalogue import routes (OPDB, IGDB) validate required credentials upfront and fail with an actionable message rather than silently erroring in the background.

## 14. Platform & PWA

- **Progressive Web App** [Player] — Installable on Android/iOS with a standalone display, offline caching of the app shell, and home-screen icons (including a maskable icon for Android's adaptive-icon system and a correctly-square Apple touch icon).
- **Automatic PWA cache updates** — The installed app's static-asset cache name is derived from a hash of the actual build output, so every deploy is automatically detected and old caches are cleared — no manual "bump the cache version" step, and no risk of forgetting it and shipping a stale bundle to installed users.
- **Bounded image cache** — Catalogue/style/room-asset/score-photo images are cached separately from app code with a capped, evict-oldest-first size limit, so the image cache can't grow unbounded across the life of an install.
- **Mobile-responsive** [Player] — Full functionality on phones and tablets across the entire public and admin surface.
- **Keyboard & screen-reader accessibility** — Visible focus states and `aria-current` on navigation, dialog semantics (`role="dialog"`, focus trapping) on key modals, keyboard-operable expandable score rows, and 44px minimum touch/click targets across primary interactive controls.
- **Route-level code splitting** — The entire admin surface loads on demand; a player scanning a QR code to submit a score never downloads a byte of admin-only code.
- **Lazy image loading** — Below-the-fold images (score-row avatars, catalogue grid art, tutorial thumbnails) load lazily; the first visible card row and page-hero art stay eager for fast perceived load.

---

For planned and in-progress work, see `ROADMAP.md`.
