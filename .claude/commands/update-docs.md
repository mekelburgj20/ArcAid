Audit the docs against current code state. Find drift; fix what you find. **Do not bump versions or roll release-arc copy in this command** — that's `/release-docs <version>`. If you'd want to do that, stop and tell the user to run `/release-docs` instead.

This command exists for two flows:

- **Mid-sprint sanity check** — between releases, when CLAUDE.md or README has fallen behind a code change.
- **Pre-release dry run** — before invoking `/release-docs`, confirm the docs the release sweep doesn't touch (CLAUDE.md, README.md features list, ROADMAP.md, ADRs) are caught up.

## Steps

### 1. Drift detection

- Read recent commits (`git log --oneline -20`) and uncommitted changes (`git status`, `git diff`).
- For each commit/change with user-visible behavior or new architecture, check whether the corresponding doc(s) reflect it. The mapping below is the inventory.
- Surface findings to the user as a punch list before applying fixes. If the only drift is "version + CHANGELOG entry missing", redirect to `/release-docs <version>` — don't try to fix it here.

### 2. Relevant Documentation (the inventory)

**Active (update regularly):**

- `README.md` — Public-facing functional summary: what the app is, what it can do (Features), how to use it (Quick Start, URL Structure, Auth, Discord Commands, Configuration, Tech Stack, Deployment). **Functional only** — no version-specific or release-history sections. Carries one line pointing at `CHANGELOG.md`.
- `CHANGELOG.md` — **Single source of truth for release history.** One section per version, Keep-a-Changelog format. Full breakdown per entry (problem, fix, files touched, migration notes, SW cache bumps). **`/release-docs` writes this; `/update-docs` only reads it to confirm an entry exists for the current version.**
- `ROADMAP.md` — Open followups, deferred items, future plans. Update when work completes (move to CHANGELOG) or when new followups surface.
- `SPRINT_STATUS.md` — Live progress tracker. "Most recent arc" is delimited by `<!-- LATEST_ARC_START -->` / `<!-- LATEST_ARC_END -->` HTML comments. **`/release-docs` rolls these markers; `/update-docs` only edits within the latest arc when current-arc detail has drifted.**
- `CLAUDE.md` (ArcAid root) — Architecture tables, key patterns, database schema, session checklist, gotchas. Update when a new pattern lands or an existing one shifts.
- `../CLAUDE.md` (parent repo root) — Repository overview shared across projects. Touch only if the repo-level structure or commands changed.
- `package.json` — `version` field. **Read-only in this command** — never bump in `/update-docs`. If drift suggests a bump is needed, tell the user.
- `admin-ui/public/sw.js` — PWA service worker. `CACHE_NAME` **must** be bumped every UI-visible release. **Read-only in this command** — bumps belong to the deploy/release flow.
- `docs/decisions/` — Architecture Decision Records. See `docs/decisions/README.md` for the convention. The ADR scan is step 3 below.
- `docs/VIDEO-TUTORIAL-SCRIPT.md` — Video tutorial scripts, episode list, B-roll checklist, production standards.
- `docs/HOW-TO-GUIDE.md` — End-user how-to documentation.
- `docs/step-2-cleanup-plan.md` — Active multi-step plan (current: drop legacy `game_library` / `game_room_game_library`). Plan-style docs live here once they outgrow `tmp/`.
- `.claude/commands/conversation-analysis-system.md` — The doc inventory referenced by the analysis system. If a new doc category emerges, add it here.

**Reference (update occasionally):**

- `.claude/commands/deploy.md` — Production deployment checklist slash command.
- `.claude/commands/release-docs.md` — Per-release doc sweep (`/release-docs`).
- `.claude/commands/update-docs.md` — This file.
- `.claude/commands/review-orchestrator.md` and the `review-*` family — Multi-pass review agents.

**Retired (do not maintain):**

- `releases/v*/README.md` — per-version release notes. Historical archive only (v2.0.0 → v2.2.8). v2.3.0+ release detail lives in `CHANGELOG.md`. See `releases/README.md`.

**Local-only (gitignored, `tmp/` folder):**

- `tmp/various_bug_fixes.md` — Current bug/fix tracking list.
- Other temp files (planning docs, screenshots, bug images).

### 3. Decision Doc Check

- Scan recent work (last release window, or last 20 commits if mid-sprint) for new load-bearing decisions: data shape changes, new auth patterns, new external integrations, new conventions that future code will assume.
- For each such decision, check whether `docs/decisions/NNNN-{slug}.md` exists.
- If a decision was made but no ADR exists, ask the user: *"I noticed we decided X — should I draft `docs/decisions/NNNN-{slug}.md` for it?"* Do not create the ADR without confirmation.
- If an existing ADR has been superseded by recent work, update its `status` and `superseded-by` front matter and confirm with the user before applying.
- Update the `docs/decisions/README.md` index table as ADRs are added.

### 4. Recommendations

After applying fixes, briefly note any process friction observed: docs that consistently drift, conventions that aren't being followed, or new doc categories that need entry into the inventory above. Keep this short — one or two bullets unless something material came up.

### What this command does NOT do

- Bump `package.json` version
- Append to `CHANGELOG.md`
- Roll the SPRINT_STATUS arc markers
- Bump `admin-ui/public/sw.js` `CACHE_NAME`

All four belong to `/release-docs <version>`. If `/update-docs` finds drift that one of these would fix, surface it and stop.
