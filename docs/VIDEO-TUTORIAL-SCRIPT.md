# Arcaid — Video Tutorial Scripts

Two videos: a 3-minute **Quick Start** to get new room admins running immediately, and an 8-minute **Deep Dive** covering advanced features. Record separately and link the Deep Dive from the Quick Start's end card.

---

# Part 1: Quick Start (3 minutes)

**Audience:** Brand new room admins
**Goal:** Login → Settings → Import games → Create first tournament
**Tone:** Fast, focused, "follow along"

## Pre-Recording Setup

- Demo room created with slug `demo_room`, credentials ready
- Browser zoomed to 110%
- Empty room (no games, no tournaments) — we set up from scratch on camera

---

## INTRO (15 seconds)

**[Show: Arcaid landing page]**

> "Welcome to Arcaid. In under three minutes, you'll have your game room configured and your first tournament running. Let's go."

---

## Step 1: Log In (20 seconds)

**[Show: Room login page]**

> "Navigate to your room's login page — your Arcaid admin will provide the URL and credentials."

**[Type credentials, click Log In]**

> "Enter your username and password and click Log In. You can also use Discord OAuth if your account is linked."

**[Show: Dashboard]**

> "You're in. The setup checklist at the top shows exactly what needs to be configured. Let's knock these out."

---

## Step 2: Configure Settings (60 seconds)

**[Click Settings in sidebar]**

> "Click Settings. Three things matter right now: Discord, iScored, and Tournament Defaults."

**[Scroll to Discord section]**

> "Discord — paste your Guild ID, default announcement channel ID, and admin role ID. The announcement channel is where the bot posts by default — you can override it per tournament later. Quick tip: enable Developer Mode in Discord settings to copy these IDs."

**[Scroll to iScored section]**

> "iScored — enter the username, password, and public URL for your room's iScored account. Arcaid uses these to automate game creation and score tracking."

**[Scroll to Tournament Defaults]**

> "Tournament Defaults — set your timezone and pick windows. The cooldown prevents the same game from being picked back-to-back."

**[Click Save All Changes]**

> "Save. Done. Now let's add some games."

---

## Step 3: Import Games (30 seconds)

**[Click Game Library in sidebar]**

> "Click Game Library, then Import from VPS to pull in the full Virtual Pinball Spreadsheet catalog."

**[Click Import from VPS, show success toast]**

> "That's hundreds of games, imported in seconds. You can also use Import VPXS Wizard for Wizard tables, or upload a CSV."

---

## Step 4: Create a Tournament (45 seconds)

**[Click Tournaments in sidebar]**

> "Click Tournaments. Give it a name — 'Daily Grind'. Tag: 'DG'. Mode: Pinball."

**[Fill in Schedule Builder]**

> "Set the schedule to Daily, pick your time and timezone. Leave Max Active Games at 1 for daily tournaments."

**[Click Create Tournament]**

> "Click Create Tournament. It's live. Arcaid will automatically rotate games on your schedule, scrape scores, pick winners, and announce in Discord."

---

## OUTRO (15 seconds)

**[Show: Dashboard with setup checklist now mostly complete]**

> "That's it — your room is running. Share your public scoreboard URL with your community and check out the Deep Dive video for rankings, stats, Discord commands, and more."

**[Show: End card with Deep Dive link]**

---

# Part 2: Deep Dive (8 minutes)

**Audience:** Room admins who completed Quick Start
**Goal:** Advanced features, Discord commands, public pages
**Tone:** Thorough but efficient

## Pre-Recording Setup

- Demo room with games imported, 1-2 tournaments running, scores submitted
- Discord test server with bot active
- Browser zoomed to 110%

---

## INTRO (15 seconds)

**[Show: Dashboard with active tournaments]**

> "Your room is set up — now let's explore what Arcaid can do. We'll cover the leaderboard, rankings, stats, Discord commands, and public pages."

---

## Leaderboard (1.5 minutes)

**[Click Leaderboard in sidebar]**

> "The Leaderboard shows live scores for every active game. Each card shows the top 10 players for that game."

**[Click a score row to expand]**

> "Click any row to expand all of that player's score submissions — useful for verifying entries."

**[Point out ranking cards if visible]**

> "Ranking group cards appear alongside games with a purple accent — these show overall standings across multiple tournaments."

> "Scores update in real-time. When a player submits via Discord, it appears here within seconds."

---

## Rankings (1.5 minutes)

**[Click Rankings in sidebar]**

> "Rankings aggregate scores across tournaments into a single overall leaderboard. Click Create Ranking Group."

**[Fill in name, select method]**

> "Give it a name. Then choose a ranking method. Max 10 awards points to the top 10 finishers — 100 for first, down to 5 for tenth. Average Rank ranks by average finishing position. PAPA and Linear use different point curves."

**[Set Best N Games, select tournaments]**

> "Best N Games means only a player's top scores count — so 'Best 25' out of 50 games played. Set the minimum games threshold to prevent someone with one lucky win from topping the board."

**[Check tournament boxes, click Save]**

> "Select which tournaments feed into this ranking and save. Rankings recalculate automatically when new scores come in."

---

## Stats & History (1 minute)

**[Click Stats in sidebar]**

> "Stats shows every player with games played, best score, and average. Click any player name for the full breakdown — wins, win rate, and recent scores."

**[Click a player, show detail]**

> "Here's their stats card. You can see exactly which games they've dominated."

**[Use game search]**

> "Search for any game to see its all-time records, who holds the high score, and how many times it's been played."

**[Click History in sidebar]**

> "History shows every completed game with its winner, score, and date. Filter by tournament to narrow it down."

---

## Discord Commands (2 minutes)

**[Switch to Discord]**

> "Your players interact with Arcaid through Discord slash commands. Let's run through the key ones."

**[Type /list-active]**

> "Slash list-active shows what's currently running across all tournaments."

**[Type /list-scores]**

> "Slash list-scores shows the leaderboard for active games. Players can filter by user."

**[Type /submit-score, show form]**

> "Slash submit-score is how players submit scores. They enter a number and attach a photo. On first use, Arcaid automatically links their Discord to their iScored username."

**[Type /my-stats]**

> "Slash my-stats shows a personal stats card — wins, win rate, best score, and recent games."

**[Type /pick-game]**

> "When someone wins a round, they get nominated to pick the next game. Slash pick-game shows only eligible games — those past the cooldown period."

**[Brief admin commands]**

> "Admin commands need the admin role. Slash force-maintenance triggers a rotation manually. Slash activate-game starts a specific game. Slash deactivate-game ends one early. The full list is in your Help page inside the admin panel."

---

## Public Pages (1 minute)

**[Open public scoreboard in new tab]**

> "Every room has public pages — no login required. Share your scoreboard URL with your community."

**[Show: scoreboard]**

> "The scoreboard shows live game scores, same as the admin leaderboard."

**[Navigate to /players]**

> "Players page lists everyone with stats. Click through for individual profiles."

**[Navigate to /games]**

> "Game Availability shows which games can be picked — green for available, amber for on cooldown."

**[Click Pick Random Game]**

> "The random picker is a fun way to choose when it's your turn. It's cosmetic only — doesn't assign anything, just suggests."

**[Show mobile view]**

> "Everything works on mobile too — scoreboard, player profiles, game availability."

---

## Advanced Settings (1 minute)

**[Switch back to admin, click Settings]**

> "A few more settings worth knowing."

**[Show: Theme selector]**

> "Two themes — Dark for a sleek look, and Light for daytime use. This applies to your public pages. You can also set a personal override for your admin panel."

**[Show: Platforms editor]**

> "Platforms let you categorize games by system — AtGames, VPXS, VR, IRL. Tournaments can then require or exclude specific platforms."

**[Show: User Management]**

> "The invite system creates one-time links for new admins. They click the link, set a password, and they're in. You can also add Discord admins who log in via OAuth."

**[Show: Merge Player]**

> "Merge Player fixes username typos — enter the old name and the correct name, and all scores, submissions, and mappings get updated."

---

## OUTRO (15 seconds)

**[Show: Dashboard]**

> "That's Arcaid. Automated tournaments, live leaderboards, Discord integration, and public pages for your community. If you need help, check the Help page in your admin sidebar or reach out to your Arcaid administrator."

---

## B-Roll Suggestions

Capture these clips separately to cut in during editing:

- Discord bot posting a tournament rotation announcement with embed
- A player using `/submit-score` with a score photo attached
- The pick system in action (winner nomination → pick-game → new game announced)
- Mobile view of the scoreboard (phone or responsive browser)
- Theme switching (quick cut between Dark → Light)
- The pinball random picker animation (full run, ball bouncing through pegs)
- iScored website showing a game that Arcaid created automatically
