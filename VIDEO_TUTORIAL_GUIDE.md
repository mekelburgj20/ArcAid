# ArcAid Video Tutorial Production Guide

## Production Notes

### Visual Style
- **Theme:** Retro-arcade aesthetic — neon glows, dark backgrounds, pixel-inspired accents. ArcAid's built-in "arcade" theme is the default for all screen captures.
- **Transitions:** Quick wipe/slide transitions between scenes. Use a brief neon-flash effect for section changes. Avoid slow fades — keep the energy up.
- **Text overlays:** Use a clean sans-serif font (e.g., Inter or Space Grotesk) for callouts and labels. Neon glow optional on titles only.
- **Cursor/click highlights:** Use a subtle ring-pulse on every click so viewers can follow along. Yellow or cyan ring, matching ArcAid's accent palette.

### Pacing
- **Overview video:** Fast cuts, 2–4 seconds per shot. Music-driven rhythm.
- **Setup videos:** Unhurried. Pause 1–2 seconds after each action to let the viewer catch up. Repeat important clicks with a zoom-in if needed.
- **Operational videos:** Moderate pace. Show the action, then briefly show the result before moving on.

### Branding
- Every video opens with the ArcAid logo (SVG, `assets/arcaid_logo.svg`) on a dark background, 2-second hold.
- Every video closes with the ArcAid logo + URL (arcaid.app) + "Set up your Game Room today" tagline.
- Lower-third watermark: small ArcAid logo, bottom-right, 30% opacity throughout.

### Screen Capture Standards
- Resolution: 1920×1080 minimum. Record Admin UI at this resolution with browser zoom at 100%.
- Browser: Use a clean Chrome profile with no extensions or bookmarks bar.
- Sample data: Use a pre-seeded demo database with realistic game names, player names, and scores. Avoid placeholder text like "Test Tournament" or "Player1."
- Discord captures: Use a dedicated demo Discord server. Populate channels with realistic bot messages. Crop to the relevant channel — do not show the full Discord UI unless demonstrating server setup.

### Music & Sound
- **Background music:** Upbeat chiptune or synthwave, low in the mix during narration (–18 dB under voice). Instrumental only.
- **SFX:** Subtle arcade-style blips on UI clicks and transitions. Do not overuse — one per major action, not every click.
- **Narration:** Warm, conversational tone. Not overly formal. Record in a treated room, compress lightly for clarity.

---

## Part 1: Overview Video

### Script: "Welcome to ArcAid"

**Target length:** 75 seconds

---

**[0:00–0:02]**
[SCREEN: ArcAid logo fade-in on dark background, neon glow pulse]

---

**[0:02–0:12] — The Hook**

**NARRATION:**
"Spreadsheets for scores. Discord arguments about who picked what. Manually updating leaderboards at midnight. If you're running a pinball league or retro gaming tournament, you know the chaos."

[SCREEN: Quick montage — a messy spreadsheet, a Discord channel full of confused messages, a frustrated admin at a keyboard. Stylized, slightly exaggerated for humor.]

---

**[0:12–0:18] — The Introduction**

**NARRATION:**
"ArcAid takes all of that — and replaces it with one platform that just works."

[SCREEN: Cut to ArcAid public Scoreboard page. Live leaderboards glowing with neon-styled game cards. Scores update in real time with the yellow flash effect.]

---

**[0:18–0:30] — Feature Montage: Tournament Lifecycle**

**NARRATION:**
"Create tournaments — daily, weekly, monthly, or custom schedules. ArcAid handles the entire rotation automatically. Games lock on time. Winners are announced. The next game goes live. No admin babysitting required."

[SCREEN: Fast cuts —
1. Admin Tournaments page: a tournament with a cron schedule visible.
2. Discord channel: bot announces "Round complete! Winner: ShadowFlip — 1,247,000,000" with a colorful embed.
3. Discord channel: bot announces "New active game: Medieval Madness" with pick window countdown.
4. Public Scoreboard: game card transitions from one game to the next.]

---

**[0:30–0:42] — Feature Montage: Discord Integration**

**NARRATION:**
"Players submit scores with a single Discord slash command — attach a photo, type the score, done. Check standings, view stats, pick the next game — all without leaving Discord."

[SCREEN: Fast cuts —
1. Discord: `/submit-score` command with autocomplete showing active games, score typed, photo attached.
2. Discord: `/list-scores` embed showing ranked leaderboard with colored tournament badge.
3. Discord: `/my-stats` embed showing a player's win count, average score, best game.
4. Discord: `/pick-game` autocomplete filtering eligible games.]

---

**[0:42–0:52] — Feature Montage: Public Leaderboards & Rankings**

**NARRATION:**
"Share a public scoreboard with your community — live standings, player profiles, game history, and cross-tournament rankings. Players can submit community scores, leave tips and comments, browse enhanced player stats, and even spin the Mystery Scoop to discover what to play next."

[SCREEN: Fast cuts —
1. Public Scoreboard page with multiple active game cards, scores ranked — click + to expand a player's score history.
2. Players page: grid of player cards with stats. Public Stats page showing enhanced metrics.
3. Game Detail page: tabbed layout (Leaderboard, Community, Tips & Comments) — community score submission and tips visible.
4. Games page: Mystery Scoop randomizer button press, pinball-style animation picks a random game.]

---

**[0:52–1:02] — Feature Montage: Multi-Room & Admin Power**

**NARRATION:**
"Run multiple game rooms on a single server — each with its own tournaments, admins, settings, and iScored account. Invite new admins with a single link. Manage everything from a clean, responsive dashboard."

[SCREEN: Fast cuts —
1. Super-admin dashboard showing multiple room cards.
2. Room admin Settings page: admin invites section, "Create Invite" button.
3. Room admin Dashboard: setup checklist complete, system status green, active tournament cards.
4. Mobile view of the admin sidebar — responsive hamburger menu.]

---

**[1:02–1:12] — The Close**

**NARRATION:**
"Whether it's virtual pinball, retro arcade, or anything with a high score — ArcAid runs your tournament so you can just play."

[SCREEN: Slow zoom out from a vibrant public Scoreboard page. Scores flash. Music builds to a final beat.]

---

**[1:12–1:15] — Call to Action**

**NARRATION:**
"Set up your Game Room at arcaid.app."

[SCREEN: ArcAid logo centered. URL "arcaid.app" below. Brief neon pulse. Fade to black.]

---

## Part 2: Setup & Configuration Series

### Episode List

1. **Creating Your Game Room** — Set up your first game room from the super-admin dashboard.
2. **Building Your Game Library** — Import games from VPS or VPXS Wizard, curate your room's library, and configure platforms.
3. **Connecting Discord** — Configure the Discord bot, set your announcement channel, and assign admin roles.
4. **Setting Up iScored** — Enter iScored credentials, configure your public URL, and verify the connection.
5. **Creating Your First Tournament** — Define a tournament with scheduling, mode, platform rules, and cleanup settings.
6. **Managing Admins & Invites** — Add local admins, Discord admins, and send one-time invite links.

---

### Script: Episode 1 — "Creating Your Game Room"

**Target length:** 2:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"In this video, we'll create your first game room in ArcAid."

---

**[0:05–0:25] — Logging In**

[SCREEN: Browser navigates to arcaid.app. The public landing page loads — it's empty, no rooms yet.]

**NARRATION:**
"When you first access ArcAid, the landing page is empty — no game rooms exist yet. Click the login link to access the super-admin panel."

[SCREEN: Navigate to `/login`. The super-admin login page appears with a password field.]

**NARRATION:**
"Enter the super-admin password you set during installation. This is the master password defined in your environment configuration."

[SCREEN: Type password, click Login. Redirect to `/admin/dashboard`. The Super-Admin Dashboard loads with a "Create your first game room" prompt.]

---

**[0:25–1:10] — Creating a Room**

**NARRATION:**
"From the super-admin dashboard, click 'Manage Rooms' in the sidebar — or follow the prompt to create your first room."

[SCREEN: Click "Rooms" in the sidebar. The Game Room Manager page loads. Click "Create Room" button. A form appears.]

**NARRATION:**
"Give your room a name — this is what players will see. The slug is your room's URL path — keep it short, lowercase, no spaces. Add an optional description, and decide whether the room should be listed publicly on the landing page."

[SCREEN: Fill in the form —
- Name: "Daily Grind Arcade"
- Slug: "daily-grind"
- Description: "Virtual pinball tournaments — daily, weekly, and monthly"
- Public: toggle ON
Click "Create".]

**NARRATION:**
"That's it — your game room exists. You'll see it appear in the room list with quick links to open its admin panel or view its public scoreboard."

[SCREEN: Room appears in the table. Highlight the "Open Admin" and "View Scoreboard" links.]

---

**[1:10–1:40] — The Onboarding Message**

**NARRATION:**
"Notice the 'Copy Onboarding Message' button. This generates a setup checklist you can paste into Discord or a note to yourself — a handy reminder of the remaining configuration steps."

[SCREEN: Click the button. A toast confirms the message was copied. Paste it into a text editor to show the checklist briefly.]

---

**[1:40–2:00] — Navigating to Room Admin**

**NARRATION:**
"Click 'Open Admin' to jump into your room's admin panel. You'll land on the room dashboard, which shows a setup checklist tracking your progress."

[SCREEN: Click "Open Admin." The Room Admin Dashboard loads at `/daily-grind/admin/dashboard`. The SetupChecklist component is visible with unchecked items.]

**NARRATION:**
"Each item on this checklist corresponds to a configuration step — we'll cover them all in the next few videos. As you complete each one, the checklist updates automatically."

[SCREEN: Highlight the checklist items — Discord settings, iScored settings, game library, first tournament.]

---

**[2:00–2:15] — Multi-Room Note**

**NARRATION:**
"One more thing — ArcAid supports multiple game rooms on a single server. Each room gets its own tournaments, admins, game library, and settings. You can create as many rooms as you need from this same super-admin panel."

[SCREEN: Navigate back to `/admin/rooms`. Show the "Create Room" button again. Brief shot of two rooms in the table.]

---

**[2:15–2:25] — Outro**

**NARRATION:**
"Your game room is created. Next up — building your game library."

[SCREEN: ArcAid logo + "arcaid.app" closing card.]

---

### Script: Episode 2 — "Building Your Game Library"

**Target length:** 3:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Let's populate your game room with games."

---

**[0:05–0:30] — Master Library vs. Room Library**

[SCREEN: Navigate to super-admin sidebar → "Master Library" page (`/admin/library`).]

**NARRATION:**
"ArcAid has two levels of game library. The master library is the global catalog — every game across all rooms. Each room then curates its own subset from this master list. Think of the master library as the warehouse, and each room picks what goes on its shelves."

[SCREEN: Show the master library page with search and filter controls. Then navigate to a room's Game Library page (`/daily-grind/admin/library`).]

---

**[0:30–1:20] — Importing Games**

**NARRATION:**
"The fastest way to populate your library is with a bulk import. ArcAid supports two sources."

[SCREEN: On the room's Game Library page, highlight the import buttons.]

**NARRATION:**
"The VPS import pulls from the Virtual Pinball Spreadsheet — a community-maintained database of virtual pinball tables. Click Import VPS, and ArcAid fetches the latest data, merges it with your existing library, and automatically detects platform types."

[SCREEN: Click the VPS Import button. A progress indicator appears. Import completes. The game list populates with dozens of entries.]

**NARRATION:**
"The VPXS Wizard import pulls tables from the LegendsUnchained GitHub repository — useful if your community plays on AtGames Legends hardware."

[SCREEN: Briefly show the Wizard Import button.]

**NARRATION:**
"Both imports are non-destructive — they merge new games in and preserve anything you've already configured. If a game name closely matches an existing entry, ArcAid flags it as a near-match so you can review before duplicates sneak in."

---

**[1:20–1:50] — Browsing and Filtering**

**NARRATION:**
"Once imported, you can search by name, filter by mode — pinball or video game — and filter by platform."

[SCREEN: Type a search term. Toggle mode filter to "Pinball." Click a platform chip to filter. Show the sortable column headers — click "Name" to sort alphabetically, click "Rating" to sort by community rating.]

**NARRATION:**
"Each game shows its name, any aliases, the mode, supported platforms, community star rating, and an optional iScored style ID."

---

**[1:50–2:20] — Adding and Editing Games Manually**

**NARRATION:**
"You can also add games manually. Click 'Add Game' and fill in the details — name, mode, platforms, and optionally an iScored style ID if you want a specific visual theme on the leaderboard."

[SCREEN: Click "Add Game." Fill in form — Name: "Medieval Madness", Mode: Pinball, Platforms: check "VPX". Click Save. Game appears in list.]

**NARRATION:**
"To edit an existing game, click its row. Update any field and save. If you need to consolidate duplicate entries, use the merge feature — it transfers all platform data and room associations from one game into another."

[SCREEN: Click a game row, edit a field, save. Briefly show the merge option.]

---

**[2:20–2:50] — Configuring Platforms**

**NARRATION:**
"Platforms are the hardware or software environments your games run on — VPX, FX3, Legends, and so on. ArcAid auto-detects platforms from imports, but you can also manage them manually in your room settings."

[SCREEN: Navigate to Room Settings page → scroll to Platforms section. Show the platform list with add/edit/remove controls.]

**NARRATION:**
"Platforms matter because tournaments can have platform rules — requiring or excluding specific platforms when players pick games. We'll cover that when we set up tournaments."

---

**[2:50–3:10] — Room Library Curation**

**NARRATION:**
"Remember — the room library is a curated subset of the master library. When you import games at the room level, they're automatically added to both the master library and your room's selection. If another room on the same server imports the same games, they share the master entries but maintain independent room associations."

[SCREEN: Show the room library with its games. Briefly toggle back to the super-admin master library to show it contains the same entries plus potentially more from other rooms.]

---

**[3:10–3:25] — Outro**

**NARRATION:**
"Your game library is ready. Next — connecting Discord so your players can interact with ArcAid from their server."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 3 — "Connecting Discord"

**Target length:** 3:00

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Let's connect ArcAid to your Discord server."

---

**[0:05–0:40] — Discord Bot Setup (Prerequisites)**

[SCREEN: Brief shot of the Discord Developer Portal — Application page.]

**NARRATION:**
"Before configuring ArcAid, you'll need a Discord bot application. If you haven't created one yet, head to the Discord Developer Portal, create a new application, and generate a bot token. You'll also need the Client ID and Client Secret if you want Discord OAuth login for admins. Make sure to enable the Server Members intent — ArcAid uses it to map Discord users to iScored usernames."

[SCREEN: Highlight the bot token field (blurred), the Client ID, and the Privileged Gateway Intents section with Server Members toggled on.]

**NARRATION:**
"Invite the bot to your Discord server using the OAuth2 URL generator. ArcAid needs permissions to send messages, embed links, attach files, and use slash commands."

---

**[0:40–1:30] — Entering Discord Settings in ArcAid**

[SCREEN: Navigate to Room Settings page (`/daily-grind/admin/settings`). Scroll to the Discord section.]

**NARRATION:**
"In your room's settings page, scroll to the Discord section. The bot token, OAuth client ID, and client secret are global credentials — those are configured once in the super-admin Global Settings page, not here. For each room, you only need three things: your Discord Guild ID, an optional Admin Role ID, and your Announcement Channel ID."

**NARRATION:**
"Enter your Discord Guild ID — that's your server's unique identifier. You can find it by enabling Developer Mode in Discord and right-clicking your server name."

[SCREEN: Enter the Guild ID field.]

**NARRATION:**
"Next, set your announcement channel ID. This is the channel where ArcAid will post game rotations, winner announcements, and pick window countdowns. Right-click the channel in Discord, copy the ID, and paste it here."

[SCREEN: Enter the announcement channel ID.]

**NARRATION:**
"If you want, you can also set a Discord admin role ID — any Discord user with this role can use admin slash commands like force-maintenance and activate-game."

[SCREEN: Enter an admin role ID. Toggle the Mentions Enabled switch.]

**NARRATION:**
"The 'Mentions Enabled' toggle controls whether ArcAid @-mentions players in announcements. Turn it on for active engagement, or off if your community prefers quieter notifications."

---

**[1:30–2:00] — Verifying the Connection**

**NARRATION:**
"Save your settings. When ArcAid restarts or reconnects, it will register all slash commands with your Discord server automatically. You'll see the bot come online in your server's member list."

[SCREEN: Click Save. Switch to Discord — show the bot appearing online in the member list.]

**NARRATION:**
"Test the connection by typing `/ping` in any channel. If the bot responds with 'Pong! ArcAid is online and ready,' you're connected."

[SCREEN: Discord channel — type `/ping`. Bot responds with "Pong!"]

---

**[2:00–2:30] — Discord Slash Commands Overview**

**NARRATION:**
"ArcAid registers a full set of slash commands automatically. Players get commands like `/submit-score`, `/list-scores`, `/my-stats`, and `/pick-game`. Admins get `/activate-game`, `/deactivate-game`, `/force-maintenance`, and more. You don't need to register these manually — ArcAid handles it on startup."

[SCREEN: Discord command picker — type `/` and scroll through the ArcAid commands briefly. Highlight a few key ones.]

---

**[2:30–2:50] — Outro**

**NARRATION:**
"Discord is connected. If your community uses iScored for score tracking, the next video covers that integration. If not, skip ahead to creating your first tournament."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 4 — "Setting Up iScored"

**Target length:** 2:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"ArcAid can automate iScored.info — creating games, locking rounds, scraping scores, and managing your lineup. Here's how to connect it."

---

**[0:05–0:40] — What iScored Does**

**NARRATION:**
"iScored is a web-based scoring platform popular in pinball communities. ArcAid uses browser automation to interact with iScored on your behalf — creating new games when a round starts, locking games when a round ends, reading final scores, and even reordering your lineup to match tournament display order."

[SCREEN: Brief shot of an iScored.info page showing a game lineup with scores.]

**NARRATION:**
"This integration is optional. If you don't use iScored, you can skip this step — players can still submit scores directly through Discord's `/submit-score` command."

---

**[0:40–1:20] — Entering iScored Credentials**

[SCREEN: Navigate to Room Settings → iScored section.]

**NARRATION:**
"In your room settings, scroll to the iScored section. Enter the iScored username and password for the account that owns your game lineup. Then enter the public URL — this is the shareable link to your iScored page where scores are visible."

[SCREEN: Fill in username, password (masked), and public URL. Toggle "iScored Enabled" to ON.]

**NARRATION:**
"Important — use dedicated iScored credentials for ArcAid. The bot will log in via an automated browser session, so don't use an account you're actively browsing with at the same time."

[SCREEN: Save settings.]

---

**[1:20–1:50] — How ArcAid Uses iScored**

**NARRATION:**
"Once connected, here's what ArcAid automates. When a tournament round rotates, it locks the completed game on iScored, scrapes the final leaderboard to determine the winner, creates the next game on iScored with the correct style and tags, and unlocks it for scoring. It also reorders your iScored lineup to match tournament display positions, and handles cleanup — hiding or deleting old games based on your rules."

[SCREEN: Animated diagram or quick screen captures showing the flow: game locked → scores scraped → new game created → lineup reordered.]

---

**[1:50–2:10] — Style Learning**

**NARRATION:**
"A neat feature — when ArcAid creates a game on iScored, it can apply a visual style. During maintenance, ArcAid also reads styles from existing iScored games and saves them to your game library. So over time, your library learns the right look for each game automatically."

[SCREEN: Room Game Library page — show a game with a style_id populated. Then show the Style Catalogue page (`/admin/styles`) briefly.]

---

**[2:10–2:25] — Outro**

**NARRATION:**
"iScored is connected. Time to create your first tournament."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 5 — "Creating Your First Tournament"

**Target length:** 4:00

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"This is where it all comes together. Let's create a tournament."

---

**[0:05–0:30] — Tournament Concepts**

**NARRATION:**
"A tournament in ArcAid is a recurring competition with a schedule. Each round, one or more games are active — players submit scores — and when the schedule fires, ArcAid locks the round, crowns a winner, and activates the next game. Tournaments can run daily, weekly, monthly, or on any custom cron schedule."

[SCREEN: Room Dashboard showing active tournament cards with cadence badges — "Daily," "Weekly," "Monthly."]

---

**[0:30–1:30] — Creating a Tournament**

[SCREEN: Navigate to Tournaments page (`/daily-grind/admin/tournaments`). Click "Create Tournament."]

**NARRATION:**
"On the Tournaments page, click Create Tournament. Let's walk through each field."

**NARRATION:**
"Name — what players will see. Something like 'Daily Grind' or 'Weekend Warriors.'"

[SCREEN: Type "Daily Grind" in the name field.]

**NARRATION:**
"Tag — this identifies the tournament type. Common tags are DG for Daily Grind, WG-VPXS for weekly VPXS games, and so on. The tag is used for iScored game tagging and color-coding in Discord embeds."

[SCREEN: Enter "DG" as the tag.]

**NARRATION:**
"Mode — pinball or video game. This determines which games from your library are eligible and affects the terminology used in announcements."

[SCREEN: Select "Pinball" from the mode dropdown.]

**NARRATION:**
"Now the schedule. The Schedule Builder lets you define when rounds rotate. Pick your timezone, then build the cron expression. For a daily tournament that rotates at 9 AM Eastern, set the hour to 9, minute to 0, and leave the rest as 'every.' For a monthly tournament on the last day of the month, use the L option."

[SCREEN: Use the ScheduleBuilder component — select timezone, configure for daily at 9:00 AM. Show the resulting cron expression.]

**NARRATION:**
"Discord Channel — paste the channel ID where this tournament's announcements should go. If left blank, ArcAid uses the room's default announcement channel."

[SCREEN: Paste a channel ID.]

---

**[1:30–2:10] — Advanced Settings**

**NARRATION:**
"Display Order controls where this tournament appears in the lineup — lower numbers appear first. Max Active Games sets how many games can run simultaneously in this tournament. Most tournaments use one, but you can run multiple slots if you want parallel games."

[SCREEN: Set Display Order to 1, Max Active Games to 1.]

**NARRATION:**
"Platform Rules let you restrict which games can be picked for this tournament. For example, you could require games that support the VPX platform, or exclude certain platforms entirely. Leave it blank for no restrictions."

[SCREEN: Show the platform rules field. Enter a simple rule or leave blank.]

**NARRATION:**
"The Cleanup Rule controls what happens to completed games on iScored. 'Immediate' deletes them right after rotation. 'Retain' keeps a set number visible before hiding older ones. 'Scheduled' runs cleanup on a separate schedule — like weekly on Sundays."

[SCREEN: Select "Retain" and set the count to 3.]

---

**[2:10–2:40] — Saving and Queuing the First Game**

**NARRATION:**
"Click Create. Your tournament is live — but it doesn't have any games yet."

[SCREEN: Click Create. Tournament appears in the list.]

**NARRATION:**
"The simplest way to get started is to queue a game manually. In Discord, use the `/pick-game` command — select your tournament and choose a game from the autocomplete list. The autocomplete filters by your tournament's mode and platform rules, and marks recently played games as ineligible."

[SCREEN: Switch to Discord. Type `/pick-game`. Select the tournament from autocomplete. Select a game. Bot confirms the game is queued or immediately activated.]

**NARRATION:**
"If iScored is connected, ArcAid creates the game there and activates it. If not, the game is tracked locally and players submit scores via Discord."

---

**[2:40–3:20] — What Happens at Rotation**

**NARRATION:**
"When the cron schedule fires, ArcAid's maintenance loop takes over. It locks the active game, scrapes final scores, announces the winner in Discord with their score, activates the next queued game, and gives the winner a pick window — typically 60 minutes — to choose the following game."

[SCREEN: Discord channel showing a sequence of bot messages — "Round complete" announcement, "New active game" announcement with pick window deadline.]

**NARRATION:**
"If the winner doesn't pick in time, the runner-up gets a shorter window. If nobody picks, ArcAid auto-selects an eligible game. The tournament never stalls."

---

**[3:20–3:45] — Outro**

**NARRATION:**
"Your first tournament is up and running. In the final setup video, we'll cover adding admins and sending invite links."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 6 — "Managing Admins & Invites"

**Target length:** 2:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Let's add some admins to help manage your game room."

---

**[0:05–0:40] — Three Types of Admins**

[SCREEN: Room Settings page, scrolled to the admin sections.]

**NARRATION:**
"ArcAid has three levels of admin access. Super-admins have full control over all rooms and global settings — they log in with the master password or Discord OAuth. Discord admins are scoped to a specific room and log in via Discord OAuth. Local admins are room-specific accounts with a username and password — useful for admins who don't use Discord."

---

**[0:40–1:10] — Adding a Local Admin**

[SCREEN: Room Settings → Local Admins section.]

**NARRATION:**
"To add a local admin, scroll to the Local Admins section. Enter a username and display name, then click Add. The admin can now log in at your room's login page using this username and a password they'll set on first login."

[SCREEN: Type username "sarah", display name "Sarah". Click Add. New row appears in the admin table.]

[VERIFY FLOW] *Confirm whether local admins set their own password on creation or via separate flow.*

---

**[1:10–1:40] — Adding a Discord Admin**

[SCREEN: Room Settings → Discord Admins section.]

**NARRATION:**
"To add a Discord admin, enter their Discord user ID. Enable Developer Mode in Discord, right-click the user, and copy their ID. Paste it here and click Add. That user can now log in via Discord OAuth on your room's login page."

[SCREEN: Paste a Discord user ID. Click Add. New row appears.]

---

**[1:40–2:10] — Sending Admin Invites**

**NARRATION:**
"The slickest way to onboard a new admin is with an invite link. Click 'Create Invite' to generate a one-time link that expires in 48 hours."

[SCREEN: Click "Create Invite." A modal appears with an optional Discord user field. Click Create. The invite appears in the pending invites table with a copyable token link.]

**NARRATION:**
"Copy the invite link and share it. If you enter the invitee's Discord user ID, ArcAid can send the link directly via Discord DM. When the new admin clicks the link, they create a username and password and they're in — scoped to your room only."

[SCREEN: Copy the invite link. Show the pending invites table with expiry date. Briefly show the InviteAccept page where a new admin creates their credentials.]

---

**[2:10–2:25] — Outro**

**NARRATION:**
"That wraps up setup. Your game room is configured, your library is loaded, Discord and iScored are connected, your first tournament is running, and your admin team is on board. Head over to the Operational Tutorials to learn the day-to-day workflows."

[SCREEN: ArcAid logo + closing card.]

---

## Part 3: Operational Tutorials

### Episode List

1. **The Tournament Lifecycle** — How rounds rotate, how winners are determined, and what the maintenance loop does.
2. **Submitting and Managing Scores** — Score submission from the player and admin perspectives.
3. **The Pick Window** — How game picking works, including the winner → runner-up → auto-select cascade.
4. **Using the Public Scoreboard** — Navigating live leaderboards, player profiles, game details, and the Mystery Scoop.
5. **Cross-Tournament Rankings** — Setting up ranking groups and understanding the four ranking methods.
6. **Admin Power Tools** — Force-maintenance, activate/deactivate games, sync state, cleanup, and reorder lineup.
7. **Leaderboards, Stats & History** — Reading dashboards, player analytics, game analytics, and tournament history.
8. **Community Features** — Community scores, game tips & comments, public stats, score history, and the Discord rating flow.

---

### Script: Episode 1 — "The Tournament Lifecycle"

**Target length:** 3:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Let's walk through a complete tournament round — from active game to rotation to the next game going live."

---

**[0:05–0:40] — The Active Phase**

[SCREEN: Public Scoreboard showing an active game — "Medieval Madness" — with scores ranked. A tournament badge ("DG") glows in the corner.]

**NARRATION:**
"Right now, Medieval Madness is the active game in our Daily Grind tournament. Players are submitting scores — either through iScored directly or via Discord's `/submit-score` command. The public scoreboard updates in real time. Scores flash yellow when they come in."

[SCREEN: Discord channel — a player uses `/submit-score`, selects the game from autocomplete, enters a score, attaches a photo. Bot confirms the submission.]

**NARRATION:**
"Each submission is recorded in ArcAid's database with the player's iScored username, their score, and the submission timestamp. This is the single source of truth — even if iScored has a hiccup, your data is safe."

---

**[0:40–1:20] — The Rotation**

**NARRATION:**
"When the tournament's scheduled time hits — say, 9 AM — ArcAid's maintenance loop kicks in automatically."

[SCREEN: Animated sequence or annotated diagram showing the maintenance steps:]

**NARRATION:**
"Step one — the active game is locked on iScored. No more scores accepted. Step two — ArcAid scrapes the final leaderboard from the iScored public page to confirm all scores. Step three — the game is marked as completed in the database. Step four — ArcAid determines the winner — the player with the highest score."

[SCREEN: Discord channel — bot posts a rotation announcement embed: "Round Complete! Medieval Madness — Winner: ShadowFlip with 1,247,000,000." Colored by tournament type.]

**NARRATION:**
"Step five — the next queued game is activated. If iScored is connected, ArcAid creates the game there, applies the saved style, sets the tournament tag, and unlocks it for scoring."

[SCREEN: Discord channel — bot posts: "Now Active: Creature from the Black Lagoon." with a countdown to the next rotation.]

---

**[1:20–1:50] — Automatic Winner Announcement**

**NARRATION:**
"The winner announcement includes the player's name, score, and the game they won. If Discord mentions are enabled, the winner gets @-mentioned. ArcAid also resolves iScored usernames to Discord users automatically using its identity mapping — so even if a player's iScored name is different from their Discord name, the right person gets credit."

[SCREEN: Discord message with an @-mention. Briefly show the user mappings concept — an iScored name linked to a Discord user.]

---

**[1:50–2:30] — Lineup Management**

**NARRATION:**
"Behind the scenes, ArcAid also manages your iScored lineup order. Active games float to the top, sorted by tournament display order. Completed games shift down. If your cleanup rule is set to 'retain 3,' only the three most recent completed games stay visible — older ones are hidden."

[SCREEN: iScored.info lineup page showing games ordered by tournament, active first.]

**NARRATION:**
"If cleanup is set to 'immediate,' completed games are deleted from iScored right after rotation. And if it's 'scheduled,' cleanup runs on its own separate cron — for example, every Sunday at midnight."

---

**[2:30–3:00] — Multi-Slot Tournaments**

**NARRATION:**
"Some tournaments run multiple games at once — for example, a weekly tournament might have two active slots. In that case, each slot rotates independently. When one slot completes, the next queued game fills that slot. Both slots can have different winners and different pick windows running in parallel."

[SCREEN: Room Dashboard showing a tournament with two active game cards side by side.]

---

**[3:00–3:20] — Outro**

**NARRATION:**
"That's the tournament lifecycle — fully automated, from rotation to winner announcement to next game activation. Next — let's look at score submission in detail."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 2 — "Submitting and Managing Scores"

**Target length:** 3:00

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Scores are the heartbeat of any tournament. Here's how they flow through ArcAid."

---

**[0:05–0:50] — Player Submits via Discord**

[SCREEN: Discord channel. A player types `/submit-score`.]

**NARRATION:**
"The primary way players submit scores is through Discord. Type `/submit-score`, and ArcAid's autocomplete shows all currently active games. Select the game, type your score, and attach a photo as proof."

[SCREEN: Autocomplete dropdown shows active games. Player selects one, enters score, attaches an image. Submits.]

**NARRATION:**
"ArcAid maps your Discord identity to your iScored username automatically. If you haven't been mapped yet, it uses your Discord display name. You can also specify a different iScored username with the optional `username` parameter — useful if your Discord and iScored names don't match."

[SCREEN: Bot replies with an ephemeral success message confirming the score and username.]

**NARRATION:**
"If iScored is connected, ArcAid submits the score there too — including the photo. Your score appears on both the ArcAid leaderboard and the iScored page."

---

**[0:50–1:20] — Checking Scores**

**NARRATION:**
"To see the current standings, use `/list-scores`. ArcAid displays an embed for each active game with ranked players, scores, and tournament-colored formatting."

[SCREEN: Discord — `/list-scores` command. Embeds appear showing leaderboards. Gold border for daily, blue for weekly.]

**NARRATION:**
"You can filter to a specific player with the `user` option, and paginate with the `page` option if there are many entries."

**NARRATION:**
"For your personal stats, use `/my-stats`. You'll see your total games played, win count, win percentage, average score, best score, and your best game — all in a single embed."

[SCREEN: Discord — `/my-stats` command. Blue embed with player stats and avatar.]

---

**[1:20–1:50] — Identity Mapping**

**NARRATION:**
"ArcAid's identity system links Discord users to iScored usernames. This mapping happens automatically when you first submit a score, but admins can also set it manually with the `/map-user` command."

[SCREEN: Discord — `/map-user iscored_name:PinWizard discord_user:@Sarah`. Bot confirms the mapping.]

**NARRATION:**
"This is important because the iScored leaderboard uses iScored usernames, while Discord announcements use Discord @-mentions. The mapping bridges the two."

---

**[1:50–2:20] — Admin: Merging Players**

**NARRATION:**
"Sometimes a player's name gets recorded differently — maybe a typo or a name change. Admins can merge player identities from the admin panel."

[SCREEN: Room Admin — Stats page or a merge player action. [VERIFY FLOW] Show the merge endpoint being triggered from the admin UI if available.]

**NARRATION:**
"Merging updates all historical submissions, leaderboard entries, and ranking group caches to reflect the correct player. It's non-destructive — scores are preserved, just reassigned."

---

**[2:20–2:45] — Outro**

**NARRATION:**
"Scores submitted. Leaderboards updated. Identities mapped. Next — the pick window, where winners choose the next game."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 3 — "The Pick Window"

**Target length:** 3:00

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"When a round ends, someone has to pick the next game. ArcAid automates this with a tiered pick window."

---

**[0:05–0:45] — Winner Gets First Pick**

[SCREEN: Discord — bot announces rotation. "ShadowFlip wins Medieval Madness! You have 60 minutes to pick the next game."]

**NARRATION:**
"After a round completes, the winner is announced in Discord. They get a pick window — 60 minutes by default — to choose the next game using the `/pick-game` command."

[SCREEN: Discord — ShadowFlip types `/pick-game`. Autocomplete shows the tournament, then eligible games. Games marked '(recently played)' are flagged as ineligible.]

**NARRATION:**
"The autocomplete filters games by the tournament's mode and platform rules. Games played within the eligibility lookback period — 120 days by default — are marked as recently played and can't be selected."

[SCREEN: ShadowFlip selects a game. Bot confirms: "Creature from the Black Lagoon — queued for Daily Grind."]

---

**[0:45–1:15] — Reminders**

**NARRATION:**
"If the winner hasn't picked after 45 minutes, ArcAid sends a reminder in the announcement channel. Another reminder goes out at 15 minutes remaining."

[SCREEN: Discord — bot posts reminder: "ShadowFlip, you have 15 minutes left to pick the next game!"]

---

**[1:15–1:50] — Runner-Up Fallback**

**NARRATION:**
"If the full 60 minutes pass without a pick, ArcAid falls back to the runner-up — the second-place finisher. They get a shorter window, 30 minutes by default, with reminders at 20 and 10 minutes."

[SCREEN: Discord — bot announces: "ShadowFlip's pick window expired. NeonKnight, you have 30 minutes to pick the next game!"]

**NARRATION:**
"The runner-up uses the same `/pick-game` command. Everything works identically."

---

**[1:50–2:20] — Auto-Select**

**NARRATION:**
"If the runner-up also times out — or if there's no runner-up — ArcAid takes over. It randomly selects an eligible game from the library, creates it on iScored if connected, and announces it in Discord."

[SCREEN: Discord — bot announces: "No pick received. Auto-selected: Attack from Mars." with the standard new-game embed.]

**NARRATION:**
"The tournament never stalls. There's always a next game."

---

**[2:20–2:40] — Configuring Pick Windows**

**NARRATION:**
"Pick window durations are configurable in your room settings under Tournament Defaults. Adjust the winner timeout, runner-up timeout, and reminder intervals to match your community's pace."

[SCREEN: Room Settings → Tournament Defaults section. Show the pick window timing fields.]

---

**[2:40–2:55] — Outro**

**NARRATION:**
"That's the pick cascade — winner, runner-up, auto-select. Always moving forward. Next — the public-facing side of ArcAid."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 4 — "Using the Public Scoreboard"

**Target length:** 3:00

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Every game room gets a set of public pages — no login required. Let's take a tour."

---

**[0:05–0:45] — The Scoreboard**

[SCREEN: Navigate to the public Scoreboard at `/daily-grind/`.]

**NARRATION:**
"The scoreboard is the front page of your game room. It shows every active game as a card with the tournament name, color-coded border, and a ranked list of the top players with their scores."

[SCREEN: Scroll through multiple game cards. Highlight the tournament badge and colored borders — magenta for DG, blue for WG-VPXS.]

**NARRATION:**
"Scores update in real time. When a new score comes in, the card flashes yellow. When a game rotates, the scoreboard refreshes automatically — no manual reload needed."

[SCREEN: Show a score flash animation. Then a game card transitioning to a new game.]

**NARRATION:**
"Below the active games, you'll see cross-tournament ranking groups — if you've configured them. These show the top players across multiple tournaments."

[SCREEN: Scroll down to ranking group section showing top-10 players with points.]

---

**[0:45–1:15] — Players Page**

[SCREEN: Navigate to `/daily-grind/players`.]

**NARRATION:**
"The Players page lists everyone who has submitted a score. Search by name to find a specific player. Each card shows games played, best score, and average score."

[SCREEN: Type a search term. Cards filter. Click a player card.]

**NARRATION:**
"Click a player to see their full profile — stat cards for wins, win percentage, best game, and a table of recent scores."

[SCREEN: PlayerDetail page with stat cards and recent scores table.]

---

**[1:15–2:00] — Games Page & Mystery Scoop**

[SCREEN: Navigate to `/daily-grind/games`.]

**NARRATION:**
"The Games page shows your room's entire game library with availability status. Green checkmark means the game is available for picking. Clock icon means it's on cooldown — recently played and not yet eligible."

[SCREEN: Show the game list with status icons. Use the filter toggles — Available, Cooldown, All.]

**NARRATION:**
"Filter by tournament to see which games are eligible for a specific tournament. Search by name to find a particular title."

**NARRATION:**
"And here's a community favorite — the Mystery Scoop. Click this button and ArcAid randomly picks a game for you, pinball-machine style. It's a fun way to discover games you haven't played."

[SCREEN: Click the "Pick Random Game" button. The Mystery Scoop randomizer animation plays, lands on a game.]

---

**[2:00–2:30] — Game Detail & Community Features**

[SCREEN: Click a game name to navigate to its detail page.]

**NARRATION:**
"Each game has a detail page organized into tabs: Leaderboard, Community, Tips & Comments, and Your Stats. The Leaderboard tab shows all-time scores with stat cards for times played, average score, unique players, and the high score holder. Click the + icon next to any player to expand their full score history — all submissions across tournaments and community rounds."

[SCREEN: GameDetail Leaderboard tab with stat cards and ranked list. Click + next to a player — expandable score history appears.]

**NARRATION:**
"The Community tab shows scores submitted outside of tournaments — casual runs that still get tracked. The Tips & Comments tab is where players share strategies and reactions. And the Your Stats tab shows a logged-in player's personal record for this game."

[SCREEN: Click Community tab — community leaderboard and submit score form visible. Click Tips & Comments tab — tips section and comments section visible.]

**NARRATION:**
"Players can also rate games with a 1-to-5 star rating. The community average and rating count are displayed on each game. Ratings help admins understand which games are popular."

[SCREEN: Click the star rating. Stars fill in. Average updates.]

---

**[2:30–2:50] — Outro**

**NARRATION:**
"Share your room's scoreboard URL with your community — it's a live window into your tournaments. Next — cross-tournament rankings."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 5 — "Cross-Tournament Rankings"

**Target length:** 3:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Rankings let you track overall player performance across multiple tournaments. Here's how to set them up and what each method means."

---

**[0:05–0:40] — What Are Ranking Groups?**

[SCREEN: Room Admin → Rankings page.]

**NARRATION:**
"A ranking group combines results from multiple tournaments into a single leaderboard. For example, you might create a 'Season 1 Overall' group that includes your daily, weekly, and monthly tournaments. Players earn points based on their performance in each game, and the ranking group aggregates those points into an overall standing."

---

**[0:40–1:10] — Creating a Ranking Group**

**NARRATION:**
"Click Create Ranking Group. Give it a name and optional description. Then select which tournaments to include — check the boxes next to each tournament you want counted."

[SCREEN: Fill in Name: "Season 1 Overall". Check three tournament boxes.]

**NARRATION:**
"Set the 'Best N' value — this is how many of a player's best games count toward their total. If you set it to 10, only a player's top 10 performances are summed. This rewards consistency without punishing players who miss a round."

[SCREEN: Set Best N to 10.]

**NARRATION:**
"The 'Minimum Games' threshold sets how many games a player must have played to qualify for the ranking. This prevents someone with one lucky score from topping the leaderboard."

[SCREEN: Set Min Games to 5.]

---

**[1:10–2:20] — The Four Ranking Methods**

**NARRATION:**
"Now choose your ranking method. ArcAid offers four."

[SCREEN: Dropdown showing the four methods. Select each one as it's described.]

**NARRATION:**
"Max 10 awards points to the top 10 finishers on each game — 100 for first, 80 for second, down to 5 for tenth. Your best N games' points are summed. This is the most common method and rewards placing well consistently."

**NARRATION:**
"Average Rank tracks your average finishing position across all games. First place is rank 1, second is rank 2, and so on. Your best N ranks are averaged — lower is better. This method favors players who consistently finish near the top."

**NARRATION:**
"Best Game PAPA uses a PAPA-style scoring system — 100 for first, 90 for second, 85 for third, then minus one per place after that. Your best N games count. This gives a big bonus to first-place finishes."

**NARRATION:**
"Best Game Linear is similar but purely linear — 100 for first, 99 for second, 98 for third, and so on. The differences between places are smaller, which smooths out the ranking."

---

**[2:20–2:50] — Viewing Rankings**

**NARRATION:**
"Once created, ranking groups appear on the public scoreboard below the active games. They also appear in the admin Leaderboard page with a Recompute button if you need to force a recalculation."

[SCREEN: Public Scoreboard → scroll to ranking group. Show top-10 players with rank, name, points, and games played.]

[SCREEN: Admin Leaderboard page → ranking group section. Click "Recompute."]

**NARRATION:**
"Rankings are cached for performance and automatically invalidated when scores change or players are merged. You can also trigger a manual recompute from the admin panel."

---

**[2:50–3:15] — Outro**

**NARRATION:**
"Rankings add a layer of competition that keeps players engaged across the entire season. Next — admin power tools for managing your room on the fly."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 6 — "Admin Power Tools"

**Target length:** 3:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"Sometimes you need to take manual control. Here are the admin commands and tools for managing your game room."

---

**[0:05–0:40] — Force Maintenance**

[SCREEN: Discord channel.]

**NARRATION:**
"If you need to rotate a tournament immediately — say, a game has a technical issue — use `/force-maintenance` in Discord. Select the tournament, and ArcAid runs the full maintenance loop right now: lock, scrape, complete, activate next."

[SCREEN: Type `/force-maintenance`. Select tournament from autocomplete. Bot confirms maintenance started. Rotation announcements appear.]

**NARRATION:**
"This is the same process that runs on schedule — you're just triggering it early."

---

**[0:40–1:10] — Activate and Deactivate Games**

**NARRATION:**
"Need to push a specific game live without waiting for maintenance? Use `/activate-game`. Pick the tournament and the game — ArcAid creates it on iScored and activates it immediately, without completing the current active game."

[SCREEN: Discord — `/activate-game`, select tournament, select game. Bot confirms activation.]

**NARRATION:**
"To pull a game out of rotation early, use `/deactivate-game`. This locks the game on iScored and marks it completed. Scores are preserved."

[SCREEN: Discord — `/deactivate-game`, select game. Bot confirms deactivation with a note that scores are preserved.]

---

**[1:10–1:40] — Sync State**

**NARRATION:**
"The `/sync-state` command reconciles ArcAid's database with what's actually on iScored. It scans your iScored lineup, imports any games ArcAid doesn't know about, updates statuses based on lock and hide state, and syncs all scores."

[SCREEN: Discord — `/sync-state`. Bot processes. Summary appears: "Managed: 5, Manual: 2, Scores synced: 47."]

**NARRATION:**
"This is useful after manual changes on iScored or if you're migrating from a manual setup to ArcAid."

---

**[1:40–2:10] — Cleanup and Reorder**

**NARRATION:**
"Run `/run-cleanup` to manually trigger cleanup across all tournaments. Each tournament's cleanup rule is applied — immediate, retain, or scheduled. The bot reports how many games were cleaned up per tournament."

[SCREEN: Discord — `/run-cleanup`. Bot shows results per tournament.]

**NARRATION:**
"Use `/reorder-lineup` to sort your iScored lineup based on tournament display order. Active games move to the top, organized by the display order you set on each tournament."

[SCREEN: Discord — `/reorder-lineup`. Bot confirms reorder complete.]

---

**[2:10–2:40] — Nominate Picker and Pause Pick**

**NARRATION:**
"Two more handy commands. `/nominate-picker` lets you manually assign pick rights to any player for the next game — useful if the normal winner can't participate."

[SCREEN: Discord — `/nominate-picker` with tournament ID and user mention. Bot confirms and announces.]

**NARRATION:**
"`/pause-pick` injects a specific game directly into a tournament's queue — bypassing the normal pick flow. Great for special events or community-voted games."

[SCREEN: Discord — `/pause-pick` with tournament ID and game name. Bot confirms the game is queued.]

---

**[2:40–3:10] — Admin UI Dashboard**

**NARRATION:**
"Everything you see in Discord is also visible in the admin dashboard. The room dashboard shows system status, active tournament cards with current leaders, and the setup checklist. The Logs page gives you a live, filterable log viewer. And the Backups page lets you create and restore database snapshots."

[SCREEN: Quick tour — Room Dashboard with active tournaments, Logs page with level filters, Backups page with create/restore buttons.]

---

**[3:10–3:25] — Outro**

**NARRATION:**
"Those are your admin power tools — manual overrides for when automation isn't enough. Last video — reading your data."

[SCREEN: ArcAid logo + closing card.]

---

### Script: Episode 7 — "Leaderboards, Stats & History"

**Target length:** 3:00

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

**NARRATION:**
"ArcAid tracks everything. Here's how to read your data."

---

**[0:05–0:45] — Admin Leaderboard Page**

[SCREEN: Room Admin → Leaderboard page.]

**NARRATION:**
"The admin Leaderboard page shows all active games with their full ranked leaderboards — not just the top 5 you see on the public scoreboard, but every submission. Each game card shows the tournament badge, game status, and whether it's locked on iScored."

[SCREEN: Scroll through game cards showing ranked players. Highlight the lock icon on a completed game.]

**NARRATION:**
"Below the active games, you'll find your ranking groups with their current standings and a Recompute button for each."

[SCREEN: Scroll to ranking groups. Click Recompute on one.]

---

**[0:45–1:20] — Stats: Players**

[SCREEN: Room Admin → Stats page, Players tab.]

**NARRATION:**
"The Stats page has two views. The Players tab shows a table of every player in your room — their total games, best score, and average score. Click any player to see their full profile."

[SCREEN: Click a player row. Player detail loads — stat cards and recent scores table.]

**NARRATION:**
"This is the same data players see with `/my-stats` in Discord, but with the full history table visible."

---

**[1:20–1:50] — Stats: Games**

[SCREEN: Stats page, Games tab.]

**NARRATION:**
"The Games tab lets you search for any game and see its performance data — how many times it's been played, average score, number of unique players, and the all-time high score holder. Below that, recent tournament results show which tournaments featured the game and who won each time."

[SCREEN: Search for a game. Game stats load with cards and results table.]

---

**[1:50–2:20] — History**

[SCREEN: Room Admin → History page.]

**NARRATION:**
"The History page is your complete tournament archive. Every completed game is listed with its tournament, winner, winning score, and start and end dates. Filter by tournament or cadence type, and paginate through the full history."

[SCREEN: Show the history table with entries. Apply a tournament filter. Page to the next set of results.]

**NARRATION:**
"This is invaluable for end-of-season recaps, settling disputes, or just reliving great moments."

---

**[2:20–2:40] — The Room Dashboard**

[SCREEN: Room Admin → Dashboard.]

**NARRATION:**
"And don't overlook the dashboard itself. It shows your bot's online status, active tournament count, total participants, and a card for each active game with the current leader and next rotation time. It's your at-a-glance command center."

[SCREEN: Dashboard with status indicator (green pulse), tournament cards showing leaders and rotation times.]

---

**[2:40–2:55] — Outro**

**NARRATION:**
"That's ArcAid — from setup to daily operations. Your tournaments run themselves, your players stay engaged, and you have full visibility into everything. Thanks for watching."

[SCREEN: ArcAid logo + "arcaid.app" + "Set up your Game Room today" tagline. Fade to black.]

---

### Script: Episode 8 — "Community Features"

**Target length:** 3:30

---

**[0:00–0:05]**
[SCREEN: ArcAid logo intro]

---

**[0:05–0:40] — Public Stats Page**

[SCREEN: Navigate to `/:slug/stats`.]

**NARRATION:**
"ArcAid's public stats page gives your community a deeper look at player performance. You'll see an enhanced metrics table with stats beyond wins and scores."

[SCREEN: Stats page loads — player table showing columns for average finish position, top 5% frequency, and champion streak.]

**NARRATION:**
"Average finish is a player's mean finishing position across all games — lower is better, so a 1.8 means they average nearly first place. Top 5% shows how often a player lands in the top tier of the leaderboard. Champion streak is the longest consecutive run of tournament wins — a great way to highlight a dominant player."

[SCREEN: Hover or highlight each column in turn as it's described. Show a player row with all three metrics populated.]

---

**[0:40–1:20] — Score History**

[SCREEN: Navigate to the public Scoreboard (`/:slug/`). Find a player row on one of the active game cards.]

**NARRATION:**
"On the public scoreboard, every player row has a + icon. Click it to expand that player's full score history for that game — every submission they've made, with the source: tournament, community, or sync."

[SCREEN: Click the + icon next to a player. Expandable rows appear beneath, showing individual submissions with scores, dates, and source labels.]

**NARRATION:**
"The same expandable history appears on the Game Detail leaderboard tab. It's a quick way to see whether a player's best score was a recent run or from months ago."

[SCREEN: Navigate to a Game Detail page → Leaderboard tab. Click + on a player row to expand score history there as well.]

---

**[1:20–2:00] — Community Scores**

[SCREEN: Navigate to a Game Detail page → Community tab.]

**NARRATION:**
"The Community tab is for non-tournament scores. If a player wants to log a casual run — just for fun, not part of an active tournament — they can submit it here. These scores appear in their own ranked list, separate from tournament results."

[SCREEN: Community tab shows a community leaderboard with player names and scores. Below it, a submit score form is visible.]

**NARRATION:**
"To submit, just enter your score and an optional note. Community scores are tracked in ArcAid's database and appear on the public leaderboard. They don't affect tournament standings, but they do contribute to overall player stats."

[SCREEN: Fill in the community score form — enter a score, add a note, click Submit. The leaderboard updates with the new entry.]

---

**[2:00–2:40] — Tips & Comments**

[SCREEN: Game Detail page → Tips & Comments tab.]

**NARRATION:**
"The Tips & Comments tab has two sections. Tips are strategy notes — how to set up a shot, which multiball to aim for, recommended settings. Comments are more casual — reactions, trash talk, general discussion about the game."

[SCREEN: Tips section is visible at the top — a few tips listed with upvote counts. Comments section below with threaded discussion.]

**NARRATION:**
"To post a tip, click Add Tip, type your note, and submit. Tips are public and persist across sessions — a growing knowledge base for your community."

[SCREEN: Click Add Tip. Type a tip. Click Submit. Tip appears in the tips list.]

**NARRATION:**
"To post a comment, type in the comment box and click Post. You can delete your own comments at any time."

[SCREEN: Type a comment. Click Post. Comment appears. Click the delete button on your own comment — confirm deletion. Comment is removed.]

---

**[2:40–3:00] — Discord Rating Flow**

[SCREEN: Discord channel — a player uses `/submit-score` and the bot replies.]

**NARRATION:**
"After submitting a score via Discord, the bot follows up with star rating buttons. The player can rate the game with one click — one through five stars."

[SCREEN: Bot reply shows five star emoji buttons below the score confirmation. Click the 4-star button.]

**NARRATION:**
"Clicking a rating triggers a modal where the player can optionally add a tip or a comment about their session. They can submit with text or skip to just log the rating. This is the fastest way to build up your community tips and ratings organically."

[SCREEN: Modal appears with fields for tip and comment. Type a short tip. Click Submit. Bot confirms the rating and tip were saved.]

---

**[3:00–3:10] — Kiosk Mode**

[SCREEN: Navigate to `/:slug/kiosk`.]

**NARRATION:**
"One quick bonus — Kiosk Mode. Navigate to your room's `/kiosk` URL and ArcAid displays a clean, full-screen scoreboard view that auto-refreshes. Perfect for a TV or monitor at your venue showing live standings."

[SCREEN: Kiosk page loads — large scoreboard layout, no nav chrome, live scores visible. Show the auto-refresh cycle once.]

---

**[3:10–3:25] — Outro**

**NARRATION:**
"Community scores, tips, comments, score history, and the Discord rating flow — ArcAid gives your players more ways to engage with the games they love."

[SCREEN: ArcAid logo + "arcaid.app" closing card.]

---

## Appendix: B-Roll & Asset Checklist

### Graphics & Branding
- [ ] ArcAid logo (SVG, from `assets/arcaid_logo.svg`)
- [ ] ArcAid logo animation (neon pulse intro, 2 seconds)
- [ ] Closing card template: logo + URL + tagline
- [ ] Lower-third watermark (30% opacity)
- [ ] Tournament type color swatches: gold (#FFD700), blue (#00BFFF), purple (#AA00FF), green (#00FF88)
- [ ] Section transition animation (neon flash wipe)

### Demo Environment
- [ ] Pre-seeded ArcAid database with realistic data (multiple tournaments, 15+ players, 50+ scores, completed game history)
- [ ] Demo Discord server with:
  - Announcement channel populated with bot messages (rotation, winner, new game, pick window, reminders)
  - Multiple users with mapped iScored identities
  - Admin role configured
- [ ] Demo iScored account with active lineup (if showing iScored integration)
- [ ] Clean browser profile (Chrome, no extensions, no bookmarks bar)

### Screen Recordings: Overview Video
- [ ] Messy spreadsheet (stylized, can be stock or mocked)
- [ ] Chaotic Discord channel (mocked)
- [ ] Public Scoreboard with live scores and yellow flash effect
- [ ] Discord slash command usage montage (`/submit-score`, `/list-scores`, `/my-stats`, `/pick-game`)
- [ ] Super-admin dashboard with multiple rooms
- [ ] Mobile-responsive admin sidebar (hamburger menu)

### Screen Recordings: Setup Series
- [ ] Super-admin login flow (password entry → dashboard)
- [ ] Game Room Manager: create room form, room list, onboarding message copy
- [ ] Room Dashboard with setup checklist (partially complete and fully complete states)
- [ ] Master Game Library page (super-admin)
- [ ] Room Game Library: VPS import process, VPXS Wizard import, search/filter, manual add, edit, merge
- [ ] Room Settings: Platforms section (add/edit/remove)
- [ ] Discord Developer Portal: bot token, Client ID, intents (blurred credentials)
- [ ] Room Settings: Discord section (all fields)
- [ ] Discord: bot appearing online, `/ping` test
- [ ] Discord: command picker showing all ArcAid commands
- [ ] Room Settings: iScored section (all fields)
- [ ] iScored.info page showing a game lineup
- [ ] Style Catalogue page (super-admin)
- [ ] Tournaments page: create form with all fields, ScheduleBuilder component
- [ ] Discord: `/pick-game` to queue first game
- [ ] Room Settings: Local Admins section (add admin)
- [ ] Room Settings: Discord Admins section (add by ID)
- [ ] Room Settings: Admin Invites section (create invite, copy link, pending table)
- [ ] Invite Accept page (new admin creating credentials)

### Screen Recordings: Operational Tutorials
- [ ] Full tournament rotation sequence in Discord (lock → winner → new game → pick window)
- [ ] `/submit-score` with autocomplete, score, photo attachment, confirmation
- [ ] `/list-scores` with pagination
- [ ] `/my-stats` embed
- [ ] `/map-user` command
- [ ] Pick window sequence: winner announcement → reminder → timeout → runner-up → timeout → auto-select
- [ ] Public Scoreboard: real-time score flash, game rotation refresh
- [ ] Public Players page: search, click player, player detail
- [ ] Public Games page: availability filters, Mystery Scoop randomizer animation
- [ ] Public Game Detail: stats, star rating submission, recent results
- [ ] Rankings page: create group form, method selection, tournament checkboxes
- [ ] Public Scoreboard: ranking group display
- [ ] Admin Leaderboard: recompute button
- [ ] `/force-maintenance` command and result
- [ ] `/activate-game` and `/deactivate-game` commands
- [ ] `/sync-state` command and summary
- [ ] `/run-cleanup` command and per-tournament results
- [ ] `/reorder-lineup` command
- [ ] `/nominate-picker` and `/pause-pick` commands
- [ ] Room Dashboard: status indicators, active tournament cards with leaders
- [ ] Admin Leaderboard page: full ranked lists, lock icons
- [ ] Stats page: Players tab (table, click to detail), Games tab (search, stats)
- [ ] History page: table, filters, pagination
- [ ] Logs page: level filters, search, auto-scroll, download
- [ ] Backups page: create and restore
- [ ] Public Stats page: enhanced player metrics table (average finish, top 5%, champion streak)
- [ ] Scoreboard: expandable score history (click + icon on a player row)
- [ ] Game Detail: tabbed layout (Leaderboard, Community, Tips & Comments, Your Stats)
- [ ] Game Detail: community score submission form and community leaderboard
- [ ] Game Detail: tips section (add tip) and comments section (post, delete)
- [ ] Discord: post-score rating buttons and optional tip/comment modal
- [ ] Kiosk mode: `/:slug/kiosk` auto-refresh full-screen view

### Audio
- [ ] Background music track: upbeat chiptune/synthwave, instrumental, loopable (2–3 minute loop)
- [ ] Arcade-style click/blip SFX (3–5 variations)
- [ ] Transition SFX (neon whoosh)
- [ ] Narration recordings for all 15 scripts
