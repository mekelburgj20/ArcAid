# Arcaid — Room Admin How-To Guide

Welcome to Arcaid! This guide walks you through setting up and managing your game room from first login to running tournaments. You'll be provided a login URL and credentials by your Arcaid administrator.

---

## Table of Contents

1. [Logging In](#1-logging-in)
2. [Dashboard Overview](#2-dashboard-overview)
3. [Room Settings](#3-room-settings)
4. [Game Library](#4-game-library)
5. [Tournaments](#5-tournaments)
6. [Leaderboard](#6-leaderboard)
7. [Rankings](#7-rankings)
8. [Stats & Analytics](#8-stats--analytics)
9. [Game History](#9-game-history)
10. [Discord Bot Commands](#10-discord-bot-commands)
11. [Public Pages](#11-public-pages)

---

## 1. Logging In

Navigate to the login URL provided to you. This will be in the format:

```
https://arcaid.app/your_room_slug/login
```

**Option A: Local Admin (Username/Password)**
Enter the username and password provided during onboarding and click **Log In**.

**Option B: Discord OAuth**
Click **Login with Discord** to authenticate with your Discord account. This works if your Discord user has been added as a room admin by the Arcaid super-admin.

{Image of room login page showing both login options}

After logging in you'll land on the **Dashboard**.

---

## 2. Dashboard Overview

The Dashboard gives you a quick snapshot of your room's current state.

**Status Bar** — Three indicators across the top:
- **Bot Online** — Green pulse = connected, magenta = offline
- **Active Tournaments** — Number of tournaments currently running
- **Participants** — Total unique players with scores

**Active Now** — Cards for each active tournament showing:
- Current game name
- Tournament name and badge
- Current leader and their score
- Next scheduled rotation time

**Recent Winners** — The last 5 tournament winners with their game, score, and date.

{Image of the room admin Dashboard with active tournaments and recent winners}

---

## 3. Room Settings

Navigate to **Settings** in the sidebar to configure your game room. Settings are organized into categories.

### Game Room

| Setting | What It Does |
|---------|-------------|
| **Game Room Name** | Display name shown on the public landing page and all public pages |
| **Game Room Slug** | URL identifier (e.g., `my_room` makes your scoreboard available at `/my_room/`) |

{Image of Game Room settings section}

### Discord

| Setting | What It Does |
|---------|-------------|
| **Discord Guild ID** | Your Discord server's ID. Right-click your server name → Copy Server ID |
| **Default Announcement Channel** | Default channel for tournament announcements. Used as a fallback when a tournament doesn't have its own channel configured |
| **Admin Role** | Discord role ID that grants access to admin-only bot commands |

To get a Channel ID or Role ID: Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode), then right-click the channel/role → Copy ID.

{Image of Discord settings section}

### iScored

| Setting | What It Does |
|---------|-------------|
| **iScored Username** | Login email/username for your room's iScored.info account |
| **iScored Password** | Password for the iScored account (masked by default, click eye icon to reveal) |
| **iScored Public URL** | The public leaderboard URL used for score scraping (e.g., `https://iscored.info/your_account`) |

These credentials allow Arcaid to automate game creation, locking, and score retrieval on iScored.

{Image of iScored settings section}

### Tournament Defaults

| Setting | What It Does |
|---------|-------------|
| **Game Eligibility Cooldown (days)** | After a game finishes, how many days before it can be picked again. Prevents the same games from repeating too frequently |
| **Winner Pick Window (minutes)** | How long the winner of a tournament round has to pick the next game before the pick passes to the runner-up |
| **Runner-up Pick Window (minutes)** | How long the runner-up has to pick if the winner didn't. After this expires, the system auto-selects a game |
| **Bot Timezone** | Default timezone for all schedules (e.g., `America/Chicago`, `America/New_York`). Can be overridden per tournament |

{Image of Tournament Defaults settings section}

### Theme

Choose the visual theme for your public-facing pages:
- **Dark** — Deep indigo dark theme with accent colors (default)
- **Light** — Clean light theme for daytime use

You can set a global theme for all visitors, and optionally set a personal override for your own admin experience.

{Image of Theme selector showing all three options}

### Platforms

Platforms define what gaming systems your room supports. Games in your library can be tagged with one or more platforms, and tournaments can require or exclude specific platforms.

Common platforms: **AtGames**, **VPXS**, **VR**, **IRL**

Click **Add Platform** to add a new one. Click the **×** next to a platform to remove it.

{Image of Platforms editor with a few platforms listed}

### User Management

**Discord Admins** — Add Discord users who can log in via OAuth. Enter their Discord username or numeric ID.

**Local Admins** — Username/password accounts listed here. These are created via the invite system.

**Invite New Admin** — Generate a one-time invite link:
1. Enter a display name for the new admin
2. Optionally enter their Discord username to send the invite via DM
3. Click **Send Invite**
4. Copy the invite link and share it (link expires in 48 hours)

The invited user visits the link, creates a username and password, and can immediately log in.

{Image of User Management section showing Discord admins, local admins, and invite form}

### System Actions

- **Reload Scheduler** — After changing timezones or tournament schedules, click this to apply changes immediately without restarting
- **Merge / Rename Player** — Consolidate two player usernames into one, or rename a player. Updates all scores, submissions, and mappings

{Image of System Actions section}

---

## 4. Game Library

The Game Library is your catalog of all games available for tournaments. Navigate to **Game Library** in the sidebar.

### Importing Games

Arcaid supports four import methods:

**CSV Upload** — Upload a CSV file with columns: `name`, `aliases`, `style_id`, `mode`, `platforms`. Click **Download Template** for a pre-formatted example file.

**Import from VPS** — One-click bulk import from the Virtual Pinball Spreadsheet database. Imports hundreds of pinball tables instantly.

**Import VPXS Wizard** — One-click import of VPXS Wizard tables from the community GitHub repository. All imported games are tagged with the `VPXS` platform.

{Image of Game Library page showing import buttons and the game table}

### Adding a Game Manually

1. Enter the **Game Name** (required)
2. Select the **Mode** — Pinball or Video Game
3. Enter **Platforms** — comma-separated (e.g., `AtGames, VPXS`)
4. Optionally fill in **Style ID**, **Aliases**, and advanced CSS styling fields
5. Click **Add Game**

### Managing Games

The game table supports:
- **Search** — Filter by name or platform
- **Mode filter** — Toggle Pinball / Video Game visibility
- **Platform filter** — Click platform chips to filter
- **Sort** — Click column headers to sort by name, mode, platforms, rating, or style ID
- **Edit** — Click the edit icon to modify any game's details
- **Rate** — Click the stars to rate a game (community average shown)
- **Bulk Delete** — Check multiple games and click **Delete Selected**

### Activating a Game

To manually start a game in a tournament:
1. Click the **Activate** button on any game row
2. Select which tournament to activate it for
3. The game will be created on iScored and appear on your leaderboard

{Image of the Activate modal showing tournament selection}

---

## 5. Tournaments

Navigate to **Tournaments** in the sidebar to create and manage tournament schedules.

### Creating a Tournament

Fill in the creation form at the top of the page:

| Field | Description |
|-------|-------------|
| **Name** | Display name (e.g., "Daily Grind", "Weekly Challenge") |
| **Tag** | Short code used as the iScored tag prefix. Must be unique (e.g., `DG`, `WG-VPXS`, `MG`) |
| **Mode** | Pinball or Video Game — controls terminology (e.g., "table" vs "game") throughout the UI and Discord |
| **Schedule** | How often the tournament rotates |
| **Display Order** | Position in the scoreboard and announcement order (lower = first) |
| **Max Active Games** | How many games run simultaneously in this tournament (1–10) |
| **Cleanup Rule** | What happens to finished games on iScored |
| **Platform Rules** | Require or exclude specific platforms for game eligibility |
| **Discord Channel** | Override the default announcement channel for this tournament |

{Image of the Create Tournament form}

### Schedule Options

- **Daily** — Rotates every day at the specified time
- **Weekly** — Rotates on a specific day of the week at the specified time
- **Monthly** — Rotates on a specific day of the month (1st–31st, or **Last day** for end-of-month)
- All schedules include a **time** and **timezone** setting

{Image of the Schedule Builder showing frequency, day, time, and timezone dropdowns}

### Cleanup Rules

After a tournament round completes, the finished game on iScored can be handled in three ways:

- **Immediate Hide** — Game is hidden on iScored right after completion
- **Retain Last N** — Keep the last N completed games visible, hide older ones
- **Scheduled** — Run cleanup on a separate cron schedule

### Platform Rules

If your room has multiple platforms, you can scope tournaments to specific ones:

- **Require** — Only games tagged with these platforms are eligible
- **Exclude** — Games tagged with these platforms are ineligible
- **No rules** — All games are eligible regardless of platform

### Tournament List

The table below the creation form shows all your tournaments with their name, tag badge, mode, position, max slots, and schedule.

- **Edit** — Opens the full edit modal to change any setting
- **Delete** — Removes the tournament (confirmation required)
- **Sync iScored Lineup** — Reorders the iScored game lineup to match your display order settings

### Active Games

Below the tournament list, the **Active Games** section shows all currently running games with their tournament, start date, and iScored link status.

- **Deactivate** — Stop an active game. Two options:
  - **Deactivate + Lock on iScored** — Marks complete in Arcaid and locks the game on iScored
  - **DB Only** — Only updates Arcaid's database (doesn't touch iScored)

{Image of Active Games section with the Deactivate modal}

---

## 6. Leaderboard

Navigate to **Leaderboard** in the sidebar for a live view of all active game scores and ranking groups.

**Game Cards** — One card per active game showing the top 10 scores. Click any score row to expand and see all submissions for that player, sorted by score.

**Ranking Cards** — If you have ranking groups configured, they appear alongside game cards with a purple accent. Shows the overall standings across tournaments.

Leaderboards update in real-time via WebSocket — scores appear within seconds of being submitted.

{Image of the Leaderboard page showing game score cards in a grid}

---

## 7. Rankings

Navigate to **Rankings** in the sidebar to set up cross-tournament player rankings.

Rankings let you aggregate scores across multiple tournaments into a single overall leaderboard. This is useful for determining an overall champion across different tournament types.

### Creating a Ranking Group

1. Click **Create Ranking Group**
2. Enter a **Name** and optional **Description**
3. Choose a **Ranking Method**:

| Method | How It Works |
|--------|-------------|
| **Max 10** | Awards points to top 10 (100, 80, 65, 50, 40, 30, 20, 15, 10, 5). Sum of best N games |
| **Average Rank** | Average finishing position across all games. Lower is better |
| **Best Game (PAPA)** | Points: 100, 90, 85, 84, 83... Sum of best N games |
| **Best Game (Linear)** | Points: 100, 99, 98, 97... Sum of best N games |

4. Set **Best N Games** — Only the top N scores count toward the ranking (default: 25)
5. Set **Minimum Games** — Player must have played at least this many games to qualify (default: 1)
6. Select which **Tournaments** to include (check the boxes)
7. Click **Save**

{Image of the Create Ranking Group form}

### Managing Rankings

Each ranking group card shows:
- Current standings with rank, player name, points/average, and games played
- **Recompute** — Refresh the cached rankings
- **Edit** — Change settings or tournament selection
- **Delete** — Remove the ranking group

{Image of a ranking group card showing player standings}

---

## 8. Stats & Analytics

Navigate to **Stats** in the sidebar to browse player and game statistics.

### Player List

A table of all players with their total games played, best score, and average score. Click any player name to view their detail page.

### Player Detail

Shows four stat cards:
- **Games Played** — Total number of games
- **Wins** — Number of first-place finishes
- **Win Rate** — Percentage of games won
- **Best Score** — Highest score achieved

Plus their best game, and a list of recent scores.

### Game Lookup

Use the search box to look up any game by name. The game detail view shows:
- **Times Played** — How many tournaments featured this game
- **All-Time High** — Highest score ever recorded
- **Record Holder** — Player with the all-time high
- **Average Score** — Mean score across all plays

{Image of the Stats page showing player list and game lookup}

---

## 9. Game History

Navigate to **History** in the sidebar to view completed games.

The history table shows every completed game with its tournament, winner, winning score, and completion date. Use the filters at the top to narrow by tournament or type.

Results are paginated at 20 per page.

{Image of the History page showing completed games table with filters}

---

## 10. Discord Bot Commands

Your players interact with Arcaid primarily through Discord slash commands. Here's what each command does and when to use it.

### Player Commands

These commands are available to all members in your Discord server.

| Command | What It Does | When to Use |
|---------|-------------|-------------|
| `/list-active` | Shows all currently active games across your tournaments | Check what games are currently running |
| `/list-scores` | Shows the leaderboard for active games. Optional `@user` filter and pagination | See who's winning the current round |
| `/submit-score` | Submit a score with a photo to iScored. Auto-links Discord account to iScored username on first use | After playing a game, submit your score |
| `/view-stats` | Look up historical stats for any game (with autocomplete) | See all-time records for a specific game |
| `/my-stats` | Personal stats card: wins, win rate, average score, best score, recent games | Check your own performance |
| `/list-winners` | Hall of fame showing recent tournament winners | See who's been winning lately |
| `/view-selection` | Shows queued games and what's coming up next | See what games are in the lineup |
| `/pick-game` | When nominated as picker, choose the next game from eligible options | It's your turn to pick! |
| `/map-user` | Link your Discord account to your iScored username | First-time setup or username change |
| `/create-backup` | Triggers a database backup | Before major changes |
| `/sync-state` | Reconciles Arcaid's database with live iScored data | If scores seem out of sync |

### Admin Commands

These commands require the Discord Admin Role configured in your room settings.

| Command | What It Does | When to Use |
|---------|-------------|-------------|
| `/force-maintenance` | Manually triggers a full tournament rotation cycle: lock current game → scrape scores → pick winner → activate next game → announce | Force a rotation outside the schedule |
| `/activate-game` | Immediately activate a specific game for a tournament | Start a specific game right now |
| `/deactivate-game` | Deactivate an active game, optionally locking it on iScored | End a game early |
| `/run-cleanup` | Delete completed/orphan games from iScored per your cleanup rules | Clean up old games from iScored |
| `/pause-pick` | Inject a specific game into the tournament queue | Queue up a specific game to play next |
| `/nominate-picker` | Manually assign picker rights to a user | Override the automatic picker selection |
| `/reorder-lineup` | Reorder queued games in a tournament's iScored lineup | Rearrange the upcoming game order |
| `/setup` | Configure Discord channels, roles, and pick windows | Initial bot setup or reconfiguration |

---

## 11. Public Pages

Your game room has several public pages that anyone can visit — no login required. Share these with your community.

| Page | URL | What It Shows |
|------|-----|-------------|
| **Scoreboard** | `arcaid.app/your_slug/` | Live leaderboards for all active games and ranking groups |
| **Player List** | `arcaid.app/your_slug/players` | All players with stats, clickable for detail |
| **Player Detail** | `arcaid.app/your_slug/players/Name` | Individual player stats, win rate, history |
| **Game Detail** | `arcaid.app/your_slug/games/GameName` | Game-specific stats, records, rating |
| **Game Availability** | `arcaid.app/your_slug/games` | Which games are available vs. on cooldown, with a random picker |

The **Game Availability** page is particularly useful for players who need to pick the next game — it shows which games are eligible (past the cooldown period) and includes a fun pinball-themed random picker.

{Image of the public scoreboard page}

{Image of the Game Availability page showing available and cooldown games}

---

## Quick Reference: Setup Checklist

Use this checklist when setting up a new room from scratch:

- [ ] Log in with provided credentials
- [ ] **Settings → Game Room**: Set your room name and slug
- [ ] **Settings → Discord**: Enter Guild ID, announcement channel, and admin role
- [ ] **Settings → iScored**: Enter iScored credentials and public URL
- [ ] **Settings → Tournament Defaults**: Set cooldown, pick windows, and timezone
- [ ] **Settings → Theme**: Choose your preferred theme
- [ ] **Settings → Platforms**: Add your gaming platforms (e.g., AtGames, VPXS)
- [ ] **Game Library**: Import games (VPS, VPXS Wizard, or CSV)
- [ ] **Tournaments**: Create your first tournament with schedule
- [ ] **Settings → User Management**: Invite additional admins if needed
- [ ] Share the public scoreboard URL with your community
- [ ] Test: Run `/list-active` in Discord to verify bot connectivity

---

*For technical support, contact your Arcaid administrator.*
