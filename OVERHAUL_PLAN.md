# ArcAid — Full Overhaul Plan

**Prepared by:** Claude Code (Senior Review)
**Date:** March 7, 2026
**Status:** Core overhaul complete (Sprints 1–7)

### Progress
- **Sprint 1 (Stabilize):** COMPLETE — All 8 critical bugs fixed, merged to main (2026-03-08)
- **Sprint 2 (Harden):** COMPLETE — All 13 tasks done: IScoredClient resilience, log rotation, Docker hardening, service layer, cooldowns, transaction safety (2026-03-08)
- **Sprint 3 (Redesign):** COMPLETE — Tailwind CSS v4, arcade dark theme, component library, all pages redesigned, login/auth flow (2026-03-09)
- **Sprint 4 (Phase 8):** COMPLETE — Internal leaderboard, WebSocket, public scoreboard, stats/analytics pages (2026-03-09)
- **Sprint 5 (Discord UX + Player Portal):** COMPLETE — Embed announcements, autocomplete improvements, /my-stats, public player/game pages (2026-03-09)
- **Sprint 6 (Schedule UX + UAT):** COMPLETE — ScheduleBuilder component, setup wizard auth fix, tournament editing, per-tournament timezone, UAT passed (2026-03-09)
- **Sprint 7 (Platform & Mode):** COMPLETE — Per-tournament mode (pinball/videogame), platform rules (required/excluded), per-game mode & platforms, terminology per tournament, Settings platform editor, simplified setup wizard (2026-03-09)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Assessment](#2-current-state-assessment)
3. [Critical Bugs to Fix First](#3-critical-bugs-to-fix-first)
4. [Part I: Backend & Architecture](#4-part-i-backend--architecture)
5. [Part II: Frontend & Design Overhaul](#5-part-ii-frontend--design-overhaul)
6. [Part III: Discord Bot Improvements](#6-part-iii-discord-bot-improvements)
7. [Part IV: iScored Integration Hardening](#7-part-iv-iscored-integration-hardening)
8. [Part V: Phase 8 — New Features](#8-part-v-phase-8--new-features)
9. [Part VI: DevOps & Deployment](#9-part-vi-devops--deployment)
10. [Implementation Roadmap](#10-implementation-roadmap)
11. [Stack Summary](#11-stack-summary)

---

## 1. Executive Summary

ArcAid has excellent architectural bones — the singleton engine pattern, terminology abstraction, and DB-backed configuration are all the right ideas. However, the project is currently in a **late beta state** with several core features still stubbed out, a frontend that will break outside of local development, and no security layer whatsoever on the API. The Admin UI is functionally minimal and visually generic.

This plan addresses three dimensions:

- **Stabilize**: Fix critical bugs, complete incomplete features, add resilience
- **Secure**: Add authentication, validate inputs, protect sensitive data
- **Elevate**: Redesign the Admin UI with a bold retro-arcade aesthetic, add real-time capabilities, and build the Phase 8 internal leaderboard

The result will be a polished, production-ready tournament platform that looks and feels purpose-built for the virtual pinball and retro gaming community.

---

## 2. Current State Assessment

| Area | Score | Notes |
|------|-------|-------|
| Architecture | 7/10 | Good patterns. Singletons, terminology abstraction, DB-backed config are solid. |
| Backend API | 5/10 | Works, but no auth, no validation, hardcoded port, `process.exit()` as restart mechanism |
| Database | 5/10 | Schema is functional but lacks indexes, proper constraints, and audit timestamps |
| Engine Logic | 4/10 | `runMaintenance()` is a stub ("Simulated"). Scheduler maintenance call is commented out. Runner-up fallback and auto-select not implemented. |
| iScored Integration | 6/10 | The hardest part is working but fragile — hardcoded timeouts, no retry logic |
| Discord Bot | 7/10 | Commands are well-structured and cover the feature set. Some UX roughness. |
| Admin UI | 4/10 | Hardcoded `http://localhost:3001` everywhere, inline styles, no validation, very minimal dashboard |
| Security | 2/10 | No API auth. Anyone on the network can delete tournaments, change bot token, wipe settings. |
| Design | 3/10 | Generic indigo SaaS style with no personality. Could be any app. |
| Error Handling | 4/10 | Logs errors, but no recovery, no user-facing detail, no retries |

---

## 3. Critical Bugs to Fix First

These are blocking issues that must be resolved before any other work. They are quick fixes.

### BUG-01: Hardcoded `localhost` in Every Frontend Component
**Severity: Critical**
Every single React page (`Dashboard.tsx`, `Tournaments.tsx`, `GameLibrary.tsx`, `Settings.tsx`, `Logs.tsx`, `App.tsx`, and `SetupWizard.tsx`) has `fetch('http://localhost:3001/api/...')` hardcoded. This means the Admin UI is **completely broken** in any Docker deployment accessed from another machine on the network.

**Fix:** Create `admin-ui/src/lib/api.ts` — a single API client module that uses a relative URL (`/api/...`) so the browser uses whatever host it loaded the page from. Replace all fetch calls with this client.

```typescript
// admin-ui/src/lib/api.ts
const BASE = '/api'; // relative — works in any deployment
export const api = {
  get: (path: string) => fetch(`${BASE}${path}`).then(r => r.json()),
  post: (path: string, body: unknown) => fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json()),
  // ... put, delete
};
```

### BUG-02: `runMaintenance()` is a Stub
**Severity: Critical**
`TournamentEngine.runMaintenance()` (line 154-157) logs `"(Simulated) Sent Discord notification"` and does nothing. The Scheduler's maintenance call is commented out entirely. This means **the core feature of the bot — automated tournament rotation — does not function.**

**Fix:** Implement the full maintenance sequence:
1. Call `IScoredClient.lockGame(iscoredId)` on the active game
2. Call `IScoredClient.scrapeWinner(iscoredId)` to get the top scorer
3. Resolve winner to Discord user via `IdentityManager`
4. Send Discord announcement with winner + next game
5. Start `TimeoutManager` pick window for the winner
6. Activate the QUEUED game on iScored
7. Uncomment the Scheduler's maintenance invocation

### BUG-03: TimeoutManager Runner-Up Fallback Not Implemented
**Severity: High**
`TimeoutManager.ts` lines 128-130: "Runner-up logic not yet implemented" — it falls straight to auto-select. And auto-select (line 157) just clears the picker metadata and does nothing. This means nobody ever gets nudged to pick, and the queue stalls.

**Fix:** Implement runner-up pivot (query `submissions` for 2nd highest score → map to Discord user → assign as picker) and auto-select (call `TournamentEngine.isGameEligible()` on a random game from `game_library`).

### BUG-04: No API Authentication
**Severity: Critical**
The Express API has no authentication middleware. Anyone who can reach port 3001 can:
- Read and overwrite all settings (including the bot token)
- Delete all tournaments
- Wipe the game library

**Fix (fast):** Generate a random `ADMIN_API_KEY` on first run, store it in the `settings` table, and require it as a `Bearer` token or `X-API-Key` header on all write endpoints. The Admin UI reads this key from a `localStorage` session after the user logs in with a password.

### BUG-05: `process.exit(0)` in API Handler
**Severity: High**
`server.ts` line 87: After saving setup settings, the server calls `setTimeout(() => process.exit(0), 1000)`. While Docker will restart it, this is a brutal mechanism — any in-flight operations are killed without cleanup, the browser gets a dead connection mid-setup, and it's confusing to debug.

**Fix:** Use a graceful restart: emit an internal event that closes the Discord client and DB connection cleanly before exiting. Or better: dynamically reload credentials without restarting at all.

---

## 4. Part I: Backend & Architecture

### 4.1 API Security Layer

Add a lightweight auth middleware. No need for full OAuth — a simple admin password/API key pattern is sufficient for a self-hosted tool.

```
POST /api/auth/login  { password } → { token, expiresAt }
All write endpoints:  Authorization: Bearer <token>
```

- Password hash stored in settings table (bcrypt)
- JWT with 24-hour expiry (or configurable)
- Read-only endpoints (`GET /api/status`, `GET /api/logs`) can optionally be unprotected
- Admin UI stores token in `localStorage`, clears on logout

### 4.2 Input Validation with Zod

Add `zod` to the backend. Define schemas for every API request body. This replaces the current "accept anything" approach and gives automatic, typed error messages.

```typescript
const CreateTournamentSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['daily', 'weekly', 'monthly', 'custom']),
  cadence: z.object({
    cron: z.string().regex(cronRegex, 'Invalid cron expression'),
    autoRotate: z.boolean(),
    autoLock: z.boolean(),
    timezone: z.string().optional(), // new!
  }),
  discord_channel_id: z.string().regex(/^\d+$/).optional(),
  discord_role_id: z.string().regex(/^\d+$/).optional(),
});
```

### 4.3 Database Improvements

**Add indexes** (these will make a real difference as data grows):
```sql
CREATE INDEX IF NOT EXISTS idx_games_tournament_id ON games(tournament_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_submissions_game_id ON submissions(game_id);
CREATE INDEX IF NOT EXISTS idx_submissions_discord_user_id ON submissions(discord_user_id);
```

**Add audit timestamps** to mutable tables:
```sql
ALTER TABLE tournaments ADD COLUMN created_at TEXT DEFAULT (datetime('now'));
ALTER TABLE tournaments ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));
ALTER TABLE games ADD COLUMN created_at TEXT DEFAULT (datetime('now'));
```

**Fix `game_library.tournament_types`** — normalize this to a proper JSON array consistently. Add a migration to convert existing CSV values.

**Add missing settings columns** — add a `GAME_ELIGIBILITY_DAYS` setting (default 120) so the lookback period is configurable from the UI rather than hardcoded.

**Configurable timezone** — add `BOT_TIMEZONE` setting (default `America/Chicago`) read by the Scheduler instead of the hardcoded value.

### 4.4 Service Layer Pattern

Currently the API routes call the database directly with raw SQL. Introduce a thin service layer:

```
src/api/server.ts          ← HTTP routing only
src/services/             ← new directory
  TournamentService.ts    ← business logic for tournaments (wraps TournamentEngine)
  GameLibraryService.ts   ← game library CRUD
  SettingsService.ts      ← typed settings with schema
  LogService.ts           ← log streaming
```

This separates routing from logic, makes testing possible, and prevents the Discord commands and API from duplicating DB calls.

### 4.5 Real-time: WebSocket / Server-Sent Events

Replace the 5-second polling on the Logs page with **Server-Sent Events (SSE)**. This is built into Express with no extra library:

```typescript
app.get('/api/logs/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const watcher = fs.watch(logPath, () => {
    const newLines = getNewLogLines();
    res.write(`data: ${JSON.stringify(newLines)}\n\n`);
  });
  req.on('close', () => watcher.close());
});
```

Add **WebSocket support** (via `ws`, already a transitive dependency) for the Phase 8 real-time leaderboard.

### 4.6 Log Rotation

The logger currently appends to `data/arcaid.log` indefinitely. Add log rotation:
- Max size: 10MB per file
- Keep last 5 rotated files
- Use `rotating-file-stream` package (small, no native deps)

Replace the synchronous `fs.appendFileSync` with an async stream write.

### 4.7 Configuration Consolidation

Remove magic numbers from code. All tuneable values should be in settings:

| Setting Key | Default | Currently |
|-------------|---------|-----------|
| `GAME_ELIGIBILITY_DAYS` | `120` | Hardcoded in TournamentEngine |
| `WINNER_PICK_WINDOW_MIN` | `60` | Hardcoded in TimeoutManager |
| `RUNNERUP_PICK_WINDOW_MIN` | `30` | Hardcoded in TimeoutManager |
| `BOT_TIMEZONE` | `America/Chicago` | Hardcoded in Scheduler |
| `MAX_LOG_LINES` | `500` | Hardcoded in server.ts |
| `BACKUP_RETENTION_DAYS` | `30` | Not implemented |

---

## 5. Part II: Frontend & Design Overhaul

### 5.1 Design Direction: Retro Arcade Dark Theme

The current Admin UI looks like a generic indigo SaaS dashboard. For a virtual pinball and retro gaming community, we have the opportunity to create something that **feels like the world it serves** — bold, atmospheric, and visually exciting while remaining functional and professional.

**Design Concept: "Arcade Command Center"**

Imagine you're looking at the control panel of a high-end arcade cabinet crossed with a mission control room. Dark, moody backgrounds with neon accent lighting. Score readouts. A visual language that says "tournament" and "competition."

**Color Palette:**
```
Background (deep)   #0a0a14   — near-black with blue tint
Background (surface) #12121f  — card/panel background
Background (raised)  #1a1a2e  — elevated elements
Border               #2a2a4a  — subtle purple-blue border
Border (glow)        #4a4a8a  — active/hover border

Neon Cyan (primary)  #00d4ff  — main accent, CTAs, active states
Neon Magenta         #ff00aa  — warnings, alerts, important
Neon Green           #39ff14  — success, online status
Neon Amber           #ffaa00  — neutral info, queued states
Neon Purple          #aa00ff  — secondary accent

Text (primary)       #e8e8f0  — main readable text
Text (muted)         #8888aa  — secondary/label text
Text (faint)         #44445a  — placeholder/disabled
```

**Typography:**
- **Headings / Score Numbers:** `"Press Start 2P"` (Google Fonts) — the iconic pixel font, used sparingly for H1s, score readouts, and tournament names
- **UI Labels / Navigation:** `"Rajdhani"` or `"Orbitron"` — techy, readable, modern
- **Body / Data:** `"Inter"` — clean and legible for data-dense tables and logs
- **Monospace / Logs:** `"JetBrains Mono"` — sharp and readable for log output

**Visual Motifs:**
- Subtle CRT scanline texture (CSS repeating-linear-gradient, ~2px, 3% opacity) on backgrounds
- Thin neon glow on active navigation items and status indicators
- Animated "pulse" on the live/online status dot (CSS keyframes)
- Sharp 1px neon borders on cards instead of soft shadows
- Score numbers rendered large and glowing (think arcade high score screens)
- Tournament type badges with distinct neon colors per type (DG=cyan, WG-VPXS=green, WG-VR=purple, MG=amber)

**Card Design Example:**
```
┌─────────────────────────────────────────┐  ← 1px cyan border, top glow
│  ◈ DAILY GRIND                          │  ← neon badge + Press Start 2P
│  Medieval Madness                        │
│  ─────────────────────────────────────  │
│  Status: ● ACTIVE   Started: 2d 4h ago  │
│  Current Leader: XxPinballKingxX        │
│  Score: 1,234,560                       │  ← large amber score number
└─────────────────────────────────────────┘
```

### 5.2 Component Library

Replace all inline styles with a proper design system. Use **Tailwind CSS** (v4) for utility classes. It integrates seamlessly with Vite and React, eliminates the CSS chaos, and makes the design system consistent.

Alternatively, keep custom CSS but move to CSS custom properties (variables) and CSS modules — eliminating the scattered `style={{}}` props throughout the current components.

**Recommendation: Tailwind CSS v4** — it's zero-config with Vite, the dark theme support is excellent, and arbitrary value support handles the neon color palette perfectly.

Core shared components to build:
- `<NeonCard>` — styled container with glow border
- `<StatusBadge type="ACTIVE|QUEUED|COMPLETED">` — color-coded pill
- `<TournamentBadge type="DG|WG-VPXS|WG-VR|MG|custom">` — arcade-style tag
- `<ScoreDisplay score={1234567}>` — large glowing number with comma formatting
- `<NeonButton variant="primary|danger|ghost">` — styled button with hover glow
- `<DataTable>` — sortable, filterable, proper arcade styling
- `<LoadingState>` — pixel-art style spinner or scan-line animation
- `<ErrorBoundary>` — catches React errors gracefully
- `<ConfirmModal>` — replaces `window.confirm()` with styled modal

### 5.3 Page-by-Page Redesign

#### Dashboard (Complete Redesign)
Current state: Two text fields in a white card. Almost no information.

**New Dashboard:**
```
┌─ SYSTEM STATUS ─────────────────────────────────────────────────┐
│  ● BOT ONLINE    ◈ iSCORED CONNECTED    ✦ 3 ACTIVE TOURNAMENTS  │
└─────────────────────────────────────────────────────────────────┘

┌─ ACTIVE NOW ────────────────────────────────────────────────────┐
│  [DG]  Medieval Madness          Leader: XxPinballKingxX        │
│        Started 2d 4h ago         Score: 1,234,560               │
│  [VPXS] Twilight Zone           Leader: PinballWizard99         │
│         Started 6h ago           Score: 987,654                 │
│  [MG]  Attack From Mars          Picker: JohnDoe (45min left)   │
└─────────────────────────────────────────────────────────────────┘

┌─ NEXT ROTATIONS ────────┐  ┌─ RECENT WINNERS ────────────────┐
│  DG    → Tonight 12:00  │  │  1st  XxPinball...  Tue DG       │
│  VPXS  → Wed 11:00 PM   │  │  2nd  Wizard99      Mon WG       │
│  MG    → Apr 1st        │  │  3rd  PinMaster     Mar MG       │
└─────────────────────────┘  └─────────────────────────────────┘

┌─ QUICK ACTIONS ─────────────────────────────────────────────────┐
│  [Force Maintenance]  [Sync State]  [Run Cleanup]  [Backup Now] │
└─────────────────────────────────────────────────────────────────┘
```

**New API endpoints to support this:**
- `GET /api/dashboard` — single call returning active games, next rotation times, recent winners, system health

#### Tournaments (Enhanced)
Add: toggle active/inactive, inline edit, cron expression helper (human-readable preview: "0 0 * * *" → "Every day at midnight"), visual schedule timeline.

#### Game Library (Overhauled)
- Search/filter by name, type, style_id
- Inline editing of existing games
- Delete individual games (with undo toast)
- "Play History" column showing last played date
- Preview of iScored styling (color swatch for bg_color)
- Better CSV import with preview/validation before committing

#### Logs (Enhanced)
- Real-time streaming via SSE (no more polling)
- Log level filter chips (DEBUG / INFO / WARN / ERROR)
- Search within logs
- Color-coded by level:
  - `ERROR` → neon magenta
  - `WARN` → neon amber
  - `INFO` → text primary
  - `DEBUG` → text muted
- Auto-scroll toggle (don't scroll if user is reading)
- Download log file button

#### Settings (Secured & Improved)
- Categorized sections (Discord, iScored, Tournament Defaults, Appearance)
- Sensitive fields (tokens, passwords) hidden by default with reveal toggle
- Validation per field type (Discord IDs must be numeric, cron expressions validated)
- "Test Connection" buttons for Discord and iScored credentials
- Change log: show when a setting was last modified

#### New Page: Leaderboard
Live scoreboard view for currently active tournaments — this is the **showcase page**. Should look incredible — like an actual arcade high score screen. Will be the Phase 8 integration point.

#### New Page: History
Past tournament results — winners, scores, dates, game names. Filterable by tournament type and date range. Exportable to CSV.

### 5.4 React Architecture Improvements

**State Management:** Replace scattered `useState` + `useEffect` + `fetch` in every component with **TanStack Query (React Query)**. This gives automatic caching, background refetching, loading/error states, and eliminates the duplicated fetching patterns.

**API Client:** Single `src/lib/api.ts` module with typed functions (fixing BUG-01). Every component imports from this module — never calls `fetch` directly.

**Routing:** Add a `src/layouts/AuthLayout.tsx` that requires login before rendering any page. If no valid session token, redirect to `/login`.

**Error Handling:** Wrap all route components in `<ErrorBoundary>`. Add a global `useToast()` hook for success/error notifications (replacing `alert()` and `console.error()`).

---

## 6. Part III: Discord Bot Improvements

### 6.1 Complete the Maintenance Loop

The most important Discord improvement is making the maintenance loop actually execute. Once BUG-02 is fixed, the bot's automated announcements should follow this structure:

**Rotation Announcement (in tournament channel):**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    DAILY GRIND — ROTATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 WINNER    XxPinballKingxX
 GAME      Medieval Madness
 SCORE     1,234,560

 NEXT UP   Attack From Mars
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 @XxPinballKingxX — you have 1 hour
 to pick the next table. Use /pick-game
 or your pre-pick will apply automatically.
```

### 6.2 Message Design Consistency

Current bot messages are inconsistent in format and tone. Adopt a consistent embed design across all commands:

- Use Discord embeds (not plain text) for all major announcements
- Consistent color coding per tournament type (map to hex colors matching the Admin UI palette)
- Consistent footer: `ArcAid • <timestamp>`
- Ephemeral responses for user-specific feedback (already doing this in some commands — enforce everywhere)
- Error embeds should be red with a clear action the user can take

### 6.3 Command Improvements

**`/submit-score`:**
- Validate that the score is a positive number before submitting to iScored
- Add a timeout on the file download/upload sequence
- Clean up temp files in a `finally` block (currently can leak on failure)

**`/pick-game`:**
- Show eligibility when listing games (e.g., "🔒 Medieval Madness — played 45 days ago")
- Confirm iScored creation succeeded before updating DB

**`/list-scores`:**
- Add optional `@user` parameter to show a specific user's score
- Paginate if more than 10 submissions

**`/view-stats`:**
- Add win percentage alongside play count
- Show all-time high score with the holder's Discord mention

**`/setup`:**
- Currently just sets terminology mode. Expand to configure: announcement channel, role IDs, pick windows — so admins can configure via Discord, not just the Admin UI.

### 6.4 Rate Limiting & Cooldowns

Add per-user command cooldowns via a simple in-memory `Map<userId, lastUsedAt>`:
- `/submit-score`: 30-second cooldown
- `/pick-game`: 10-second cooldown
- `/list-scores`: 5-second cooldown

### 6.5 Autocomplete Improvements

Expand autocomplete to all game-selection commands, with real-time eligibility indication in the option label:
```
Medieval Madness (Last: Jan 2026 — ELIGIBLE)
Attack from Mars (Last: Nov 2025 — ELIGIBLE)
Twilight Zone    (Last: Feb 2026 — BLOCKED)
```

---

## 7. Part IV: iScored Integration Hardening

The Playwright automation is the most fragile part of the system. Here's how to make it resilient:

### 7.1 Retry Logic with Exponential Backoff

Wrap all iScored operations in a retry utility:

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      logWarn(`iScored operation failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}
```

### 7.2 Replace Hardcoded Timeouts

Replace all `page.waitForTimeout(2000)` calls with:
- `page.waitForSelector(selector, { timeout: 10000 })` — wait for a specific element
- `page.waitForLoadState('networkidle')` — wait for network quiet
- `page.waitForResponse(url => url.includes('/api/'))` — wait for an API response

These are deterministic rather than time-based and won't break when iScored is slow.

### 7.3 Browser Session Persistence

Currently, every IScoredClient operation boots a new browser. This is slow and resource-heavy. Use a **persistent browser context** that stays logged in between operations, only reconnecting if the session expires.

Add a `isSessionAlive()` check before each operation that navigates to the dashboard and checks for the login form.

### 7.4 Screenshot on Failure

On any Playwright error, automatically save a screenshot to `data/playwright-errors/` with a timestamp. This is invaluable for debugging iScored DOM changes:

```typescript
} catch (err) {
  const screenshotPath = `data/playwright-errors/${Date.now()}.png`;
  await this.page?.screenshot({ path: screenshotPath });
  logError(`Screenshot saved: ${screenshotPath}`);
  throw err;
}
```

### 7.5 iScored Change Detection

Store a hash of the iScored DOM structure on each successful scrape. If a future scrape fails and the hash differs from the last successful one, alert in Discord that iScored's layout may have changed. This proactively surfaces breaking changes before they become silent failures.

---

## 8. Part V: Phase 8 — New Features

### 8.1 Internal Leaderboard Engine

Move score storage and ranking entirely in-house. iScored remains the **display** platform, but ArcAid becomes the **source of truth** for scores.

**New `scores` table** (replacing the current `submissions` table, or supplementing it):
```sql
CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  discord_user_id TEXT NOT NULL,
  iscored_username TEXT,
  score INTEGER NOT NULL,
  photo_url TEXT,
  verified INTEGER DEFAULT 0,  -- 0=unverified, 1=verified by admin
  submitted_at TEXT NOT NULL,
  synced_at TEXT               -- when it was pushed to iScored
);

CREATE TABLE leaderboard_cache (
  game_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,          -- JSON array of ranked scores
  generated_at TEXT NOT NULL
);
```

**Leaderboard Calculation Service** — on each new score submission:
1. Insert to `scores`
2. Recalculate ranking for the game
3. Write ranked result to `leaderboard_cache`
4. Broadcast update via WebSocket

**Benefits:**
- Near-instant `/list-scores` responses (no iScored scraping)
- Historical data owned by ArcAid (not dependent on iScored availability)
- Foundation for future stats (personal bests, win streaks, head-to-head)

### 8.2 WebSocket Real-Time API

Add Socket.io (or native `ws`) to the Express server:

```typescript
// Events emitted to connected clients
'score:new'           → { gameId, userId, score, rank }
'game:rotated'        → { tournamentId, completedGame, newGame }
'picker:assigned'     → { tournamentId, discordUserId, windowMinutes }
'picker:reminder'     → { tournamentId, discordUserId, minutesLeft }
'bot:status'          → { online, iscoredConnected }
```

The Admin UI Dashboard and the public Leaderboard page connect via WebSocket for live updates.

### 8.3 Public Leaderboard Page

A **separate, publicly accessible URL** (same Express server, different route) showing live tournament standings. No authentication required. This is what gets shared on Discord, projected on a screen at the venue, etc.

**Design:** Full-screen arcade high score aesthetic. Auto-rotating between active tournaments every 15 seconds. Could be embedded as a browser source in OBS for streaming.

```
╔══════════════════════════════════════════════════════╗
║            DAILY GRIND — HIGH SCORES                 ║
║               Medieval Madness                        ║
╠══════════════════════════════════════════════════════╣
║  #1  XxPinballKingxX           1,234,560  ████████  ║
║  #2  PinballWizard99             987,654  ██████░░  ║
║  #3  ArcadeChampion              765,432  █████░░░  ║
║  #4  TableMaster                 543,210  ████░░░░  ║
╠══════════════════════════════════════════════════════╣
║  ● LIVE  |  Resets Tonight at Midnight               ║
╚══════════════════════════════════════════════════════╝
```

### 8.4 Stats & Analytics

With internal score history, unlock:
- **Player profiles:** All-time wins, total games played, average score per tournament type, best/worst games
- **Game stats:** Times played, average score, all-time high, eligible/ineligible status
- **Tournament stats:** Most competitive games, longest win streaks
- Expose via `GET /api/stats/player/:discordUserId` and `GET /api/stats/game/:name`

### 8.5 Backup Restoration via Admin UI

Currently `/create-backup` works but there's no way to restore via the UI — it requires SSH access and a CLI command. Add:
- `GET /api/backups` — list available backups with timestamps and sizes
- `POST /api/backups/:name/restore` — trigger restore (with "ARE YOU SURE?" guard)
- A **Backups page** in the Admin UI showing backup history and restore button

---

## 9. Part VI: DevOps & Deployment

### 9.1 Docker Improvements

**Add a non-root user:**
```dockerfile
RUN groupadd -r arcaid && useradd -r -g arcaid arcaid
USER arcaid
```

**Add a health check:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3001/api/status || exit 1
```

**Reduce image size:** The Playwright Ubuntu base adds ~2GB. Consider:
- Using `playwright:chromium-only` variant
- Or pulling Playwright into a separate `browser` service in docker-compose if the image size is a concern

**Add a `docker-compose.override.yml`** for local development (volume-mounts source code, sets `NODE_ENV=development`).

### 9.2 Environment Variable Improvements

Add a `PORT` environment variable (default 3001) instead of hardcoding it.

Document all env vars in a proper `.env.example` with comments explaining each one, valid values, and whether it's required vs. optional.

### 9.3 Startup Validation

Add a startup check that validates required environment variables before attempting to connect to Discord or iScored. Fail fast with a clear error message rather than a cryptic runtime crash:

```
❌ ArcAid cannot start: Missing required configuration:
   - DISCORD_BOT_TOKEN (set in .env or Admin UI settings)
   - ISCORED_USERNAME  (set in .env or Admin UI settings)
```

---

## 10. Implementation Roadmap

### Sprint 1 — Stabilize (1-2 weeks)
Fix all critical bugs. Get the core loop actually working end-to-end.

| Task | Priority | Effort |
|------|----------|--------|
| BUG-01: Fix hardcoded localhost URLs | Critical | Small |
| BUG-04: Add API authentication | Critical | Medium |
| BUG-02: Implement full `runMaintenance()` | Critical | Large |
| BUG-03: Implement TimeoutManager runner-up + auto-select | Critical | Medium |
| BUG-05: Replace `process.exit()` with graceful reload | High | Small |
| Add Zod validation to all API endpoints | High | Medium |
| Add DB indexes | Medium | Small |
| Add configurable settings (eligibility days, timezone, pick windows) | Medium | Small |
| Fix temp photo file leak in `/submit-score` | High | Small |

### Sprint 2 — Harden (1-2 weeks)
Resilience, security, and code quality.

| Task | Priority | Effort |
|------|----------|--------|
| Add retry logic to IScoredClient | High | Medium |
| Replace Playwright `waitForTimeout` with deterministic waits | High | Medium |
| Add persistent browser session | Medium | Medium |
| Add screenshot-on-failure to Playwright | Medium | Small |
| Implement log rotation | Medium | Small |
| Add startup environment validation | Medium | Small |
| Add Docker health check + non-root user | Medium | Small |
| Add service layer (separate routing from logic) | Medium | Large |

### Sprint 3 — Redesign Frontend (2-3 weeks)
Visual overhaul and UX improvements.

| Task | Priority | Effort |
|------|----------|--------|
| Migrate to Tailwind CSS | High | Medium |
| Build shared component library (NeonCard, StatusBadge, etc.) | High | Large |
| Redesign Dashboard with live stats | High | Large |
| Add `/api/dashboard` endpoint | High | Medium |
| SSE real-time log streaming | Medium | Small |
| Enhanced Logs page (filtering, coloring, search) | Medium | Medium |
| Enhanced Tournaments page (inline edit, cron helper) | Medium | Medium |
| Enhanced Game Library (search, inline edit, history) | Medium | Large |
| Improved Settings page (categorized, masked secrets) | Medium | Medium |
| New History page | Medium | Medium |
| New Backups page + restore API | Medium | Large |
| Add login page + auth flow in Admin UI | High | Medium |

### Sprint 4 — Phase 8 Features (2-3 weeks)
New capabilities that differentiate ArcAid.

| Task | Priority | Effort |
|------|----------|--------|
| Internal leaderboard engine (scores table + cache) | High | Large |
| WebSocket integration | High | Medium |
| Public-facing Leaderboard page | High | Large |
| Player stats API + UI | Medium | Large |
| Game stats API + UI | Medium | Medium |
| Discord autocomplete with eligibility indicators | Medium | Medium |

---

## 11. Stack Summary

### Keep (No Changes)
- **TypeScript** — excellent coverage, keep strict mode
- **Discord.js v14** — mature, stable
- **Playwright** — necessary for iScored automation (no public API alternative)
- **SQLite + sqlite/sqlite3** — right choice for a self-hosted single-server app
- **node-cron** — fine for the scheduler
- **Express v5** — already on latest
- **React 19 + Vite** — excellent choice, keep

### Add
- **Zod** — schema validation for API and settings
- **TanStack Query (React Query)** — data fetching in Admin UI
- **Tailwind CSS v4** — replace inline styles
- **Socket.io or ws** — WebSocket for Phase 8 real-time
- **rotating-file-stream** — log rotation
- **bcryptjs** — password hashing for Admin UI login
- **jsonwebtoken** — session tokens

### Remove / Replace
- `http://localhost:3001` hardcoded in frontend → relative `/api/` paths
- `window.confirm()` → proper modal component
- `alert()` → toast notification system
- Inline `style={{}}` props → Tailwind classes
- `process.exit(0)` as restart mechanism → graceful reload

---

*This document is ready for review. Upon approval, implementation will begin with Sprint 1 critical bug fixes.*
