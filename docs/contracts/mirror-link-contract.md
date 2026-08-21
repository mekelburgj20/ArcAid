# Contract: Discord-side mirror link flow (Google as second login key)

**Feature:** A user logged in with a Discord identity can add a Google account as a second
login key for the same canonical account. Mirror of the existing Google-side-initiated
flow shipped in v2.36. Target release: **v2.46.0** (minor). No DB migration needed
(`user_identity_links` already exists, migration 114; next free migration number 117 — DO NOT consume it).

**Recon reference:** the full file:line map of the existing direction is in the session
notes; key files listed at the bottom. Read `src/api/routes/auth.ts:104-362` (Discord side),
`auth.ts:365-538` (Google side), `src/services/IdentityLinkService.ts`, and
`src/services/LinkNonceStore.ts` before writing any code.

## Design decisions (settled — do not relitigate)

1. **No merge preview/confirmation step.** Completing the Google OAuth leg proves ownership
   of the Google account — same consent bar as the existing direction. If the Google identity
   has its own history (scores, rooms, prefs), `IdentityLinkService.createLink` merges it onto
   the Discord snowflake exactly as today (snowflake wins conflicts, COALESCE-fill NULLs).
2. **Conflict guard, both directions.** `createLink` currently does
   `ON CONFLICT(provider_user_id) DO UPDATE` — a Google id already linked to a DIFFERENT
   canonical gets silently re-pointed (flagged in-code as an out-of-scope v1 edge; becomes a
   steal-link vector in the mirror direction). Change `createLink` to:
   - pre-flight `SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?`
   - same canonical → **idempotent success** (early return, no rewrites needed beyond upsert)
   - different canonical → **throw a typed error** (`LINK_CONFLICT` — follow the existing
     error-shape conventions in the service, cf. MergeService's `MAPPING_CONFLICT`)
   - routes map `LINK_CONFLICT` → **409** `{ error: 'That Google account is already linked to a different Arcaid account.' }`
   The existing Discord-side callback branch gets the same 409 mapping (this changes behavior
   there too — that is intentional).
3. **Canonical is always the Discord snowflake** (unchanged doctrine). The link row written is
   still `(provider_user_id = google:<sub>, canonical_user_id = <snowflake>)`. `createLink`'s
   signature does not change.
4. **Unlink stays as-is** (row delete, no un-merge).

## Backend

### `src/services/LinkNonceStore.ts`
- Genericize: the stored value is "the user id the link was initiated from" (today the field
  is named for the google id). Rename the internal field (e.g. `initiatorUserId`) + update the
  doc comment. Public API (`create(userId)` / `consume(nonce)`) unchanged. Same TTL (10 min),
  same single-use semantics.

### `src/api/routes/auth.ts`
- **New `POST /link/google/start`** — mirror of `/link/discord/start` (lines 309-329):
  - `requireDiscordUser`-gated.
  - 400 if the caller IS a `google:*` identity (`isGoogleUserId` from `src/utils/identityProvider.ts` —
    the check is the inverse of the existing endpoint's).
  - Ban-check the caller before minting (same pattern as line 319).
  - Mint nonce bound to the caller's Discord snowflake. Mirror the existing endpoint's exact
    response shape.
- **`POST /google/callback` gains a `linkNonce` branch** mirroring `discord/callback`'s
  (lines 172-200), placed at the equivalent point in the google callback sequence:
  - `LinkNonceStore.consume(linkNonce)` → initiator id, else 400 'Invalid or expired link request'.
  - **Direction assert:** the consumed id must NOT be a `google:*` id → else 400. (And add the
    symmetric assert in the discord callback branch: consumed id MUST be `google:*` → else 400.
    This prevents a nonce minted for one flow being replayed into the other callback.)
  - Ban-check BOTH sides before any writes (mirror the M2-fix ordering, lines 162-165 + 187-190).
  - `IdentityLinkService.createLink(googleUserId, snowflake)` — catch `LINK_CONFLICT` → 409.
  - Respond with `linked: true` and a token signed for the **canonical snowflake** (mirror what
    discord/callback returns on the link path).

## Frontend (`admin-ui/`)

### `src/pages/AccountSettings.tsx`
- For a **Discord-identity viewer** (currently only sees the linked-identities list + unlink,
  ~lines 624-670): add a **"Link Google account"** button, visually parallel to the existing
  google→discord link button (~lines 603-623).
- New `startGoogleLink` mirroring `startDiscordLink` (lines 139-180): `POST /api/auth/link/google/start`
  → build the Google OAuth authorize URL with `state=link:<nonce>` → full-page redirect.
  Reuse however the app already builds the Google authorize URL (`loginWithGoogle` in
  `ViewerAuthContext` / lib helper) rather than duplicating it — the only delta is the `state` value.

### `src/pages/GoogleCallback.tsx`
- Mirror `DiscordCallback.tsx`'s link handling (lines 29-35, 78-104): detect `state.startsWith('link:')`,
  extract the nonce, include `linkNonce` in the callback POST body, and on `data.linked === true`
  store the returned token as the player token, show the success state, and redirect to
  `/account/settings` after ~1.2s.
- Handle OAuth cancel (`error=access_denied`) the same way DiscordCallback does (lines 38-42).

## Tests

Extend `src/__tests__/identity-link-flow.test.ts` (or a sibling `mirror-link-flow.test.ts`
following its structure — 35 existing tests are the template). Must cover at minimum:
- `/link/google/start`: google-identity caller → 400; banned caller → 403; happy path mints nonce.
- Google callback link branch: invalid nonce 400; expired 400; replayed 400; direction-mismatch
  400 (nonce from the OTHER flow); banned google id 403; banned snowflake 403; already-linked-to-
  different-canonical 409; same-canonical idempotent success; happy path writes the link row and
  the attribution rewrite runs (spot-check one score table).
- The new `createLink` conflict guard: direct unit coverage of same-canonical no-op vs
  different-canonical throw, PLUS the existing Discord-side callback now returning 409 in the
  conflict case.
- Do not break the existing 35 tests; the full backend suite (677 tests pre-change) must pass.

## Docs

- `CHANGELOG.md`: v2.46.0 entry.
- Root `package.json`: bump version to 2.46.0.
- Draft `docs/decisions/0015-multi-idp-identity-linking.md`: covers both link directions, the
  snowflake-is-canonical doctrine, the merge-on-link semantics, the new LINK_CONFLICT policy,
  and the no-un-merge unlink doctrine. Keep it factual and short; it will be reviewed.
- Do NOT touch SPRINT_STATUS.md / ROADMAP.md / CLAUDE.md (handled at session close).

## Gates (all must pass before declaring done)

1. `npm run build` (repo root, backend tsc).
2. `cd admin-ui && npm run build`.
3. Full test suites: backend + admin-ui (`npx vitest run` per package — check package.json scripts).
4. CRLF check: `git diff --numstat` vs `git diff -w --numstat` byte-identical for every touched file.
5. **Do NOT commit, push, or branch** — leave changes in the working tree for review.

## Blockers policy

If anything in this contract contradicts what you find in the code (helper names, response
shapes, how the Google authorize URL is built, test harness setup), STOP and report the
discrepancy as a blocker in your final report instead of guessing. Small naming adaptations
are fine; semantic deviations are not.
