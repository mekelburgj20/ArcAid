Session start, or start on one item. `/work` with no argument shows the board and asks what to pick;
`/work <ID>` (for example `/work B3.2`) claims that item and starts it. `$ARGUMENTS` is the ID.

`WORK.md` at the repo root is the **only live tracker**. Everything else is either history
(`CHANGELOG.md`, `git log`) or detail (design docs, ADRs, spec sections that items point at). If a
fact about what is open, who is on it, or what is blocked is not in `WORK.md`, it is not tracked.

## The file

```
# <Repo> — Work
Board: <artifact url>  ·  Rules: .claude/commands/work.md  ·  Check: npm run work:check

## Now
- at most 12 bullets: version, what is in flight, what only the owner can do, blockers, last wrap

## A. Section title
Lane: `path/one/**`, `path/two/**`. One line on what the section covers.
- **A1** `done 0.2.4` Title
- **A2** `ready` Title — one line of detail · spec: docs/design/x.md §3 · needs: A1
  - **A2.1** `claimed` Sub-item · owner: fable@wt-a2 · since: 2026-10-21 · branch: feat/a2-1
```

**Item line grammar** (the board renderer and `npm run work:check` parse exactly this):

- `- **ID** ` then `` `status` `` or `` `status qualifier` `` then the text.
- **ID** = section letters + number, dotted for sub-items: `B3`, `B3.2`, `B3.2.1`. A sub-item is indented
  two spaces under its parent and its ID starts with the parent's ID. **IDs are never reused and never
  renumbered**; a finished item stays as a one-line `done` entry so its number stays taken.
- **status** is one of `idea` (not committed to), `ready` (committed, unclaimed), `claimed`, `blocked`,
  `review` (PR open), `done`, `parked` (deferred, may come back), `dropped` (will not be done: shipped
  another way, superseded by a ruling, or no longer wanted). The qualifier says the version for `done`, the PR
  for `review`, the blocking ID or reason for `blocked`, the reason or ruling for `dropped`: `` `done 0.2.4` ``,
  `` `review #371` ``, `` `blocked B3` ``, `` `dropped ADR 0027` ``. A dropped item keeps its line and its number.
- **text** = title, then optional ` — detail` (one line), then ` · key: value` fields. Known keys:
  `owner`, `since`, `branch`, `pr`, `needs` (comma-separated IDs), `touches` (paths outside the lane),
  `spec` (where the detail lives), `due`, `gate` (what proves it done). Other keys are allowed and shown as-is.
- A `claimed` item must carry `owner` and `since`. A `needs` ID must exist in the file.
- Indented plain lines under an item are notes. Keep them rare; detail belongs in a spec doc.

**Sections are lanes.** Each `## X. Title` names the paths it owns on its `Lane:` line. An agent that
works inside one section's lane does not collide with an agent in another. An item that must touch
another lane's paths says so with `touches:` and its owner checks that lane's claims first.

## Claiming (the concurrency rule)

1. Before claiming, `git pull --rebase` (or `git fetch` and read `origin/main:WORK.md`) so you see
   current claims.
2. Claim = change the item's status to `` `claimed` `` and add `owner: <who>` and `since: <date>`;
   `branch:` when you work on a branch. `<who>` is `owner` for the human, otherwise
   `<model>@<worktree-or-branch>` (for example `fable@main`, `opus@wt-b3`).
3. Commit that one-line change **to main immediately**, message `work: claim B3.2`, and push when the
   repo has a remote. A claim nobody can see is not a claim. (In ArcAid, doc-only commits skip the deploy.)
4. Edit only the lines of items you have claimed, plus new items you append. Two agents editing the
   same item line is the only way `WORK.md` conflicts; appending to the same section conflicts
   trivially (keep both, renumber yours if the number collided).
5. A claim older than 7 days with no commits on its branch may be released by anyone: set it back to
   `` `ready` `` and say so in the commit message.

**Orchestrating several agents.** The lead claims the parent item and spawns one worktree subagent per
sub-item, each scoped to the section's lane paths (the subagent worktree conventions in
`C:\code\repos\CLAUDE.md` apply). Subagents never edit `WORK.md`; the lead records their results
when they return. Subagents on different sections need no coordination at all.

## `/work` with no argument

1. `git pull --rebase` if the tree is clean (else `git fetch` and read `origin/main:WORK.md`).
2. `npm run work:summary` (the terminal view of `WORK.md`: the Now block, in-flight claims, ready
   items per section, blockers, stale claims).
3. Present it in a few lines and ask which item to take. If the owner names one, continue below.

## `/work <ID>`

1. Find the line. If it is `claimed` by someone else and not stale, say so and stop.
2. Read its `spec:` and `needs:`; if a `needs` item is not `done`, say so and let the owner decide.
3. Claim it (steps above). Create the branch named in `branch:` when the repo works in branches.
4. Work. New follow-ups you discover go in as new items (`idea` or `ready`) under the right section,
   appended, in the same commit as the code that found them.
5. End the session with `/wrap`.
