---
status: accepted
date: 2026-05-02
deciders: mekelburgj
supersedes:
superseded-by:
---

# Per-account iScored Playwright session serialization via `IScoredSessionRegistry`

## Context

ArcAid drives game management (create, lock, hide, delete, reorder) on iScored via Playwright UI scripting (`IScoredClient`), because the iScored REST surface (`IScoredApiClient`) doesn't expose those operations. Score read/write IS available over REST and goes through `IScoredApiClient` — Playwright is reserved for the management cases.

Pre-v2.10.0, every code path that needed Playwright access constructed its own `IScoredClient` and called `connect()` / disconnect()`. The constructors were sprinkled across `TournamentEngine` (4 sites: maintenance, cleanup, deactivate, delete), `TimeoutManager.fallbackToAutoSelection`, `gameCreation.{pinGameToScoreboard, unpinGameFromScoreboard}`, `IScoredSubmitSync`, four admin endpoints in `rooms.ts`, the backup endpoint in `admin.ts`, and four Discord commands. ~14 construction sites in total.

Each construction logged into iScored independently. iScored's session model treats one logged-in account as one browser session — multiple Playwright contexts authenticated as the same account contend over server-side state (cookies, CSRF tokens, the in-memory game-list dropdown that `deleteGame` enumerates).

**The contention manifested as silent data loss.** The 2026-04-29 incident on `rtx_pinball`:

- Wed 22:00 Central fired five concurrent maintenance crons (4 weeklies + Daily Grind) plus three inline cleanup phases — eight independent Playwright contexts authenticated as `mekelburgj@gmail.com` within ~5ms.
- Inside `IScoredClient.deleteGame`, the flow was: navigate to Games tab → enumerate `<select id="selectGame">` options → confirm the target's `option[value=<iscored_id>]` exists → drive the delete modal. Between the navigate and the enumerate, another concurrent context's mutation could repopulate the dropdown.
- When the lookup returned 0, `deleteGame` short-circuited with `Game '<name>' not found in dropdown. Skipping delete.` and returned. The caller (`runCleanup`) had no way to distinguish this from real success because `deleteGame` returned `void`. It logged `-> Deleted from iScored: <name>` regardless and moved on. The local DB row went `COMPLETED → HIDDEN` per the cleanup contract, but iScored kept the entity visible.
- Production fallout: CSI, X-Men Wolverine LE, Paranormal, and Attack from Mars all stayed visible on iScored despite local DB marking them HIDDEN. Manual hand-delete via the iScored admin UI was the only recovery path. The user (operator) flagged this as the symptom that triggered this work.

Plus a related cost: `runMaintenanceWork` opened one client for the slot processing loop, then `runCleanup` (called inline at the end) opened a *second* client. Even within a single tournament's maintenance run, two sequential Playwright logins were paid (~3-9 seconds each) for work that could have shared one session.

The ROADMAP entry "Parallel iScored Playwright sessions step on each other on Wed 22:00" had two named sub-bugs: (a) the dropdown-state-flip race; (b) `runCleanup`'s false-success log line. Both needed to be fixed together — fixing only the log line gives accurate failure visibility but doesn't actually keep iScored in sync; fixing only the race without honest return values would make the *next* drift invisible.

## Decision

Add a singleton `IScoredSessionRegistry` that owns Playwright session lifecycle. Every iScored mutation routes through `withSession(creds, fn)`. Make `IScoredClient.deleteGame` return `boolean` so callers can branch on actual outcome. Construction of `IScoredClient` is allowed only inside the registry's `acquireClient` method — every other site goes through the registry.

### `IScoredSessionRegistry` — chain-based per-account serialization

`src/engine/IScoredSessionRegistry.ts`. Singleton. Two pieces of state per iScored account (keyed by lowercased username):

- `chains: Map<accountKey, Promise<void>>` — the **tail** of the per-account work chain. Each new caller awaits the current tail and replaces it with its own `myDone` promise.
- `sessions: Map<accountKey, SessionEntry>` — the open `IScoredClient` (if any) plus an `idleTimer` handle.

`withSession<T>(creds, fn): Promise<T>`:

```ts
const previous = this.chains.get(key) ?? Promise.resolve();
let resolveMyDone!: () => void;
const myDone = new Promise<void>((resolve) => { resolveMyDone = resolve; });
this.chains.set(key, myDone);

try {
    await previous;                                  // wait my turn
    const client = await this.acquireClient(key, creds);
    try {
        return await fn(client);
    } finally {
        this.scheduleIdleClose(key);                 // hold for IDLE_TTL_MS
    }
} finally {
    resolveMyDone();                                  // unblock the next waiter
    if (this.chains.get(key) === myDone) {
        this.chains.delete(key);                      // last-out cleans the chain
    }
}
```

`acquireClient` reuses the existing session if alive; otherwise constructs a fresh `IScoredClient`, calls `connect()`, stores the entry. `scheduleIdleClose` queues a `setTimeout(IDLE_TTL_MS = 1500)` to disconnect — cancelled if another caller acquires before it fires.

The chain pattern guarantees: only one `fn` runs at a time per account; failures don't deadlock subsequent callers (the outer `finally` always resolves `myDone`); session reuse across consecutive callers within 1.5s is automatic.

### `IScoredClient.deleteGame` returns `Promise<boolean>`

`false` on the dropdown short-circuit (entity not present in `<select id="selectGame">`), `true` on confirmed delete-modal completion. Throws on real errors (timeout, login lost, etc.).

Every caller branches on the return value:

- `TournamentEngine.runCleanup` — logs `-> Cleanup skipped <name> on iScored (not in dropdown). Local row will still be marked HIDDEN.` instead of the misleading success line.
- `TournamentEngine.deleteGameCompletely` — sets `iscoredStatus: 'failed'` with `iscoredError: 'Game not found in iScored dropdown — iScored entity may need manual cleanup.'` so admin UI surfaces the orphan instead of reporting fake success.
- The three `rooms.ts` admin delete paths — same pattern: `logWarn` on `false`.

### Caller refactor

Roughly 14 sites moved from `new IScoredClient(...)` + manual `connect`/`disconnect` to `withSession(creds, async (client) => { … })`. Notable shape changes:

- `TournamentEngine.runMaintenanceInternal` resolves creds upfront and wraps `runMaintenanceWork(tournamentId, client, creds)` in `withSession`. The work function accepts an injected client + creds (or `null` when iScored is disabled for that room) instead of constructing its own.
- `runCleanup(tournamentId, rule?, sharedClient?, sharedCreds?)` accepts an optional injected pair. When supplied (the inline-cleanup path from maintenance), it uses them directly. When called standalone (e.g. `runScheduledCleanup`), it acquires its own session via the registry.
- `reorderIScoredLineup(gameRoomId?, sharedClient?)` was scoped to a single room when called with a `sharedClient` matching that room's account — pre-fix it iterated *every* room's lineup on every maintenance fire (5 weeklies on rtx_pinball reordered the same lineup 5×).

### Account key

`creds.username.toLowerCase()`. iScored uses email/username for login; case-insensitive comparison matches iScored's own behavior at the identity layer (see ADR 0010 Notes). Two rooms that share an account share the same chain.

## Consequences

- **Easier:** All mutations are serial per-account by construction. A new code path that needs Playwright Just Works without thinking about contention — the registry handles it.
- **Easier:** Login cost amortized across batches. Wed 22:00 used to pay ~5 logins (3-9s each). Now it pays one, with subsequent callers reusing the open session within the 1.5s idle window. Net savings ~30-40s per concurrent-fire moment.
- **Easier:** `deleteGame`'s honest return value means future iScored-side drift is *visible* in logs the moment it happens. The ROADMAP-tracked manual cleanup chore can drop to "look at last week's logs for `Cleanup skipped` warnings" instead of "compare ArcAid HIDDEN rows against iScored UI by hand."
- **Easier:** Admin actions during maintenance no longer race with the cron flow. Pre-fix, an admin clicking Delete on a game while Wed maintenance was running could win or lose the dropdown-state coin flip. Now the admin's `withSession` queues behind the maintenance chain and runs cleanly when its turn comes up.
- **Harder:** Tournament A's maintenance blocks tournament B's maintenance for the duration of A's iScored work. With 5 tournaments on one account each taking ~10-30s of Playwright work, a Wed 22:00 batch now takes ~50-150s of wall-clock time end-to-end instead of running in parallel. Acceptable: the parallelism was never *correct* — it was only ever incidental damage. Sequential runs are slower in real time but produce reliable outcomes.
- **Harder:** A bug in `withSession` that fails to resolve `resolveMyDone` deadlocks every subsequent caller for that account *forever* until container restart. The `try { … } finally { resolveMyDone() }` structure is explicit about this; future edits to `withSession` must preserve the invariant. The chain itself is small (~30 lines) and self-contained.
- **Harder:** Callers can no longer assume `deleteGame`'s success — they must explicitly handle `false`. New callers that ignore the boolean will silently regress to the pre-v2.10.0 behavior. TypeScript catches the unused-return only with `noImplicitReturns`-style strictness, which this codebase doesn't enable; code review is the safety net.
- **Locked out:** True parallel iScored mutations on the same account are not possible without superseding this ADR. If iScored ever gains a per-resource lock model that allows concurrent operations on different games, the chain becomes overly conservative. The pragmatic response would be a per-(account, game-id) lock instead of per-account; that's a future optimization, not a present concern.
- **Locked out:** No standalone caller can opt out of the registry "for performance." Every iScored Playwright operation must serialize behind the chain. This is intentional — the registry IS the correctness story.

## Alternatives Considered

- **Per-account mutex on `IScoredClient` mutating methods.** Wraps each mutation call in a per-account async lock; each caller still constructs its own client. Rejected for two reasons: (a) doesn't fix the *underlying* problem (multiple Playwright contexts authenticated as the same iScored user — a constraint iScored imposes, not a fix we can apply at the lock layer); (b) doesn't amortize login cost. The lock would correctly serialize calls but each tournament's session still pays its own ~3-9s login. The registry's "single client per account, shared across callers in the same idle window" is materially cheaper.
- **Per-cron-batch shared client.** Scheduler groups tournaments firing at the same minute, opens one client, passes it to all `runMaintenance` calls. Rejected because (a) it requires Scheduler-layer awareness of which tournaments share an account — the registry is account-scoped from the start without that coordination; (b) it doesn't help admin actions or Discord commands that fire outside the cron flow. The registry handles all of these uniformly.
- **Long-lived singleton client per account, kept connected at process startup.** Open one Playwright session per account at boot, keep alive forever, route all mutations through it. Rejected as operationally fragile: pinning a Chromium per account ties up memory; long-lived sessions lose iScored-side cookies and need transparent reconnect; container restarts are no-ops for everything except the long-lived sessions which must reinitialize. The 1.5s idle TTL gives effectively the same batching benefit (consecutive cron fires reuse the session) without the infinite-lifetime cost.
- **Per-account `node-rwlock` style read-write lock.** Allows concurrent reads with exclusive writes. Rejected because Playwright's session-state contention isn't a reads-vs-writes problem — even two read-only navigations can flip the in-page dropdown state. The actual constraint is "one operation at a time per session" regardless of read/write shape, which is a plain mutex, which is what the chain implements.
- **Leave callers separate, fix only `deleteGame`'s return value (option 2 from the diagnostic conversation).** Surfaces the failures cleanly but doesn't prevent them. Each Wed 22:00 would still log multiple `Cleanup skipped` warnings, and the admin would still manually clean up iScored. Rejected as half-measure — the user explicitly asked for the long-term robust fix, not the observability improvement.
- **De-stagger cron expressions so weeklies fire at `:00`, `:05`, `:10`, `:15` instead of all at `:00`.** Cheapest mitigation; reduces contention probability. Rejected because (a) it's stochastic, not architectural — a new tournament's cron could re-introduce contention; (b) doesn't help the last-day-of-month case where DG + MG inevitably share `:00` 12 times a year; (c) UX regression: players expect synchronized weekly rotations, not a slow cascade of `[Pending Pick]` notifications staggered across 20 minutes.

## Notes

- The registry's `shutdown()` method exists for completeness but is never called today (the process model is "container restart on every deploy," and Playwright cleanup happens implicitly when the Chromium subprocess exits with the parent). If we ever ship hot-reload or in-process restart, calling `shutdown()` from the appropriate lifecycle hook is the right move.
- `withSession` accepts `Promise<T>` callbacks and returns `Promise<T>`. Multi-step iScored operations (e.g. "create game + set tags + unlock") should land inside a single `withSession` call so they're atomic with respect to the chain. Splitting them across two `withSession` calls would let another caller's work interleave between steps — which the chain pattern is specifically designed to prevent within a single logical operation.
- The ROADMAP entry that motivated this ADR is closed by this work. Two follow-ups remain open: (1) iScored per-score delete cascade (independent of this ADR; see ADR 0011), (2) reconcile the four pre-fix iScored orphans (Paranormal, Attack from Mars, etc.) — manual hand-delete, owned by the operator.
- `IScoredApiClient` (REST/HTTP) does NOT route through the registry — it's stateless per-call and doesn't have the session-state contention problem. The registry is exclusively for Playwright (`IScoredClient`).
