# Contract: Standalone "pure ArcAid" room mode — Phase 1 (v2.32.0)

Orchestrator contract for the implementing agent. Recon findings embedded — verify line numbers before editing (drift expected, semantics are not).

## Goal

A room with no Discord guild and no iScored board must be creatable, configurable, and fully operable without anything rendering broken, misleading, or silently dead. Phase 1 = onboarding choice + Settings packaging + audit-pass fixes (incl. two real notification bugs). NO self-onboarding (that's Phase 2/3).

## Deliverables

### D1 — Room-creation "Standalone / Connected" choice

- `src/api/schemas.ts` `CreateGameRoomSchema` (~:109-119): add optional `mode: z.enum(['standalone','connected']).optional()` (default behavior when absent = connected, i.e. today's behavior — back-compat for any existing callers).
- `src/services/GameRoomService.create` (~:43-73): accept the mode; when `'standalone'`, seed `DISCORD_ENABLED='false'` and `ISCORED_ENABLED='false'` into `game_room_settings` alongside the existing `REQUIRE_DISCORD_LOGIN='true'` seed. NOTE: for standalone rooms seed `REQUIRE_DISCORD_LOGIN='true'` still (Discord OAuth is a global IdP, works without a guild — do not change this default).
- `src/api/routes/admin.ts` POST `/rooms` (~:53-69): thread `mode` through.
- `admin-ui/src/pages/GameRoomManager.tsx` create form (~:230-306): a two-option choice (e.g. segmented buttons "Connected" / "Standalone") above or near the top of the form, default **Connected**, with one line of caption each ("Discord + iScored integrations" / "Web-only — no Discord server or iScored board needed"). Send `mode` in `handleCreate` (~:58-77).
- Onboarding-message generator `copyOnboardingMessage` (~:124-157): branch the QUICK SETUP steps — standalone rooms get steps WITHOUT "Enter your Discord Guild ID" / "Enter your iScored credentials" (replace with web-relevant steps: set room theme/branding, create first tournament, share the `/:slug` link). Detect standalone at generation time from the room's settings if available in that component's data, else from the mode just chosen at creation.
- `SetupWizard.tsx` is DEAD CODE (zero importers) — do not touch it, do not build on it.

### D2 — Settings page: collapse integration credential categories

`admin-ui/src/pages/Settings.tsx` — `CATEGORIES` (~:105-111) render loop (~:981+):

- When `settings.DISCORD_ENABLED === 'false'`: do not render the `'Discord'` credential category card by default. Same independently for `'iScored'` ↔ `ISCORED_ENABLED`. (Per-toggle, not all-or-nothing.)
- In place of hidden card(s), render ONE quiet affordance (small muted text/link, not a NeonCard): "Integrations disabled for this room — Enable integrations…" which, when clicked, reveals the hidden category card(s) for the session (local state) and scrolls to / highlights the existing Integrations toggles card (~:887-915) where the actual enable toggles live. Not airtight — a reveal, not a wall.
- The Integrations toggles card itself (`integrationsCard`, injected at `'Game Room'` ~:1650) stays ALWAYS visible — it's how you turn things back on.
- **`usersCard` (Discord Admins, ~:724+, injected ~:1653) stays ALWAYS visible** — orchestrator decision: admin Discord-OAuth login is identity, orthogonal to the bot/guild integration.
- Follow the existing `SetupChecklist.tsx` gating precedent (`isFlagOn`, lines ~21-26/56/67) for reading the flags.

### D3 — Health card: room-scoped iScored status

- BE `GET /:roomId/admin/health` (`src/api/routes/rooms.ts` ~:4779-4839): add `iscored: { enabled: boolean, configured: boolean }` (enabled from the room's `ISCORED_ENABLED` ≠ 'false'; configured = `getIScoredCredsForRoom` returns non-null). Additionally **filter `poller.accounts` to this room's own account** — build the room's account key from its creds (poller keys accounts `${gameroomName}::${publicUrl}`, see `ScoreSyncPoller.ts` ~:210-220; reuse/extract the same key derivation rather than duplicating the format string if a helper can be exported cheaply). When the room has no creds → `accounts: []`.
- FE `admin-ui/src/pages/Dashboard.tsx` (`HealthData` ~:36-49, rendering ~:137-206): mirror the Discord-disabled treatment (~:144-158, neutral `bg-faint` dot) for iScored — `iscored.enabled === false` → gray dot + "iScored disabled" label; enabled-but-unconfigured → existing behavior. Keep the Discord half untouched.
- This closes a real leak: today the card shows the GLOBAL poller account map, i.e. other rooms' sync health, on every room's dashboard.

### D4 — Notification fixes (the two real bugs; required for the standalone story)

- `src/services/NotificationService.ts` `notify()` (~:135-225): the `isDiscordEnabledForRoom` gate (~:144-151) currently returns early and suppresses EVERYTHING including web push. Restructure so the Discord-disabled condition suppresses only the Discord-DM delivery; the web-push branch (~:192) must evaluate independently of the room's DISCORD_ENABLED. Preserve existing semantics otherwise: per-user opt-in prefs check, rate limit, return value indicating whether anything was delivered (adjust return semantics minimally and consistently — if it returned false only on the early gate, it should now reflect "delivered via any channel").
- `WEB_PUSH_TYPES` (~:51-54): add `turnToPick`.
- `src/engine/TournamentEngine.ts` `turnToPick` notify call (~:1343-1349): pass `pushUrl` deep-linking to the room's Picks page, mirroring the `tournamentWin` call's pattern (~:1097-1104). Use the same URL-construction idiom that call uses.
- Check `src/__tests__/s15-web-push.test.ts` and any NotificationService tests: update/extend to cover (a) DISCORD_ENABLED=false + push-subscribed user → push still sent, DM not attempted; (b) turnToPick is push-eligible with correct URL. Follow the existing test file's mocking patterns.

## Constraints

1. NO migration — next free is 113 and stays free (this is settings-key seeding + code, no schema).
2. No behavior change for existing connected rooms: absent `mode` = connected; rooms with DISCORD_ENABLED unset still default enabled (`!== 'false'`) — do not change the default-read semantics.
3. Do not touch: `SetupWizard.tsx`, `OpsAlertService`, admin-invite DM path (documented silent-fail is acceptable), `ScoreSyncPoller` poll logic (only key-derivation reuse for D3 if trivially exportable).
4. Repo hygiene: NEVER `git add -A` (huge untracked data/ dirs — explicit paths only). Version bump via Edit tool (CRLF). No SW bump (automatic). Backend CommonJS, admin-ui ESM.
5. Scope discipline: no per-room push toggles, no invite codes, no self-serve signup, no quotas — Phase 2/3.

## Tests / gates

- Backend vitest: existing suite green (1 known pre-existing flake `s12-account-deletion` acceptable if it's the only failure and reproduces on main); new/updated NotificationService + web-push cases per D4.
- Admin-ui: `npm run build` clean; `npx vitest run` all green (48+ from the ranking-card work if merged first, plus any you add — a Settings/Dashboard render test is optional, add only if cheap with existing harness).
- Root `npm run build` clean; `docker compose build` green.

## Process

1. Branch `standalone-room-phase1` off current `main` (rebase onto main if the ranking-card PR merged meanwhile).
2. Implement D1→D4.
3. Run all gates.
4. Version: root `package.json` → **2.32.0** (Edit tool). Do NOT touch CHANGELOG.md.
5. Commit(s) with `feature:` prefix. Do NOT push, do NOT open a PR — orchestrator reviews first.
6. Final report: files changed w/ per-file summary; discretionary decisions; verbatim gate results; commit SHA(s); deviations/blockers. If blocked, STOP and report — do not guess.

## Ops note (orchestrator handles, not implementer)

Web push is live only if prod has `WEB_PUSH_VAPID_PUBLIC_KEY`/`WEB_PUSH_VAPID_PRIVATE_KEY` seeded (global settings; private key encrypted). Verify on prod before ship; if absent, seeding VAPID keys is a deploy-day step for the standalone story to be real.
