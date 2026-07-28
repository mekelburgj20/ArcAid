# Arcaid Moderator Quickstart

Thanks for jumping on this. This is the short version of what you'll be doing. For the full reference, see `MODERATOR_PLAYBOOK.md`. For an overview of the admin portal itself, see `ADMIN_PORTAL_TOUR.md`.

## The 30-second version

1. Log in at the admin URL I sent you with **Log in with Discord**.
2. You'll land on the **Dashboard**.
3. Poke around. Try things. Break stuff.
4. When something breaks, surprises you, or annoys you, write it down in `#mod-log`.
5. When players ping you for help, the fix is almost always one of the five things below.

That's it.

## What this test is really about

Arcaid runs the tournament on its own. It rotates games, polls iScored, asks the winner to pick the next one, picks for them if they don't, and announces everything in Discord. None of that needs a human and most of the time it'll just work.

Honestly, having you in here early is a real help. The feedback that comes from someone who actually runs pinball tournaments isn't something I can manufacture by clicking around myself, so anything you notice is gold. Use the tool the way you'd want it to work as a real mod and tell me what felt off, broke, surprised you, or made you want to throw your laptop. Even the small stuff.

Yes, including the "should I really click this" buttons. Especially those. Click them. Find out.

## Things players will ping you about

These are the scenarios that come up in normal use. The fix is short in every case.

### 1. Player typo'd their score, or picked the wrong game

Most common one. Submitted 1,200,000 instead of 12,000,000, or picked Attack from Mars when they played Medieval Madness.

- Open **Leaderboard** in admin. Find the game card, click **Scores**.
- Every submission has a photo attached (it's required). Pull it up to see what really happened.
- If the photo backs up what the player is now claiming, delete the bad row and tell them to resubmit. If the photo matches what they originally submitted, gently push back; the submission was right.

### 2. Anonymous player wants their score linked to their Discord

Submitted as a guest, then later logged in with Discord, now their old scores aren't tied to their account.

- Go to **Identity**.
- Find the anon entry under **Pending Claims**.
- Arcaid usually suggests the matching Discord user. Click **Preview Merge**, then **Confirm**.
- If no suggestion shows up, paste their Discord ID into the merge box and run it manually.

### 3. Winner is AFK and the pick prompt is hanging

Arcaid hands the pick to the runner-up after a window, then auto-picks if that runs out too. So usually you wait. If a tournament looks genuinely stuck:

- Go to **Game States**.
- Find the `[Pending Pick]` row.
- Click **Clear Picker**.
- Either let auto-pick run on the next maintenance tick, or activate a game manually from **Game Library** to keep things moving.

### 4. Bad comment, photo, or score report

- Toxic comments: open the public game page, find the comment, delete it.
- Inappropriate score photos: open **Leaderboard**, find the game, use **Scores** to remove the row.
- Score reports from other players: they show up on the **Leaderboard** page or the public game detail page. Review the photo. Accept (removes the score) or reject (dismisses the report).

### 5. You can't tell what's wrong

Don't sweat it. Screenshot what you see, write down what tournament or player it involves, drop it in `#mod-log` and tag me. Half the value of this test is the things mods can't fix because the tool doesn't expose what they need.

## Things worth poking at on purpose

This is honestly where you'd be helping me out the most. If you've got ten minutes, picking even one or two of these makes a real difference:

- **Edit a tournament's schedule** to something firing soon and watch the rotation happen live. Did the announcement land? Did the right game come up? Anything off?
- **Manually activate a game from Game Library** while a tournament already has an active game. Does the queue do what you expected? Does it conflict?
- **Force Maintenance** on a tournament from **Game States**. What changed? Anything weird in the Activity log?
- **Try the Sync iScored buttons** (Lock, Unlock, Create, Delete) on a game and see what happens on the iScored side.
- **Toggle the Discord login requirement** in Room Settings. Heads up, this has cascade effects on existing anon identities, which is exactly what I want to know about. Ping me before AND after you flip it so I can watch.
- **Submit a wild score** intentionally and try to delete it as someone else.
- **Run a merge** between two test identities you set up just to exercise the flow. Then **reverse** it. Did the audit chain make sense? Did everything come back?
- **Post a test announcement** in **Lobby**. Label it clearly as a test so real players don't get confused. Does it look how you expected on the public lobby page?
- **Change platform rules** on a tournament mid-flight and see what happens to game eligibility.
- **Use the rename player tool** in Identity. Does the renamed name propagate everywhere it should?
- **Change card styles** in Leaderboard or Style Catalogue. Anything render weird at small or large sizes?

You don't need to do all of these. You don't need to do any of them. But if you're bored on a Tuesday afternoon, this is the list I'd hand you.

If you find something that looks irreversible (you deleted something and nothing came back, or the room is in a state you can't get out of), stop and ping me. Otherwise, keep going.

## When to ping me

- You found something interesting, especially something that broke or looked broken.
- A user wants their data fully removed (GDPR-style request).
- The bot stops responding in Discord.
- Two users are in a fight you'd rather not referee alone.
- Anything that looks like a bug, not a user incident.

Default for "should I tell Justin about this" is yes. If it's nothing, it takes me ten seconds to say so. If it's something, I'd rather know.

## Logging your work

If you fix something or try something, a quick note in `#mod-log` helps me a ton. Even rough notes are fine:

- Who was involved (if a real player)
- What you did
- What happened
- Anything that felt rough

The Activity page captures the action itself, but your notes are what tell me whether the test went well. At end of day, a one-line summary is the cherry on top. Even "uneventful day, tried Force Maintenance on the weeklies, nothing surprising" is useful to me.

## You are not on call

Check in once or twice a day. Handle anything pinged at you. Try a couple of the "poke at it on purpose" items if you feel like it. That's plenty. If something is genuinely urgent and I'm reachable, I'll handle it directly.

Thanks for doing this.
