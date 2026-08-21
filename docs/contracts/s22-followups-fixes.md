# Fix round: S22 follow-ups — adversarial review findings (v2.47.0, branch s22-followups)

Apply ALL items. Working tree already contains the implementation + a few direct edits
(Help.tsx sweep, GlobalScoreboard subtitle, rooms.ts invite DM, package.json description,
ArcaidLogoAnimated aria-label). Review findings reference the CURRENT tree.

## Blockers (H/M)

1. **H1 — gate the submission-draft commit path.** `global.ts` ~737:
   `POST /submission-drafts/:stateParam/commit` is `requireDiscordUser` only — a full room-score
   write path (CommunityScoreService.submitScore + direct submissions INSERT + merge sweep) with
   no ban check. Add `requireNotBanned` after `requireDiscordUser`. Add a test (banned user,
   room-target draft → 403, no score rows).
2. **H2 — fix the failing admin-ui test.** `admin-ui/src/components/__tests__/ArcaidLogoAnimated.test.tsx`
   lines ~7, ~10, ~13, ~18: assertions/comments still expect aria-label 'ArcAid'; the component
   now says 'Arcaid'. Update to 'Arcaid'. Suite must return to 132/132.
3. **M1 — gate display-name changes.** `src/api/routes/users.ts` ~42: add `requireNotBanned` to
   the `PATCH /me/profile` chain (banned user renaming themselves is the highest-visibility
   content write left open). Test: banned → 403.
4. **M2 — gate the room-admin content writes.** Add `requireNotBanned` to these `rooms.ts`
   chains (after the auth middleware): lobby announcements POST (~1890) + PUT (~1906), lobby
   config PUT (~2021), settings POST (~2661), tournaments POST (~2691), styles upload POST
   (~3987). One representative test suffices (announcements POST).
5. **M3 — gate explicit room join.** `global.ts` ~211 `POST /me/rooms/:roomId`: add
   `requireNotBanned` (the approval-path join-request at ~269 is already gated — this is the
   open-room twin).
6. **M4 — own-comment matching must cover historical rows.** `rooms.ts` ~2058 (GET masking) and
   ~2110 (DELETE authorization) currently prefer `req.user?.discordId` over `x-user-id`; every
   pre-existing GameDetail comment was stored under the anon UUID, so logged-in users just lost
   the delete button on their own old comments (and gained a Flag button on them). Fix
   server-side: build a candidate identity set `[req.user?.discordId, x-user-id]` (filter
   empty/'anon') and treat the row as "own" when `user_id` matches ANY member — both for masking
   and for delete auth. FE (`GameDetail.tsx` ~430 `isOwnComment`) already checks both ids —
   verify it matches either id too (extend if it prefers one). Test: comment created with anon
   UUID, then same request with Authorization + x-user-id both present → still deletable.
7. **L8 — restore package.json CRLF.** Working tree flipped CRLF→LF (a sed edit). Run
   `unix2dos package.json`; verify `git diff --numstat` for it drops to ~2/2 and matches `-w`.

## Cheap hardening (L/N — all in scope)

8. **L1 — ban gate fail-open must not be silent.** `middleware.ts` ~250: keep fail-open (a DB
   hiccup must not 503 every write) but add `logError('requireNotBanned: ban check failed open', err)`.
9. **L2 — clear the whole ban cache on ban writes.** `ScoreReportService.ban`/`.lift`: replace
   the single-key `BanService.invalidate(id)` with a full `BanService.clearCache()` (add the
   method) — bans are rare, the cache is 10s deep; this closes the linked-alias 10s stale-allow.
   Keep `invalidate()` if other callers use it, else remove.
10. **L3 — re-check ban before the Discord comment write.** `submitscore.ts` ~484-497: the
    comment modal can land ~5 min after the last check; add an `isIdentityBanned` re-check
    immediately before `CommentService.addComment` (silent drop or ephemeral "banned" reply,
    match the existing pattern at ~417-425).
11. **L4+L5 — atomic remove + sweep sibling reports.** `CommentReportService.remove`: wrap
    delete+resolve in a transaction, and resolve ALL open reports on the same `comment_id`
    (resolution 'removed' for the acted-on one; the siblings can share it) so the queue doesn't
    accumulate dangling rows. Test: two open reports on one comment → remove via one → both
    resolved, comment gone.
12. **L7 — limiter-before-gate ordering.** `global.ts` ~1443 and ~1920: swap so the rate limiter
    runs before `requireNotBanned` (matches rooms.ts ordering; banned clients consume budget).
13. **N1 — bind the OG test to the real shell.** `s16-og-meta.test.ts`: add one test that reads
    the actual `admin-ui/index.html` from disk and asserts `injectOgTags` (or the title-splice
    helper) produces a non-null injection against it — so a future title edit can't silently
    kill OG previews while the suite stays green.
14. **N2 — sweep leftovers.** `admin-ui/public/sw.js` ~167 push fallback title 'ArcAid'→'Arcaid'
    (BUILD_ID re-derives automatically — safe). Root docs: `ADMIN_PORTAL_TOUR.md`,
    `MODERATOR_PLAYBOOK.md`, `MODERATOR_QUICKSTART.md` — same prose sweep, same exclusions.
15. **N3 — CHANGELOG accuracy.** `docs/video-scripts/` is untracked (its sweep edit won't ship);
    remove/adjust that mention in the CHANGELOG entry. Do NOT `git add` the directory.
16. **M5 — document the guest-path limitation.** Add one sentence to the CHANGELOG entry and to
    ROADMAP's ban-enforcement section: on guest-allowed paths (comments always; score submits in
    REQUIRE_DISCORD_LOGIN=false rooms; ratings) a banned user can still write anonymously by
    omitting the token — ban enforcement is identity-based, anon-tier enforcement remains open.

## Explicitly NOT in scope
- L6 (comment-report room-visibility scoping / id oracle) — accepted for now.
- N4 (cache eviction) — bounded, fine.
- Fail-closed ban gate — rejected (availability wins).

## Gates (all mandatory)
Root build · admin-ui build · backend suite (738 + new, all green) · **admin-ui suite 132/132**
· CRLF numstat check incl. package.json restored · NO commit/branch/push.

Blockers policy: code contradicts a fix → stop and report, don't guess.
