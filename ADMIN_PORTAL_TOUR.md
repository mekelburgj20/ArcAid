# Arcaid Admin Portal Tour

A walk through every section in the room admin sidebar so you know what's behind each link before you need it. None of this is a procedure to follow. It's a map.

The sidebar is grouped by purpose. Items inside a group relate to each other. The horizontal lines between groups are visual separators only.

For the test week, this is your room. Anything in this sidebar is yours to use, and the more you wander the better, since the point of the week is finding the rough edges. Thanks again for spending the time on this.

## Top: where you are

The sidebar header shows the room name and the words "Room Admin." If you see "Super Admin" instead, you're in the wrong place. Use the URL I gave you.

---

## Group 1: Overview

### Dashboard

The home page. It shows three things: a setup checklist (mostly already complete for the test room, ignore unless something is red), a system status bar that tells you whether the bot is online, and a list of currently active tournaments with their current game, the current leader, and a countdown to the next rotation. Below that is a recent winners feed.

Read-only overview of the room's pulse. If the bot is green and there are tournaments running, the room is healthy.

---

## Group 2: Setup and structure

### Tournaments

The list of tournaments configured for the room. Each row is a tournament with its schedule (cadence), platform rules, and current active games.

All of this is editable. Schedules, platform rules, max active games, cleanup rules, the rotation knobs. Editing them mid-week is one of the more interesting things you can do, because changing schedule or platform rules can interact with games already in flight in surprising ways. If you change something, a one-liner in `#mod-log` is hugely helpful so I can see what happened next.

Each tournament also lists its current ACTIVE games with **Deactivate** and **Delete** buttons. Both work. Deactivate ends the round cleanly (final score sync, lock on iScored, mark complete). Delete is the destructive variant for "wrong game in wrong tournament" (orphans the local scores, removes the iScored entry). Try them on a test game if you want to see them in action.

### Game Library

The catalogue of games available in this room. Search, filter by platform, see which games have been pulled in from the global catalogue. Each row has buttons: **Activate** (puts the game live in a tournament), **Style** (sets the visual look of the card), **Edit** (display name, custom platforms), and a tag dialog for room-specific platform tags.

You used this page during seeding to activate the starting games. Activate more during the week if you want to see how it interacts with the running tournament. The whole point is to see what happens.

If a player asks for a game that isn't in the room library, you can add it from the global catalogue view. If it's not in the global catalogue either, that's a catalogue import and you'll want to ping me.

### Game States

The truth-table view of every game in the room across every status: ACTIVE, QUEUED, COMPLETED, HIDDEN. Filter buttons at the top let you narrow the list. Each row shows the game, the tournament it belongs to, its iScored ID, who the picker is (if any), and a set of action buttons.

This is the rescue page. If a tournament looks stuck, the stuck row is here. **Clear Picker** cancels a hanging pick timeout. **Delete** removes a phantom `[Pending Pick]` row. **Force Maintenance** triggers the full maintenance cycle (lock, scrape, rotate) on demand and is interesting to watch even when nothing is wrong.

The **Sync iScored** action is for repairing a mismatch between Arcaid's view and iScored's view. It exposes Lock, Unlock, Create, and Delete on the iScored side. Try them on a test game if you're curious. The iScored side is where unexpected things happen, so any weirdness is worth writing down.

---

## Group 3: Reading the room

### Leaderboard

The admin view of every game's leaderboard, rendered the same way the public scoreboard renders it. Each card has hover actions: edit display name, set notes, change card style, **manage scores** (the per-row delete tool you'll use most often), and delete the whole leaderboard.

This is your primary tool for the "user typo'd a score" scenario. Click **Scores** on the affected game's card, find the bad row, delete it. The page also lets you delete a game's whole leaderboard, which is heavier but available.

### Rankings

Cross-tournament standings. Arcaid lets you group tournaments together (for example, "all weekly tournaments combined") and produce an aggregate ranking. The page shows those groups and who's leading each.

Mostly read-only. There's a **Recompute** button per group; it's a diagnostic escape hatch and shouldn't usually be needed, but pressing it won't hurt anything.

### Stats

Per-player and per-game analytics. Click a player to see their lifetime numbers, their best game, their recent submissions. Click into a game to see times played, average score, all-time high.

Useful for sanity-checking a complaint. If a player says "I always score around 5 million" and their stats show their average is 800 thousand, that's a clue.

### History

Past tournament rounds and their winners. A scrollable archive of "what was active when, and who won."

Reference, not an action surface. Worth glancing at to confirm rotations look reasonable.

---

## Group 4: Presentation and configuration

### Lobby

The lobby is the public landing page for the room. This admin page configures it: announcements (what scrolls at the top), social links (Discord, YouTube, Twitch, etc.), pinned message, the shelf (curated links and embeds), and feed settings (which event types appear in the live feed, how long until something is "stale").

If you want to test how an announcement renders, post one. Just label it as a test in the body so real players don't get confused. Same goes for shelf items and pinned messages, all editable.

### Style Catalogue

The visual styles used to render scoreboard cards. Each style is a logo plus a background image plus some metadata. Styles are global (shared across rooms) but applied per-game from the **Game Library** or **Leaderboard** pages.

Try changing a card's style if you're curious how the renderer handles different image sizes and color combos. Anything that looks squashed, cropped weird, or unreadable is worth a screenshot.

### Room Settings

Per-room configuration. Auth toggles (`REQUIRE_DISCORD_LOGIN`, etc.), Discord integration settings (guild ID, admin role, announcement channel), iScored credentials with a **Validate Credentials** button, theme picker, and the lists of local admins, Discord admins, and pending invites.

Everything here is editable. Two things are worth flagging:

- The **Validate Credentials** button on the iScored card is a quick sanity check if scores stop syncing. It does a real Playwright login and tells you if the creds work.
- Toggling **REQUIRE_DISCORD_LOGIN** has cascade effects on existing anon identities (an orphan-handling routine kicks in when it flips on). That's a thing I'd love to see exercised; if you do flip it, a quick heads-up before and after would let me watch what happens on the backend side.

---

## Group 5: People and audit

### Identity

Where you handle merges between anonymous players and Discord accounts, and where you can reverse a merge if something went wrong. Two main sections:

- **Pending Claims**: anonymous identities that have submitted scores in this room. Arcaid suggests a Discord match when it can; otherwise you can paste a Discord ID and merge manually. Every merge runs a preview first so you can see exactly what moves and what stays.
- **Audit Chain**: every merge that's been done, with a **Reverse** button if you need to undo one.

There's also a **Rename Player** tool at the top for cases where a name needs to change.

You'll use this any time a player asks "can you link my old guest scores to my account." It's also one of the more interesting flows to stress-test, because the merge model is newish and edge cases are likely.

### Activity

A timeline of what's been happening in the room: score submissions, game rotations, tournament completions, settings changes, admin logins. Filterable by event type. Read-only.

This is your first stop when something feels off. If a tournament rotated unexpectedly, this is where you see when and why. If you think someone changed a setting they shouldn't have, this shows admin logins and settings_change events. Also useful right after you trigger something deliberately (like Force Maintenance) to confirm what the system thinks just happened.

### Help

The in-app version of the docs. Has a table of contents covering Dashboard, Settings, Library, Tournaments, Leaderboard, Rankings, Stats, History, Discord Commands, Public Pages, Style Catalogue, Game States, and the Setup Checklist. Useful when you're in the middle of something and want a refresher without leaving the portal.

---

## Logout

Bottom of the sidebar, under your username. Logs you out of admin only. Doesn't disconnect Discord.

---

## Pages you won't see in this sidebar

These exist but are super-admin only and don't appear in the room admin nav:

- **Backups**
- **Logs**
- **Setup Wizard**
- **Catalogue Approval**
- **Global Settings**
- **Game Room Manager**

If you bookmark a URL with `/admin/` in it (no room slug), you'll bounce to login or a page you don't have access to. That's expected.

---

## Where most of the action is

Two buttons handle the bulk of what real players will ping you about:

1. **Scores** on a game card in the **Leaderboard** page (delete a bad row).
2. **Preview Merge** in the **Identity** page (link an anon to a Discord account).

If you're comfortable with those two, you'll handle most of what players ask for. The rest of the portal is yours to wander through, and honestly the more wandering the better. Thanks for putting in the time on this; the test is genuinely more useful with you in it than without.
