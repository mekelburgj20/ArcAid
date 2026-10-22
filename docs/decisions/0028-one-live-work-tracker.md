# ADR 0028 — One live work tracker: `WORK.md`, lanes, claims, a board

**Status:** Accepted (2026-10-21)
**Owner rulings:** 2026-10-21, "a single tracking file and an associated tracking artifact"; items addressable
by ID ("let's work on item B13.4"); organised so several agents can take a section each without colliding,
or be orchestrated. The same decision is Castcade ADR 0006; the two repos share the format and the tooling
(`tools/work-board.mjs` is copied, not shared, per Castcade ADR 0003's "shared = contract, never code").

## Context

ArcAid tracked open work in four places that no single routine maintained:

- `ROADMAP.md` (611 lines): the deep backlog, 181 commits.
- `SPRINT_STATUS.md` (1,130 lines, 331 commits): "resume point" paragraphs of 1,500+ characters per session,
  plus arc summaries rolled by `/release-docs` behind `LATEST_ARC_*` markers.
- `LAUNCH.md` (109 lines): the owner's ordered priority view, rebuilt 2026-09-07. Neither `/update-docs` nor
  `/release-docs` mentioned it; by 2026-10-21 its "Now — this week" was six weeks stale and five of its open
  entries had already shipped (rotation audit trail 2.146.0, lock indicator 2.95.2, leaderboard
  consolidation C3 2.124.0, catalogue report-a-problem 2.25.0, first-login tutorial 2.48.0).
- Plan docs under `docs/` and a gitignored `tmp/` bug list.

`/update-docs` audited drift across an eleven-file inventory on every run; `/release-docs` wrote the
CHANGELOG entry and rolled the sprint arc. Reading state at session start meant two long files (tens of
thousands of tokens); writing it meant a long paragraph, so it slipped: on 2026-10-21 `SPRINT_STATUS`
ended at v2.164.0 while `main` was at v2.166.1, with the integrity-mode work recorded only in the Castcade
repo's `CLAUDE.md`. Nothing let an agent say "this item is mine" in a way another agent would see.

## Decision

### 1. One file: `WORK.md`

The only live tracker is `WORK.md` at the repo root: a `## Now` block (at most 12 bullets) and sections
of one-line items. History lives in `CHANGELOG.md` and `git log -- WORK.md`; detail lives where it always
did and items point at it with `spec:` (`ROADMAP.md §"heading"`, a plan doc, a SPRINT_STATUS resume
point number). `ROADMAP.md`, `LAUNCH.md` and `SPRINT_STATUS.md` are frozen archives with a banner at the
top; they are never appended to again. The migration carried every open entry across as an item, with
the LAUNCH tier as a `tier:` field, and corrected the stale ones against the CHANGELOG.

### 2. A grammar, checked in CI

`- **ID** \`status qualifier\` Title — detail · key: value`. IDs are section letters plus a number, dotted
for sub-items, never reused, never renumbered. Eight statuses: `idea`, `ready`, `claimed`, `blocked`,
`review`, `done`, `parked`, and `dropped` (added 2026-10-21 after the first audit: will not be done, with the
ruling or reason as qualifier; the line and number stay). `npm run work:check` (`tools/work-board.mjs --check`, also a step in the
`deploy.yml` test job) fails on duplicate IDs, unknown statuses, dangling `needs:` and claims without
`owner`/`since`. The full grammar is `.claude/commands/work.md`.

### 3. Sections are lanes; claims are commits

Each section names the paths it owns (`Lane:`). An agent claims an item by committing the one-line status
change to `main` immediately (`work: claim B3.2`, doc-only so the deploy is skipped) and edits only lines
of items it has claimed plus items it appends. Claims older than seven days without activity may be
released by anyone. An orchestrating agent claims a parent item and gives each worktree subagent one
sub-item scoped to the lane; subagents never edit `WORK.md`. Section W (Witness and Castcade) mirrors
section F of the Castcade repo's `WORK.md`; when one side ships, the other side's mirror line is flipped.

### 4. A board, generated from the file

`tools/work-board.mjs` renders `WORK.md` to a self-contained page, published as a claude.ai artifact whose
URL is on the `Board:` line of `WORK.md` so every session republishes to the same link. The page embeds
the parser and re-reads `WORK.md` from `raw.githubusercontent.com` on load (the repo is public), so it is
live between republishes. The file is the source of truth; the board is a view.

### 5. Three commands replace five

`/work [ID]` (start a session or claim an item), `/wrap` (end a session: statuses, new items, Now,
diff-scoped drift check, board, commit) and `/release-docs <version>` (CHANGELOG entry, version bump,
items flipped to `done`). `/update-docs` is retired; its inventory became the drift table in `/wrap`,
scoped to the session's diff. `/deploy` is unchanged apart from its note.

## Consequences

### Easier
- Session start is `npm run work:summary`: one screen.
- "Let's work on B13.4" is an exact address; the board's ID button copies that sentence.
- Agents on different sections need no coordination; agents on one section coordinate through claims
  visible in `git log` and on the board.
- The release sweep no longer rewrites a narrative block; it flips lines.

### Harder
- Discipline: what used to be dumped into a resume point must now be split into items, a commit message
  and a 12-line Now block. `/wrap` enforces this.
- `WORK.md` can conflict when two agents append to the same section at once; resolution is trivial
  (keep both, renumber the later one) but it is a conflict.
- The board depends on the artifact staying published and the repo staying public for live refresh; the
  embedded snapshot is the fallback.
- Three uncertain migrations are flagged in the file itself: B1 ("Also count this score in…" has no ADR
  despite LAUNCH citing 0024), F6 (the weekly-cleanup orphan mapped to 2.155.6), X10 (the jsdom 30 hold has
  no recorded reason).

### Locked out
- A second live list (a new `LAUNCH.md`, a `tmp/` bug list, a status paragraph in `CLAUDE.md`). Standing
  facts go in `CLAUDE.md`; open work goes in `WORK.md`; nothing else is live.

## Alternatives rejected

- **GitHub Issues + Projects.** The standard answer and the fallback if the file outgrows a page. Rejected
  now because the list must travel with the code (a claim and the commit that found a follow-up land
  together), the owner reads the tracker in the editor, worktree agents work from files, and `gh` auth on
  the owner's machine is unreliable.
- **YAML or JSON with a generated Markdown view.** More machine-friendly, less hand-editable; people edit
  the file far more often than tools read it.
- **Keep ROADMAP + SPRINT_STATUS + LAUNCH and fix the commands.** The problem was the number of places,
  not the commands; any routine that must touch four files skips one.
- **The artifact's own database as the source of truth.** Outside git, invisible to worktree agents and
  to `git log`, dependent on one hosted page.
