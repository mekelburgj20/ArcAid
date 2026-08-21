# Contract: Google ↔ Discord identity linking (v2.36.0)

PREREQUISITE: the `google-idp` branch (v2.35.0) must be MERGED to main before this starts — this feature builds directly on its `identityProvider.ts` helpers, `provider` JWT claim, Google OAuth routes, and `GoogleCallback`/`loginWithGoogle` FE flow. Verify those exist on your base commit before writing any code; STOP with a blocker if absent.

CONTEXT: with namespaced IDs, `google:<sub>` and a Discord snowflake are unrelated identities. A user who starts with Google then wants Discord features would fork into two users. Fix: canonical-identity linking. Beta status: pre-link attribution data is explicitly disposable (user confirmed), so the link-time rewrite uses simple last-write-wins — no elaborate conflict machinery, NO merge-reversal in v1.

## Architecture (binding)

- **Migration 114** (`114_user_identity_links`): new table
  ```sql
  CREATE TABLE IF NOT EXISTS user_identity_links (
      provider_user_id TEXT PRIMARY KEY,   -- e.g. 'google:1234...'
      canonical_user_id TEXT NOT NULL,     -- e.g. '190239...' (Discord snowflake)
      created_at TEXT DEFAULT (datetime('now'))
  );
  ```
  Idempotent per house convention. Canonical is ALWAYS the Discord snowflake in v1 (Discord unlocks the channel features). One google identity links to at most one Discord user (PK); one Discord user may hold multiple linked google identities (harmless; UI only offers one).
- **Login-time resolution**: in BOTH OAuth callbacks and `refreshAccessToken`, after computing `userId`, resolve: `SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?` → if found, mint the JWT with the canonical ID (and `provider` reflecting the ACTUAL login method used — provider claim stays 'google' when they logged in via Google; the ID is what canonicalizes). Session rows store the canonical ID. Keep the resolution in ONE shared helper (e.g. `IdentityLinkService.resolveCanonical(userId)`) called from all three sites.
  - Note: Discord logins resolve too (a snowflake is never a `provider_user_id` in v1, so it's a cheap no-op lookup — keep it uniform anyway).
- **New service** `src/services/IdentityLinkService.ts`: `resolveCanonical`, `createLink(googleUserId, discordUserId)` (with the attribution rewrite inside one transaction), `getLinkForCanonical(discordUserId)` (for the settings UI), `deleteLink(providerUserId)` (unlink v1 = row delete ONLY, identities diverge going forward — no un-merge).

## D1 — Linking flow (BE)

Endpoint design — the flow must prove ownership of BOTH identities:

- `POST /api/auth/link/discord/start` (requireDiscordUser): caller is a logged-in `google:*` user (400 if their canonical id is already a snowflake — nothing to link). Returns a short-lived one-time nonce (10 min expiry) bound to their google user id. Store server-side (small in-memory map with TTL is acceptable — single-process app; document the restart-loses-pending-links tradeoff — or a tiny KV row; implementer's call, note it).
- FE then runs the NORMAL Discord OAuth redirect with `state = link:<nonce>`.
- `POST /api/auth/discord/callback`: extend to accept the link case — when the FE posts `{ code, redirectUri, linkNonce }` (FE decodes its own state and passes the nonce explicitly; the server still never trusts `state` itself), the handler: exchanges code → gets the Discord user → validates nonce → maps to the pending google user id → calls `IdentityLinkService.createLink(googleId, discordId)` → mints a FRESH token as the canonical (Discord) identity → returns it with a `linked: true` marker. Invalid/expired nonce → 400, no link, no token change.
- **Attribution rewrite inside `createLink`'s transaction** (last-write-wins, beta-simple). Rewrite `google:<sub>` → snowflake in: `submissions.discord_user_id`, `score_history.discord_user_id` + `submitted_by_user_id`, `community_scores` (its submitter column — check actual name), `global_scores.player_id`, `room_members.user_id` (on conflict with an existing row for the snowflake in the same room: keep the snowflake's row, delete the google row), `user_preferences.discord_user_id` (same conflict rule), `push_subscriptions.discord_user_id` (keep both — endpoint PK likely differs; verify PK shape first), `game_room_admins.discord_user_id` (INSERT OR IGNORE-style move; PK is (room,user)), `sessions.discord_user_id` (rewrite so the google login's refresh chain survives), `user_profiles`: if the snowflake has NO profile row, re-key the google row; if both exist, keep the snowflake's row but COALESCE over display_name and avatar_url from the google row for any NULL fields, then delete the google row. Check the FK/cascade notes in CLAUDE.md's database section before writing the UPDATE order.
- Verify against the live schema which of these tables/columns actually exist with these names — the list above is from recon; adjust to reality and document deviations.

## D2 — FE

- `AccountSettings.tsx`: new "Connected accounts" section. For a google-identity user (`user id starts with google:` — or provider claim): show "Link Discord account" button → calls `/auth/link/discord/start`, stores the nonce (sessionStorage), redirects via the existing Discord OAuth URL-building with `state=link:<nonce>`. For a Discord-identity user: show linked google identities via `getLinkForCanonical` (new small GET endpoint, requireDiscordUser, self-only) with an "Unlink" button (deleteLink; confirm dialog: "Your Google login will become a separate account going forward"). Keep styling consistent with the page's existing sections.
- `DiscordCallback.tsx`: handle `state=link:<nonce>` — post the nonce with the code, then store the returned canonical token (player token storage), show a brief success state, redirect to `/account/settings`. Do NOT disturb the existing `__super__`/`player:`/bare-slug branches.
- After-link UX: the user is now logged in as their Discord identity; both login buttons work for them from now on (login-time resolution).
- Nudge: in the SubmissionSheet/PublicLayout hint added by v2.35.0 ("Sign in with Discord to get DM notifications..."), if the viewer is a logged-in google-identity user, the hint's CTA becomes "Link your Discord account" → `/account/settings`. (Only where the hint already exists — no new surfaces.)

## Constraints

1. Migration 114 only as specified. NO changes to user_mappings//map-user/MergeService semantics — this is a PARALLEL mechanism (document the distinction in a code comment on the service: user_mappings maps iScored NAMES to users; user_identity_links maps provider IDENTITIES to a canonical identity).
2. Legacy/unlinked users: zero behavior change. Discord-only users never see any of this except the Connected-accounts section (showing "no linked accounts").
3. Unlink does NOT rewrite attribution back (v1 scope; the confirm dialog says so).
4. No new npm deps. Hygiene: no `git add -A`; version via Edit; no SW bump.

## Tests

- IdentityLinkService: createLink rewrite correctness per table (seed google-attributed rows → link → assert re-keyed; conflict cases: both-have-room_members-row, both-have-profiles), resolveCanonical hit/miss, deleteLink.
- Callback link path: valid nonce → link + canonical token; expired/invalid nonce → 400 no-op; replay (second use of same nonce) → 400.
- Login-after-link: google callback for a linked google id mints the snowflake-id token.
- Existing suites green (backend full, admin-ui).

## Process

1. Branch `identity-linking` off main (must contain v2.35.0). 2. Implement, gates (root build, backend vitest full, admin-ui build+vitest, docker compose build). 3. Version → **2.36.0**. No CHANGELOG edit. 4. Commit(s) `feature:`, do NOT push/PR. 5. Report: files, rewrite-table deviations from the D1 list, discretionary decisions, verbatim gates, SHAs, blockers.
