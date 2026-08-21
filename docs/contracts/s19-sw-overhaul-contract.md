# S19 — Service-Worker Overhaul: Implementation Contract (v2.28.0)

> Contract author: orchestrator (Fable). Implementer: Sonnet agent.
> Protocol: if any instruction is ambiguous, contradicts the code you find, or is infeasible,
> STOP and return a structured BLOCKER (what you found, why it conflicts, 1–2 options).
> Do NOT guess. Deviations require orchestrator sign-off via blocker round-trip.

## Mission

Kill the manual `CACHE_NAME` bump ritual and the unbounded image cache in
`admin-ui/public/sw.js`, without breaking the update path for already-installed PWAs.
This sprint is ⚠️ flagged: a wrong move pins installed PWAs to a dead bundle.

Branch: `s19-sw-overhaul` off `main`. Version bump: root `package.json` → **2.28.0**
(admin-ui package.json version is not the source of truth; leave it unless it has been
bumped in lockstep historically — check `git log -p -3 -- admin-ui/package.json` and match precedent).
**No DB migration** (next free stays 113 — do not touch database.ts).

## Ground truth (from recon — verified on main 2026-07-20)

- `admin-ui/public/sw.js` (112 lines): `CACHE_NAME='arcaid-v100'`, single cache,
  `STATIC_ASSETS=[]` (install is a no-op precache), `skipWaiting()` on install,
  `clients.claim()` on activate. Activate deletes every cache `key !== CACHE_NAME`.
  Fetch: navigations network-first w/ cache fallback; extension-regex
  `/\.(css|js|woff2?|ttf|eot|png|jpg|svg|webp)$/` on pathname (any origin path) +
  Google Fonts hostnames → cache-first, no eviction; everything else network-only.
  Lines 70–111: S15 `push` + `notificationclick` handlers — **preserve verbatim**.
- Registration: `admin-ui/index.html:20-24` only. `navigator.serviceWorker.register('/sw.js')`,
  no update handling. `AccountSettings.tsx` uses `serviceWorker.ready` for push only — don't touch.
- Vite: `admin-ui/vite.config.ts` is 25 lines, plugin-react only, no define/manualChunks;
  `public/` is copied verbatim to `dist/`. Emitted bundles are content-hashed (`assets/[name]-[hash].js`).
- Serving: `src/api/server.ts:211-214` — `express.static(frontendPath)` with **no options**
  → no Cache-Control on sw.js / index.html / hashed assets. Image mounts at lines 81-95:
  `/api/styles/images` (7d), `/api/room-assets` (7d), `/api/score-photos` (7d),
  `/api/catalogue-images` (30d).
- The SW's extension regex currently matches all four image mounts → unbounded cache-first
  growth (4.9GB / 187k files of catalogue images alone).
- No workbox / vite-plugin-pwa anywhere. Do NOT add them — hand-rolled stays hand-rolled.
- Zero existing SW/PWA test coverage, front or back.

## Deliverables

### D1 — `sw.js` rewrite (`admin-ui/public/sw.js`)

Two caches, allowlist cleanup, path-scoped routing:

```
const BUILD_ID = '__ARCAID_BUILD_ID__';            // replaced at build time (D2)
const STATIC_CACHE = `arcaid-static-${BUILD_ID}`;  // build assets + shell; new name per build
const IMAGE_CACHE  = 'arcaid-images-v1';           // survives deploys; LRU-capped
const IMAGE_CACHE_MAX_ENTRIES = 200;
```

- **install**: keep as today minus precache list — just `self.skipWaiting()`. Do NOT add
  install-time precaching (an install-time `addAll` failure mode is new risk we don't want).
- **activate**: `clients.claim()` + delete every cache whose name is NOT in
  `[STATIC_CACHE, IMAGE_CACHE]`. This intentionally deletes all legacy `arcaid-v###`
  caches on upgraded installs AND old `arcaid-static-*` generations, while preserving
  the image cache across deploys. (The current `key !== CACHE_NAME` filter is the trap —
  a naive port wipes IMAGE_CACHE every deploy.)
- **fetch** routing, in order:
  1. Non-GET → pass through (`fetch(request)`), never cache.
  2. `request.mode === 'navigate'` → network-first; on success cache a clone in STATIC_CACHE;
     on failure fall back to `caches.match(request)`. (Same as today.)
  3. **Image routes by same-origin path prefix** — `/api/catalogue-images/`,
     `/api/styles/images/`, `/api/room-assets/`, `/api/score-photos/` →
     **stale-while-revalidate** in IMAGE_CACHE: if cached, respond cached and
     `event.waitUntil(revalidate-and-trim)`; if not cached, fetch, cache on `response.ok`,
     trim. **LRU trim**: after each put, `cache.keys()`; if length > 200, delete oldest
     entries (keys() insertion order) down to the cap. Keep the trim logic in a small
     named function.
  4. **Build/static assets** — same-origin pathname matching `/assets/` prefix OR the
     extension regex `/\.(css|js|woff2?|ttf|eot|png|jpg|jpeg|svg|webp)$/` (note: `jpeg`
     added), OR the existing Google-Fonts hostname check → cache-first in STATIC_CACHE,
     cache on `response.ok` (current semantics — do not start caching opaque responses).
     Explicitly never cache `/sw.js` itself.
  5. Everything else (all other `/api/*`, unknown) → network only.
  (Because image prefixes are checked BEFORE the extension regex, image mounts no longer
  leak into the static cache. Order matters — keep it.)
- **Lines 70-111 push/notificationclick: copy verbatim, byte-identical.**
- Structure the routing predicates + LRU trim as small named functions near the top so
  tests can exercise them (see D5).

### D2 — Build-time BUILD_ID injection (`admin-ui/vite.config.ts` + helper)

- New small helper module `admin-ui/scripts/swBuildId.ts` (or `.mjs` if vite.config
  import ergonomics demand — match how vite.config.ts resolves) exporting:
  - `computeBuildId(assetFileNames: string[], indexHtml: string): string` — sha-256 over
    the sorted asset filename list + index.html contents, truncated to 12 hex chars.
  - `injectBuildId(swSource: string, buildId: string): string` — replaces ALL occurrences
    of `__ARCAID_BUILD_ID__`; **throws if the placeholder is absent** (guards against the
    placeholder being renamed in sw.js without updating the plugin — build must fail loud).
- Inline Vite plugin in `vite.config.ts` (name it `arcaid-sw-build-id`):
  - `generateBundle`: record emitted chunk/asset fileNames.
  - `closeBundle`: read `dist/sw.js` (it exists by then — public/ copy happens before
    closeBundle; VERIFY this ordering empirically with a build; if false, blocker),
    read `dist/index.html`, compute id, inject, write back.
- Dev-server behavior: `vite dev` serves `public/sw.js` raw with the placeholder intact →
  cache name `arcaid-static-__ARCAID_BUILD_ID__`. That is acceptable; note it in a comment.
- Determinism: same build output → same BUILD_ID (no timestamps, no randomness).

### D3 — HTTP cache headers (`src/api/server.ts`)

Replace the bare `express.static(frontendPath)` mount with one passing `setHeaders`:
- `sw.js` and `index.html` (and bare `/`) → `Cache-Control: no-cache` (ETag revalidation
  stays on — express defaults).
- Paths under `/assets/` (Vite's hashed output) → `Cache-Control: public, max-age=31536000, immutable`.
- Everything else in dist (manifest.json, icons) → leave default (no explicit header).
Do NOT touch the four image mounts at lines 81-95 (their 7d/30d maxAge is correct and the
SW's SWR rides on top).
Also check `server.ts` for the SPA catch-all `sendFile(index.html)` path (S16 OG code near
lines 216-235) — the catch-all response must ALSO carry `no-cache` on index.html; if it
goes through a separate `res.sendFile`, set the header there too.

### D4 — Docs & ritual retirement (in-repo, this PR)

- `CLAUDE.md` (ArcAid) Gotchas: replace the "Service-worker cache-bust" entry with the new
  contract: BUILD_ID auto-derived from build output, no manual bump ever; images
  stale-while-revalidate LRU (200); `sw.js`/`index.html` served no-cache.
- `.claude/commands/release-docs.md` step 5 (bump CACHE_NAME): rewrite to "no action —
  SW version is build-derived since v2.28.0".
- `.claude/commands/update-docs.md:27,67`: update the two CACHE_NAME references likewise.
- `ROADMAP.md:31` mentions stale `arcaid-v75` — fix the wording to the new scheme.
- `CHANGELOG.md`: add v2.28.0 entry (follow existing entry format).
- Do NOT rewrite historical CHANGELOG entries mentioning old CACHE_NAME values.

### D5 — Tests (greenfield; both suites)

- **admin-ui (vitest)**: new `sw.test.ts`. Recommended approach: read
  `public/sw.js` as text, evaluate in a controlled context (`new Function` or `vm`) with a
  stubbed `self` (captures event listeners) + stubbed `caches`/`Cache` implementation
  (Map-backed, keys() in insertion order). Cover at minimum:
  1. Activate deletes `arcaid-v100` (legacy) and stale `arcaid-static-<old>` but KEEPS
     `arcaid-images-v1`.
  2. Routing: `/api/catalogue-images/x.jpg` → image cache; `/assets/index-abc123.js` →
     static cache; `/api/rooms/1/leaderboard` → network-only (never cached); POST → never cached.
  3. LRU: 201st image insert evicts the oldest, cache stays at 200.
  4. `computeBuildId` determinism + `injectBuildId` throws on missing placeholder.
  If the eval-in-vm approach proves unworkable in jsdom (check `setupTests.ts` for
  conflicts), fall back to extracting the pure predicates into a module imported by both
  sw.js — WAIT: sw.js is a classic script and cannot import. In that fallback case,
  return a BLOCKER with your proposed alternative instead of shipping untested logic.
- **backend (vitest + supertest)**: new test asserting response headers —
  `GET /sw.js` → `no-cache`; `GET /index.html` (or `/`) → `no-cache`;
  `GET /assets/<any built file>` → immutable long max-age. If the test harness doesn't
  serve the real dist (likely — check how existing server tests boot), build a minimal
  fixture dist dir in the test. Follow existing backend test file patterns.

### D6 — Version + bookkeeping

- Root `package.json` → 2.28.0.
- **This PR must NOT contain a manual CACHE_NAME bump** — the string `arcaid-v1xx`
  should no longer exist anywhere in sw.js.
- Commit style: repo convention (`feat:`/`fix:`/`refactor:` prefixes); batch commits at
  natural milestones.

## Invariants (review will check these adversarially)

1. An installed PWA running `arcaid-v100` (or v101) that loads the new deploy MUST: fetch
   the new sw.js (guaranteed by no-cache header + SW 24h spec ceiling), install, activate,
   delete ALL `arcaid-v*` legacy caches, and continue serving pages. No code path may
   leave it pinned to the old bundle.
2. `IMAGE_CACHE` must survive activate across two consecutive different BUILD_IDs.
3. No `/api/*` JSON endpoint response is ever cached by the SW (image mounts excepted).
4. Push notification behavior (S15) byte-identical.
5. skipWaiting/claim semantics unchanged (no new "prompt to reload" UX — out of scope).
6. `ChunkErrorBoundary` untouched.
7. Build fails loudly if BUILD_ID injection cannot happen (missing placeholder / missing
   dist/sw.js).
8. manifest.json untouched (maskable icons are S20's).

## Gates before you report done

1. `cd admin-ui && npm run build` — clean; then verify `dist/sw.js` contains a real 12-char
   hex BUILD_ID and NOT the placeholder; run the build twice and confirm the same BUILD_ID
   (determinism).
2. `cd admin-ui && npx vitest run` — all green including new tests.
3. Backend: container gate — `docker compose build` from repo root must succeed (this PR
   touches `src/api/server.ts`). Run backend vitest the way recent sprints did (in the
   container / alpine harness — check SPRINT_STATUS precedent; if Docker is unavailable,
   report it as a blocker rather than skipping the gate).
4. `git status` clean of stray files; diff reviewed for accidental churn (Windows CRLF:
   prefer Edit over Write on existing files; check `git diff --stat` vs `git diff -w --stat`).

## Report format

Return: branch name + commit SHAs, file-by-file summary, gate results (verbatim pass/fail
counts), the BUILD_ID determinism check result, any deviations (should be none without a
blocker round-trip), and anything you observed that contradicts this contract's ground truth.
