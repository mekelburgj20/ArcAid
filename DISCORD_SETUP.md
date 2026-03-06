# Discord Bot Setup Guide (ArcAid Beta)

To ensure your new bot functions correctly, follow these steps in the [Discord Developer Portal](https://discord.com/developers/applications):

## 1. OAuth2 Configuration
Go to the **OAuth2** -> **URL Generator** tab and select:
- **Scopes**: 
    - [x] `bot`
    - [x] `applications.commands`

- **Bot Permissions**:
    - [x] `Send Messages`
    - [x] `Create Public Threads` (Optional, for tournament discussions)
    - [x] `Send Messages in Threads`
    - [x] `Embed Links`
    - [x] `Attach Files`
    - [x] `Read Message History`
    - [x] `Use External Emojis`
    - [x] `Add Reactions`

## 2. Bot Settings (Intents)
Go to the **Bot** tab and scroll down to **Privileged Gateway Intents**. Enable:
- [x] **Presence Intent** (Optional, if tracking player status)
- [x] **Server Members Intent** (Optional, for role management)
- [x] **Message Content Intent** (Required for processing commands/messages)

## 3. Interaction Logic
The ArcAid app uses **Slash Commands** as the primary interface. Ensure you have your `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID` ready for your `.env` file to deploy these commands to your test server.
