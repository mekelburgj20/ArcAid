# ArcAid Leaderboard & Room Settings UX Plan

## Expert UX Analysis of Leaderboard_RoomSettings_Redesign.md

Analysis based on current ArcAid implementation, the redesign spec, and design patterns from leading pinball scoreboard platforms (Stern Insider Connected).

---

## Section-by-Section Review

### 1. Progressive Web App (PWA)
**Verdict: RECOMMEND**

Instead of native Android/iOS app wrappers, implement PWA support. The web app is already responsive -- a PWA approach is far cheaper and faster than native wrappers while delivering most of the same benefits.

**Implementation:**
- Add a `manifest.json` with app name, icons, theme color, and `display: "standalone"`
- Add a service worker for offline caching of static assets and basic offline fallback page
- This gives users "Add to Home Screen" on both Android and iOS with: app icon, splash screen, full-screen experience (no browser chrome), and faster load times
- No app store submission, review process, or maintenance overhead
- Revisit native wrappers only if push notifications or hardware access (NFC, camera beyond web APIs) become critical requirements

### 2. Theme Selection (Scoreboard Theme + Admin/Public Split)
**Verdict: IMPLEMENT -- HIGH PRIORITY**

The current system applies one `UI_THEME` to everything. Splitting into Admin Theme and Public Theme is a strong UX improvement.

**Recommendation:**
- Rename `UI_THEME` to `PUBLIC_THEME` (controls all `/:slug/*` public pages)
- Add `ADMIN_THEME` (controls all `/:slug/admin/*` pages)
- The existing 9 themes are well-designed for the admin context. For the public scoreboard, consider adding 3-5 scoreboard-specific "display themes" optimized for wall-mounted TVs and projectors (higher contrast, larger type, bolder colors). This is more valuable than importing all 30+ daisyUI themes, which would overwhelm admins with choice and many of which wouldn't look good with the scoreboard card design.
- **Do NOT adopt daisyUI wholesale.** The current CSS variable system is clean and purpose-built. DaisyUI would require a significant refactor for marginal benefit. Instead, expand the existing theme system with more presets that are curated for gaming/arcade aesthetics.

**New theme suggestions (scoreboard-optimized):**
| Theme | Vibe | Reference |
|-------|------|-----------|
| `midnight` | Deep navy + gold accents | Stern Insider Connected dark palette |
| `neon-noir` | Pure black + hot neon accents | Classic arcade cabinet aesthetic |
| `stadium` | Dark charcoal + bright white scores | Sports scoreboard readability |
| `vintage` | Warm browns + cream text | Pinball backglass feel |
| `electric-blue` | Deep blue + cyan/white | Modern gaming tournament |

**New arcade / pinball themed suggestions:**
| Theme | Palette | Inspiration |
|-------|---------|-------------|
| `backglass` | Deep black bg, warm amber/orange text, red accents, slight warm glow on borders | Classic 1970s-80s pinball backglass translite art -- think warm incandescent bulb lighting behind painted glass. Score text in amber like old LED segment displays. |
| `crt-green` | Pure black bg, phosphor green text (#33FF33), scanline overlay, subtle green glow on borders | Monochrome CRT monitor aesthetic. All text and accents in variations of phosphor green. Pairs naturally with the existing kiosk scanline effect. |
| `plasma` | Dark purple-black bg, hot pink primary, electric blue accents, white scores | Inspired by plasma ball / Tesla coil arcade decorations. High energy, very vivid. Pink and blue tendrils feel. |
| `cabinet` | Matte black bg, yellow title text, white scores, red rank highlights, blue accents | Classic black arcade cabinet with painted side art colors. Think Pac-Man, Galaga, Donkey Kong era -- primary colors on black. |
| `silverball` | Gunmetal/steel gray bg, chrome silver text, gold accents for #1, brushed metal card borders | Inspired by the chrome and steel of physical pinball machines. Metallic, industrial, premium feel. Card backgrounds like brushed stainless. |
| `wizard` | Deep indigo bg, mystical purple accents, gold/amber scores, teal highlights | Inspired by Wizard/fantasy pinball themes (Medieval Madness, Lord of the Rings). Regal, magical atmosphere. |
| `playfield` | Dark green bg (felt/playfield green), white scores, red/yellow accents, wood-tone borders | The playing surface itself -- green felt with bright inserts. Borders styled like wooden rail trim. Nostalgic and immediately recognizable to pinball players. |
| `marquee` | Black bg, bright white text with a subtle outer glow, cycling accent colors per card | Inspired by illuminated arcade marquee headers. Each card's border/accent subtly varies (like different game marquees in a row). High contrast, high readability. |

### 3. Room Settings Reorganization
**Verdict: IMPLEMENT -- HIGH PRIORITY**

The current Settings.tsx has a `CATEGORIES` object that defines groupings. The reorganization is straightforward and high-value.

**Recommended new category structure (top to bottom, most used first):**

```
1. Scoreboard Display
   - SCOREBOARD_LAYOUT, SCOREBOARD_CARD_SIZE, SCOREBOARD_MAX_SCORES,
     SCOREBOARD_RANKINGS_POSITION, SCOREBOARD_ZOOM, SCOREBOARD_CARD_OPACITY
   - SCOREBOARD_HIDE_EMPTY (move from Features toggle)
   - SCOREBOARD_TITLE_HIDDEN (move from Features toggle)
   - REQUIRE_SCORE_PHOTO (move from Features toggle)

2. Scoreboard Branding
   - SCOREBOARD_TITLE, SCOREBOARD_TITLE_STYLE, SCOREBOARD_TITLE_SIZE
   - Logo upload + LOGO_POSITION + LOGO_MAX_HEIGHT
   - Background upload + SCOREBOARD_BG_MODE + SCOREBOARD_BG_OPACITY

3. Kiosk
   - KIOSK_ENABLED (new toggle -- if disabled, /:slug/kiosk returns 404)
   - KIOSK_REFRESH_SECONDS

4. Game Room
   - GAME_ROOM_NAME, GAME_ROOM_SLUG

5. Discord
   - DISCORD_GUILD_ID, DISCORD_ADMIN_ROLE_ID, DISCORD_ANNOUNCEMENT_CHANNEL_ID
   - DISCORD_MENTIONS_ENABLED, ENABLE_CALLOUTS (move from Features)

6. iScored
   - ISCORED_ENABLED (move from Features toggle)
   - ISCORED_USERNAME, ISCORED_PASSWORD, ISCORED_PUBLIC_URL
```

**Items to remove/relocate:**
- **3b. Reload Scheduler:** Keep for now -- useful when an admin changes a tournament schedule and wants it to take effect immediately without restarting the container. But rename to "Refresh Schedules" and add a tooltip explaining when to use it.
- **3c. Others section duplicates:** Confirm and remove `LOGO_POSITION`, `SCOREBOARD_BG_MODE`, `SCOREBOARD_BG_OPACITY`, `SCOREBOARD_BG_URL`, `PLATFORMS` from the Others section. These are already in the proper Scoreboard Branding section.
- **3f. System settings:** Move `PORT`, `LOG_LEVEL`, `MAX_LOG_LINES`, `BACKUP_RETENTION_DAYS`, `SETUP_COMPLETE` to super-admin only (they don't belong in room admin UI).
- **3g. Add Custom Setting:** Remove entirely. This was likely a debug/development feature. Custom settings with no defined behavior add confusion.
- **3h. Tournament Defaults:** Remove this section. Set defaults in backend code (90 min for both pick windows). Document defaults in Help. Tournament config pages should show these as pre-filled defaults.

### 4. Game Library -- Platform Management
**Verdict: IMPLEMENT -- MEDIUM PRIORITY**

Good quality-of-life improvement. The platform-in-use validation before deletion is essential.

**Additional UX recommendations:**
- **Platform autocomplete:** When adding a platform from Game Library, show an inline text input with autocomplete from existing platforms (prevents typos/duplicates like "VPXS" vs "vpxs"). Platform names should be normalized to uppercase on save.
- **Game Library autocomplete:** Apply the same inline autocomplete pattern when admins add a game to the game library. Search against the existing master game library as the admin types, surfacing similar names (fuzzy match) to prevent duplicates and help admins find games that already exist. Display matches in a dropdown with game name + platform for disambiguation (e.g., "Medieval Madness - VPXS" vs "Medieval Madness - VR").

### 5a. Global Game CSS Override UI
**Verdict: IMPLEMENT -- LOW PRIORITY**

The schema exists. Build a simple "Global Card Styles" panel in Settings with:
- Toggle: "Override individual game styles" (off by default)
- Fields: Title color, Initials color, Score color, Card border color, Card background color
- Use color pickers, not raw CSS input (admins are not developers)
- Preview swatch showing a sample card with the selected colors

**Design note from Stern:** Their cards use a consistent dark card background with game-specific artwork in the header only. ArcAid already does this well with the catalogue style system. The global override should be positioned as "uniform look" mode, not as a replacement for the per-game style catalogue.

### 5b. QR Codes on Score Cards
**Verdict: IMPLEMENT -- MEDIUM PRIORITY**

Score submission from the leaderboard already works via click/touch on the game title. QR codes add value for two scenarios: (1) kiosk/TV displays where users can't touch the screen, and (2) desktop leaderboard users who prefer to enter scores on their phone rather than their PC.

**Refined recommendation:**
- **Three-state toggle** for `SCOREBOARD_QR_MODE`:
  - `disabled` -- No QR codes anywhere (default)
  - `kiosk-only` -- QR codes only on the kiosk view
  - `all` -- QR codes on both the public leaderboard and kiosk view
- QR links to `/:slug/submit/:gameId` -- a lightweight mobile-optimized score entry page
- Single position setting (bottom-right is the standard convention for QR overlays). Bottom-right or top-right are the only sensible choices -- don't over-engineer with 6 position options.
- QR size should auto-scale relative to card size
- Use a lightweight QR library (e.g., `qrcode` npm package, render as SVG inline)

### 5c. Logged-In User's Rank Highlight
**Verdict: IMPLEMENT -- HIGH PRIORITY**

This is one of the most impactful engagement features. Stern Insider Connected does exactly this (see Image 1: MEKELBURGJ shown at rank 26 in the last slot with distinct highlighting).

**Design specification:**
- If the logged-in user is within the top N (maxScores), highlight their row with a distinct background color (e.g., `bg-neon-cyan/15` with a left border accent `border-l-2 border-neon-cyan`)
- If the logged-in user is **outside** the top N, replace the last visible slot with their entry:
  - Show ranks 1 through (N-1), then show the user's actual rank in the Nth slot
  - Add a visual separator (subtle dashed line or gap) before the user's row to indicate the jump in ranks
  - The user's row should have the highlight treatment described above
- If the user has no score for that game, don't modify the card
- This should work on both Scoreboard (interactive) and KioskScoreboard (read-only display won't show since no login)

**Implementation notes:**
- The `scoreboard-config` API already receives viewer headers with the player token
- The leaderboard API response needs to include the requesting user's rank/score if they're outside top N (add an optional `viewerEntry` field to the response)
- The `GameCard` component needs a new `viewerUsername` prop to know which row to highlight

### 6. Game Room Admin Activity Log
**Verdict: IMPLEMENT -- MEDIUM PRIORITY**

Useful for troubleshooting and transparency. Keep it simple.

**Recommendation:**
- New admin page: `/:slug/admin/activity`
- Show a filterable, time-sorted list of events: score submissions, tournament maintenance runs, game rotations, Discord command usage, settings changes
- Source data from existing `audit_log` table (admin actions) + a new lightweight `room_events` table for automated events
- 7-day retention with automatic cleanup (add to existing `runCleanup()` in TournamentEngine)
- Filters: event type, date range, search by username
- No need for real-time/websocket updates -- simple paginated fetch is fine

---

## Additional UX Enhancements (Inspired by Stern Insider Connected)

These are features NOT in the current redesign doc that would significantly elevate the leaderboard experience:

### A. Two-Column Score Layout Within Cards
**Priority: HIGH**

Stern's desktop view (Image 2) shows scores in a **two-column layout** within each card (ranks 1-5 left, 6-10 right). This is far more space-efficient than a single-column list and allows showing 10 scores per card without making the card twice as tall.

**Recommendation:**
- Add a `SCOREBOARD_SCORE_COLUMNS` setting: `1` (default, current behavior) or `2`
- When set to 2, scores display as two side-by-side columns within each card
- Only activate 2-column when `maxScores > 5` (no point splitting 3 scores into two columns)
- Each column shows rank number + username + score in the same row format

**Mobile responsiveness:**
- Two-column score layout works well on desktop/tablet but becomes cramped on phone screens (< 480px), especially with long usernames and large scores. Usernames get truncated aggressively and scores may overlap.
- **Recommended approach: responsive collapse.** Use two columns on screens >= 640px (`sm:` breakpoint) and automatically collapse to single column on mobile. This is the standard responsive pattern and matches how Stern handles it -- their mobile app (Image 1) uses single-column while their desktop view (Image 2) uses two columns.
- Implementation: use CSS grid with `grid-template-columns: 1fr` on mobile, `repeat(2, 1fr)` on `sm:` and above. No admin setting needed -- this is purely a responsive behavior.
- The `SCOREBOARD_SCORE_COLUMNS` setting controls the **intent** (1 or 2 columns). When set to 2, mobile still collapses to 1 automatically. When set to 1, it stays single-column everywhere.
- Card width on mobile should expand to full viewport width (`calc(100vw - 2rem)`) regardless of `SCOREBOARD_CARD_SIZE` setting, ensuring scores are always readable.

### B. Player Avatars / Badges
**Priority: MEDIUM**

Both Stern screenshots show **colored avatar badges** next to each player name. This dramatically improves scanability -- users can find their name by color even before reading text.

**Recommendation:**
- **Discord users (primary):** The leaderboard data already includes `discord_user_id` for mapped players. Use the Discord CDN avatar URL (`https://cdn.discordapp.com/avatars/{userId}/{avatarHash}.png`) to display actual Discord profile pictures. This requires storing the avatar hash in `user_mappings` (fetched during identity resolution or OAuth login). Display as a 24px circular avatar next to the username.
- **Non-Discord fallback:** For players without a Discord mapping, generate a deterministic colored circle (24px) with the first letter of the username. Colors drawn from a curated palette of 12-16 high-contrast colors, selected by hashing the username. This is purely display-side (no DB changes for the fallback).
- **Future enhancement:** Allow non-Discord users to upload custom avatars via the score submission flow or a profile page. Not needed for initial implementation.
- **Performance:** Lazy-load avatar images with `loading="lazy"` and provide the colored-letter fallback as the error/loading state (handles broken Discord avatar URLs gracefully).

### C. Countdown Timer on Active Game Cards
**Priority: MEDIUM**

Stern shows "3 DAYS, 12 HOURS REMAINING" on active competitions. This creates urgency and engagement.

**Recommendation:**
- If a tournament game has a known end time (maintenance schedule), show a countdown badge on the card
- Format: "2d 8h left" (compact) or hide if > 7 days remaining
- Position: below the tournament name in the card header
- Only show on interactive scoreboard, not kiosk (kiosk should be clean/minimal)

### D. Score Entry Animation / Live Feed
**Priority: LOW (NICE-TO-HAVE)**

When a new score comes in (websocket `score:new` event already exists), animate the affected card:
- Brief highlight flash on the card (already partially implemented with the cyan overlay)
- Smooth re-sort animation if rankings change
- Optional: a small "toast" banner at the top: "DANIMAL227 just posted 497,397,188 on Avengers!"
- This is especially impactful for kiosk displays at events

### E. "Your Best" Quick-Stat on Each Card
**Priority: LOW**

For logged-in users, show a small "Your best: 2,083,270" line at the bottom of each card where they have a score, even if they're ranked. This gives instant context without needing to scan the full list. Stern does this implicitly by always showing the user's row.

### F. Game Card Header Artwork Enhancement
**Priority: MEDIUM**

The current implementation shows game artwork in a 112px banner. Stern's desktop view (Image 2) uses a **left-aligned artwork thumbnail + title bar** pattern that's more compact and shows the game name more prominently.

**Two layout options to offer admins:**
1. **Banner** (current): Full-width artwork header above scores
2. **Compact**: Small artwork thumbnail (64x64) left-aligned in the title bar, game name to the right

Add as `SCOREBOARD_CARD_HEADER_STYLE`: `banner` (default) or `compact`

---

## Implementation Priority Summary

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| **P0** | 5c. Logged-in user rank highlight | Medium | Very High -- core engagement |
| **P0** | 3. Settings reorganization | Low | High -- admin QoL |
| **P0** | 2. Admin/Public theme split | Low | High -- admin QoL |
| **P1** | A. Two-column score layout | Medium | High -- space efficiency |
| **P1** | 3h. Remove Tournament Defaults section | Low | Medium -- declutter |
| **P1** | 3c/3f/3g. Remove Others/System/Custom | Low | Medium -- declutter |
| **P2** | 4. Platform management in Game Library | Medium | Medium -- admin QoL |
| **P2** | 5b. QR codes (disabled/kiosk-only/all) | Medium | Medium -- multi-device use case |
| **P2** | 6. Activity log page | Medium | Medium -- admin visibility |
| **P2** | B. Player avatars (Discord + fallback) | Low | Medium -- visual polish |
| **P2** | C. Countdown timers | Low | Medium -- engagement |
| **P3** | 5a. Global CSS override UI | Medium | Low -- niche use |
| **P3** | F. Compact card header option | Low | Low -- visual variety |
| **P3** | D. Score entry animations | Low | Low -- polish |
| **P3** | E. "Your Best" quick stat | Low | Low -- engagement |
| **P3** | 1. PWA support (manifest + service worker) | Low | Medium -- mobile experience |
| **P1** | 2+. New arcade/pinball themes (8 themes) | Medium | High -- visual identity |
| **P2** | 4+. Game Library autocomplete on add | Low | Medium -- admin QoL |

---

## Design Principles (Derived from Analysis)

1. **Readability at distance** -- Leaderboards are often displayed on TVs/projectors. Every design choice should prioritize legibility at 10+ feet. This means high contrast, large rank numbers, and generous spacing.
2. **Scanability** -- Users look for their name first. Color badges, rank highlighting, and the logged-in user highlight all serve this need.
3. **Information density vs. clarity** -- Two-column scores (Stern pattern) are the right tradeoff. More than two columns would sacrifice readability.
4. **Minimal admin cognitive load** -- Fewer settings with smart defaults beats maximum configurability. Curated theme presets over raw CSS. Color pickers over text inputs. Pre-tested layouts over pixel-level margin controls.
5. **Arcade identity** -- The gaming/arcade aesthetic is a strength. Lean into it with bold typography (Orbitron is a great choice), neon accents, and dark backgrounds. Don't dilute with generic corporate themes.
