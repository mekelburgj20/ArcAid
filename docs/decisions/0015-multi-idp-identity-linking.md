---
status: accepted
date: 2026-07-27
deciders: mekelburgj
supersedes:
superseded-by:
---

# Multi-IdP identity linking: bidirectional Google<->Discord, snowflake-is-canonical, no un-merge

## Context

ADR 0010 established the identity layer inside a single provider (Discord): many iScored aliases collapse onto one Discord user via `user_mappings` + `user_profiles`. v2.35.0/v2.36.0 then added a *second* login provider (Google OAuth, namespaced `google:<sub>` ids) and, alongside it, a one-way account-link flow so a user who signs in with both providers is recognized as one account instead of forking into two logins with separate history.

That first flow only covered one direction: a user currently signed in as `google:*` could link a Discord account onto themselves (`POST /link/discord/start` → Discord OAuth round-trip → `POST /discord/callback` with a `linkNonce`). A user who signs in with Discord first — the more common case, since Discord is ArcAid's primary identity (DMs, tournament picks, slash commands) — had no way to *add* a Google login. This release (v2.46.0) mirrors the flow in the other direction.

Two design questions had to be settled before writing code:

1. **Does completing the mirror direction need a merge preview/confirmation step**, given the Google identity might carry its own scores/rooms/prefs that are about to be merged onto the Discord account? Or is completing OAuth sufficient consent, same as the existing direction?
2. **What happens when the identity being linked is already linked to someone else?** The original `createLink` used `ON CONFLICT(provider_user_id) DO UPDATE`, which silently re-points an existing link. That was flagged in-code as an out-of-scope v1 edge case for a one-way flow (an attacker would need to *already* control the google account to exploit it, and the value of Doing so was low). Making linking bidirectional changes the calculus: now a Discord-identity attacker can complete the Google OAuth leg for a victim's already-linked google account and re-point that link to themselves — a "steal-link" that requires no cooperation from the victim.

## Decision

### 1. No merge-preview step — completing OAuth is the consent bar, both directions

Identical to the existing direction: finishing the second provider's OAuth exchange (proving you control that email/account) is treated as sufficient authorization to merge its history onto the canonical account. No preview screen, no "are you sure, this will merge N scores" confirmation. This keeps the two directions symmetric and avoids a UX branch that only exists for one of them.

### 2. Canonical is always the Discord snowflake, in both directions

Unchanged from ADR 0010/the v2.36.0 flow. `IdentityLinkService.createLink(googleUserId, discordUserId)`'s signature and merge target did not change — a Discord snowflake is always `canonical_user_id`, a `google:<sub>` id is always `provider_user_id`. In the mirror flow, the *initiator* of the link request is the Discord user (they start from Account Settings while signed in as Discord), but the *direction of the write* is identical: prove ownership of the google account via OAuth, then `createLink(thatGoogleId, thisDiscordSnowflake)`.

This means both link-start endpoints mint a nonce bound to different things — `/link/discord/start` binds the nonce to the caller's `google:*` id (the identity that will become `provider_user_id`), `/link/google/start` binds it to the caller's Discord snowflake (the identity that will become — or already is — `canonical_user_id`) — but the nonce's *meaning* is uniform: "the id this nonce carries proved ownership of the browser session that started the link." `LinkNonceStore`'s stored field was renamed from `googleUserId` to `initiatorUserId` to reflect that it's no longer direction-specific; the public API (`create(userId)` / `consume(nonce)`) is unchanged.

**Post-review hardening (adversarial review, same release): the nonce alone is not a CSRF-safe bearer token.** A nonce minted by `/link/*/start` proves the *initiator* controls one account, but nothing originally stopped a *different* browser from completing the callback with that nonce — an attacker could mint a nonce for their own account, embed it in a crafted authorize URL (`state=link:<attacker's nonce>`), and get a victim to click it; the victim's identity would merge onto the attacker's account (full account takeover on the Google->Discord direction, since canonical carries roles). This is CSRF, not a nonce-strength problem, so the fix is session binding, not a longer nonce. Two layers, both directions:

1. **FE session binding.** `sessionStorage['arcaid_link_nonce']`, written by `startGoogleLink`/`startDiscordLink` right before the OAuth redirect, must match the `state`-derived nonce before either callback page (`GoogleCallback.tsx`/`DiscordCallback.tsx`) enters its link branch. A mismatch (or missing entry — the attacker's crafted URL was never preceded by a same-browser `/link/*/start` call) shows a "retry from Account Settings" error and never falls through to a normal login. Cleared after one read regardless of outcome.
2. **Server-side initiator assert.** Both callbacks' link branches now require an `Authorization: Bearer <token>` header — the initiator's own player token, still held by the FE throughout the OAuth round-trip — and verify (reusing the existing `verifyToken` helper, the same one every other authenticated route uses) that its decoded identity matches the id `LinkNonceStore.consume` just returned. Mismatch, missing, or invalid token -> 401. The nonce is consumed either way (a failed assert still burns it, closing the replay window even on a forged attempt).

Together these mean completing a link now requires BOTH knowing the nonce AND presenting a live token for the exact identity that requested it — a nonce alone (leaked, guessed, or attacker-minted-for-self) is no longer sufficient.

### 3. Direction assert on both callbacks

Because one nonce store now serves two flows, a nonce minted for one direction must not be replayable into the other callback — a `link:<nonce>` minted by `/link/google/start` (initiator = Discord snowflake) has no meaning inside `discord/callback` (which expects to consume a `google:*` initiator and link it onto the *just-authenticated* Discord snowflake), and vice versa. Both callbacks now assert the consumed initiator's shape before proceeding:

- `discord/callback`: initiator MUST be `google:*` → else 400.
- `google/callback`: initiator MUST NOT be `google:*` → else 400.

Both reuse the same "Invalid or expired link request" message as a plain missing/expired nonce — the distinction isn't surfaced to the client, since from the attacker's perspective a rejected-for-wrong-direction nonce and a rejected-for-expired nonce should look identical (no signal about *why* it failed).

### 4. `createLink` conflict guard — same-canonical idempotent (and re-swept), different-canonical rejected, atomic with the write

`IdentityLinkService.createLink` checks the existing link row for `provider_user_id` before committing anything:

- **No existing row** → proceed with the full link + attribution-rewrite transaction, same as before.
- **Existing row, same `canonical_user_id`** → idempotent success. **Falls through into the transaction and re-runs every rewrite** (post-review revision — see below), rather than early-returning.
- **Existing row, different `canonical_user_id`** → throws a typed error (`(err).code = 'LINK_CONFLICT'`, following the existing convention set by `MergeService`'s `MAPPING_CONFLICT`). No writes happen.

Both OAuth callbacks catch `LINK_CONFLICT` and map it to `409 { error: 'That Google account is already linked to a different Arcaid account.' }`. This is a **behavior change on the pre-existing Google->Discord direction too** — the old `ON CONFLICT DO UPDATE` re-pointed silently; now it 409s. That's intentional: closing the steal-link vector requires the guard to apply uniformly regardless of which side initiated the request that's about to overwrite an existing link.

**Post-review revisions (adversarial review, same release):**

- **Same-canonical relink now re-sweeps (was an early return).** A stale pre-link `google:*` JWT (24h lifetime) can keep writing attribution rows under the google id for up to a day *after* the link is created; the original early-return meant relinking — the obvious repair action — did nothing to those stragglers. The rewrites are idempotent (each is a plain `UPDATE ... WHERE column = googleId`, safe to re-run against rows that already moved), so falling through costs nothing on the common case and fixes the drift case.
- **The conflict check is now atomic with the write, not a separate pre-flight.** The original implementation read the existing row, decided same-vs-different canonical, THEN opened a transaction and wrote with `ON CONFLICT(provider_user_id) DO UPDATE` — a window between the read and the write where a concurrent `createLink` call could interleave, and the `DO UPDATE` fallback was itself last-write-wins (the exact steal-link shape the guard exists to prevent). The write is now `ON CONFLICT(provider_user_id) DO NOTHING` inside the transaction; if the insert no-ops (row already existed), the row is re-read *inside* the same transaction and the same same/different-canonical decision is made there — the pre-flight `SELECT` survives only as a fast path to skip opening a transaction for the common already-conflicting case.
- **`createLink`'s canonical argument is now shape-asserted** (`isDiscordUserId`, throws otherwise) — the "canonical is always a snowflake" doctrine (Decision #2 below) was previously enforced only by every call site behaving correctly, not by the function itself.

### 5. Unlink stays a row delete, no un-merge (unchanged)

`IdentityLinkService.deleteLink` is untouched by this release. Unlinking either direction still just deletes the `user_identity_links` row — identities diverge going forward, prior merged history stays merged. No new un-merge machinery was introduced for the mirror direction.

### 6. Remaining adversarial-review fixes

A handful of narrower fixes came out of the same review pass, applied to whichever direction(s) they actually affect:

- **`user_profiles` merge ordering.** The both-profiles-exist branch deletes the google row's `user_profiles` row BEFORE running the COALESCE `UPDATE` on the snowflake row, not after. The old order could have both rows holding the identical non-null `display_name` for the duration of one UPDATE statement, tripping the partial UNIQUE INDEX and rolling back the entire link transaction — with the nonce already consumed, unrecoverable without a fresh link attempt from scratch.
- **Google->Discord link path no longer clobbers the Discord profile.** `google/callback`'s post-link generic avatar/username upsert is skipped entirely when `linked === true`. Without this, after `createLink` reassigns `canonicalUserId` to the snowflake, the very next block in the same request handler would unconditionally overwrite that snowflake's `avatar_url`/`username` with the Google identity's own values — undoing the COALESCE-fill-only merge `createLink` just did. The `discord/callback` side never had this problem (its `canonicalUserId` is never reassigned mid-request), so only the google side needed the guard.
- **`prompt=select_account`** added to the Google authorize URL for link flows only (`startGoogleLink` in `AccountSettings.tsx`) — forces the account chooser so a browser already signed into one Google account can't silently link the wrong one. Normal Google login is unchanged. Discord's OAuth has no equivalent account-chooser parameter (`prompt=consent` re-shows scope approval, not an account switcher), so `startDiscordLink` has no corresponding change — a known, accepted asymmetry.
- **`/link/google/start`'s caller-shape check strengthened** from "not a google id" to "is an `isDiscordUserId` id", and the nonce is bound to the verified JWT's id only — the route never reads an id from the request body, closing off a spoofed-body-id class of bug even though the pre-fix code never actually read the body either (test coverage now pins this down explicitly).
- **FE gates on the server's `linked: true` flag**, not its own `state`-derived `isLinkFlow` guess. A malformed `state` value that still reaches a normal-login response (no `linked` field) no longer gets treated as a successful link and stored under the wrong identity. Link-flow failure states now link back to `/account/settings` (the user is still logged in throughout a link attempt) instead of `/login`.

## Consequences

- **Easier:** A Discord-primary user (the common case — Discord is ArcAid's main identity surface) can now add Google as a backup/alternate login without needing to have signed in with Google first. Symmetric linking UX in Account Settings: whichever provider the viewer is signed in with, they see a "Link the other one" button.
- **Easier:** The conflict guard closes a real vulnerability class (link-stealing) that was latent but unexploited while linking was one-directional, without needing a new table or migration — it's a read-before-write pattern already established elsewhere (`MergeService.recordMerge`'s pre-flight `MAPPING_CONFLICT` check).
- **Harder:** `LinkNonceStore` is now direction-agnostic storage shared by two different flows; a future third link direction (a hypothetical third IdP) needs the same direction-assert discipline on its own callback, or the nonce-replay-across-flows hole reopens. This isn't enforced by the type system — it's a convention future code must uphold, same caveat ADR 0010 flagged for the leaderboard partition rule.
- **Harder:** The 409 behavior change on the existing Google->Discord direction is a (minor, security-positive) breaking change to that endpoint's contract — any external caller relying on silent re-pointing (none exist; it was JWT-token-driven FE-only) would need updating. None do.
- **Locked out:** Still no un-merge. A user who links the wrong Google account, notices, and unlinks it is left with permanently-merged history from that account (same limitation ADR 0010 already accepted for the original direction). If un-merge becomes a real need, it requires new machinery (a merge-log table capturing pre-merge state) and should get its own ADR.

## Alternatives Considered

- **Merge-preview/confirmation screen before completing the link.** Rejected for symmetry with the existing direction and because OAuth completion is already the trust bar used everywhere else in the app (e.g. a fresh Google login on a room that happens to share history via `user_mappings` doesn't get a preview either). Revisit if either direction's merge blast radius turns out to surprise users in practice.
- **Keep `ON CONFLICT DO UPDATE` (silent re-point) and only guard the NEW direction.** Rejected — the steal-link vector is symmetric (an attacker can complete either OAuth leg to re-point an existing link), so a guard on only one direction leaves the other exploitable. Applying the guard inside `createLink` itself (rather than in each route handler) makes it structurally impossible to add a third call site that forgets the check.
- **A dedicated `LinkConflictError` class instead of a `code` property on a plain `Error`.** Rejected for consistency — every other typed-error convention in this codebase (`MAPPING_CONFLICT`, `DISPLAY_NAME_TAKEN`, `NAME_NOT_ALLOWED`, `ACCOUNT_BANNED`) uses `(err as Error & { code?: string }).code`, not a class hierarchy. Introducing a class here would be a one-off inconsistent with the rest of the error-handling surface.
- **A separate `LinkNonceStore`-per-direction instead of genericizing the shared one.** Rejected — doubles the sweep/TTL logic for no benefit, and the direction-assert in each callback already provides the safety property a separate store would have given "for free." Genericizing plus asserting is less code than two near-identical stores.

## Notes

- Recon reference: `src/api/routes/auth.ts` (Discord callback + link-start routes, Google callback), `src/services/IdentityLinkService.ts`, `src/services/LinkNonceStore.ts`, `src/utils/identityProvider.ts` / `admin-ui/src/lib/identityProvider.ts`. Test coverage in `src/__tests__/identity-link-flow.test.ts` (original direction, 14 tests) and `src/__tests__/mirror-link-flow.test.ts` (mirror direction, 18 tests: start/callback coverage, direct `createLink` conflict-guard unit tests, and the existing direction's new 409 case) — plus `src/__tests__/IdentityLinkService.test.ts` (direct service-level coverage of the attribution-rewrite/conflict-resolution table logic both directions share). The adversarial-review fix round (same release) added 12 more tests across all three files — Fix 1/2/4/6/7 regressions, mirror-path role resolution, nonce-binds-to-JWT-not-request-body, and no-session/no-profile-trace assertions on banned/conflict attempts — bringing the full backend suite to 707.
- No DB migration was needed — `user_identity_links` (migration 114) already models a directionless `(provider_user_id, canonical_user_id)` pair; this release only adds application-level guards and a second route/FE pairing that write through the same table.
