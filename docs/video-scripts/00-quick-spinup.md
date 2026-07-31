# Arcaid Tour: Features + Admin Portal (~9 minutes)

Two-part video. **Part 1** is the *what* — what Arcaid does, from a player's seat and an admin's. **Part 2** is the *where* — what each section of the admin portal is for. Deep-dive videos for each admin section live in the playlist.

Format: beat sheet, not teleprompter. Key lines are quoted; everything else is direction or talking points. Target length: ~9 minutes. The showcase carries the first 5 minutes; the admin tour is the back half.

## Pre-record checklist

- Logged out of Discord on the recording browser, so the OAuth flow plays out on camera.
- Two tabs ready: a live room's **public scoreboard** (Part 1) and the **admin portal** (Part 2).
- A second window with a Discord channel open + your own DMs visible for the notifications beat.
- Pick a real game ahead of time that has: multi-platform scores, multi-score history on at least one player, a download link and a tutorial. Part 1 dies without a real story to point at.
- Sidebar visible on the admin tab.
- Quiet room, mic check, screen at 1080p minimum.

---

## Section 1. Cold open (0:00 – 0:30)

**On screen:** the public scoreboard of a live room. If a score toast fires while you're talking, even better.

**Tone:** confident. "Here's the thing."

**Key line:** "Arcaid is a tournament platform for pinball and retro arcade rooms. Players see a live scoreboard, admins run rotations and schedules, and Discord and iScored plug in if you want them. This video is two parts — what it does, then where to find the levers. About nine minutes."

**Beats:**
- Two audiences: players who'll be looking at the scoreboard, admins who'll be running the room. Both halves are worth your time even if you only do one of those jobs.
- Part 1 is the showcase. Part 2 is the admin portal walkthrough.

---

## Section 2. What players see (0:30 – 2:00)

**On screen:** the public scoreboard. Pause on it long enough for viewers to register what they're looking at, then click into a single game's detail page.

**Key line:** "Everything a player needs lives at one URL — the room's scoreboard. No login required to watch, no app to install. Although they *can* install it — it's a PWA, so it pins to a phone home screen like a native app."

**Beats:**
- Scoreboard updates live. New score lands, toast slides down, card re-sorts.
- Three card style families (Banner, Showcase, Minimal) across eleven themes — admins pick what fits the room's vibe.
- Tabs split **Tournaments** from **All Games**; platform filter chips narrow it to "what's playable on my setup."
- Click any game card title → game detail page.

**On screen:** game detail page on a game with rich metadata + multi-score history.

**Key line:** "This is where the depth shows up. The catalogue isn't just a list of names — it ships with downloads, tutorials, rule sheets, manufacturer, year, designers, the whole thing."

**Beats:**
- **Downloads** — direct links to table files where the importer has them (VPX, FX, etc.).
- **Tutorials** — embedded YouTube videos when available.
- **Rule sheets** and **IPDB** links for the pinball nerds.
- **Score history per player** — expand a row to see every score they've posted on this game, with a sparkline. Switch between **This tournament** and **All time**.
- **Platform tab strip** — flip between VPX scores, real-cab scores, AtGames scores side by side. Same game, separate leaderboards per platform.
- **Comments and tips** — players leave notes for whoever picks it next.
- **Star ratings** roll up so the catalogue tells you what's worth picking.

---

## Section 3. What players do (2:00 – 4:00)

**On screen:** click **Submit score** on a game card. Show the sheet — platform picker, score field, optional photo.

**Key line:** "Submitting a score is two clicks. Pick the platform, enter the number, optional photo. Anonymous if the room allows it, Discord-linked if not."

**Beats:**
- Anonymous submissions stay scoped to that one room. Discord-linked submissions also roll up to the **global scoreboard** across every Arcaid room.
- **First-claim-wins display names** — pick a handle, it's yours in this room until you release it. Auto-suffix on collision.
- If you start anonymous and later log in with Discord, the **identity merge** tool grafts your old scores onto your real profile. No lost history.

**On screen:** open the Picks page. Show pending picks, the queue list, and the Mystery Award button.

**Key line:** "When you win a tournament round, you pick the next game. You can also queue up to five picks ahead so you never miss your turn — and if you want the system to surprise you, you can Spin the Mystery Award."

**Beats:**
- **Pick a game** from the eligible list — cooldowns and platform rules already filtered the bad options out.
- **Queue up to five** picks in priority order. Reorder, delete, whatever. When your turn comes, the queue auto-fires the top entry.
- **Mystery Award** — the DMD-style spinner. Click to roll a random eligible game; the cabinet animation lands on the pick. The "random pick" path.
- All of this works from Discord too — same actions, different surface.

**On screen:** switch to Discord. Type `/submit-score` to show the autocomplete. Show your DMs with any past notification (turn-to-pick, tournament-win, etc.). Show a picker channel embed if you have one.

**Key line:** "Twenty-plus slash commands and five opt-in DM notifications. Opt into what you want with `/arcaid-notifications`, ignore the rest."

**Beats:**
- **Score submission from Discord** — `/submit-score`, photo attached, platform autofilled when there's only one.
- **Game picking from Discord** — `/pick-game` mirrors the web flow including queue behavior.
- **Personal stats and lookups** — `/my-stats`, `/list-scores`, `/list-active`, `/list-winners`, `/view-stats`, `/view-selection`.
- **DM notifications**, all opt-in and rate-limited: tournament win, your turn to pick, tournament starting, your rank got dethroned, a friend posted a score.
- **Channel embeds** for picker prompts and announcements are color-coded by cadence — daily gold, weekly blue, monthly purple, custom green.

---

## Section 4. Behind the scenes (4:00 – 5:00)

**On screen:** quick cut to the Catalogue page, then to the iScored panel in Room Settings.

**Key line:** "Two integrations do most of the heavy lifting: iScored and the global game catalogue."

**Beats:**
- **iScored, bidirectional.** If your room already runs iScored, Arcaid reads scores in continuously and writes web and Discord submissions back to it. Notification-gated polling means tens of API calls a day, not hundreds of thousands — friendly to iScored, fast for you.
- **Smart catalogue dedup.** The same pinball table pulled in from VPS, OPDB, and IPDB collapses into one record, not three. Per-room **game tags** let you say "this room also runs WHO dunnit on AtGames" without polluting the global record everyone else sees.
- **Multi-alias identity.** One Discord user can hold many iScored names — handy when players have a console handle, a VPX handle, and a real-cab handle. The leaderboard collapses them to one row per game.
- **Deletes that stick.** Remove a bad score from the leaderboard and Arcaid writes a tombstone so the iScored poller doesn't re-import it on the next cycle.

---

## Section 5. The admin portal — log in + dashboard (5:00 – 5:30)

**On screen:** click **Log in with Discord** → authorize → land on Dashboard.

**Key line:** "One click with Discord. If it doesn't let you in, you're not on the admin list yet — ping whoever invited you. Otherwise this is where you land every time."

**Beats:**
- Dashboard is read-only — room vitals at a glance: system status, active tournaments, recent winners.
- Setup checklist at the top: ignore unless something turns red.
- "Everything you actually *do* lives in the sidebar."

---

## Section 6. Sidebar tour (5:30 – 8:30)

**On screen:** sidebar visible. Hover each item briefly as you name it — half a second to a second so the label is readable. Don't click into anything.

**Tone:** quick. ~14 seconds per item. Resist the urge to expand.

**Opening line:** "Here's what each section is *for*, top to bottom. The how-to lives in the deep-dive video for each one, so I'm not clicking into anything here."

For each item — one line on what it does, one line on when you'd open it:

- **Tournaments.** "Schedules, platform rules, rotation knobs. Open this when you want to change *what's running or when*."
- **Game Library.** "The catalogue of every game this room knows about — variant tags, per-game style overlays, pin-to-scoreboard. Open this to activate new games or check whether something exists."
- **Game States.** "The rescue page. Stuck picks, phantom rows, Force Maintenance. Open it when something feels wedged."
- **Leaderboard.** "Where you fix bad scores — wipe a single row, wipe a player off a game entirely. The single most-used page for player-facing problems."
- **Rankings.** "Cross-tournament standings. Mostly read-only — open it when a player asks where they stack overall."
- **Stats.** "Per-player and per-game numbers. Sanity-check tool when complaints come in."
- **History.** "Archive of past rounds. Open it to look something up after the fact."
- **Lobby.** "Configures the public landing page — announcements, social links, the shelf, the live feed. Open it when you want to change what visitors see."
- **Style Catalogue.** "Visual styles for cards — logos, backgrounds, headers. Open it if you want to change how a game looks on the scoreboard."
- **Room Settings.** "Per-room knobs. iScored creds, Discord settings, auth toggles. Open sparingly — some toggles cascade."
- **Identity.** "Where you merge anonymous scores into a Discord account. Second most-used page for player-facing problems."
- **Activity.** "Audit log of everything that's happened. First stop when something feels off."
- **Help.** "In-app docs. If you forget where something is, start here."

**Wrap line:** "The two pages worth bookmarking are **Leaderboard** and **Identity**. Those two handle most of what players ping you about. Everything else, you'll find by feel."

---

## Section 7. Wrap (8:30 – 9:00)

**On screen:** back to Dashboard.

**Key line:** "That's the lay of the land. Each admin section has its own deep-dive video in the playlist — watch the ones you need, skip the rest. If I had to pick one to watch first, it'd be the deep-dive on **Leaderboard**."

**Beats:**
- Two written guides also exist: a quickstart for day-to-day moves, and a portal tour that mirrors what we just walked through.
- Default rule when something looks irreversible: stop and ping someone before you confirm.
- Thanks for stepping in to run the room.

**Final line:** "See you in `#mod-log`."

---

## Recording notes

- Pace is the whole game. Nine minutes only works if you keep moving — don't dwell on any one feature or any one sidebar item.
- The showcase half (Sections 2–4) is harder to land than the admin tour. Live data makes it sing — pick a real game with downloads, tutorials, and multi-score history *before* you start recording, and have it open in a tab.
- If you fluff a key line, just keep going. Whole-section retake is fine; mid-section retake looks choppy.
- For the Discord segment, have a real DM in your inbox to show. A screenshot is acceptable if you don't have a fresh one.
- Hover, don't click, during the sidebar tour. The moment you click into a section, this becomes a 15-minute video.
- Volume check at the start: loud enough at half volume on a phone.
- If anything looks broken on the live system mid-record, don't troubleshoot on camera — cut and re-roll that section against a screenshot.

## Cross-reference

- The longer 8-10 minute version with live demos lives at `VIDEO_TUTORIAL_SCRIPT.md` in the repo root. This refactored script now sits in the same length/scope zone — consider whether one of them should be retired or whether they target different audiences.
- `MODERATOR_QUICKSTART.md` is the day-to-day written reference.
- `ADMIN_PORTAL_TOUR.md` is the section-by-section written tour the sidebar walkthrough mirrors.
- Deep-dive scripts (one per sidebar section) will land in this folder — suggested naming: `01-tournaments.md`, `02-game-library.md`, etc.
- If you'd rather split this into separate videos for the two audiences (prospective adopters vs. new admins), suggested filenames: `00a-features-showcase.md` (~5 min, the Part 1 content) and `00b-admin-tour.md` (~5 min, the original Part 2 content padded back out).
