# Fix round: mirror link flow — adversarial review findings

Branch `google-mirror-link`, working tree already contains the v2.46.0 mirror-link implementation
(uncommitted). Apply ALL fixes below. Findings #1–#3 are merge-blockers; #1 also patches a
vulnerability that is LIVE IN PROD in the existing Google→Discord direction.

## Fix 1 (CRITICAL) — bind the link nonce to the initiating browser session + account

Today the FE derives `linkNonce` entirely from the OAuth `state` param (attacker-controllable),
and `sessionStorage['arcaid_link_nonce']` is written but never read. Exploit: attacker mints a
nonce for THEIR account, crafts an authorize URL with `state=link:<nonce>`, victim clicks, victim's
identity gets irreversibly merged onto the attacker's account (both directions; the shipped
direction yields full account takeover incl. roles).

Implement BOTH layers, in BOTH directions (GoogleCallback + DiscordCallback / google + discord
callback routes):

a) **FE session binding:** in the callback pages, a link flow is only entered when
   `sessionStorage.getItem('arcaid_link_nonce')` is present AND equals the `state`-derived nonce.
   If `state` says `link:` but sessionStorage doesn't match → treat as error ("This link request
   didn't start in this browser — please retry from Account Settings"), do NOT fall through to a
   normal login. Clear the key after use (success or failure).

b) **Server-side initiator assert:** the link-callback POST must include the initiator's
   `Authorization: Bearer <player token>` (the initiator is by definition still logged in — the FE
   sends the stored player token). In the callback route's link branch, verify the token and
   assert the decoded user id === the id returned by `LinkNonceStore.consume`. Mismatch, missing,
   or expired token → 401 with a message telling the user to retry from Account Settings (nonce is
   consumed; that's acceptable). Use the same token-verification helper the rest of the API uses —
   do NOT roll new JWT handling. The non-link login path of the callbacks stays public/unchanged.

## Fix 2 (HIGH) — user_profiles UNIQUE collision kills the mirror link permanently

In `IdentityLinkService.createLink`'s both-profiles-exist branch, the COALESCE `UPDATE` on the
snowflake row runs while the google row still holds its `display_name` → violates the partial
UNIQUE index `idx_user_profiles_display_name` → transaction rollback → 500 forever (nonce already
consumed). The google profile is already read into memory before this point.
**Fix:** move the `DELETE FROM user_profiles WHERE discord_user_id = <googleId>` BEFORE the
COALESCE `UPDATE`. Add a regression test: both rows exist, google side has a display_name,
snowflake side has NULL → link succeeds, name carried over.

## Fix 3 (HIGH) — force account chooser on link flows

Add `prompt=select_account` to the authorize URL for LINK flows only, in both `startGoogleLink`
and `startDiscordLink` (AccountSettings.tsx). (Discord's OAuth: use its equivalent —
`prompt=consent` is Discord's re-approval param; check what the discord authorize URL builder
supports; if Discord has no account-chooser param, apply the fix to the Google side and note it.)
Normal login flows unchanged.

## Fix 4 (MEDIUM) — same-canonical relink must re-run the attribution sweep

`createLink`'s same-canonical early-return skips the idempotent rewrites, but stale pre-link
`google:*` JWTs (24h) can still create attribution rows under the google id after linking, and
relink used to be the repair. **Fix:** keep the `LINK_CONFLICT` throw for different-canonical,
but on same-canonical FALL THROUGH into the transaction (all rewrites are idempotent).

## Fix 5 (MEDIUM) — make the conflict guard atomic with the write

The pre-flight `SELECT` runs outside the transaction and the INSERT still ends
`ON CONFLICT ... DO UPDATE` (last-write-wins = the steal we're guarding against, under a race).
**Fix:** change to `ON CONFLICT(provider_user_id) DO NOTHING`; after the insert, if
`changes === 0`, re-read the row — same canonical → continue (per Fix 4), different → ROLLBACK +
throw `LINK_CONFLICT`. Keep the pre-flight SELECT only as a fast path before BEGIN (optional).

## Fix 6 (MEDIUM) — don't overwrite the Discord profile with Google data on the link path

In the google/callback link branch, after canonical reassignment the generic profile upsert writes
Google's `username`/`avatar_url` onto the snowflake's profile row. **Fix:** on the link path
(`linked === true`), skip the provider-profile upsert entirely OR change it to COALESCE-only
(fill NULLs, never overwrite). Snowflake's existing data must win. Mirror what the discord-side
link path effectively does. Add a test asserting a snowflake with an existing avatar/username
keeps them after linking a Google account.

## Fix 7 (LOW) — assert canonical shape

`createLink`: assert arg 2 with `isDiscordUserId` (exists in `src/utils/identityProvider.ts`),
throw on failure. `/link/google/start`: assert the caller id with `isDiscordUserId`, not just
"not google". Doctrine ("canonical is always a snowflake") becomes enforced, not conventional.

## Fix 8 (LOW) — FE must gate on `data.linked === true`

Both callback pages currently store the returned token + show "linked!" based on the FE-derived
`isLinkFlow` flag. With a malformed `state` (`link:` empty nonce) the server performs a NORMAL
login and returns a provider token → false success + wrong identity stored. **Fix:** only store
the token + show success when `data.linked === true`; otherwise show a link-failure state with a
"Back to Account Settings" action.

## Fix 9 (NIT) — error CTA

GoogleCallback link-failure state: "Back to Login" → link/button to `/account/settings`
(the user is still logged in).

## Deliberately NOT in scope (do not do)

- Server-side nonce invalidation on cancel (`/link/cancel`) — deferred; Fix 1 makes a live nonce
  non-bearer anyway.
- Any preview/confirmation UI.
- Un-merge on unlink.

## Test additions (beyond the regression tests named above)

- Banned / conflict callback attempts create NO `sessions` row and NO `user_profiles` row
  (not just no link row).
- The 409 conflict case: assert attribution rows did NOT move.
- Mirror path role resolution: a snowflake with `room_admin` (or super_admin) role linking a
  Google account receives a token carrying that role.
- `/link/google/start` binds the nonce to the JWT identity even if the request body tries to
  supply a different id.
- Fix 1 server assert: link callback without Authorization → 401; with a token for a DIFFERENT
  user than the nonce initiator → 401; happy path with matching token → 200.
- Update any existing tests broken by Fix 1's new Authorization requirement (they must now send
  the initiator's token — that's the new contract, not a regression).

## Gates (all mandatory before reporting done)

1. `npm run build` (root) · 2. `cd admin-ui && npm run build` · 3. full backend + admin-ui vitest
suites pass (695+ / 132) · 4. `git diff --numstat` vs `git diff -w --numstat` — flag any file where
they differ and verify by CR-byte count that it's re-indentation, not line-ending churn ·
5. NO commit/branch/push.

Also update `docs/decisions/0015-multi-idp-identity-linking.md` where the fixes change its claims
(nonce now session- AND token-bound; conflict guard atomic; select_account consent bar), and add a
CHANGELOG line noting the CSRF hardening applies to the pre-existing direction too.

Blockers policy: if a fix contradicts what you find in the code, stop and report the discrepancy
instead of guessing.
