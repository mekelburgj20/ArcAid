Per-release doc sweep. Mechanical updates that align the docs with a freshly-shipped release.

**Usage:** `/release-docs <version>` — e.g. `/release-docs 2.9.0`. The version arg is the release being documented (already shipped or about to ship). Don't run this for an unfinished arc — wait until the code lands and the deploy is healthy, otherwise you'll have to amend the CHANGELOG entry.

This command does the four things `/update-docs` deliberately doesn't: bump `package.json`, append to `CHANGELOG.md`, roll the SPRINT_STATUS arc markers, and bump the SW cache. For doc audits *between* releases (CLAUDE.md drift, README features list, ADRs), use `/update-docs`.

## Steps

### 1. Confirm the release is real

- `git log --oneline` since the previous version tag — must show the actual commits being documented.
- Build state should already be green (the user typically runs `/deploy` first; if not, run `npm run build && cd admin-ui && npm run build && cd .. && npm test` and abort if anything fails).
- If `package.json.version` already equals `<version>`, the release sweep already ran — stop and ask whether the user wants to amend instead.

### 2. Draft the CHANGELOG entry

The hardest part. Order matters:

1. **Pull commit messages from the arc:** `git log --format='%h %B' v<previous>..HEAD` (or since the last CHANGELOG entry's date if no tag exists). Read the full bodies, not just subjects — context is in the body.
2. **Group by theme**, not by commit order. A typical release has 2–4 themes (e.g. for v2.9.0: "Score moderation", "Cron race fix", "Multi-slot picker correctness"). Each theme gets a `### {Theme}` subsection.
3. **Inside each theme, lead with the user-visible behavior.** Then the latent bug it surfaced (if any). Then implementation details (file paths, query patterns, migration numbers). The reader scanning for "what changed" should see the answer in one bullet; the reader scanning for "how was it implemented" should find it in the same bullet's tail clause.
4. **Files touched section** — list every file with a one-line note on what changed. Helps future readers who hit a regression and want to find the implicated diff fast.
5. **Migration notes** — call out any new migration number, any data backfills, any one-time prod cleanup the user had to do manually. If the release adds a column to a hot table, note the lock semantics.
6. **Tests** — the count, plus mention of any new test files. If 129/129 pass and you didn't add tests, say "no new test files this release — paths covered by existing route smoke tests" with a one-line reason why.
7. **Known followups (in ROADMAP)** — anything you punted on that's tracked in ROADMAP under "Open Followups". Names and short descriptions; don't duplicate the ROADMAP detail.

Place the new entry **immediately after** the `## [<previous>] — <date>` line. Match the existing voice — terse, specific, drops file paths and table names freely.

### 3. Bump `package.json`

Single field: `"version": "<old>"` → `"version": "<new>"`. Don't touch anything else.

### 4. Roll the SPRINT_STATUS arc markers

`SPRINT_STATUS.md` carries `<!-- LATEST_ARC_START -->` / `<!-- LATEST_ARC_END -->` HTML comments delimiting the current "Most recent arc" block. Mechanical move:

1. Read everything between the markers (the soon-to-be-old arc).
2. Insert that block as a new `- **Earlier arc (v<previous> — <previous arc title>):**` entry immediately *after* the `<!-- LATEST_ARC_END -->` line. Demote the heading line from "Most recent arc" to "Earlier arc". Drop any "Build state" line at the bottom of the demoted arc — that line only ever describes the *current* state, and we're about to write a new one.
3. Replace the inter-marker content with the new arc, written in the same shape as the demoted one (3–8 bullets, last bullet always "Tests" or "Build state").
4. Update the top-of-file lines: `**Current version:** **v<new>**` and the `Build state` line.

If `<!-- LATEST_ARC_START -->` is missing (file from before the markers landed), insert both markers around the current "Most recent arc" block first, then proceed.

### 5. Service worker — no action

Since v2.28.0 the SW's static cache name (`arcaid-static-${BUILD_ID}`) is derived automatically at build time (`admin-ui/vite.config.ts`'s `arcaid-sw-build-id` plugin + `admin-ui/scripts/swBuildId.ts`) — there is no `CACHE_NAME` to bump by hand anymore. Nothing to do in this step.

### 6. ADR check

Same as `/update-docs` step 3. For each new load-bearing decision in the arc, ask before drafting `docs/decisions/NNNN-{slug}.md`. Update `docs/decisions/README.md` index when ADRs are added.

### 7. Commit

Single commit, message:

```
docs: v<version> doc sweep — <brief arc summary>

CHANGELOG entry for v<version>. package.json bumped <prev> → <version>.
SPRINT_STATUS most-recent-arc rolled; <prev> moved to "Earlier arc".

[Optional: ADR additions, CLAUDE.md updates, etc.]
```

Don't push automatically — the user pushes when they're ready. Doc-only commits skip the deploy pipeline (per `paths-ignore` in `.github/workflows/deploy.yml`), so this is safe to push without re-deploying.

### What this command does NOT do

- **Audit drift in CLAUDE.md, README features, ROADMAP, etc.** — that's `/update-docs`. Run it *before* `/release-docs` if you suspect mid-sprint drift.
- **Touch ADRs without asking** — same as `/update-docs`.
- **Run the deploy pipeline** — `/deploy` does that. `/release-docs` runs after the deploy is verified healthy.
- **Decide the version number** — the version arg is mandatory. SemVer judgment is the user's call (patch / minor / major).

### Anti-patterns to avoid

- **Writing the CHANGELOG entry from memory of "what we did this session" instead of from `git log`.** You'll miss things. Pull the commit bodies; let them anchor the entry.
- **Bumping `package.json` first.** Do it after the CHANGELOG entry exists, so a partial run doesn't leave the version ahead of the docs.
- **Demoting more than one arc per run.** Each `/release-docs` rolls exactly one arc forward. If two releases shipped between sweeps, run the command twice.
- **Touching files outside the inventory in step 4 of `/update-docs`.** If you find drift in CLAUDE.md or README, surface it in the commit message but apply the fix in a separate `/update-docs` invocation — don't conflate audit work with the release sweep.
