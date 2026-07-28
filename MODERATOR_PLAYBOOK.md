# Arcaid Moderator Playbook

Quick reference for whatever comes up during a tournament week. Skim **Where the tools live** first, then jump to the scenario you're dealing with. Thanks for being here, by the way; the playbook is the long-form reference, but the day-to-day is in `MODERATOR_QUICKSTART.md`.

---

## A few habits worth keeping

These three save us both a lot of headache:

1. **Log it.** When you fix something, a quick note in `#mod-log` (what happened, who was involved, what you did) is gold. The Activity page captures the action, but your context is what makes it useful later.
2. **Screenshot first.** Before deleting anything or changing a status, a quick screenshot saves the before-state in case something goes sideways.
3. **Don't cascade.** Fix the one thing the user reported. Cleaning up adjacent stuff at the same time tends to turn one ticket into three, so leave it alone unless the user (or another mod) confirms it's broken too.

---

## Where the tools live

From the room admin sidebar (left side, or hamburger on mobile):

| I need to... | Go to |
|---|---|
| See all games + force status changes | **Game States** (wrench icon) |
| Activate / deactivate a game directly | **Game Library** → row → **Activate** |
| Edit a tournament's settings | **Tournaments** |
| Merge two users / reassign an anon score | **Identity** |
| Delete or moderate a specific score | **Leaderboard** (or game detail on public side) |
| Handle lobby announcements / shelf / pinned | **Lobby** |
| Review what admins did recently | **Activity** |
| Force maintenance on a stuck tournament | **Game States** → **Force Maintenance** |

---

## Score fixes

### User typo'd their score value

> "I submitted 1,200,000 but meant 12,000,000."

1. Open **Leaderboard** in admin, find the game card, click **Scores**.
2. Every submission has a photo attached (it's required at submit time), so pull it up. The photo is your source of truth.
3. If the photo backs up what the player is now claiming, delete the bad row and ask them to resubmit. If the photo matches what they originally submitted, the original was right and a gentle pushback is all that's needed.
4. Drop a note in `#mod-log`: user, game, old → new, reason.

### User submitted to the wrong game

> "I played Medieval Madness but picked Attack from Mars in the submit form."

Same flow as above. The photo on the submission usually makes it obvious which game it actually was. Delete the bad row, have them resubmit to the correct game.

### Score photo clearly disagrees with the submitted value

1. DM the user to ask what happened.
2. If they admit the typo, delete the bad row and have them resubmit.
3. If they double down but the photo clearly disagrees, delete it, drop a note in `#mod-log`, and flag it to me if it's a repeat offender.

### Duplicate submission

Delete the later of the two duplicates. Leave the original.

### Submission landed right at a cadence boundary

Engine assigns by server timestamp at submit time. Don't override — explain to the user that boundary submissions go by clock, not intent.

### User wants their own score removed

If they're Discord-authenticated, they can delete it themselves from the game detail page. If they're anonymous or the option is missing, delete it for them.

### Impossibly high score / cheat suspicion

The submission photo is already there (it's required), but for impossibly high scores a static photo isn't always enough.

1. Screenshot everything before changing anything, just so we have the before-state.
2. DM the user asking for video evidence of the run.
3. If they can't produce it, delete the row and ban via **Identity → Ban User**.
4. If they can, leave the row in place and apologize for the flag.

---

## Identity & merges

The test room defaults to **Require Discord Login**, but anon submissions may still exist from specific flows (e.g. name-claim before a Discord link). Anon identities appear with a display name chosen by the user — if that name collides with someone else's, it's auto-suffixed ("SkillShot" → "SkillShot2").

All identity work happens on the **Identity** page.

### Anon user claims their score after logging in with Discord

> "I submitted as 'ChromeDome' earlier, then logged into Discord. Can you link them?"

1. Go to **Identity**.
2. Find the anon identity by its display name.
3. Find their Discord identity.
4. Run the merge — anon (source) → Discord (target).
5. Submissions, history, comments, ratings, memberships all move over. Leaderboards refresh on next view.

### Two Discord identities need merging

Same flow. Pick the older / lower-activity account as source, newer / higher-activity as target.

### Name collision complaint

> "Why does it say SkillShot2? I am THE SkillShot."

First claimer keeps the bare name — that's the rule. The newcomer can choose a different display name on **Identity** (per-room display name override).

### Discord nickname is stale on the scoreboard

Nickname refreshes on the user's next submission or re-auth. If it's urgent, ask them to log out and log back in.

### Full user-data removal request

This one is gnarly enough that it's worth bringing to me directly. It touches multiple tables and isn't a one-click operation, so just send the request my way and I'll take it from there.

---

## Picks & queue

### Winner didn't pick in time

Expected behavior. The engine gives runner-up a window, then auto-picks if that lapses. Not an incident — let it run.

### Winner picks a game on cooldown

Pick is rejected with "not eligible." Options:
- Tell the user to pick something else (usually the right call).
- Or: **Tournaments** → edit → lower `eligibility_days` (affects everyone).
- Or: manually activate a game via **Game Library → Activate**, forfeiting the pick flow.

### Winner picks a wrong-platform game

Same rejection, same options as above.

### Winner is AFK / on vacation

1. **Game States** → find the `[Pending Pick]` row for that tournament.
2. Click **Clear Picker** to cancel the timeout.
3. Either manually activate a game for them, or designate a different picker manually.

### User queued 5 games and hit the limit

Expected. They can reorder/remove their own queued games from the public **Picks** page. Mods don't intervene.

### User left the server with queued games

Stale entries auto-drop at next activation (cooldown revalidation). If one is blocking a tournament, delete it from **Game States**.

---

## Tournament lifecycle

### Current game needs to end early

> "This pick is broken / nobody wants to play it."

1. **Game States** → find the ACTIVE row → change status to **COMPLETED**.
2. Wait for next cron tick, or click **Force Maintenance** on Game States.
3. Normal winner/pick flow kicks in.

### Phantom `[Pending Pick]` won't resolve

**Game States** → find the row → **Delete**. Leave "Delete from iScored" unchecked — these rows have no iScored ID.

### Duplicate ACTIVE games in a single-slot tournament

**Game States** → complete whichever one shouldn't be there (usually the newer, empty one).

### Tournament needs to pause

**Tournaments** → edit → toggle `is_active` off. Re-enable when ready. Active games persist; maintenance won't run while paused.

### Tournament feels stuck

**Game States** → **Force Maintenance**. Runs the same logic cron runs, just right now.

---

## Library & metadata

### Game isn't in the room library

1. **Game Library** → search the master list (or switch to the global catalogue view).
2. Add to room library.
3. User can now pick it.

Not in the global catalogue either? Escalate to Justin — that's a catalogue import.

### Game's platform tags are wrong

**Game Library** → row → **Edit** → fix platforms → save.

### Scoreboard card looks plain

**Game Library** → row → **Style** → apply a style from the catalogue. No suitable style? Upload one via **Style Catalogue**.

### Game name is too long for the scoreboard

**Game Library** → row → **Edit** → set a shorter display name. Library name stays for search; only the card updates.

---

## iScored sync

### Score on iScored but not on Arcaid

Usually polling lag. Give it the poll interval + 30 seconds. Still missing?

1. **Game States** → game → **Sync iScored** → confirm the iScored ID.
2. If it looks right, escalate to Justin — likely a poller issue.

### Game wasn't locked when tournament ended

**Game States** → game → **Sync iScored** → **Lock**.

### iScored game wasn't created for a new ACTIVE entry

**Game States** → game → **Sync iScored** → **Create**. Wait for the round-trip; the iScored ID populates when it's done.

---

## Community moderation

### Toxic / inappropriate comment

Game detail page (public side) → find the comment → delete.

### Inappropriate community score photo

Delete the community score entry. Note the reason in `#mod-log`.

### Score report filed

**Leaderboard** or game detail → **Reports** section. Review the reported score + photo → accept (removes score) or reject (dismisses report, notifies reporter).

### Banned user keeps trying to submit

**Identity** → search user → **Ban**. Their Discord ID is blocked from submitting.

### Bad announcement posted

**Lobby** → Announcements → edit or delete.

### Dead / embarrassing shelf link

**Lobby** → Shelf → remove the item.

---

## Send these my way

These are mine to deal with. Just ping me directly and I'll take it from there:

- Backup / restore operations
- Direct database edits
- Rate limit tuning
- iScored credential or webhook issues
- Full user-data removal (GDPR-style)
- Per-score iScored push (no mod UI exists for this yet)
- Anything that feels like a bug, not a user incident

---

## End-of-day

If you have a minute at the end of your shift, a one-paragraph summary in `#mod-log` (how many incidents, categories, anything that felt rough) is hugely valuable. That summary is what turns this week from "a test" into useful product findings, and honestly it's the part of the test I care about most. Thanks for putting the time in.
