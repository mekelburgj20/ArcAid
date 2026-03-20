# ArcAid — Onboarding Video Tutorial Script

**Duration:** ~12–15 minutes
**Audience:** New ArcAid TMaaS customers (room admins)
**Tone:** Friendly, practical, no jargon overload
**Format:** Screen recording with voiceover

---

## Pre-Recording Setup

- Have a demo room already created with slug `demo_room`
- Pre-import a game library (50+ games minimum so the library looks populated)
- Have one tournament already running with a few scores submitted (so leaderboard and dashboard aren't empty)
- Have Discord open with the bot in a test server
- Browser zoomed to 110% for readability on recording

---

## INTRO (30 seconds)

**[Show: ArcAid landing page at arcaid.app]**

> "Welcome to ArcAid — your tournament management platform for virtual pinball and retro gaming. In the next few minutes, I'll walk you through everything you need to set up your game room, configure tournaments, and get your community playing. Let's get started."

---

## SECTION 1: Logging In (1 minute)

**[Show: Room login page]**

> "Your ArcAid administrator has set up a game room for you and provided login credentials. Navigate to your room's login page — the URL will look like `arcaid.app/your_room/login`."

**[Type in credentials, click Log In]**

> "Enter your username and password and click Log In. If you have a Discord account linked as a room admin, you can also click 'Login with Discord' instead."

**[Show: Dashboard loads]**

> "After logging in, you'll land on the Dashboard. Let's start by configuring your room settings."

---

## SECTION 2: Room Settings (3 minutes)

**[Click Settings in sidebar]**

> "Click Settings in the sidebar. This is your command center for room configuration. Let's go through each section."

### Game Room

**[Show: Game Room section]**

> "First, your room identity. The Room Name is what players see on the public landing page. The Slug is your URL — so if your slug is 'my_room', your scoreboard lives at arcaid.app/my_room."

### Discord

**[Show: Discord section]**

> "Next, Discord integration. You need three IDs from your Discord server."

> "Guild ID — right-click your server name in Discord, copy the Server ID. Announcement Channel — right-click the channel where you want tournament announcements posted, copy the Channel ID. Admin Role — right-click the role that your admins have, copy the Role ID."

> "Quick tip: you need Developer Mode enabled in Discord to see these copy options. Go to User Settings, Advanced, and toggle Developer Mode on."

### iScored

**[Show: iScored section]**

> "iScored is the scoring platform ArcAid automates. Enter your iScored account email and password. The Public URL is your iScored leaderboard page — this is where ArcAid scrapes scores from. Click the eye icon to reveal masked passwords."

### Tournament Defaults

**[Show: Tournament Defaults section]**

> "These defaults apply to all tournaments. Game Eligibility Cooldown — how many days a game must wait before it can be picked again. This prevents the same games from being picked over and over."

> "Winner Pick Window — when someone wins a round, they get this many minutes to pick the next game. If they don't pick in time, it falls to the runner-up for the Runner-up Pick Window. After that, the system auto-selects."

> "Bot Timezone — set this to your community's timezone. All schedules use this."

### Theme & Platforms

**[Show: Theme selector, click through all 3]**

> "Choose a visual theme. Arcade gives you the neon glow look, Dark is a clean dark mode, and Light is a standard light theme. This applies to your public pages."

**[Show: Platforms section, add one]**

> "Platforms define what gaming systems your room supports. Add platforms like AtGames, VPXS, VR, or IRL. These get used later when you set up tournament platform rules."

### User Management

**[Show: User Management section]**

> "Finally, you can manage who has admin access. Add Discord admins by username, or use the invite system to create local admin accounts. Click Send Invite, copy the link, and share it — the new admin creates their own password."

**[Click Save for any changed setting]**

> "Settings auto-save when you change them. Now let's build our game library."

---

## SECTION 3: Game Library (2 minutes)

**[Click Game Library in sidebar]**

> "The Game Library is your catalog of every game available for tournaments. You have four ways to add games."

**[Click Import from VPS]**

> "The fastest way — Import from VPS pulls hundreds of pinball tables from the Virtual Pinball Spreadsheet. One click and they're all imported."

**[Show: success toast]**

> "Import VPXS Wizard does the same for VPXS Wizard tables. You can also upload a CSV, or add games one at a time with the form at the top."

**[Show: game table with filters]**

> "Once imported, you can search, filter by platform, sort by any column, and rate games. The star ratings help your community surface favorites."

**[Click Edit on a game, show modal]**

> "Click Edit to change a game's name, mode, platforms, or styling. You can tag games as Pinball or Video Game — this changes the terminology used in Discord announcements and the admin UI."

> "Now that we have games, let's create a tournament."

---

## SECTION 4: Tournaments (3 minutes)

**[Click Tournaments in sidebar]**

> "Tournaments are the heart of ArcAid. Each tournament runs on its own schedule and pulls games from your library."

### Creating a Tournament

**[Fill in the Create form step by step]**

> "Let's create a Daily tournament. Name it 'Daily Grind'. The Tag is a short code — type 'DG'. This gets used as a prefix on iScored."

> "Mode — choose Pinball. This controls the language used everywhere. Pinball mode says 'table', Video Game mode says 'game'."

**[Show: Schedule Builder]**

> "For the schedule, select Daily, set the time, and choose your timezone. Weekly and Monthly options let you pick a specific day. Monthly even supports 'Last day' for end-of-month rotations."

> "Max Active Games controls how many games run at once. For a daily tournament, one is typical. For a weekly, you might run two or three simultaneously."

**[Show: Cleanup Rule dropdown]**

> "Cleanup Rule determines what happens to finished games on iScored. Immediate Hide clears them right away. Retain Last keeps a history. Scheduled lets you clean up on a separate schedule."

**[Show: Platform Rules]**

> "If you have multiple platforms, you can require or exclude specific ones. For example, a 'VPXS Weekly' tournament might require the VPXS platform so only VPXS games are eligible."

**[Click Create Tournament]**

> "Click Create Tournament. It appears in the list below with its schedule summary."

### Active Games & Management

**[Show: tournament list and Active Games section]**

> "Below the tournament list, Active Games shows what's currently running. You can deactivate a game early — either locking it on iScored or just updating the database."

> "Edit any tournament by clicking Edit. Delete removes it entirely. Sync iScored Lineup reorders games on iScored to match your display order settings."

---

## SECTION 5: Leaderboard & Rankings (1.5 minutes)

**[Click Leaderboard in sidebar]**

> "The Leaderboard shows live scores for all active games. Each card displays the top 10 players. Click any row to expand and see all of that player's score submissions."

**[Show: ranking cards if available]**

> "If you've set up ranking groups, they appear here too with a purple accent — showing overall standings across tournaments."

**[Click Rankings in sidebar]**

> "Rankings let you aggregate scores across multiple tournaments into one overall leaderboard. Click Create Ranking Group, give it a name, and choose a method."

> "Max 10 awards points to the top 10 finishers on each game. Average Rank uses average finishing position. PAPA and Linear scoring use different point scales. Pick what fits your community's style."

> "Select which tournaments to include, set how many games count, and save."

---

## SECTION 6: Stats & History (1 minute)

**[Click Stats in sidebar]**

> "Stats shows all your players with their games played, best score, and average. Click any player to see their full profile — wins, win rate, recent scores, and best game."

**[Use game search box]**

> "Use the game search to look up all-time records for any game."

**[Click History in sidebar]**

> "History is your complete record of completed games. Filter by tournament or type. You can see every winner and winning score going back to the beginning."

---

## SECTION 7: Discord Commands (2 minutes)

**[Switch to Discord, show the test server]**

> "Now let's look at the Discord side. Your players interact with ArcAid through slash commands."

**[Type /list-active, show result]**

> "Slash list-active shows what games are currently running across all tournaments."

**[Type /list-scores, show result]**

> "Slash list-scores shows the leaderboard. Players can filter by user and paginate through results."

**[Type /submit-score, show the form]**

> "Slash submit-score is how players submit their scores. They enter the score and attach a photo. The first time they use it, ArcAid automatically links their Discord account to their iScored username."

**[Type /my-stats, show result]**

> "Slash my-stats gives players a personal stats card — wins, win rate, average, best score, and recent games."

**[Brief mention of admin commands]**

> "As an admin, you also have commands like slash force-maintenance to trigger a rotation manually, slash activate-game to start a specific game, and slash setup to configure the bot. The full command reference is in your How-To guide."

---

## SECTION 8: Public Pages (1 minute)

**[Open the public scoreboard in a new tab]**

> "Every game room has public pages that anyone can visit. Share your scoreboard URL with your community — no login required."

**[Show: scoreboard]**

> "The scoreboard shows live scores for all active games, just like the admin leaderboard."

**[Navigate to /players]**

> "The Players page lists everyone with their stats. Click any player for their full profile."

**[Navigate to /games]**

> "Game Availability shows which games are eligible to be picked — green for available, with a cooldown timer for recently played games. There's even a random game picker for when you can't decide."

**[Click Pick Random Game, show the pinball animation]**

> "Click Pick Random Game for a fun pinball-themed random selection."

---

## OUTRO (30 seconds)

**[Show: Dashboard]**

> "That's everything you need to get your game room up and running. To recap: configure your settings, import your game library, create your tournaments, and share the public scoreboard with your community. ArcAid handles the rest — automated rotations, score tracking, winner announcements, and picker assignments."

> "If you have questions, reach out to your ArcAid administrator. Happy gaming!"

**[Show: ArcAid logo / landing page]**

---

## B-Roll Suggestions

Capture these clips separately to cut in during editing:

- Discord bot posting a tournament rotation announcement
- A player using `/submit-score` with a photo
- The pick system in action (winner nomination message in Discord)
- Mobile view of the scoreboard
- Theme switching (quick cuts between all 3)
- The pinball random picker animation (full run)
