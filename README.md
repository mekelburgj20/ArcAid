# ArcAid

**ArcAid** is a modern, platform-agnostic tournament management system, the successor to TableFlipper. Designed to be server-independent and highly customizable.

## 🚀 Installation & Setup

### 1. Discord Bot Configuration
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
- Local React-based Admin Dashboard.
- Automated database backups and snapshots.
