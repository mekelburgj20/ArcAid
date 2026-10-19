# UX skills playbook: how to act on the 2026-10-19 analysis without touching production

Companion to `docs/ux-skills-analysis-2026-10-19.md`. That document says *what* the two skill sets would change. This one says *how to run the work*: what the owner does, what an agent does, and how to iterate so the live site at arcaid.app never sees a half-finished change.

---

## 1. The shape of the risk

Three facts about how ArcAid ships decide everything below.

1. **`main` is production.** `deploy.yml` builds and deploys to Hetzner on every push to `main`. A squash-merged PR is live within minutes. There is no staging environment.
2. **The PR test gate is real and already strict.** Every PR runs backend `tsc` + vitest and admin-ui `tsc -b` + vite build + vitest. A red suite blocks the merge. `CLAUDE.md` adds the local ritual: `docker compose build`, `cd admin-ui && npm run build`, `cd admin-ui && npx vitest run`.
3. **The local container can be a second production bot.** The repo `.env` holds the production Discord token, so `docker compose up` on your machine registers slash commands against the live guilds and answers chat (the 2026-08-21 incident). Any local UI iteration must run on a dev env file, never the prod one.

So the safety model is not "feature flags" or "a staging server". It is: **small PRs, each one visually reviewed on a local sandbox with a dev env and a copied database, merged one at a time, with revert as the rollback.** UI work has an advantage here: it never migrates data, so a bad merge is embarrassing, not destructive, and a revert PR redeploys the previous look in minutes.

---

## 2. Division of labour

| | You (owner) | An agent (Claude Code, local or cloud session) |
|---|---|---|
| Decisions | Who the product is for, which surfaces are protected, which trade-offs to accept, approve new dependencies, merge PRs | Never decides these; asks once, then records the answer in `PRODUCT.md`/`DESIGN.md` |
| Setup | Install the skills on your machine, connect GitHub for cloud sessions, create the dev env file | Scaffolds the dev compose override and seed script, turns the hook on, writes `DESIGN.md` from the code |
| Interviews | Answer `/impeccable init`'s three to six questions and `document`'s naming questions | Runs them, drafts, you confirm |
| Implementation | None | All of it, one scoped PR at a time, with the hook running on every edit |
| Verification | Open the sandbox and your phone, look, use it for a day as a room admin or a player | Build, both vitest suites, `contrastAudit.cjs`, `impeccable detect` on the dev server, before/after screenshots sent to you |
| Shipping | Review the PR diff and screenshots, merge, glance at prod after deploy | Opens the PR with screenshots in the body, watches CI, fixes red |
| Rollback | Decide | Opens the revert PR |

The two things only you can do well: say what the product is (the interview), and look at the result on real hardware in the real use scene. Everything else is agent work.

---

## 3. One-time setup (half a day, mostly yours)

### 3a. Install the skills so every session has them

Both skill sets can be installed **project-scoped**, which writes them under `.claude/` in the repo. That matters for two reasons: cloud sessions get them automatically, and `deploy.yml` ignores `.claude/**`, so committing them does not trigger a deploy.

From the repo root on your machine:

```bash
npx impeccable install --providers=claude --scope=project
npx skills@latest add emilkowalski/skills
```

Then in Claude Code, inside the repo:

```
/impeccable hooks on
/impeccable telemetry off     # optional; the engine reports anonymous usage otherwise
```

Commit `.claude/` and `.impeccable/config.json`. Do not commit `.impeccable/config.local.json` (it is gitignored by the installer).

### 3b. Make the local sandbox safe

Create `.env.dev` next to `.env` (never commit either). It is a copy of `.env` with these changes:

- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`: either blank (the bot does not start; the API warns and runs) or a **separate dev Discord application** pointed at a private test server. Blank is fine for UI work.
- `ISCORED_API_ENABLED=false` and no `ISCORED_*` credentials, so nothing polls or mutates a real iScored room.
- `DB_PATH=./data/dev.db`.

Then seed `data/dev.db`. Two options:

- **Copy of production.** `docker cp arcaid:/app/data/arcaid.db ./data/dev.db` from the prod host, then scrub: the `game_room_settings` rows holding Discord/iScored/AtGames credentials, and the `sessions` table. This gives you real room names, real card art, real score volumes, which is what you want when judging a scoreboard change.
- **Synthetic seed.** A small script that creates one room, one tournament, three active games and six players with a dozen scores. The cloud session that produced the analysis did exactly this through the public API plus direct SQLite inserts; turning it into `scripts/seed-dev.ts` is a one-hour agent task and makes every future sandbox a single command.

Run the sandbox with an override so the base compose file stays untouched:

```yaml
# docker-compose.dev.yml (commit this one)
services:
  arcaid:
    container_name: arcaid-dev
    env_file: [.env.dev]
    ports: ["3002:3001"]
```

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Port 3002, container `arcaid-dev`, dev database, no live integrations. This is where every UI change gets looked at before a PR goes up.

### 3c. Connect GitHub for cloud sessions

Cloud Claude Code sessions currently cannot push to `mekelburgj20/ArcAid` (HTTP 403). Connect the Claude GitHub App at https://claude.ai/connect-github. Local sessions use your own git credentials and are unaffected.

---

## 4. The phases

Each phase is one or more PRs. Never combine phases in a PR. Within a phase, prefer one page or one primitive per PR.

### Phase 0: zero-risk fixes (one PR, agent, ~1 hour)

Ship these first. They are bugs, not design, and they prove the loop works.

- `Toast.tsx:58` animates `fadeIn`, which is not defined anywhere; `GlobalScoreboard.tsx:931,948` uses `animate-slide-down`, which is not defined (the class is `animate-slideDown`). Define the keyframes once in `index.css` and use them.
- Five token classes that do not exist in the theme and render nothing: `bg-surface-alt` (25), `text-secondary` (8), `bg-card` (6), `text-accent` (2), `border-default` (1). Replace with the real tokens.
- `neon-blue` duplicates `neon-cyan`, `neon-purple` duplicates `border-glow` in the default theme. Decide whether they are aliases or should differ.
- Two dev placeholders (`placeholder="mekelburj"`, `"mekelburgj"`).

Verification: both vitest suites, `contrastAudit.cjs`, open the sandbox toast and Global Scoreboard toast and confirm they now animate.

### Phase 1: foundations (two PRs, you + agent, ~half a day)

1. **`/impeccable init`.** The agent reads the repo, then asks you a few questions. Have answers ready: primary users are league players submitting from a phone at a cabinet, in a bar or arcade, often one-handed and in low light; secondary users are room admins and mods, who also edit from phones; kiosk displays run unattended on TVs; Discord is the community home. Say which surfaces are protected (next bullet). The output is `PRODUCT.md`.
2. **Record the protected surfaces.** In the same conversation, state it plainly so it lands in `PRODUCT.md` as a brand commitment: *the room Scoreboard cards, the Global Scoreboard, the kiosk and the title styles are the product's signature; refine their mechanics (contrast, text size) but do not quiet, flatten or de-neon them.* Without this sentence, both skill sets will eventually propose exactly that.
3. **`/impeccable document`.** The agent extracts `index.css`'s `@theme` block, the 15 `.theme-*` classes, `NeonButton`/`NeonCard` and the card system into `DESIGN.md`, then asks you to name things ("Deep Navy Slate", not `--color-deep`). This activates the detector's design-system drift rules. Also have the agent add the known intentional exceptions to the ignore list with reasons: `marquee` on the rankings ticker, `repeating-stripes-gradient` on the scanline overlay, `gradient-text` on the logo wordmark and the opt-in title styles, and your decision on `overused-font` for Inter.

Both files are docs; merging them deploys nothing.

### Phase 2: baseline critique (no code, agent, ~1 hour)

`/impeccable critique` on three surfaces against the running sandbox: `/<slug>` (the Scoreboard), `/<slug>/picks` logged in as a player, and `/<slug>/admin/settings`. You get Nielsen scores, a P0 to P3 list with file lines, and persona red flags, persisted under `.impeccable/critique/` so later runs trend. Read it, then tell the agent two things: which three issues to take first, and anything you disagree with. This is the single most important half hour you spend in the whole effort.

### Phase 3: primitives (three to five PRs, agent, ~2 days)

Order matters: build the primitive with no visual change, ship it, then migrate call sites in separate PRs.

1. **Approve the dependencies.** `pick-ui-library` will propose base-ui (dialogs, popovers, menus, selects) and Sonner (toasts). Say yes or no once. If no, the agent builds the same primitives by hand with focus trapping and reduced-motion handling; it is more work and the result is slightly worse, but it is a legitimate choice.
2. `Dialog`/`Sheet` primitive → migrate the 39 hand-rolled overlays in two or three PRs grouped by area (admin pages, public pages, scoreboard). Every migrated modal gains `role="dialog"`, Escape, focus return and an enter/exit transition.
3. `Toaster` → replace `Toast.tsx` and the two score toasts.
4. `Input`/`Select`/`Field` → replace the 16 per-file `inputClass` constants. `EmptyState` and `Skeleton` → replace the 26 copies of the spinner and the bare "No X yet" lines.
5. A global `:focus-visible` ring in the accent, and removal of the 104 `focus:outline-none`.

Each of these is the kind of PR where the vitest suite earns its keep. Remember the `Settings.test.tsx` trap in `CLAUDE.md`: a UI change that passes build and lint can still fail a test on a `getByRole` query.

### Phase 4: admin surfaces (one page per PR, agent, ~3 days)

`/impeccable typeset`, then `layout`, then `distill` or `quieter`, on Room Settings, Tournaments, LobbyAdmin, Reports and the two admin layouts. Expected changes: Orbitron leaves admin labels and stays in page titles; the 10px tracked eyebrows become real headings and labels at readable sizes; nested panels flatten to spacing and dividers; the sidebar shell is shared by the two layouts instead of duplicated; glow borders stop on admin cards. Room Settings also carries the roadmap's reorganisation (tabs or sections), which fits naturally here.

Your verification: use the sandbox as a room admin for a day, on desktop and on your phone. Admin pages are only seen by admins, so this phase can move fastest.

### Phase 5: player surfaces (one page per PR, agent, ~3 days)

- **Picks**: the six stacked panels, the stat tiles and the two simultaneous onboarding layers. `layout` + `distill` + `onboard`.
- **GameDetail**: the four stat tiles above the fold on phones. `layout`.
- **Submit sheet**: enter from the bottom on the drawer curve under 300 ms, press feedback on Submit, 16px inputs. Emil's `animate` with the sheet recipe.
- **`mobile-native` baseline** in `index.html`/`index.css`: tap-highlight off, `overscroll-behavior`, `100dvh` where the sheet and app shell size themselves, `user-select: none` on controls only, `theme-color` per colour scheme matching the top-of-page surface.
- **`break-ui`** on the scoreboard row and the GameDetail history rows with a dev-only worst-case fixture (32-character Discord names, 13-digit scores, "1 members").

These pages are seen by every player, so ship them one at a time and test each on your own phone at a cabinet before merging. If you have a friendly room, ask its admin to look at the sandbox link before the merge rather than after.

### Phase 6: scoreboard mechanics only (one PR, agent, ~half a day)

The detector's rendered findings on the Scoreboard were mechanical: white initials on pale avatar fills at 1.8 to 2.9:1, the 10px `WEEKLY` chip and timer, two light-theme chips at 1.1:1 on the landing page. Fix those and nothing else on the protected surfaces. Any change here is visible on every kiosk in every room the moment it deploys, so this PR gets the most careful look and ships at a quiet hour.

### Phase 7: polish and re-critique (agent, ~half a day)

`/impeccable harden` for long names and error states, `/impeccable polish` to clear the critique backlog, then `/impeccable critique` again on the same three surfaces. The score should move; if it did not, the critique tells you why.

---

## 5. The per-PR loop

This is the ritual for every PR from Phase 0 onward. Give it to the agent verbatim at the start of each session.

1. Branch from `main`. Scope is one page or one primitive. Read `PRODUCT.md`, `DESIGN.md` and the latest critique snapshot.
2. Implement with the Impeccable hook on. Act on each hook finding or add a narrow, reasoned ignore; never widen the PR to satisfy a finding.
3. Run the repo's own gates: `docker compose build`, `cd admin-ui && npm run build && npx vitest run`, `node admin-ui/scripts/contrastAudit.cjs`.
4. Start the dev sandbox and run `impeccable detect --json http://localhost:3002/<route>` at `1440x900` and `390x844`. No new findings versus `main`.
5. Capture before/after screenshots of the changed surface at both widths, dark and light, and send them to the owner.
6. Open the PR with the screenshots in the body and the list of hook findings and how each was handled.
7. The owner looks at the sandbox and at a phone, then merges. The deploy is automatic; check `docker logs arcaid --tail 50` on the host and load the changed page on prod.
8. Anything wrong: revert PR immediately, diagnose afterwards.

---

## 6. Things not to do

- Do not run `/impeccable new-work`, `craft` or the direction "roll". Those invent a visual world. ArcAid has one; the work is refinement.
- Do not let an agent run `quieter` or `distill` on the Scoreboard, Global Scoreboard, kiosk or title styles. The `PRODUCT.md` sentence in Phase 1 is the guard; repeat it in the session if an agent drifts.
- Do not bulk-apply a primitive migration across all 39 modals in one PR. Three PRs grouped by area keep the diff reviewable and the blast radius small.
- Do not start the local container with the production `.env`. Always the dev override.
- Do not edit a theme token without re-running `contrastAudit.cjs`; the 4.5:1 bar in `CLAUDE.md` is what keeps 16 themes honest.
- Do not run `impeccable detect` against arcaid.app in a loop. The API rate limiter (100 requests per minute per IP) will serve empty 429 pages and the findings will be wrong. Scan the sandbox.
- Do not let an agent fix a hook finding by adding `ignore-rule` or `ignore-file`; only `ignore-value` with a reason, and only for the exceptions you decided in Phase 1.

---

## 7. Where to start

1. Connect GitHub for cloud sessions (two minutes) so the analysis branch and future cloud work can push.
2. Install both skill sets project-scoped and turn the hook on (ten minutes).
3. Create `.env.dev`, the dev compose override and a seeded `data/dev.db` (an hour, or hand it to an agent as its first task).
4. Hand an agent Phase 0 as its first real PR. It is small, it is obviously correct, and merging it exercises the whole loop end to end.
5. Book one uninterrupted hour for the `init` interview and the critique read-through. Everything downstream is only as good as those two conversations.

Rough total for Phases 0 to 7 at one PR a day: three to four weeks of calendar time, perhaps eight to ten working days of agent time, and three or four hours of yours.
