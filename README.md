# ArcAid

**ArcAid** is a modern, platform-agnostic tournament management system, the successor to TableFlipper. Designed to be server-independent and highly customizable.

> **Development Status:** Active overhaul in progress. See [OVERHAUL_PLAN.md](./OVERHAUL_PLAN.md) for the full plan and [SPRINT_STATUS.md](./SPRINT_STATUS.md) for current progress. Currently on **Sprint 1 — Stabilize**.

## 🚀 Installation & Setup

### Docker Deployment (Recommended)
The easiest way to run ArcAid is using Docker.
1. Copy `.env.example` to `.env` and fill in your Discord credentials.
2. Run `docker-compose up -d --build`.
3. Access the Admin UI at `http://localhost:3001`.

### Manual Local Setup
#### 1. Discord Bot Configuration
Before running the app, you must set up a Discord bot:
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application (e.g., "ArcAid Beta").
3. **Bot Settings**:
   - Go to the **Bot** tab.
   - Enable **Privileged Gateway Intents**:
     - [x] Presence Intent
     - [x] Server Members Intent
     - [x] Message Content Intent
   - **Important**: Click the green **"Save Changes"** button at the bottom after enabling these.
4. **Permissions**:
   - Use the **OAuth2 -> URL Generator** to create an invite link.
   - Select the `bot` and `applications.commands` scopes.
   - Check the following permissions (see `assets/bot_permissions.png` for reference):
     - [x] View Channels
     - [x] Send Messages
     - [x] Create Public Threads
     - [x] Send Messages in Threads
     - [x] Embed Links
     - [x] Attach Files
     - [x] Read Message History
     - [x] Use External Emojis
     - [x] Add Reactions
     - [x] Use Slash Commands
5. Copy the generated URL and invite the bot to your server.

### 2. Environment Setup
1. Copy `.env.example` to a new file named `.env`.
2. Fill in your `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID`.
3. Configure your iScored credentials in the same file.

### 3. Application Start
1. Install dependencies: `npm install`
2. Start the application: `npm start`

## 🛠 Features
- Generic "Games" and "Tournaments" engine with "Pinball Legacy" mode.
- Playwright-powered iScored automation.
- **Managed vs. Manual Protection**: Automatically protects your personal iScored games from bot interference while still tracking their scores.
- **Discovery Mode**: Automatically syncs and tracks manual games into the local database for historical stats.
- Local React-based Admin Dashboard.
- Automated database backups and snapshots.

## 🕹️ Discord Commands

### User Commands
- `/list-active`: Show currently active tournament and manual games.
- `/list-scores`: Display the leaderboard for recent games.
- `/submit-score`: Post your score and photo directly to iScored.
- `/view-stats`: Show historical stats (play count, high scores) for any game.
- `/list-winners`: Display a hall of fame for recent tournament winners.
- `/view-selection`: Check which game is currently queued for the next rotation.
- `/pick-game`: Nominated pickers can select the next game in the rotation.
- `/map-user`: Link your Discord ID to your iScored username.

### Admin Commands
- `/force-maintenance`: Manually trigger a tournament rotation.
- `/sync-state`: Reconcile local database with live iScored board and sync scores.
- `/run-cleanup`: Sweep and hide old finished tournament games from iScored.
- `/create-backup`: Manually trigger a database backup.
- `/pause-pick`: Inject a specific game into the queue (Manual Override).
- `/nominate-picker`: Manually assign picker rights to a user.
- `/setup`: Configure tournament channels and roles.
