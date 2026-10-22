Per-release doc sweep. Mechanical updates that align the docs with a freshly-shipped release.

**Usage:** `/release-docs <version>` — e.g. `/release-docs 2.9.0`. The version arg is the release being documented (already shipped or about to ship). Don't run this for an unfinished arc — wait until the code lands and the deploy is healthy, otherwise you'll have to amend the CHANGELOG entry.

This command does the things `/wrap` deliberately doesn't: bump `package.json`, append to `CHANGELOG.md`, and flip the shipped items in `WORK.md` to `done`. Doc drift between releases is `/wrap`'s job (diff-scoped, every session).

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
7. **Known followups** — anything you punted on, by `WORK.md` item ID (add the item if it is not there yet). Names and IDs; don't duplicate the detail.

Place the new entry **immediately after** the `## [<previous>] — <date>` line. Match the existing voice — terse, specific, drops file paths and table names freely.

### 3. Bump `package.json`

Single field: `"version": "<old>"` → `"version": "<new>"`. Don't touch anything else.

### 4. Flip the shipped items in `WORK.md`

Every item the release finishes becomes `` `done <version>` `` on one line (title only; the CHANGELOG
entry carries the detail). Items it partly finishes keep their status and get a sub-item for the rest.
Update the version line in `## Now`. Never renumber or delete an item. `npm run work:check` must pass.

### 5. Service worker — no action

Since v2.28.0 the SW's static cache name (`arcaid-static-${BUILD_ID}`) is derived automatically at build time (`admin-ui/vite.config.ts`'s `arcaid-sw-build-id` plugin + `admin-ui/scripts/swBuildId.ts`) — there is no `CACHE_NAME` to bump by hand anymore. Nothing to do in this step.

### 6. ADR check

Same as `/wrap` step 2. For each new load-bearing decision in the arc, ask before drafting `docs/decisions/NNNN-{slug}.md`. Update `docs/decisions/README.md` index when ADRs are added.

### 7. Commit

Single commit, message:

```
docs: v<version> doc sweep — <brief arc summary>

CHANGELOG entry for v<version>. package.json bumped <prev> → <version>.
WORK.md: <ids> done.

[Optional: ADR additions, CLAUDE.md updates, etc.]
```

Don't push automatically — the user pushes when they're ready. Doc-only commits skip the deploy pipeline (per `paths-ignore` in `.github/workflows/deploy.yml`), so this is safe to push without re-deploying.

### What this command does NOT do

- **Audit drift in CLAUDE.md, README features, specs, etc.** — that's `/wrap`, at the end of every session.
- **Touch ADRs without asking** — same as `/wrap`.
- **Run the deploy pipeline** — `/deploy` does that. `/release-docs` runs after the deploy is verified healthy.
- **Decide the version number** — the version arg is mandatory. SemVer judgment is the user's call (patch / minor / major).

### Anti-patterns to avoid

- **Writing the CHANGELOG entry from memory of "what we did this session" instead of from `git log`.** You'll miss things. Pull the commit bodies; let them anchor the entry.
- **Bumping `package.json` first.** Do it after the CHANGELOG entry exists, so a partial run doesn't leave the version ahead of the docs.
- **Documenting more than one release per run.** If two releases shipped between sweeps, run the command twice so each gets its own entry.
- **Mixing a drift fix into the release sweep.** If you find drift in CLAUDE.md or README, note it in the commit message and fix it in `/wrap` — don't conflate audit work with the release sweep.
