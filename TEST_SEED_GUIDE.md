# ArcAid Test Run — Game Seeding Guide

Thanks so much for jumping on this. You're going to set up the test environment's tournament games to mirror what the real RTX community picks this week. After you're done seeding tonight, ArcAid takes over and runs the tournament on its own; the mod side is yours to dig into from there (see `MODERATOR_QUICKSTART.md` for what that looks like).

This takes about 5 to 10 minutes total, and you'll only use your web browser and Discord. No command line, no technical stuff.

---

## What you're doing

ArcAid runs **tournaments**. Each tournament needs one **active game** for players to compete on. Tonight we're setting the active game for each tournament to match what RTX picked.

You'll do this through the **ArcAid admin portal** in your browser.

---

## What you need before you start

From Justin:
- The **admin portal URL** for the test room
- The **list of tournaments you're assigned** and the **game to activate for each**
- Confirmation that your Discord account has been added as a test-room admin

On your end:
- A desktop browser (Chrome, Firefox, or Edge recommended). Mobile works but is cramped.
- You're signed into the **test Discord server** — not the real RTX server.

---

## Step 1 — Log in

1. Open the admin portal URL in your browser.
2. Click **Log in with Discord**.
3. Authorize the app when Discord prompts you.
4. You should land on the **room admin dashboard**.

If login fails or you don't see a dashboard, message Justin. You may not be added as an admin yet.

---

## Step 2 — Open the Game Library

In the left sidebar (or the hamburger menu on mobile), click **Game Library**.

You'll see a big table of games with a search/filter bar above it. Each row has action buttons on the right: **Activate**, **Style**, **Edit**.

> If you see a sidebar that says "Super Admin" at the top instead of the test room name, you're in the wrong place. Click the room name or navigate to the URL Justin gave you.

---

## Step 3 — Activate your game(s)

For each tournament + game pair Justin gave you, do this:

1. **Find the game.** Type the game name into the search/filter box above the library table. The list narrows as you type.
2. **Click the "Activate" button** on that game's row (right-most column).
3. A small dialog opens: **"Activate [game name] for which tournament?"**
4. **Click the button for your assigned tournament.** If you see multiple tournaments and aren't sure which, double-check Justin's list before clicking.
5. The button shows **"Activating…"** for a few seconds while ArcAid creates the game on iScored.
6. When the dialog closes, you're done with that one. Move on to the next.

Repeat for every tournament on your list.

---

## Step 4 — Verify it worked

There are three ways to confirm:

- **Admin Tournaments page** (sidebar → **Tournaments**) — the tournament should show the game you activated as its current active game.
- **Test Discord server** — a **"Now Active: [game name]"** embed should post automatically in that tournament's channel.
- **Public scoreboard** — open the public test-room URL in a new tab; the game should appear as the tournament's current card.

If all three look right, that tournament is done.

---

## Troubleshooting

**"Game does not meet this tournament's platform requirements"**
The game's platform tags don't match what the tournament allows (e.g., a VPX table being activated in a video-game tournament). Confirm you're activating the right game for the right tournament per Justin's list. If the list is correct, message Justin — he can adjust the tournament's platform rules.

**I can't find the game in the library**
It hasn't been added to the test room's library yet. Send me the exact game name and which tournament it's for; I'd rather handle library additions during seeding myself just to keep things consistent.

**I clicked Activate on the wrong tournament**
No problem. In the sidebar, go to **Game States** (wrench icon). Find the game you just activated in the list, change its status to **COMPLETED** (or click the delete/trash action on that row). Then go back to **Game Library** and repeat Step 3 with the correct tournament.

**The Activate button is missing on game rows**
You're probably on the super-admin global catalogue, not a room library. Make sure the sidebar header shows the test room's name. If it doesn't, navigate back to the URL Justin gave you.

**Discord didn't announce the activation**
The activation itself still worked — it's a Discord wiring issue. Note which tournament didn't announce and tell Justin so he can check the channel configuration.

**I got logged out / token expired**
Just log in again via Discord. Your activations so far are saved.

**Something else weird happened**
If you'd rather not poke at it during seeding, totally fine; just screenshot the error, note what tournament you were working on, and send both my way. Once seeding is done you can absolutely dig into stuff like this, but during seed night I'd rather just unblock you and keep things moving.

---

## When you're done

Send me a quick message that you've finished. Once everyone's seeds are in, I'll flip the tournament settings back to **auto-rotate mode** and we're rolling.

From there, two ways to spend the week, both welcome:

- **As a player.** Submit scores, react to Discord messages, use `/pick-game` when you win. Just be a normal community member.
- **As a mod.** The admin portal is yours to explore. The quickstart (`MODERATOR_QUICKSTART.md`) covers what to do when players ping you and what's worth poking at on purpose. Genuinely any feedback you can give me about how the tool feels to use is gold.

Thanks again, this whole test is way more useful with you in it.
