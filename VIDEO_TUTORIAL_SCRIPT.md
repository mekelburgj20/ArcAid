# Video Tutorial Script and Notes

Companion to `MODERATOR_QUICKSTART.md` and `ADMIN_PORTAL_TOUR.md`. This is a beat sheet, not a teleprompter. Key lines are quoted; everything else is direction or talking points. Target length: 8 to 10 minutes total. Two takes if you fluff a section is fine, no editing needed.

## Pre-record checklist

- Test room admin URL ready in a tab.
- Logged out of Discord on the recording browser, so the Discord login flow plays out on camera.
- A real player account ready in a second tab to demo the "delete a bad score" flow without faking data on prod.
- An anon submission ready under a throwaway name in case you want to demo the merge live.
- Quiet room, mic check, screen at 1080p minimum.
- Both written guides open in a separate window for reference.

---

## Section 1. Cold open (0:00 to 0:45)

**On screen:** the admin portal login page.

**Tone:** casual, talking to a friend.

**Key line:** "Hey, if you're watching this, you're helping me run the ArcAid test next week, and honestly thank you. I know you're busy, so I really appreciate you putting time into this. This video is the on-ramp."

**Beats:**
- Frame the test: the most useful thing you can do is use the tool, try things, and let me know what felt off. The point of this week is finding the rough edges before more people show up.
- This video walks you through the click paths so you have a starting point. After that, the room is yours.
- Two written guides exist: a quick start (day-to-day) and a portal tour (what every section is for). Both are short.

---

## Section 2. Logging in (0:45 to 1:15)

**On screen:** Click **Log in with Discord**. Authorize the app. Land on the Dashboard.

**Key line:** "If this didn't work, you're not added as an admin yet. Ping me. Otherwise, you're in."

**Beats:**
- One click, Discord OAuth, done.
- You'll land on the Dashboard, which is what we'll look at next.

---

## Section 3. Dashboard tour (1:15 to 2:00)

**On screen:** Dashboard. Hover the system status card. Scroll to active tournaments. Scroll to recent winners.

**Key line:** "This is the home page. Bot status, what's running, who just won. If those three look healthy, the room is healthy."

**Beats:**
- Setup checklist at the top: ignore unless something is red.
- System status: green dot is good.
- Active tournaments: each one shows current game, leader, countdown.
- Recent winners: feed of who just won what.
- This page is read-only. From here, the rest of the sidebar is where the action is.

---

## Section 4. Sidebar walkthrough (2:00 to 4:00)

**On screen:** sidebar visible. Hover each item briefly without clicking, except where noted.

**Key line:** "Quick tour of what's behind each link. Don't take notes, the portal tour doc covers this in writing."

**Beats, in sidebar order:**

- **Tournaments.** "List of tournaments. All settings here are editable. Schedules, platform rules, rotation knobs. Change them and see what happens."
- **Game Library.** "The catalogue. You used this on seed night. Activate more games during the week if you want to see how it interacts with the running tournament."
- **Game States.** "The rescue page. Stuck picks, phantom rows, Force Maintenance. We'll come back to it."
- **Leaderboard.** (Click into it briefly.) "Where you fix bad scores. Single most useful page for player-facing stuff."
- **Rankings.** "Cross-tournament standings. Mostly read-only."
- **Stats.** "Per-player and per-game numbers. Useful for sanity-checking complaints."
- **History.** "Archive of past rounds."
- **Lobby.** "Configures the public landing page. Announcements, social links, shelf, feed settings. Post a test announcement if you want; just label it as a test."
- **Style Catalogue.** "Visual styles for cards. Try changing one if you're curious how the renderer behaves."
- **Room Settings.** "Per-room knobs. iScored creds, Discord settings, auth toggles. The Discord login requirement has cascade effects on existing anon identities, so ping me before you flip that one."
- **Identity.** "Where you merge anon scores into Discord accounts. Second most useful page for player-facing stuff."
- **Activity.** "Audit log of everything that's happened. First stop when something feels off, also useful right after you trigger something on purpose."
- **Help.** "In-app docs if you forget where something is."

**Wrap line:** "The two pages worth keeping in your back pocket are **Leaderboard** and **Identity**. Those handle most of what players ping you about. Everything else, treat as fair game."

---

## Section 5. Live demo: fix a bad score (4:00 to 5:30)

**On screen:** Leaderboard page. Find the test submission you set up in advance.

**Key line:** "By far the most common thing you'll do for a real player. Someone fat-fingered a score. Here's the whole flow."

**Beats:**
- Find the game card on the Leaderboard page.
- Hover over it, click **Scores**.
- Modal opens with all submissions for that game.
- Find the bad row, click the trash icon.
- Confirm the delete.
- Note the leaderboard refreshes automatically.

**Key line:** "Then it's a quick DM to the player, ask them to resubmit, and a one-liner in `#mod-log`. Thirty seconds end to end."

---

## Section 6. Live demo: merge an anon to a Discord account (5:30 to 7:00)

**On screen:** Identity page.

**Key line:** "Second most common ask. Someone played as a guest, signed in with Discord later, wants their old scores tied to their account."

**Beats:**
- Open Identity in the sidebar.
- Show the **Pending Claims** list.
- Point at a row. Note the suggested Discord match if there is one.
- Click **Preview Merge**.
- Show the preview modal: this many submissions move, this many stay frozen because they were inside a completed tournament.
- Click **Confirm**.
- Note the audit chain at the bottom now has a new entry, with a **Reverse** button if the merge was wrong.

**Key line:** "If the suggested match is wrong, or there isn't one, paste the Discord ID into the manual merge box. Same preview, same confirm. Try doing one with two test identities and then reversing it; that's a flow I'd love to see exercised."

---

## Section 7. The "stuck pick" rescue (7:00 to 8:00)

**On screen:** Game States page. Filter to ACTIVE.

**Key line:** "Third common scenario. Someone won, the bot DM'd them to pick the next game, they ghosted. Most of the time ArcAid handles this on its own; it gives the runner-up a window, then auto-picks. But if you want to nudge it, here's how."

**Beats:**
- Open Game States.
- Show the filter buttons at the top.
- Point out a `[Pending Pick]` row (use a screenshot if there isn't a real one).
- Hover the row, point at **Clear Picker**.
- Note: clearing the picker cancels the timeout. Auto-pick will run on the next maintenance tick.
- Or you can manually activate a game from **Game Library** to keep things moving.

**Key line:** "Same page has Force Maintenance, which triggers the full rotation cycle on demand. Worth pressing just to watch what shows up in Activity afterwards."

---

## Section 8. Things worth trying on purpose (8:00 to 9:00)

**On screen:** sidebar visible, no specific click.

**Key line:** "Quick list of things you'd never do at a real event but I'd love it if you tried this week, because that's the whole point."

**Beats:**
- Edit a tournament schedule to fire in two minutes; watch the rotation live.
- Manually activate a game while a tournament already has one active.
- Force Maintenance from Game States and see what shows up in Activity.
- Try the Sync iScored buttons (Lock, Unlock, Create, Delete) on a test game.
- Toggle the Discord login requirement in Room Settings. Ping me before and after; that one has cascade effects on existing anon identities and I want to watch.
- Run a merge between two test identities, then reverse it. Did everything come back?
- Post a test announcement in Lobby. Label it as a test.
- Change platform rules on a tournament mid-flight.
- Change a card's visual style and see how it renders at different sizes.

**Key line:** "If you find something that looks irreversible (you deleted something and nothing came back, the room is in a state you can't get out of), stop and ping me. Otherwise, keep going."

---

## Section 9. Logging and end-of-day (9:00 to 9:30)

**On screen:** flip to a Discord window with `#mod-log` open.

**Key line:** "Two small habits that help me a ton. If you fix something or try something, a one-liner in `#mod-log` is gold. At the end of your shift, even a one-line summary is gold."

**Beats:**
- The Activity page captures the action itself. Your notes capture the context: who, why, anything that felt rough.
- End-of-day summary: how many things happened, anything weird. Even an uneventful day is useful data; just say so.
- This is how breaks get turned into useful findings, and honestly the notes from this week are what shape what I build next.

---

## Section 10. Wrap (9:30 to 10:00)

**On screen:** back to dashboard.

**Key line:** "That's it. Two written guides for reference. The quickstart for day-to-day, the portal tour for 'what is this section even for.' Both are in the repo I'll send you."

**Beats:**
- You're not on call. Check in once or twice a day.
- Try a few of the "on purpose" experiments when you have ten minutes.
- Default for "should I ping Justin" is yes.
- Genuinely, thank you for doing this. The test is way more useful with you in it than without.

**Final line:** "Have fun. Break stuff. See you in `#mod-log`."

---

## Recording notes for later

- If you fluff a key line, just keep going. Whole-section retakes are fine; in-section retakes look choppy.
- Don't speed up. The audience is busy but they're also seeing this for the first time. Speed reads as nervousness.
- Where you reference a doc, hold the page on screen long enough that someone could pause and read the heading.
- If a demo doesn't work on the live system, cut to a screenshot rather than troubleshooting on camera. Note it in `TEST_KNOWN_ROUGH_EDGES.md` afterwards.
- Volume check at the start. Loud enough that someone watching at half volume on a phone can still hear you.

## Cross-reference

- `MODERATOR_QUICKSTART.md` is the day-to-day reference the video is built around.
- `ADMIN_PORTAL_TOUR.md` is the section-by-section written tour the sidebar walkthrough mirrors.
- `MODERATOR_PLAYBOOK.md` is the deep reference for everything the quickstart skips.
- `TEST_SEED_GUIDE.md` is the pre-test seeding guide; not covered by this video.
- `TEST_KNOWN_ROUGH_EDGES.md` is your private notes; don't show it on camera.
