End of session. Bring `WORK.md` up to date, catch doc drift the session caused, republish the board,
commit. Takes ten minutes, not an hour; if a step would take longer, record it as an item instead.

`WORK.md` is the only live tracker (rules and grammar: `.claude/commands/work.md`). Session narrative
does not go there: it goes in commit messages, and per release in `CHANGELOG.md`.

## Steps

### 1. What happened

`git status`, `git diff --stat`, `git log --oneline` since the session started. This list, not memory,
drives every step below.

### 2. Items

For every item you claimed this session, set the status that is true now:

- shipped → `` `done <version>` `` (collapse the line to its title; detail is in CHANGELOG / git);
- PR open → `` `review #<n>` ``;
- continuing next session → stay `` `claimed` ``, and add ONE indented note line under it that says
  where to resume (the one thing a fresh agent needs: branch, failing test, next sub-step);
- stopped → `` `ready` `` with the note, and drop `owner`/`since`.

Add every follow-up, bug or idea the session surfaced as a new item (`idea` or `ready`) at the end of
the right section, with `spec:` pointing at where the detail lives (a doc you wrote, a commit, an
issue). Never renumber. Never delete an item.

Owner rulings made this session: add an ADR (`docs/decisions/`, same session, reasoning fresh) and,
if the ruling is one agents must not reopen, a row in the rulings table in `CLAUDE.md`. Ask before
drafting an ADR for a decision the owner did not clearly make.

### 3. Now block

Rewrite `## Now` (max 12 bullets): current version, what is in flight (IDs + owners), what only the
owner can do, blockers, the next two or three items by priority, and
`Last wrap: <date> — <IDs touched>`. Replace, don't append; the previous Now is in git.

### 4. Drift check, scoped to the diff

Only for the files the session changed, check the doc that describes them:

| Changed | Check |
|---|---|
| a module's shape, a command, a gotcha | `CLAUDE.md` (architecture / commands / working agreement) |
| user-visible behaviour | `README.md` (features), tester-facing docs |
| a design the item points at (`spec:`) | that doc: mark what shipped, move open questions into items |
| the wire format or a journal/protocol file | the spec doc + a fixture, and a version bump |
| a shipped version | `CHANGELOG.md` has the entry (see "This repo") |
| `docs/decisions/` | `docs/decisions/README.md` index + "next free number" |

Fix what you find. Anything larger than a few lines becomes an item under the docs section.

### 5. Check, render, publish

```
npm run work:check          # grammar, duplicate ids, dangling needs, stale claims — must pass
npm run work:board          # tmp/work-board.html (gitignored)
```

Publish `tmp/work-board.html` with the Artifact tool. The `Board:` line at the top of `WORK.md` holds
the artifact URL: pass it as `url` so the same page updates in place. If the line has no URL yet,
publish once (icon `board`), then write the URL into that line before committing. The page also
refreshes itself from `WORK.md` on GitHub when the repo is public, so a stale republish is never
worse than a few minutes behind.

### 6. Commit and push

One commit for the tracker + doc fixes, separate from code: `work: wrap <date> — <IDs>` with one line
per item whose status changed. Push. Doc-only pushes skip deploys in both repos.

## This repo (ArcAid)

- Every PR ships a version (`package.json`), so `/release-docs <version>` runs per release, after the
  deploy is verified healthy; it writes the CHANGELOG entry, bumps the version and flips items to
  `` `done <version>` ``. If a version shipped this session and `/release-docs` has not run, run it before
  this wrap.
- Doc-only commits skip the deploy (`paths-ignore` in `deploy.yml`); add `[skip ci]` to a pure
  tracker commit so the test job skips too.
- `ROADMAP.md`, `LAUNCH.md` and `SPRINT_STATUS.md` are frozen archives: items point into them with
  `spec:`; never append to them. Standing facts go in `CLAUDE.md`; a session narrative goes nowhere
  but the commit message.
- The ArcAid Witness / Castcade work is section W here and section F in
  `C:\code\repos\castcade\WORK.md`; when one side ships, flip the mirror line on the other side.
