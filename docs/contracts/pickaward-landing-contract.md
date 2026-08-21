# Contract: remove room-level pick-award gate + landing-page light mode (v2.56.0)

Two unrelated workstreams in one release. Next free migration: **126**.

---

## A. Remove the room-level pick-award gate

### Why
A live tournament ("Flippin Friends Pro Invitational", room `hoser_haven_pinball`) was configured with
*Winner picks next game* ✓, a 60-minute winner window and a 30-minute runner-up window. On rotation it
**auto-picked immediately** and the winner never got to choose. He did receive a "you won" push.

Root cause, verified on prod: `PickAwardGate.isEnabled()` resolves `room AND tournament`, and
`isRoomEnabled` is `raw === 'true'` against `ENABLE_GAME_PICK_AWARD` — which is **absent** for that
room, so `false`. The tournament's three settings were correct and inert. `tournamentWin` isn't gated
by this switch but `turnToPick` is, producing the exact symptom: congratulated, then nothing.

`ENABLE_GAME_PICK_AWARD` appears **only** in `Settings.tsx` — `TournamentForm.tsx` and
`Tournaments.tsx` never reference it, so the tournament form presents live-looking controls a room
switch silently disables.

**User decision: the room-level toggle is redundant. Remove it; winner-picks is per-tournament only.**

### Blast radius (verified on prod, do not re-derive)
5 rooms. Exactly **one** room sets the key (to `'true'`); the other four have it absent. **No room sets
it `'false'`** — nobody has deliberately opted out. All **9** tournaments have `winner_picks = 1`.
So four rooms begin honouring winner-picks on their next rotation, which is what their admins
configured. This is the intended outcome, not a regression.

### Work
1. **`src/services/PickAwardGate.ts`** — drop `isRoomEnabled` and the room leg. Keep the 5s cache.
   - `isEnabled(roomId, tournamentId)`: when `tournamentId` is supplied, resolve **only**
     `tournaments.winner_picks`.
   - **Room-scoped callers** (no `tournamentId`) exist — the Picks tab, Mystery Award, and some admin
     surfaces ask "is this flow live for this room at all?". Resolve those as **"any tournament in this
     room has `winner_picks = 1`"**. Do not return a blanket `true`; a room whose every tournament has
     winner-picks off should still render the disabled states.
   - Update the class doc comment: the override semantics it describes ("both room and per-tournament
     must be truthy", "a room-level off cannot be re-enabled per-tournament") are being deleted, and a
     stale comment here is exactly what made this bug hard to see.
2. **`admin-ui/src/pages/Settings.tsx`** — remove the `ENABLE_GAME_PICK_AWARD` toggle definition and
   its entry in whichever category renders it. Check `managedKeys` so the key doesn't fall through to
   the "Other" card as a raw text input.
3. **Audit every reference** to `ENABLE_GAME_PICK_AWARD` and to `PickAwardGate` across `src/` and
   `admin-ui/src/` — including Discord command gating strings and any admin-UI disabled states — and
   update each. Report the full list in your final report.
4. **Migration 126** — delete `game_room_settings` rows for `ENABLE_GAME_PICK_AWARD`. The key stops
   being read, and leaving orphans invites a future reader to think it still matters. (It is not in the
   public `scoreboard-config` prefix allowlist, so no payload change.)
5. **Do NOT** change any default, add a replacement room-level switch, or touch `winner_picks` values.

### Tests
- A tournament with `winner_picks = 1` in a room that never set the key now creates picker slots
  (this is the reported bug — assert it directly).
- `winner_picks = 0` still suppresses the flow.
- Room-scoped `isEnabled(roomId)` is true when any tournament has winner-picks, false when none do.
- Migration 126 removes the rows and is idempotent.
- Existing suites stay green: backend **864**, admin-ui **205**.

---

## B. Landing-page light mode

The landing page never followed the light theme introduced in A1 (v2.50.0). Three fixes.

### B1 — Rotating score tiles
`ScoreboardPromo` / `ScoreTickerCard` in `admin-ui/src/pages/LandingPage.tsx` are **entirely
inline-styled with hardcoded dark values** (`rgba(18,18,24,0.95)`, `'DM Sans'`, its own
avatar-initials fallback) and consume none of the token system — which is exactly why they stayed dark.

Convert them to the same tokens the rest of the app uses so they follow polarity, matching how the
Global Scoreboard's cards behave in light mode. Where a value has no token, add one following the
`--sb-*` convention with a light override. **No literal `rgba()` left in the component.** While there:
prefer the shared `PlayerAvatar` over the local initials/hue-hash duplicate if it drops in cleanly —
if it doesn't, leave it and say so rather than forcing it.

### B2 — Hero logo
The hero renders `ArcaidLogoAnimated`, a CSS/SVG recreation whose own doc says it "assumes a near-black
backdrop (#0C0C13)" — so it can't work on `#E8EAF0`.

In **light polarity only**, render the light artwork (`/arcaid-logo-light-v1.png`, already in
`admin-ui/public/`) in place of the animated component, sized to the hero's existing box. Dark keeps
the animated mark unchanged.

**Accepted loss: light mode has no glitch animation.** The package shipped no animated light source
(its README references a `share/arcaid-light-src.html` that isn't in the bundle), and rebuilding the
animation for light means reimplementing the component against six documented differences. Note it in
the final report; do not attempt the rebuild.

Respect the artwork's 180px minimum display width — the hero is far wider than that, so this is only a
check, not a constraint.

### B3 — Motto colour
The motto (`Run the room. Settle the score. Own the arcade.`) is currently
`rgba(255,255,255,0.72)` with a cyan-tinted text-shadow — invisible-ish on light.

In light polarity it becomes a **deep purple matching the logo's backdrop plate**. The plate gradient
runs `#4A1D82 → #2A0C52 → #1B0638 → #3A1468`. Those are *background* values; do not use one raw as
text. Pick a purple from that family that clears **4.5:1 on `#E8EAF0`** and state the measured ratio in
your report. Add it as a token with a dark-mode value that preserves today's appearance — the dark
motto must not change.

Drop or re-tint the cyan text-shadow in light; a cyan glow under purple text on a pale background reads
as a printing error.

### Tests
- Landing page renders in both polarities without literal-rgba regressions (assert the ticker uses
  token-driven classes/vars, not hardcoded colours).
- Light polarity renders the PNG hero; dark renders the animated component.
- Motto token resolves differently per polarity.

---

## C. ROADMAP entry only — do not implement

Add a ROADMAP item: **proof-photo access is too buried on room scoreboard cards.** Today the proof
link is hard to find from a score row. Desired: clicking a score opens the proof photo directly, the
way iScored does. User explicitly deferred this until the UX redesign arc completes — record it, build
nothing.

---

## Gates
Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD) · **no commit/branch/push**.

## Visual verification
Reuse `tmp/landing-screenshot-harness.js` (extend it; do not write another). Capture to
`tmp/landing-shots/`: `landing-dark.png`, `landing-light.png` (1440×900) and `landing-light-mobile.png`
(390×844). The light shot must show the new hero, token-driven ticker tiles, and the purple motto.

## Blockers policy
STOP and report if a `PickAwardGate` caller can't supply a tournament id and the room-scoped semantic
above doesn't fit it, or if the ticker has a colour with no sensible token. Do not expand scope into
the proof-photo work (§C).
