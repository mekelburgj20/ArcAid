# Leaderboard UX Redesign — Follow-up Items

Items deferred from the current implementation for follow-up discussion or future sprints.

## Questions for Review

### 1. Discord Avatar Integration (Enhancement to Player Avatars)
Currently implemented: deterministic colored-letter avatars for all players.
Next step: Use actual Discord profile pictures for mapped players.
- **Requires:** Storing `avatar_hash` in `user_mappings` table (DB migration)
- **Requires:** Fetching avatar data during identity resolution or Discord OAuth login
- **Question:** Should avatar hashes be refreshed periodically, or only on OAuth login? Discord users can change avatars frequently.
ANSWER: Should be refreshed periodically and at OAuth login.

### 2. Score Submission Route for QR Codes
QR codes are implemented and render a link to `/:slug/submit/:gameId`.
- **Requires:** A new standalone page/route component for mobile score submission (currently the submission is a modal within the scoreboard page). This needs to be a lightweight, mobile-optimized standalone page.
- **Question:** Should this page require Discord login, or allow anonymous submissions (like community scores)?
ANSWER: Allow anonymous submissions. If logged in, prepopulate in score entry the discord username (not including the @symbol). If user modifies, ask if they want to merge records with Discord username.

### 3. Kiosk Enabled Toggle — Backend Enforcement
The `KIOSK_ENABLED` toggle is added to the Settings UI.
- **Requires:** Backend check in the kiosk route or scoreboard-config response so the frontend can conditionally render a 404 for `/:slug/kiosk` when disabled.

## Deferred Features (from UX Plan)

### P2: Countdown Timers on Active Game Cards
- Shows "2d 8h left" on game cards based on tournament maintenance schedule
- **Complexity:** Requires converting cron expressions to "next run time" — the Scheduler uses `node-cron` with custom `L` support. Calculating next execution from cron is non-trivial and would need a library like `cron-parser`.
- **Question:** Should this show time until next maintenance run (game rotation), or a fixed end date set per game? The former is more accurate but technically harder.
- ANSWER: It should show countdown until the next maintenance run for accuracy. 

### P2: Game Room Admin Activity Log
- New admin page at `/:slug/admin/activity` showing room-specific events
- **Requires:** New `room_events` table schema design, event instrumentation throughout the codebase (score submissions, maintenance runs, Discord commands, settings changes), 7-day retention cleanup
- **Question:** What events should be tracked? Suggested: score submissions, game rotations, tournament completions, settings changes, admin logins. Anything else?
- ANSWER: We can start with these that you've mentioned above and add more later if needed.

### P2: Platform Management in Game Library
- Add platform inline from Game Library page with autocomplete
- Platform-in-use validation before deletion
- Platform sync between Game Library and Room Settings
- **Relatively straightforward** — can be done in a focused session

### P2: Game Library Autocomplete on Add
- Fuzzy search against master game library when adding games
- Show name + platform for disambiguation
- **Requires:** A search/autocomplete API endpoint for the master library
- ANSWER: Make sure if a fuzzy match is found, an error or warning is shown. User should still be allowed to add game despite warning.

### P3: Global Game CSS Override UI
- Color pickers for Title, Initials, Scores, Card border, Card background
- Toggle to override individual game styles
- DB schema exists, needs admin UI panel

### P3: Compact Card Header Option
- `SCOREBOARD_CARD_HEADER_STYLE`: 'banner' (current) or 'compact' (small thumbnail + title bar)
- Small change to GameCard component

### P3: Score Entry Animations / Live Feed
- Animated re-sort when rankings change via websocket
- Toast banner: "DANIMAL227 just posted 497,397,188 on Avengers!"
- The websocket `score:new` event already exists

### P3: "Your Best" Quick-Stat on Each Card
- Show "Your best: 2,083,270" at bottom of each card for logged-in users
- Small addition to GameCard, data already available via viewerEntry

### P3: PWA Support
- Add `manifest.json` with app icons, theme color, `display: "standalone"`
- Add service worker for offline static asset caching
- Straightforward, low risk
