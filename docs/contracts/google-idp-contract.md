# Contract: Google login (second IdP) — v2.35.0

Largest change of the session. Namespaced-ID strategy: Google users get subject IDs `google:<sub>` stored in the SAME columns/claims Discord snowflakes use today (precedent: `iscored:*` synthetic IDs). Recon facts embedded; verify line numbers.

## Architecture decisions (binding)

- Google identity = `google:` + OIDC `sub`, flowing through every existing `discord_user_id` column/claim unchanged (all plain TEXT, verified).
- New JWT claim `provider?: 'discord' | 'google'` on `TokenPayload` (src/api/auth.ts ~:20-29). ABSENT = legacy token = treat as discord. `localAdminId` tokens unaffected.
- New util `src/utils/identityProvider.ts`:
  - `isDiscordUserId(id: string): boolean` — `/^\d{17,20}$/`
  - `isGoogleUserId(id: string): boolean` — `id.startsWith('google:')`
  - `isProviderUserId(id: string): boolean` — either of the above (for ID-vs-username dispatch)
  - `providerOfUserId(id: string): 'discord' | 'google'` — prefix-based, default discord
- NO user_mappings involvement for Google users — attribution via `submitted_by_user_id`/`discord_user_id` columns only.
- Migration **113**: `ALTER TABLE user_profiles ADD COLUMN avatar_url TEXT` (nullable). Follow the inline-array migration convention in database.ts; claim name `113_user_profiles_avatar_url`.

## D1 — Backend Google OAuth

In `src/api/routes/auth.ts`, mirroring the Discord handlers (~:84-226):

- `GET /google` → `{ clientId }` from `process.env.GOOGLE_CLIENT_ID` (400 if unset, same as Discord's).
- `POST /google/callback` body `{ code, redirectUri }`:
  1. Exchange code at `https://oauth2.googleapis.com/token` (form-encoded: code, client_id, client_secret, redirect_uri, grant_type=authorization_code).
  2. Fetch profile from `https://openidconnect.googleapis.com/v1/userinfo` with the access token → `{ sub, name, email, picture }`. Plain fetch — NO new npm dependencies, no id_token JWT verification library (userinfo endpoint is the verification).
  3. `userId = 'google:' + sub`; `username = name || email?.split('@')[0] || 'Player'`.
  4. Upsert `user_profiles(discord_user_id=userId, avatar_url=picture, avatar_fetched_at=now)` — mirror the Discord upsert (~:150-176) but write `avatar_url` (new column), leave `avatar_hash` NULL. Do NOT touch `display_name` (stays user-chosen).
  5. Same role branch as Discord: `isSuperAdmin(userId)` → super_admin; `getRoomsForDiscordUser(userId)` → room_admin; else player. Include `provider: 'google'` in ALL minted tokens. Return `{ token, refreshToken, user: { discordId: userId, username, avatar: picture } }` (keep response field names — FE compat).
- Discord callback: add `provider: 'discord'` to its minted tokens (all three role branches).
- `createSession`/refresh: no schema change (verified provider-agnostic). BUT fix `refreshAccessToken` (src/api/auth.ts ~:75-121): username/avatar must come from `user_profiles` (display_name/avatar_hash/avatar_url) NOT `user_mappings` (documented doctrine drift; for Google users the current code degrades to the raw `google:<sub>` string as username). Preserve the re-derivation of role. Refresh must re-stamp the correct `provider` (derive via `providerOfUserId(session.discord_user_id)`).

## D2 — Settings/secrets

- `src/utils/secrets.ts` `ENCRYPTED_SETTING_KEYS` (~:48-53): ADD `GOOGLE_CLIENT_SECRET`. Do NOT add `DISCORD_CLIENT_SECRET` (existing plaintext value would fail decrypt-on-read on prod — instead add a ROADMAP.md note: "encrypt DISCORD_CLIENT_SECRET at rest — requires a re-save via the settings UI after adding to allowlist, or a one-time re-encrypt migration").
- `admin-ui/src/pages/GlobalSettings.tsx`: add `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to `GLOBAL_KEYS` (~:9-27), `SETTING_LABELS` (~:31-48), and `GOOGLE_CLIENT_SECRET` to `SENSITIVE_KEYS` (~:29).

## D3 — Identity dispatch + Discord-channel gating (the audit fixes)

1. **6 regex dispatch sites** (schemas.ts:9 is channel/role config — SKIP it): `admin.ts:114`, `rooms.ts:838`, `rooms.ts:891`, `rooms.ts:3531`, `StatsService.ts:753`, `discord.ts:75` — replace bare `/^\d{17,20}$/.test(x)` "is this an ID" checks with `isProviderUserId(x)` where the semantic is "is this an identity key (vs a username to resolve)". At `rooms.ts:3531` (admin-add) and `discord.ts:75` (resolveDiscordUserId): these RESOLVE via Discord guild when not an ID — a `google:*` input should be accepted as a raw ID (admin-add: yes, granting room-admin to a google user by pasted ID is legitimate; resolveDiscordUserId: return the id unchanged only if `isDiscordUserId`, else null for google ids — it feeds Discord-channel operations. Judge each site by what consumes its output; explain per-site in the report.)
2. **NotificationService** (~:236-245): before the DM attempt, gate on `isDiscordUserId(userId)` — non-Discord users skip the DM path silently (no logError spam, no wasted REST call); web push evaluates as normal (v2.32.0 restructure already made push independent).
3. **`formatUserMention`** (discord.ts ~:143-151): if the id is not a Discord snowflake, never emit `<@...>` — fall back to the plain-bold-name branch.
4. **`fetchAvatarHash`** (discord.ts ~:126-137): early-return null for non-snowflake ids (skip the doomed REST call).
5. **TournamentEngine winner resolution** (~:1045-1057): prefer the top submission's own `discord_user_id`/`submitted_by_user_id` (already fetched at ~:964, currently unused for winnerId) BEFORE the `user_mappings` iscored-username lookup. Fall back to the existing lookup when the submission row has no attribution (pure iScored-synced/anon rows). Then the existing downstream splits naturally: Discord winner → DM + placeholder as today; `google:*` winner → placeholder + web-push `turnToPick` (v2.32.1 path), NO DM (gated by #2), channel announcement uses `formatUserMention` fallback (#3). `picker_discord_id` stores the namespaced id (TEXT, fine). Verify the Discord `/pick-game` command path can't be hit by a google-id placeholder holder (they have no Discord identity to invoke it — web `/pick-game` route must work; it's `requireDiscordUser`-gated which passes any provider).

## D4 — Room policy: REQUIRE_DISCORD_LOGIN third value

- Value domain becomes `'false' | 'true' | 'discord'` (same key, no migration). `'true'` = any logged-in provider (semantics broaden — this is intended and labeled). `'discord'` = provider must be discord.
- `conditionalRequireDiscordUser` (middleware.ts ~:75-112): when `'discord'`, additionally require the token's provider to be discord — derive via `payload.provider ?? providerOfUserId(payload.discordId)`. 401 message should say Discord login specifically is required.
- FE `admin-ui/src/pages/Settings.tsx`: the REQUIRE_DISCORD_LOGIN toggle (~:103, ~:199) becomes a 3-option select: "Guests can submit" / "Login required (any)" / "Discord login required". Preserve the existing DANGEROUS_KEYS orphan-on-flip confirm behavior for transitions that tighten the policy (check how the dangerous-flip confirm works; treat 'discord' like 'true' for that logic).
- FE `SubmissionSheet.tsx`: the room public config already ships REQUIRE_DISCORD_LOGIN; handle the third value — `'discord'` shows ONLY the Discord button with a line like "This room requires Discord sign-in to submit scores"; `'true'` shows both providers.

## D5 — FE login surfaces

- `ViewerAuthContext`: add `loginWithGoogle(returnSlug, returnTo)` mirroring `loginWithDiscord` (~:161-186): fetch `/api/auth/google` for clientId, redirect to `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, `scope=openid email profile`, `redirect_uri=${origin}/auth/google/callback`, `state=player:${returnSlug}` (same state conventions).
- New FE route `/auth/google/callback` + component `GoogleCallback.tsx` — clone `DiscordCallback.tsx`'s logic but POST to `/api/auth/google/callback`. If the shared logic can be extracted cleanly into a helper both callbacks use, do it; if extraction risks regressing the battle-tested Discord callback, clone-and-diverge is ACCEPTABLE (note the choice). (`auth` is already a reserved slug — no route collision.)
- `GoogleLoginButton` component styled as a sibling of `DiscordLoginButton` (standard Google branding: white/dark button, "Sign in with Google" — simple inline SVG G mark, no external assets). Then a small `LoginButtons` wrapper (both buttons stacked) can replace bare `DiscordLoginButton` usages — implementer's call whether wrapper or per-site addition is cleaner; the 10 shared-component call sites (PublicLayout, CreateRoom, GlobalGameDetail, Picks, MysteryAwardPage, GlobalScoreboard, SubmissionSheet, AccountSettings, Friends, MyRooms) must all show Google EXCEPT where D4 policy says discord-only (SubmissionSheet is the only policy-aware site).
- Hand-rolled surfaces: `Login.tsx` (super-admin, state `__super__`) and `RoomLogin.tsx` (room admin, bare-slug state) — add a Google button to each (a google-identified super_admin/room_admin is legitimate; role derivation is table-based and provider-agnostic, verified).
- **Discord-integrated-room nudge**: where both buttons show on a room with DISCORD_ENABLED ≠ 'false', add a one-line hint under the buttons: "Sign in with Discord to get DM notifications and tournament picks." (Room's discord-enabled state is available in the portal/public config — check what the component already receives; if not cheaply available at a given site, the hint may be limited to SubmissionSheet + PublicLayout where config is at hand. Note coverage in report.)

## D6 — Avatar resolution

- BE: in the two URL-construction sites (`src/api/auth.ts` ~:94 refresh, `src/api/routes/auth.ts` ~:145 login) the `avatar` value returned to the FE becomes: Discord → hash (unchanged shape) ; Google → full `picture` URL. Decide and DOCUMENT the JWT/user-object contract: simplest is `avatar` carries EITHER a hash (discord) or a full URL (google), and the FE helper disambiguates by `startsWith('http')`.
- FE: new `lib/avatar.ts` — `resolveAvatarUrl(userIdOrProvider, avatar: string | null): string | null`: full URL → as-is; hash + discord id → CDN template; null → null. Replace the 4 hardcoded CDN template sites (`AccountSettings.tsx:368`, `Friends.tsx:154`, `ScoreboardComponents.tsx:207`, `LandingPage.tsx:63`) with the helper. Any BE endpoints that ship avatar_hash to the FE for OTHER users (leaderboards etc.) should also ship `avatar_url` when present — check what the leaderboard queries SELECT from user_profiles and extend the SELECT + response field where user_profiles is already joined (do NOT add new joins).

## Constraints

1. Migration 113 ONLY as specified (one ADD COLUMN). Claim it properly in the migrations array.
2. Zero behavior change for existing Discord users: legacy tokens (no provider claim) = discord everywhere; Discord login flow byte-equivalent apart from the added claim; `REQUIRE_DISCORD_LOGIN='true'` rooms: Discord users unaffected (Google users NEWLY allowed — intended semantics broadening).
3. No new npm dependencies (BE or FE).
4. Do not touch: `/map-user` + user_mappings semantics, MergeService, Discord slash commands, ScoreSyncPoller, OpsAlertService.
5. Hygiene: NEVER `git add -A`; version via Edit tool; no SW bump; backend CommonJS / admin-ui ESM. **Back up nothing — but the migration must be idempotent per house convention.**

## Tests (backend vitest + admin-ui vitest, follow existing harness patterns)

- identityProvider helpers (all four functions, edge cases).
- Google callback route: mocked fetch for token+userinfo → token minted with provider:'google', user_profiles upserted with avatar_url (follow the existing auth/route test patterns if any; else service-level).
- conditionalRequireDiscordUser 3-state: false/true/discord × guest/discord-token/google-token matrix.
- NotificationService: google-id user → no DM attempted, push still delivered.
- TournamentEngine winner preference: submission with discord_user_id wins over user_mappings lookup; google-id winner gets placeholder + no DM (extend existing engine tests if a harness exists; else unit-test the extracted resolution logic — note approach).
- FE: avatar helper unit tests; existing suites green.

## Process

1. Branch `google-idp` off current `main`.
2. Implement D1→D6. Commit in logical chunks (migration+helpers / BE auth / audit fixes / FE) — separate commits welcome.
3. Gates: root build, backend vitest full, admin-ui build + vitest, `docker compose build`.
4. Version → **2.35.0**. No CHANGELOG edit. Do NOT push or open PR.
5. Report: files+summaries, per-site dispatch decisions (D3.1), discretionary decisions, verbatim gates, SHAs, deviations/blockers. STOP on semantic conflicts.
